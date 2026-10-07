# OpenSocket

Open-source alternative to Claude Cowork: agents on your machine, open
harnesses (OpenCode, pi, DeepSeek/Ollama via the builtin), driven from a
pleasant mobile companion app over Tailscale. See [PLAN.md](PLAN.md).

**Status:** M0. Harnesses are the session engines — **Orchestra** (validated,
contract-tested) and **opencode** (adapter WIP); `opensocketd` is the auth +
translation bridge with JSONL persistence. Runs on Node ≥ 24 (native TS
stripping) — Bun-compatible, no runtime-specific APIs.

## Layout

- `docs/rfc/0001-ossp.md` — OSSP wire/persistence protocol (draft)
- `packages/protocol/` — OSSP TypeScript types
- `apps/daemon/` — `opensocketd` v0: SSE fan-out, JSONL store, harness adapters
  (`src/orchestra.ts` validated, `src/opencode.ts` TODO), smoke test in `test/`
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
npm run test:smoke   # full pipeline vs an Orchestra contract test double
npm run typecheck
```

| Env var          | Default                  | Purpose                        |
|------------------|--------------------------|--------------------------------|
| `PORT`           | `8097`                   | Daemon listen port             |
| `DAEMON_TOKEN`   | _(unset = open, dev)_    | Bearer token (M0 stopgap)      |
| `ORCHESTRA_URL`  | `http://127.0.0.1:8080`  | `orchestra serve` base URL     |
| `OPENCODE_URL`   | `http://127.0.0.1:4096`  | `opencode serve` base URL      |
| `OPENSOCKET_DATA`| `~/.opensocket`          | JSONL session storage root     |

## Typecheck

```sh
npm run typecheck
```
