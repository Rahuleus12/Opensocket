# OpenSocket

Open-source alternative to Claude Cowork: agents on your machine, open
harnesses (pi, Orchestra, OpenCode, DeepSeek/Ollama via the builtin), driven
from a pleasant companion app over **your own network** — Tailscale, LAN,
tunnel, or a hosted box; connection recipes included, no VPN code. See
[PLAN.md](PLAN.md).

**Status:** M0/M2. Harnesses are the session engines — **pi** (coding agent,
RPC, approvals + resumable sessions), **Orchestra** (multi-agent workflows,
contract-tested), **builtin** (direct-to-provider chat: OpenRouter, DeepSeek,
Ollama, or the local mock), and **opencode** (adapter WIP); `opensocketd` is
the auth + translation bridge with JSONL persistence. Runs on Node ≥ 24
(native TS stripping) — Bun-compatible, no runtime-specific APIs.

## Layout

- `docs/rfc/0001-ossp.md` — OSSP wire/persistence protocol (draft)
- `packages/protocol/` — OSSP TypeScript types
- `apps/daemon/` — `opensocketd` v0: SSE fan-out, JSONL store, harness adapters
  (`src/orchestra.ts`, `src/pi.ts`, `src/opencode.ts` WIP), tests in `test/`
- `PLAN.md` — architecture, roadmap, decisions

## Run (M0)

Requires Node ≥ 24 and a running Orchestra server (`orchestra serve`).

```sh
npm install
DAEMON_TOKEN=devsecret ORCHESTRA_URL=http://127.0.0.1:8080 npm run dev:daemon
curl localhost:8097/health
```

## Test

```sh
npm run test:smoke    # full pipeline vs an Orchestra contract test double
npm run test:pi       # live pi RPC protocol check (needs `pi` on PATH)
npm run test:builtin  # built-in agent vs the OpenAI mock
npm run typecheck
```

## Dev stack (no Tailscale needed)

```sh
powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1   # start
powershell -ExecutionPolicy Bypass -File scripts/dev-down.ps1  # stop
```

| Service | URL | Notes |
|---|---|---|
| Web UI (real) | http://localhost:8097 | token: `devsecret`; Orchestra path needs a provider key |
| **Web UI (keyless demo)** | **http://localhost:8098** | **pi sessions stream from the local OpenAI mock — no keys, works offline** |
| Orchestra (real) | http://localhost:8080 | `orchestra.exe serve` |
| Orchestra (mock) | http://localhost:8081 | contract test double |
| OpenAI mock | http://localhost:8082 | feeds pi on the demo daemon (`demo/pi-agent/models.json`) |

Logs: `%TEMP%\opensocket\`. Set `OPENAI_API_KEY` etc. before `dev-up` and the
real daemon streams for real. Token entry lives in the UI header (stored in
localStorage); it is sent as a Bearer header, never a URL parameter.

`PI_TOOLS=read,ls,grep,find` (set before `dev-up`) restricts the pi harness
to read-only tools at spawn time; default is all tools.

**Push notifications:** put `NTFY_URL=https://ntfy.sh/<your-topic>` in `.env`
(and `NTFY_TOKEN` for authenticated self-hosted servers), subscribe the ntfy
app to that topic, and the daemon pushes **approval requests**, **errors**,
and **task finished** (15s cooldown) for every harness.

| Env var          | Default                  | Purpose                        |
|------------------|--------------------------|--------------------------------|
| `PORT`           | `8097`                   | Daemon listen port             |
| `DAEMON_TOKEN`   | _(unset = open, dev)_    | Bearer token (M0 stopgap)      |
| `ORCHESTRA_URL`  | `http://127.0.0.1:8080`  | `orchestra serve` base URL     |
| `OPENCODE_URL`   | `http://127.0.0.1:4096`  | `opencode serve` base URL      |
| `NTFY_URL`       | _(unset = off)_          | ntfy topic URL for pushes      |
| `NTFY_TOKEN`     | _(unset)_                | Bearer token (self-hosted ntfy)|
| `OPENSOCKET_DATA`| `~/.opensocket`          | JSONL session storage root     |

## Typecheck

```sh
npm run typecheck
```
