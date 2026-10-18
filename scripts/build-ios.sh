#!/usr/bin/env bash
# Build the OpenSocket iOS app with xtool (ADR 0001 — iOS on the no-macOS dev
# box). Runs inside the official Swift container (the dev box is Arch; Swift
# ships Ubuntu/Debian builds only). The xtool release is an AppImage: it is
# extracted once on the host so the container can run it without FUSE.
#
#   scripts/build-ios.sh              # xtool dev build  (unsigned .app)
#   scripts/build-ios.sh --ipa        # .ipa instead of .app
#   scripts/build-ios.sh sdk-install  # interactive: prompts for Xcode.xip path
#   scripts/build-ios.sh shell        # shell in the container for debugging
#
# One-time prerequisites (host): docker; ~/.local/bin/xtool; pull the image:
#   docker pull swift:6.4.1-noble
# One-time SDK bootstrap (interactive; downloads your Xcode.xip with your
# Apple ID in a browser first — xtool only reads the local file):
#   scripts/build-ios.sh sdk-install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${SWIFT_IMAGE:-swift:6.4.1-noble}"
HOME_DIR="${XTOOL_HOME:-$HOME/swift/xtool-home}"
XTOOL_APPIMAGE="${XTOOL_APPIMAGE:-$HOME/.local/bin/xtool}"
SQUASHFS="${XTOOL_SQUASHFS:-$HOME/swift/xtool-squashfs/squashfs-root}"

# Extract the AppImage once (its AppRun resolves bundled libs without FUSE).
if [ ! -x "$SQUASHFS/AppRun" ]; then
  echo "extracting xtool AppImage -> $SQUASHFS"
  mkdir -p "$(dirname "$SQUASHFS")"
  rm -rf "$SQUASHFS"
  ( cd "$(dirname "$SQUASHFS")" && "$XTOOL_APPIMAGE" --appimage-extract >/dev/null )
fi

# A wrapper on PATH inside the container, next to the mounted home.
mkdir -p "$HOME_DIR/bin"
cat > "$HOME_DIR/bin/xtool" <<'WRAPPER'
#!/bin/sh
exec /opt/xtool-app/AppRun "$@"
WRAPPER
chmod +x "$HOME_DIR/bin/xtool"

args=()
mode="build"
case "${1:-build}" in
  sdk-install) mode="sdk-install" ;;
  shell) mode="shell" ;;
  *) args=("$@") ;;
esac

base=(-u "$(id -u):$(id -g)"
  -e "HOME=/home/build"
  -e "PATH=/home/build/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  -v "$HOME_DIR:/home/build"
  -v "$ROOT:/work"
  -v "$SQUASHFS:/opt/xtool-app:ro"
  -w /work/apps/mobile/ios)

case "$mode" in
  sdk-install)
    exec docker run --rm -it --security-opt seccomp=unconfined "${base[@]}" "$IMAGE" xtool sdk install
    ;;
  shell)
    exec docker run --rm -it --security-opt seccomp=unconfined "${base[@]}" "$IMAGE" bash
    ;;
  *)
    # xtool serves its build protocol over stdio and epoll-registers stdin:
    # without -i docker gives the container /dev/null as stdin, and epoll_ctl
    # on /dev/null fails with EPERM, crashing SwiftNIO. Always attach stdin —
    # from the terminal when there is one, otherwise a kept-open pipe.
    if [ -t 0 ]; then
      exec docker run --rm -it --security-opt seccomp=unconfined "${base[@]}" "$IMAGE" \
        xtool dev build "${args[@]}"
    else
      exec docker run --rm -i --tty=false --security-opt seccomp=unconfined "${base[@]}" "$IMAGE" \
        xtool dev build "${args[@]}" < <(sleep infinity)
    fi
    ;;
esac
