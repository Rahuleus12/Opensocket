# Agent guide — OpenSocket

Read `PLAN.md` (architecture + decisions) and `docs/HANDOFF.md` (current
state + setup + backlog) before changing anything. RFC: `docs/rfc/0001-ossp.md`.

## Commands

```sh
npm install            # workspaces + dev deps (typescript, @types/node)
npm run typecheck      # tsc strict, must pass before any commit
npm run test:smoke     # full pipeline vs Orchestra contract double (no keys)
npm run test:pi        # live pi RPC check (needs `pi` on PATH, no model calls)
npm run test:builtin   # builtin agent vs the OpenAI mock (no keys)
npm run test:client    # @opensocket/client vs a real daemon + mock (no keys)
npm run dev:daemon     # run opensocketd (Node >= 24, native TS stripping)
npm run dev:mobile     # companion app vite dev server (:5173, against :8098)
npm run tauri:dev      # companion app in a native desktop window
npm run build:mobile   # vite production build (what `tauri build` embeds)
powershell -ExecutionPolicy Bypass -File scripts/dev-up.ps1    # full stack (Windows)
powershell -ExecutionPolicy Bypass -File scripts/dev-down.ps1  # stop it
scripts/dev-up.sh      # full stack (Linux/macOS; keyless demo if no ORCHESTRA_DIR)
scripts/dev-down.sh    # stop it
# On the Linux box: export TMPDIR=$HOME/tmp first (/tmp is a shared tmpfs
# that fills up; writes then fail with EDQUOT, "Unknown system error -122").
```

## Layout

- `apps/daemon/src/server.ts` — routing, SSE fan-out, permission routes
- `apps/daemon/src/harness.ts` — the harness seam (all engines normalize here)
- `apps/daemon/src/{pi,orchestra,builtin,opencode}.ts` — adapters
- `apps/daemon/src/store.ts` — JSONL persistence + snapshot fold
- `apps/daemon/src/approvals.ts` — shared R3 approval gate
- `apps/daemon/src/sse.ts` — shared SSE line parser
- `packages/protocol/` — OSSP types (additive-only, R1)
- `packages/client/` — framework-agnostic OSSP client (pairing/REST, WS
  hello-auth + snapshot/tail + auto-resume, SSE fallback); used by the
  Tauri companion app and shareable with the web UI
- `demo/pi-agent/` — pi config for keyless demos (models.json, approval ext)
- `apps/mobile/` — Tauri 2 companion app (ADR 0001): Preact/vite frontend on
  `@opensocket/client` + a thin Rust shell (no custom commands); desktop
  target verified via `cargo check` on this box
- `scripts/` — dev-up/down (Windows), mock-orchestra, mock-openai,
  gen-app-icon

## Hard rules

- **Providers are handled by harnesses** (R4): the daemon never calls model
  APIs; models are opaque harness-reported descriptors.
- **JSONL is the source of truth** (R2): `sessions/<id>/events.jsonl`.
- **OSSP is additive-only** (R1): clients must tolerate unknown events.
- **Approvals are first-class** (R3): side-effecting tools ask via
  `ApprovalGate` (builtin) or the loaded pi extension; deny/timeout blocks.
- **No secrets in the repo**: `.env` is gitignored and carries
  `OPENROUTER_API_KEY` etc. Never commit tokens.

## Windows gotchas (this codebase runs on Node type-stripping)

- No TypeScript parameter properties, enums, or namespaces (strip-only mode).
- `spawn("pi", ...)` needs `shell: true` on Windows (npm shim is pi.cmd);
  always handle the child `error` event or ENOENT hangs pending commands.
- `req.on("close")` fires after body consumption in Node >= 16 — cleanup on
  `res.on("close")` instead.
- Child processes started from Git Bash die with the shell; use
  `Start-Process` (scripts/dev-up.ps1), not nohup.

## Commits

Subject <= 50 chars, imperative, capitalized, no trailing punctuation.
Body only when it adds information, wrapped at 72.
