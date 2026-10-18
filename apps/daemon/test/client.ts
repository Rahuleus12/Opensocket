/**
 * @opensocket/client contract test (ADR 0001 step (a)): pairing + devices,
 * WS transport (snapshot, live events, approval round-trip), reconnect +
 * re-subscribe without duplicates, and the SSE fallback — against a real
 * daemon with the builtin harness on the OpenAI mock. Keyless, offline.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Envelope } from "@opensocket/protocol";
import type { Config } from "../src/env.ts";
import { startServer } from "../src/server.ts";
import { HttpError, OpenSocketClient } from "@opensocket/client";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const mockPort = await freePort();
const mock = spawn(process.execPath, ["scripts/mock-openai.ts"], {
  env: { ...process.env, MOCK_OPENAI_PORT: String(mockPort) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const dataDir = await mkdtemp(join(tmpdir(), "os-client-"));
const cfg: Config = {
  port: 0,
  daemonToken: "devsecret",
  opencodeUrl: "http://127.0.0.1:1",
  opencodePassword: "",
  orchestraUrl: "http://127.0.0.1:1",
  piBin: "pi",
  builtinBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
  builtinApiKey: "mock",
  builtinModel: "mock-gpt",
  dataDir,
  identityHeaders: [],
  identityEnforce: false,
};
const server = await startServer(cfg);
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function isAssistantDone(env: Envelope): boolean {
  return env.type === "message.completed" &&
    (env.payload as { role?: string }).role === "assistant";
}

try {
  // 1. connect: WS hello-auth with the dev token
  const c = new OpenSocketClient({ baseUrl, token: "devsecret" });
  const modes: string[] = [];
  c.on("transport", (m) => modes.push(m));
  await c.connect();
  assert.equal(c.transport, "ws");
  assert.ok(modes.includes("ws"));
  console.log("ok  connect -> ws");

  // 2. pairing: mint a code, pair a device, manage + revoke it
  const { code, expiresAt } = await c.mintPairingCode();
  assert.ok(code && new Date(expiresAt).getTime() > Date.now());
  const paired = await c.pair(code, "cli-test");
  assert.ok(paired.token.length > 20);

  const c2 = new OpenSocketClient({ baseUrl, token: paired.token });
  assert.ok((await c2.devices()).some((d) => d.name === "cli-test" && !d.revoked));
  await c.revokeDevice(paired.deviceId);
  await assert.rejects(
    () => c2.sessions(),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
  console.log("ok  pair + devices + revoke -> 401 for revoked token");

  // 3. create + subscribe + prompt: snapshot and live events over WS
  const envelopes: Envelope[] = [];
  c.on("envelope", (env) => envelopes.push(env));
  const { sessionId } = await c.createSession({
    harness: "builtin",
    model: "mock-gpt",
    workspace: "demo",
    name: "client test",
  });
  assert.ok(sessionId.startsWith("sess_"));
  const snap = await c.subscribe(sessionId);
  assert.equal(snap?.meta.harness, "builtin");
  assert.ok((snap?.lastSeq ?? 0) >= 1, "session.started(+updated) already logged");
  await c.prompt(sessionId, "Say OK");
  const done = await waitFor(
    () => envelopes.find(isAssistantDone),
    "assistant message.completed",
  );
  assert.match(String((done.payload as { text?: string }).text), /Hello from the mock/);
  await waitFor(() => envelopes.find((e) => e.type === "usage"), "usage");
  await waitFor(
    () => envelopes.find((e) => e.type === "status" && e.payload === "idle"),
    "idle",
  );
  console.log("ok  subscribe + prompt -> deltas/completed/usage/idle");

  // 4. approval round-trip through the client
  await c.prompt(sessionId, "!run echo client");
  const ask = await waitFor(
    () => envelopes.find((e) => e.type === "permission.request"),
    "permission.request",
  );
  const requestId = (ask.payload as { requestId?: string }).requestId as string;
  await c.respondPermission(sessionId, requestId, "allow_once");
  await waitFor(
    () =>
      envelopes.find(
        (e) =>
          e.type === "permission.resolved" &&
          (e.payload as { decision?: string }).decision === "allow_once",
      ),
    "permission.resolved",
  );
  const toolResult = await waitFor(
    () => envelopes.find((e) => e.type === "tool.result"),
    "tool.result",
  );
  assert.notEqual((toolResult.payload as { isError?: boolean }).isError, true);
  console.log("ok  permission round-trip");

  // 5. REST views: folded snapshot + session list
  const restSnap = await c.snapshot(sessionId);
  assert.ok(restSnap.messages.length >= 2);
  assert.ok((await c.sessions(true)).some((s) => s.sessionId === sessionId));
  await c.renameSession(sessionId, "renamed by client");
  assert.equal(
    (await c.snapshot(sessionId)).meta.name,
    "renamed by client",
  );
  console.log("ok  REST snapshot/list/rename");

  // 6. reconnect: drop -> auto-reconnect -> re-subscribe, no duplicate events
  const doneId = (done.payload as { messageId?: string }).messageId;
  let snapshots = 0;
  c.on("snapshot", () => {
    snapshots += 1;
  });
  c.dropConnection();
  await waitFor(
    () => (modes.filter((m) => m === "ws").length >= 2 ? true : undefined),
    "reconnect back to ws",
  );
  assert.ok(c.subscriptions().includes(sessionId), "subscription survives reconnect");
  await new Promise((r) => setTimeout(r, 600));
  const doneCount = envelopes.filter(
    (e) =>
      e.type === "message.completed" &&
      (e.payload as { messageId?: string }).messageId === doneId,
  ).length;
  assert.equal(doneCount, 1, "reconnect must not duplicate events");
  assert.ok(snapshots >= 1, "re-resume re-delivers a snapshot");
  console.log("ok  drop -> reconnect -> re-subscribe (snapshot, no dupes)");

  // 7. SSE fallback client: full replay + live events, REST prompt fallback
  const sse = new OpenSocketClient({ baseUrl, token: "devsecret", ws: false });
  assert.equal(sse.transport, "off");
  const sseEnvelopes: Envelope[] = [];
  sse.on("envelope", (env) => sseEnvelopes.push(env));
  const sseSnap = await sse.subscribe(sessionId);
  assert.equal(sseSnap, null, "SSE mode has no snapshot; state rebuilds by replay");
  await waitFor(
    () => sseEnvelopes.find(isAssistantDone),
    "SSE replay reaches stored history",
  );
  const before = sseEnvelopes.filter(isAssistantDone).length;
  await sse.prompt(sessionId, "Say OK again"); // no WS -> REST fallback
  await waitFor(
    () => (sseEnvelopes.filter(isAssistantDone).length > before ? true : undefined),
    "live SSE event after REST prompt",
  );
  await sse.unsubscribe(sessionId);
  await sse.close();
  console.log("ok  SSE fallback: replay + live + REST prompt");

  // 8. clean close
  await c.close();
  assert.equal(c.transport, "off");
  console.log("ok  close -> off");
} finally {
  mock.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
}

console.log("CLIENT_OK");
