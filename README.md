# OpenSocket

Open-source alternative to Claude Cowork: agents on your machine, open
harnesses (OpenCode, pi, DeepSeek/Ollama via the builtin), driven from a
pleasant mobile companion app over Tailscale. See [PLAN.md](PLAN.md).

**Status:** M0 scaffolding. `opencode serve` is the v0 session engine;
`opensocketd` is a thin auth + translation bridge in front of it.

## Layout

- `docs/rfc/0001-ossp.md` — OSSP wire/persistence protocol (draft)
- `packages/protocol/` — OSSP TypeScript types
- `apps/daemon/` — `opensocketd` v0 (SSE fan-out, JSONL store, opencode bridge)
- `PLAN.md` — architecture, roadmap, decisions

## Run (M0)

Requires [Bun](https://bun.sh) and a running `opencode serve`.

```sh
npm install
DAEMON_TOKEN=devsecret OPENCODE_URL=http://127.0.0.1:4096 bun run dev:daemon
curl localhost:8097/health
```

| Env var          | Default                  | Purpose                       |
|------------------|--------------------------|-------------------------------|
| `PORT`           | `8097`                   | Daemon listen port            |
| `DAEMON_TOKEN`   | _(unset = open, dev)_    | Bearer token (M0 stopgap)     |
| `OPENCODE_URL`   | `http://127.0.0.1:4096`  | `opencode serve` base URL     |
| `OPENSOCKET_DATA`| `~/.opensocket`          | JSONL session storage root    |

## Typecheck

```sh
npm run typecheck
```
