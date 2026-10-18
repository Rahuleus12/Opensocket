# Handoff — working on OpenSocket from a fresh PC

This file + `AGENTS.md` + `PLAN.md` are all the context needed to continue.
Last updated: 2026-10-19.

## State at a glance

Everything below is **implemented and verified live** on the authoring PC:

- **opensocketd** (Node >= 24, TypeScript, no runtime-specific APIs): HTTP +
  SSE per-session fan-out with replay + **WebSocket transport** (`/ws`, hello-
  auth, envelope requests with ok/error replies, snapshot + tail on resume),
  JSONL persistence (`~/.opensocket/sessions/<id>/events.jsonl`), restart
  recovery, snapshot folding, session create/list/prompt/permission/interrupt/
  snapshot routes.
- **Auth (M1)**: per-device revocable tokens via pairing — the daemon prints a
  single-use 6-word code on first boot; `POST /api/pair` mints a hashed,
  revocable device token (list/revoke routes, brute-force throttle). The shared
  `DAEMON_TOKEN` remains as the dev-only quick start. Optional proxy-identity
  binding (`OPENSOCKET_IDENTITY_HEADERS` + `…_ENFORCE`) for `tailscale serve`
  fronting. Tested in `test:auth` and `test:ws`.
- **harness-pi** (`@earendil-works/pi-coding-agent`, global install — v1.3.0
  on the Linux box, v1.2.0 on the authoring Windows PC; protocol unchanged):
  `pi --mode rpc` child per session, LF-framed JSONL, deltas/tools/usage →
  OSSP, interrupt via `abort`, **resumable** (`--session-id`/`--session-dir`,
  id in `session.started.remoteSessionId`), **approvals** via loaded extension
  (`opensocket-approval.js` — every tool_call asks the daemon → client).
- **harness-builtin**: daemon-native agent loop on any OpenAI-compatible
  endpoint. Tools `read`/`ls` (workspace-rooted, auto-allowed) and
  `write`/`bash` (gated through `ApprovalGate`), 5-turn tool loop, in-memory
  history. Defaults to the env's OpenRouter key when present, else the mock.
- **harness-orchestra**: drives Orchestra's server (`POST /v1/agents`,
  `/v1/agents/{id}/stream` SSE). Contract-verified; live runs need Orchestra
  to have a working provider (see patches below).
- **harness-opencode**: verified against `opencode serve` v2.0.32 (see
  `apps/daemon/src/opencode.ts` header for the live-checked contract):
  v2 HTTP API under `/api/*`, HTTP Basic auth (user `opencode`, password from
  the server's `OPENCODE_PASSWORD` env), one shared `/api/event` SSE bus
  demuxed by session id, session-level ask-rules deliver R3 approvals
  (`permission.asked` → OSSP `permission.request`, reply `once|always|reject`).
  Tested in `test:opencode` (spawns an isolated server + the OpenAI mock;
  keyless, offline).
- **Session logs (PLAN §4.6)**: every session renders a derived plain-text
  `session.log` next to its JSONL (`ssh host -- tail -f …` with no client);
  `npm run tail -- <sessionId>` follows it locally and regenerates it if
  missing. JSONL stays authoritative; logs rebuild on daemon startup.
- **packages/client (ADR 0001 step a)**: `@opensocket/client`, framework-
  agnostic OSSP client — pairing/devices/sessions REST, WS transport
  (hello-auth, envelope RPC, snapshot + tail, auto-reconnect + re-subscribe
  with per-reconnect snapshots, client-side unsubscribe filtering), SSE
  fallback (full replay), WS-down-only HTTP fallback for RPC (never
  re-submits a sent prompt). Runtime contract: any JS runtime with
  fetch + WebSocket (browser, Tauri webview, Node >= 22); structural typings
  so it compiles under DOM lib or @types/node. Tested in `test:client`.
- **apps/mobile (ADR 0001 step b, scaffolded)**: Tauri 2 shell (identifier
  `dev.opensocket.mobile`, no custom Rust commands — the webview speaks OSSP
  directly) + Preact/vite frontend on `@opensocket/client`: setup screen
  (URL + token or pair-with-code), session drawer, streaming transcript,
  approval cards, composer; reconnects re-render from the re-delivered
  snapshot. Daemon gained CORS (OPTIONS preflight + allow-origin; auth stays
  Bearer, so "*" relaxes nothing) — needed by the tauri://localhost origin,
  tested in `test:client`. Verified on this box: `vite build`,
  `tsc -p apps/mobile`, `cargo check` (1m07s cold). Icons: full set from
  `scripts/gen-app-icon.ts` via `tauri icon`. Not yet: real-device walkthrough,
  iOS CI (needs macOS + Apple Developer Program).
- **iOS on Linux (ADR 0001 amendment, xtool)**: `apps/mobile/ios` is a
  SwiftPM shell (SwiftUI + WKWebView loading the bundled `www/` from the
  same vite frontend; ATS exception in its Info.plist) built by
  `scripts/build-ios.sh` (swift:6.4.1-noble container + the xtool AppImage,
  extracted once to avoid FUSE; seccomp=unconfined; real stdin pipe — see
  the script comments for why). Pipeline verified to the SDK gate; needs
  from the user: Xcode 27 `.xip` (browser + Apple ID), then one
  `scripts/build-ios.sh sdk-install`; `xtool auth` only for signing/device
  install. macOS CI stays for hands-off TestFlight.
- **Web UI** (`apps/daemon/public/index.html`, served at `/`): rendered
  transcript, tool cards, approval cards, status/usage pills, session picker,
  composer with send/stop, **pair-with-code + device management**, and a
  WS-first transport (SSE fallback). Token = Bearer header / WS hello,
  entered in the header or paired.
- **Tests**: `test:smoke` (pipeline vs Orchestra double), `test:pi` (RPC
  protocol, offline), `test:opencode` (isolated server + mock), `test:builtin`
  (streaming, usage, history, tool denial + auto-allowed read), `test:auth`
  (pairing/revocation/identity), `test:ws` (WS transport), `test:notify`,
  `test:restore`. All green at handoff time.

## Fresh-PC setup

1. **Prerequisites**: Node >= 24 (type-stripping), Git. Optional: Go >= 1.25
   (only to rebuild Orchestra), OpenRouter account.
2. `git clone https://github.com/Rahuleus12/redesigned-goggles && npm install`
3. `npm install -g @earendil-works/pi-coding-agent` (gives `pi` on PATH).
4. **Orchestra** (the multi-agent engine, separate repo:
   `github.com/Rahuleus12/Orchestra`, branch `master`):
   `git clone`, then `go -C <dir> build -o bin/orchestra.exe ./cmd/orchestra`.
   The build **must include the provider-linking patch** (commit `0dab960`) —
   without it, every provider fails with "not linked in this build".
5. **Keys**: create `.env` in the repo root (gitignored):
   ```
   OPENROUTER_API_KEY=sk-or-v1-...
   ```
   Rotate the old key — it appeared in chat. Free models (id suffix `:free`)
   work even on a $0-limit key and DO support tool calls
   (e.g. `nvidia/nemotron-3-super-120b-a12b:free`).
6. **Start**: Windows: `powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1`;
   Linux/macOS: `scripts/dev-up.sh` (set `ORCHESTRA_DIR` first if your
   Orchestra checkout is elsewhere; without it the script starts the keyless
   demo stack only and says so). Stop: `scripts/dev-down.ps1` / `.sh`.
7. **Use**: http://localhost:8097 (real — needs the key) and
   http://localhost:8098 (keyless demo: pi + builtin against local mocks).
   Token for both: `devsecret`.

## Ports and processes (dev-up)

| Port | Thing |
|------|-------|
| 8080 | Orchestra (real binary) |
| 8081 | mock-orchestra (contract double) |
| 8082 | mock-openai (OpenAI-compatible, feeds pi demo + builtin demos) |
| 8097 | daemon → real Orchestra / real provider keys |
| 8098 | daemon → mocks (fully keyless demo) |

Logs: `%TEMP%\opensocket\`.

## Environment gotchas (learned the hard way)

- `api.openrouter.ai` was NXDOMAIN at authoritative DNS during development;
  the API answers on the apex `https://openrouter.ai/api/v1`. dev-up sets
  `ORCHESTRA_PROVIDER_OPENROUTER_BASE_URL` accordingly. Re-check if 403/DNS
  errors appear.
- Orchestra upstream had two bugs; **both are patched and pushed** (commit
  `0dab960`): providers were never linked in server mode, and agent error
  events serialized without their message (`json:"-"`).
- The first OpenRouter key had a `$0.00 of $0.00` limit → HTTP 403 on every
  call. Free (`:free`) models bypass the limit.
- pi does startup network ops (model catalogs) unless `PI_OFFLINE=1`; on
  DNS-restricted networks that hang. dev-up sets it for the demo daemon; the
  protocol test sets it too.
- Git Bash `nohup ... &` does NOT survive shell exit on Windows — that is
  what scripts/dev-up.ps1 (Start-Process) solves. On real Linux `nohup … &
  disown` is fine (scripts/dev-up.sh relies on it).
- **Linux box (this machine, since 2026-10-18)**: shared box that also runs
  Jenkins; `/tmp` is a small tmpfs others fill up (a stray Swift toolchain
  hit it). Full tmpfs surfaces as `Unknown system error -122` (= EDQUOT)
  inside the daemon and fails the tests with cryptic assertion errors —
  export `TMPDIR=$HOME/tmp` before running tests/dev-up.sh here. Verified
  green on this box: typecheck + all 9 test suites (incl. test:client since
  2026-10-19), Node 26.11, pi 1.3.0,
  opencode 2.0.32, cargo 1.96 (ADR 0001 desktop target).

## Decisions already made (do not relitigate without an ADR)

- Providers live entirely inside harnesses (R4); daemon is provider-blind.
- JSONL event log is the only source of truth (R2); snapshots are derived.
- oh-my-pi: evaluated, deferred (duplicates daemon-level orchestration).
- Bun: deferred; code stays runtime-agnostic, Node 24 type-stripping runs it.
- **Transport is user infrastructure** (user decision): the daemon is
  transport-agnostic HTTP + tokens; we ship connection recipes (LAN,
  Tailscale, SSH, VPS), never VPN/tunnel code. The product piece kept from
  the Tailscale plan is transport-neutral auth: pairing + per-device
  revocable tokens (replaces the shared devsecret).
- opencode adapter stays a stub until verified against a real install.
- **Compaction is harness-owned**: the daemon never summarizes, folds, or
  rewrites provider context; each harness manages its own window (pi natively,
  builtin in its loop). Snapshots are derived views, never mutations (R2+R4).
- **Orchestra is a separate project**: own repo, own roadmap and backlog;
  OpenSocket consumes it only via the `harness-orchestra` adapter and its
  documented HTTP contract.

## Backlog — next work, in priority order

1. ~~**Notifications (M2)**~~ — **done**: `apps/daemon/src/notify.ts`
   (`NTFY_URL`/`NTFY_TOKEN`), hooked on the daemon's emit path so every
   harness is covered: permission.request (high), error (high), and
   status-idle (cooldown 15s). Tested in `test:notify`.
2. ~~**opencode adapter verification (M1 close-out)**~~ — **done**: adapter
   implemented + `test:opencode` protocol test (spawn isolated
   `opencode serve` with a mock provider; create/stream/tool/approval
   allow+deny/interrupt all verified). Gotchas learned: v2 tools were renamed
   (`bash`→`shell`, `task`→`subagent`), permission actions use tool names,
   session-level ask-rules append after agent defaults and win (findLast),
   prompt message ids must be `msg_*` + globally unique in the server's
   durable store, and the web UI/SDK route sets differ from the server's
   (`/api/*` on the server).
3. ~~**M1 auth**~~ — **done**: pairing (single-use 6-word code printed at
   startup or minted by a paired device) + per-device revocable tokens
   (`devices.json`, hashed), WebSocket transport (`/ws`, hello-auth, envelope
   requests, snapshot+tail resume; hand-rolled RFC 6455 in `src/ws.ts` — no
   deps), brute-force throttle, optional proxy-identity enforcement, web UI
   pair/devices management + WS-first transport with SSE fallback. The QR of
   the pair code is deferred to the Expo app (it can render one of the pair
   URL); the daemon ships the code + REST surface now. Tested in `test:auth`
   and `test:ws`.
4. ~~**builtin: provider-context rebuild**~~ — **done**: optional
   `restoreSession(meta, messages)` on the harness seam; the daemon calls it
   on startup with the folded messages. builtin rebuilds its conversation
   (system prompt now persisted in `session.started.system`); pi silently
   respawns its RPC child from `remoteSessionId`. Tested in `test:restore`
   (provider sees full history after restart; unrestored control sees 1).
5. ~~**builtin: `fetch` tool**~~ — **done**: gated `fetch(url)` with SSRF
   guards (scheme allowlist, hostname patterns, DNS-resolved private-IP
   refusal — policy runs before the approval prompt; deny/timeout blocks).
   `BUILTIN_FETCH_ALLOW_LOCAL=1` is the dev escape hatch for local URLs.
   `ls` gained an optional `glob` (stdlib glob→regex). Tested in `test:builtin`.
6. ~~**UI session drawer**~~ — **done**: workspaces, rename/archive,
   per-session token/cost totals, wide layout (commit `affc404`), plus device
   management and pair-with-code in the M1 pass.
7. ~~**Connection recipes doc**~~ — **done**: `examples/connect.md` (LAN,
   Tailscale + WhoIS identity, SSH tunnel, VPS + TLS with Caddy/nginx
   snippets) + `examples/opensocketd.service` (systemd, hardened). Docs only,
   no code (see the transport decision above). Companion app (Expo) can start
   — pairing exists.
8. ~~**Orchestra upstream**~~ — **out of scope**: Orchestra is a separate
   project (own repo, own backlog); this repo only consumes it through the
   `harness-orchestra` adapter. The provider/error patches live in
   `Rahuleus12/Orchestra` (`0dab960`) and are tracked there.
9. ~~**Compaction** for long sessions~~ — **decided, harness-owned**:
   compaction is context management, and context management belongs to the
   harness (R4) — pi compacts its own sessions; `harness-builtin` would do
   loop-level compaction itself if usage ever demands it. The daemon never
   folds or rewrites conversation state; JSONL stays append-only (R2).
10. **Companion app (Tauri 2 — ADR 0001)**: stack decided (owner rejected
    Expo; Dioxus declined for v1; Flutter = fallback). Order of work:
    (a) ~~`packages/client` — framework-agnostic OSSP client (pairing REST +
    WS hello/snapshot/tail + SSE fallback), shared with the web UI~~ —
    **done**: `@opensocket/client` + `test:client` (pair/revoke, WS snapshot
    + live events + approval round-trip, reconnect dedupe, SSE fallback);
    (b) `apps/mobile` — Tauri 2 shell + Preact/vite frontend, developed on
    Linux against the keyless demo daemon (:8098), desktop target works on
    this box (cargo 1.96 + webkit2gtk-4.1 present) — **scaffolded, see the
    state-at-a-glance bullet above**; next: real-use polish (markdown/diff
    rendering, session drawer metadata, long-list scroll check);
    (c) CI — GitHub Actions `macos-15` job for `tauri ios build` → TestFlight
    (needs Apple Developer Program; no iOS toolchain on Linux for any stack).

## Verification checklist for a new machine

```sh
npm run typecheck && npm run test:smoke && npm run test:pi && npm run test:opencode && npm run test:builtin && npm run test:auth && npm run test:ws && npm run test:client
npm run build:mobile             # companion frontend (vite + tsc)
(cd apps/mobile/src-tauri && cargo check)  # companion Rust shell
# Windows: powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1
# Linux/macOS (this box: export TMPDIR=$HOME/tmp first): scripts/dev-up.sh
curl -s http://localhost:8098/health
# then in a browser: http://localhost:8098 (token devsecret)
#   - new session, harness builtin, model mock-gpt -> prompt -> streams
#   - new session, harness pi      -> prompt -> streams
# on :8097 with a funded key or a :free model: prompt -> approval card -> allow
```
