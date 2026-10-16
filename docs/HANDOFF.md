# Handoff — working on OpenSocket from a fresh PC

This file + `AGENTS.md` + `PLAN.md` are all the context needed to continue.
Last updated: 2026-10-14.

## State at a glance

Everything below is **implemented and verified live** on the authoring PC:

- **opensocketd** (Node >= 24, TypeScript, no runtime-specific APIs): HTTP +
  SSE per-session fan-out with replay, JSONL persistence
  (`~/.opensocket/sessions/<id>/events.jsonl`), restart recovery, snapshot
  folding, session create/list/prompt/permission/interrupt/snapshot routes,
  shared bearer-token auth (`DAEMON_TOKEN`, M0 stopgap).
- **harness-pi** (`@earendil-works/pi-coding-agent` v1.2.0, global install):
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
- **harness-opencode**: WIP stub — needs an opencode install to verify its
  server API (routes/event names are TODOs in `apps/daemon/src/opencode.ts`).
- **Web UI** (`apps/daemon/public/index.html`, served at `/`): rendered
  transcript, tool cards, approval cards, status/usage pills, session picker,
  composer with send/stop. Token = Bearer header, entered in the header.
- **Tests**: `test:smoke` (pipeline vs Orchestra double), `test:pi` (RPC
  protocol, offline), `test:builtin` (streaming, usage, history, tool
  denial + auto-allowed read). All green at handoff time.

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
6. **Start**: `powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1`
   (set `ORCHESTRA_DIR` env first if your Orchestra checkout is elsewhere).
7. **Use**: http://localhost:8097 (real — needs the key) and
   http://localhost:8098 (keyless demo: pi + builtin against local mocks).
   Token for both: `devsecret`. Stop: `scripts/dev-down.ps1`.

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
  what scripts/dev-up.ps1 (Start-Process) solves.

## Decisions already made (do not relitigate without an ADR)

- Providers live entirely inside harnesses (R4); daemon is provider-blind.
- JSONL event log is the only source of truth (R2); snapshots are derived.
- oh-my-pi: evaluated, deferred (duplicates daemon-level orchestration).
- Bun: deferred; code stays runtime-agnostic, Node 24 type-stripping runs it.
- Tailscale: deferred by user choice; localhost/LAN now, tailnet later
  (`tailscale serve` + pairing is designed in PLAN §4.4).
- opencode adapter stays a stub until verified against a real install.

## Backlog — next work, in priority order

1. ~~**Notifications (M2)**~~ — **done**: `apps/daemon/src/notify.ts`
   (`NTFY_URL`/`NTFY_TOKEN`), hooked on the daemon's emit path so every
   harness is covered: permission.request (high), error (high), and
   status-idle (cooldown 15s). Tested in `test:notify`.
2. **opencode adapter verification (M1 close-out)**: `npm i -g opencode-ai`,
   run `opencode serve`, fill the TODO table in
   `apps/daemon/src/opencode.ts` (routes + event mapping), add a protocol
   test like test:pi.
3. **M1 auth**: replace `DAEMON_TOKEN` with pairing (QR + per-device tokens
   bound to tailnet identity) and WebSocket transport alongside SSE
   (PLAN §4.4, RFC §3).
4. **builtin: provider-context rebuild** from the JSONL fold on daemon
   restart (messages already exist in the log; repopulate `history`).
5. **builtin: `fetch` tool** (web_get, gated) and `ls` glob support.
6. **UI session drawer**: workspaces, rename/archive, per-session cost
   totals; wide layout.
7. **Tailscale wiring (M1)**: `tailscale serve` doc + pairing flow
   (PLAN §4.4); the companion app (Expo) starts after pairing exists.
8. **Orchestra upstream**: the provider/error patches are pushed to
   `Rahuleus12/Orchestra` (`0dab960`); consider a PR upstream if published.
9. **Compaction** for long sessions (RFC §9) once real usage shows the need.

## Verification checklist for a new machine

```sh
npm run typecheck && npm run test:smoke && npm run test:pi && npm run test:builtin
powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1
curl -s http://localhost:8098/health
# then in a browser: http://localhost:8098 (token devsecret)
#   - new session, harness builtin, model mock-gpt -> prompt -> streams
#   - new session, harness pi      -> prompt -> streams
# on :8097 with a funded key or a :free model: prompt -> approval card -> allow
```
