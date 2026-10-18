# @opensocket/client

Framework-agnostic OSSP client (ADR 0001): pairing + device management and
session RPC over REST, event streaming over WebSocket (hello-auth, snapshot +
tail, auto-resume) with the daemon's SSE endpoint as fallback.

Runs in any JS runtime with `fetch` + `WebSocket` — browsers, the Tauri 2
webview (`apps/mobile`), Node >= 22, Deno, Bun. No `node:*` imports, no
framework, no dependencies beyond `@opensocket/protocol` types.

## Usage

```ts
import { OpenSocketClient } from "@opensocket/client";

const client = new OpenSocketClient({
  baseUrl: "https://daemon.example",   // or http://localhost:8098 on LAN
  token: "…device token…",
});

// listen before connecting
client.on("transport", (mode) => console.log("transport:", mode));   // ws | sse | off
client.on("snapshot", (sid, snap) => renderAll(snap));                // initial + every reconnect
client.on("envelope", (env) => renderEvent(env));                     // live OSSP events
client.on("error", (err, sid) => console.warn(err, sid));

await client.connect();                       // WS hello-auth; stays "off" if it fails

// pairing (code printed by the daemon, or minted by a paired device)
const { token } = await client.pair(code, "my phone");
client.setToken(token);                       // reconnects the socket

// sessions
const { sessionId } = await client.createSession({ harness: "pi", workspace: "demo" });
const snap = await client.subscribe(sessionId);   // snapshot over WS; null on SSE (full replay)
await client.prompt(sessionId, "fix the failing test");
await client.respondPermission(sessionId, requestId, "allow_once");
await client.interrupt(sessionId);

// REST-only surface
await client.sessions(true);
await client.snapshot(sessionId);
await client.renameSession(sessionId, "fix auth");
await client.mintPairingCode();
await client.devices();
```

## Transport behavior

- **WS (default)**: `ws(s)://host/ws`, first frame `{"type":"hello","payload":{"token":…}}`.
  Requests are envelopes with `ok`/`error` replies; `session.resume` returns a
  snapshot + stored tail; the server-side seq guard prevents duplicates.
  Drops auto-reconnect (default 1.5 s) and re-resume every subscribed session,
  so listeners get a fresh `snapshot` per session after each reconnect.
- **SSE fallback**: `GET /sse/{id}` replays the whole stored log then tails
  live. There is no resume-from-seq, so state is rebuilt by replay — resolve
  value of `subscribe()` is `null` in this mode.
- **RPC fallback**: when the WS is down, `createSession`/`prompt`/`interrupt`/
  `respondPermission` use the REST routes. A request that *was* sent over WS
  is never retried over HTTP (no double prompts).

## Contract tests

`npm run test:client` (spawns a real daemon + the OpenAI mock; keyless)
covers pairing/revocation, WS snapshot + live events, a full approval
round-trip, reconnect + re-subscribe dedupe, and the SSE fallback.
