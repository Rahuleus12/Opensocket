#!/usr/bin/env bash
# Linux/macOS counterpart to dev-up.ps1: start the OpenSocket dev stack.
# Processes survive the calling shell (nohup). Logs land in ${TMPDIR:-/tmp}/opensocket.
set -euo pipefail

logDir="${TMPDIR:-/tmp}/opensocket"
mkdir -p "$logDir"
repo="$(cd "$(dirname "$0")/.." && pwd)"

# Deploy the pi approval gate next to the daemon data dir. PiHarness loads
# <dataDir>/extensions/opensocket-approval.js into every pi child when present.
extDir="$HOME/.opensocket/extensions"
mkdir -p "$extDir"
cp -f "$repo/demo/pi-agent/extensions/opensocket-approval.js" "$extDir/opensocket-approval.js"

# Load .env from the repo root if present (gitignored). KEY=VALUE lines.
if [ -f "$repo/.env" ]; then
  while IFS= read -r line; do
    case "$line" in
      [A-Za-z_]*) export "${line?}" ;;
    esac
  done < "$repo/.env"
fi

started="mock-orchestra :8081 | mock-openai :8082 | daemon(keyless demo) :8098"

# Real Orchestra server, only when a checkout is available. Set ORCHESTRA_DIR
# to your local checkout; without it the script starts the keyless demo only.
orchestraDir="${ORCHESTRA_DIR:-}"
if [ -n "$orchestraDir" ] && [ -x "$orchestraDir/bin/orchestra" ]; then
  export ORCHESTRA_DEFAULT_PROVIDER=openrouter
  # api.openrouter.ai can be NXDOMAIN at authoritative DNS; the API answers on
  # the apex domain. Override the provider's base_url accordingly.
  export ORCHESTRA_PROVIDER_OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
  nohup "$orchestraDir/bin/orchestra" serve \
    --config "$orchestraDir/configs/orchestra.yaml" --addr 127.0.0.1:8080 \
    > "$logDir/orchestra.log" 2> "$logDir/orchestra.err" &
  disown

  : "${DAEMON_TOKEN:=devsecret}" ; export DAEMON_TOKEN
  export PORT=8097 ORCHESTRA_URL="http://127.0.0.1:8080" OPENSOCKET_MODEL="openai/gpt-4o"
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    export BUILTIN_BASE_URL="https://openrouter.ai/api/v1"
    export BUILTIN_API_KEY="$OPENROUTER_API_KEY"
    export BUILTIN_MODEL="openai/gpt-4o"
  fi
  nohup node "$repo/apps/daemon/src/index.ts" \
    > "$logDir/daemon-real.log" 2> "$logDir/daemon-real.err" &
  disown
  started="orchestra(real) :8080 | $started | daemon(real) :8097"
else
  echo "ORCHESTRA_DIR not set (or bin/orchestra missing) - starting the keyless demo only."
fi

node "$repo/scripts/mock-orchestra.ts" > "$logDir/mock-orchestra.log" 2> "$logDir/mock-orchestra.err" &
disown
node "$repo/scripts/mock-openai.ts" > "$logDir/mock-openai.log" 2> "$logDir/mock-openai.err" &
disown

export DAEMON_TOKEN="${DAEMON_TOKEN:-devsecret}"
export PORT=8098 ORCHESTRA_URL="http://127.0.0.1:8081"
# Keyless demo: pi talks to the local OpenAI-compatible mock via this config dir.
export PI_CODING_AGENT_DIR="$repo/demo/pi-agent" PI_OFFLINE=1
export OPENSOCKET_MODEL="mock/mock-gpt"
export BUILTIN_BASE_URL="http://127.0.0.1:8082/v1"
export BUILTIN_API_KEY="mock-not-needed" BUILTIN_MODEL="mock-gpt"
nohup node "$repo/apps/daemon/src/index.ts" \
  > "$logDir/daemon-mock.log" 2> "$logDir/daemon-mock.err" &
disown

# Wait (briefly) for the demo daemon to answer /health.
for _ in $(seq 1 25); do
  if curl -fsS http://localhost:8098/health > /dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "$started"
echo "logs: $logDir"
