# ADR 0001 — Companion app stack: Tauri 2, not Expo/Dioxus/Flutter-native

- **Status:** Accepted (supersedes the Expo choice in PLAN §4.5)
- **Date:** 2026-10-18
- **Deciders:** project owner (explicit no-Expo call) + research pass below

## Context

PLAN §4.5 originally chose Expo/React Native for the iOS/Android companion
app. The owner rejected Expo. Candidate stacks: Dioxus, Tauri, Flutter
(and the Expo status quo). The app is a **reading surface** (RFC/PLAN §4.5):
streaming markdown, code blocks, diff/tool/approval cards, a composer, a
session drawer — over OSSP (HTTP + WebSocket + JSON envelopes, RFC 0001) to a
daemon the user runs on their own network (LAN / Tailscale / SSH / VPS).
Notifications are delegated to self-hostable ntfy, so the app itself does not
need APNs/FCM plumbing for v1.

Versions compared (fetched 2026-10-18): Tauri 2.12.4 stable (37.3M downloads,
v3 alpha.5 in progress), Dioxus 0.7.10, Flutter stable 3.47.7.

## Options considered

### Dioxus 0.7 — declined for v1
Active (0.7.10, Oct 2026) but still 0.x with the youngest mobile story of the
three. Mobile renders in the same WKWebView wrapper (wry) that Tauri uses, so
the native-feel argument over Tauri is moot; what differs is the ecosystem:
no plugin workspace comparable to Tauri's (barcode scanning, secure storage,
deep links), thinnest docs, and Rust for the entire UI layer — a real
velocity cost for a TS-dominant, single-maintainer repo. Markdown/diff
rendering would be rebuilt in RSX or inside the same webview Tauri gives us
anyway. Revisit for a Rust desktop/tray companion later.

### Flutter 3.47 — strong runner-up, not chosen
The most mature mobile runtime here: own renderer, best long-list/performance
and platform-integration story, excellent hot reload. Costs: introduces Dart
as a third language; the app cannot share protocol/client code with the daemon
(types get hand-ported); the markdown/syntax-highlight package story is
post-`flutter_markdown` discontinuation (community forks); and iOS builds
still require macOS, so it does not remove the toolchain constraint that
shapes everything below. Keep as the fallback if we ever hit webview ceilings
(scrolling performance of very long sessions is the plausible one).

### Expo / React Native — rejected by owner
Explicit. Recorded here so the decision has a paper trail; no technical
relitigation.

### Tauri 2 — **chosen**
- Mobile stable since 2.0 (Oct 2024) → two years of 2.x hardening by now;
  iOS/Android from one codebase, `wry`/WKWebView on iOS.
- Frontend is ordinary web TypeScript: OSSP types (`packages/protocol`) and
  the planned OSSP client (`packages/client`) are **shared verbatim** between
  the in-daemon web UI, the app, and any future web PWA (PLAN M3). The Rust
  surface is a thin generated shell plus config — app logic stays TS.
- Plugin workspace covers our v1 needs: barcode scanner (pairing QR), local
  notifications (in-app + ntfy topic notifications arrive via the ntfy app
  regardless), secure storage (device token), deep links.
- A reading surface is precisely the workload WKWebView handles well; native
  rendering buys little here and costs the reuse above.

## Constraints that hold for every option

- **iOS builds require macOS/Xcode.** None of the three can produce an iOS
  artifact on the Arch Linux dev box. The plan: develop the frontend as a
  plain web app on Linux (vite) against the keyless demo daemon (:8098);
  build iOS in CI on a GitHub Actions `macos-15` runner (free for public
  repos) via `tauri ios build`; distribute via TestFlight (requires the
  Apple Developer Program, $99/yr — unavoidable under every framework).
- **Cleartext LAN HTTP needs an ATS exception** in Info.plist (or use
  `tailscale serve` for real TLS, the recommended recipe — examples/connect.md).
  Device tokens are high-entropy and pairing codes are single-use, but TLS is
  still the right default outside the home LAN.
- Android falls out of the same Tauri codebase when wanted (helps the
  FOSS/UnifiedPush story later).

## Decision

Build the companion app as a **Tauri 2 iOS app with a TypeScript web
frontend** (Preact or vanilla TS + vite), sharing `packages/protocol` and a
new framework-agnostic `packages/client` (OSSP pairing + WS + snapshot
client) with the daemon's web UI. Flutter remains the documented fallback;
Dioxus is declined for v1.

## Consequences

- `packages/client` becomes the next shared foundation (also useful to the
  web UI and a future CLI).
- `apps/mobile` = Tauri shell + vite frontend; desktop target gives a free
  Linux/macOS/Windows companion for development.
- CI: add a macOS runner job for iOS builds once the shell exists; Linux CI
  keeps running the daemon/test suite.
- If long-session scroll performance or platform depth ever forces the issue,
  the OSSP protocol keeps a native Swift rewrite viable (transport-level
  auth, JSONL replay) — the same escape hatch the plan always kept open.

## References

- PLAN §4.5 (UI spec — unchanged by this ADR), §9 Open Questions
- docs/rfc/0001-ossp.md (protocol the app speaks)
- examples/connect.md (transport recipes the app will use)
