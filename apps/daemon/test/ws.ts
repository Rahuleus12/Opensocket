/**
 * M1 WebSocket transport test (RFC §3): hello-auth, request envelopes with
 * ok/error replies, session.create/resume (snapshot + tail), live events,
 * permission round-trip, and large-frame handling — against a real daemon
 * with the builtin harness on the OpenAI mock.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Config } from "../src/env.ts";
import { startServer } from "../src/server.ts";

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

const dataDir = await mkdtemp(join(tmpdir(), "os-ws-"));
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

interface Frame {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Promise-based WS client on the built-in browser-style WebSocket. */
class TestClient {
  ws: WebSocket;
  frames: Frame[] = [];
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  closed: number | null = null;
  private reqSeq = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      let f: Frame;
      try {
        f = JSON.parse(String(ev.data)) as Frame;
      } catch {
        return;
      }
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(f)) {
          w.resolve(f);
          return false;
        }
        return true;
      });
    };
    this.ws.onclose = (ev: CloseEvent) => {
      this.closed = ev.code;
    };
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws error"));
    });
  }

  send(type: string, payload: Record<string, unknown>): string {
    const id = `req_${++this.reqSeq}`;
    this.ws.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 30_000): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${what}; got ${this.frames.map((f) => f.type).join(",")}`)),
        timeoutMs,
      );
      this.waiters.push({
        pred: (f) => {
          if (pred(f)) {
            clearTimeout(timer);
            resolve(f);
            return true;
          }
          return false;
        },
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  replyTo(reqId: string): Promise<Frame> {
    return this.waitFor((f) => (f.type === "ok" || f.type === "error") && f.payload.reqId === reqId, `reply to ${reqId}`);
  }
}

try {
  const url = `ws://127.0.0.1:${port}/ws`;

  // 1. bad token is refused with close 4003
  {
    const bad = new TestClient(url);
    await bad.opened();
    bad.ws.send(JSON.stringify({ type: "hello", payload: { token: "nope" } }));
    const code = await new Promise<number>((resolve) => {
      const t = setTimeout(() => resolve(-1), 5000);
      const check = () => {
        if (bad.closed !== null) {
          clearTimeout(t);
          resolve(bad.closed);
        } else setTimeout(check, 50);
      };
      check();
    });
    assert.equal(code, 4003);
    console.log("ok  bad token -> close 4003");
  }

  // 2. hello with the devsecret -> ok {via}
  const c = new TestClient(url);
  await c.opened();
  c.ws.send(JSON.stringify({ type: "hello", payload: { token: "devsecret" } }));
  const hello = await c.waitFor((f) => f.type === "ok" && f.payload.via === "devsecret", "hello ok");
  assert.ok(hello);
  console.log("ok  hello auth");

  // 3. session.create over WS
  const createId = c.send("session.create", { harness: "builtin", model: "mock-gpt", workspace: "demo", name: "ws test" });
  const createReply = await c.replyTo(createId);
  assert.equal(createReply.type, "ok", JSON.stringify(createReply.payload));
  const sessionId = createReply.payload.sessionId as string;
  assert.ok(sessionId.startsWith("sess_"));
  console.log("ok  session.create");

  // 4. session.resume -> snapshot envelope + ok {lastSeq}
  const resumeId = c.send("session.resume", { sessionId });
  const snap = await c.waitFor((f) => f.type === "snapshot" && (f.payload as { meta?: { sessionId?: string } })?.meta?.sessionId === sessionId, "snapshot");
  assert.equal((snap.payload.meta as { harness?: string }).harness, "builtin");
  const resumeReply = await c.replyTo(resumeId);
  assert.equal(resumeReply.type, "ok");
  assert.ok(typeof resumeReply.payload.lastSeq === "number");
  console.log("ok  session.resume -> snapshot + lastSeq");

  // 5. prompt.send -> live events stream over WS
  const promptId = c.send("prompt.send", { sessionId, text: "Say OK" });
  assert.equal((await c.replyTo(promptId)).type, "ok");
  const completed = await c.waitFor(
    (f) => f.type === "message.completed" && (f.payload as { role?: string }).role === "assistant",
    "assistant message.completed",
  );
  assert.ok(String((completed.payload as { text?: string }).text ?? "").includes("Hello from the mock"));
  await c.waitFor((f) => f.type === "usage", "usage");
  await c.waitFor((f) => f.type === "status" && (f.payload as unknown) === "idle", "idle");
  console.log("ok  prompt.send -> deltas/completed/usage/idle over WS");

  // 6. approval round-trip entirely over WS
  const permId = c.send("prompt.send", { sessionId, text: "!run echo ws" });
  await c.replyTo(permId);
  const ask = await c.waitFor((f) => f.type === "permission.request", "permission.request");
  const respondId = c.send("permission.respond", {
    sessionId,
    requestId: (ask.payload as { requestId?: string }).requestId,
    decision: "allow_once",
  });
  assert.equal((await c.replyTo(respondId)).type, "ok");
  await c.waitFor(
    (f) => f.type === "permission.resolved" && (f.payload as { decision?: string }).decision === "allow_once",
    "permission.resolved",
  );
  const toolResult = await c.waitFor((f) => f.type === "tool.result", "tool.result");
  assert.notEqual((toolResult.payload as { isError?: boolean }).isError, true);
  console.log("ok  permission round-trip over WS");

  // 7. interrupt + list requests
  assert.equal((await c.replyTo(c.send("interrupt", { sessionId }))).type, "ok");
  const listReply = await c.replyTo(c.send("session.list", {}));
  assert.ok(Array.isArray(listReply.payload.sessions) && (listReply.payload.sessions as unknown[]).length >= 1);
  const harnessReply = await c.replyTo(c.send("harness.list", {}));
  assert.ok((harnessReply.payload.harnesses as { id: string }[]).some((h) => h.id === "builtin"));
  console.log("ok  interrupt + session.list + harness.list");

  // 7.5 re-resume delivers snapshot + tail only, never duplicate events
  {
    const mid = (completed.payload as { messageId?: string }).messageId;
    const before = c.frames.filter((f) => f.type === "message.completed" && (f.payload as { messageId?: string }).messageId === mid).length;
    await c.replyTo(c.send("session.resume", { sessionId }));
    await new Promise((r) => setTimeout(r, 600));
    const after = c.frames.filter((f) => f.type === "message.completed" && (f.payload as { messageId?: string }).messageId === mid).length;
    assert.equal(after, before, "resume must not duplicate events");
    console.log("ok  re-resume: no duplicate events");
  }

  // 8. unknown request -> error envelope echoing reqId
  const bogusId = c.send("session.teleport", { sessionId });
  const bogus = await c.replyTo(bogusId);
  assert.equal(bogus.type, "error");
  assert.equal(bogus.payload.code, "unknown_request");
  console.log("ok  unknown request -> error with reqId");

  // 9. large frames: a >64KiB prompt exercises 64-bit length paths both ways
  const big = "x".repeat(70_000);
  const bigId = c.send("prompt.send", { sessionId, text: big });
  assert.equal((await c.replyTo(bigId)).type, "ok");
  const bigEcho = await c.waitFor(
    (f) => f.type === "message.delta" && (f.payload as { text?: string }).text?.length === 70_000,
    "big delta echo",
  );
  assert.equal((bigEcho.payload as { text?: string }).text, big);
  console.log("ok  64-bit frame lengths (>64KiB round-trip)");

  c.ws.close();
  await new Promise((r) => setTimeout(r, 300));
} finally {
  mock.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
}

console.log("WS_OK");
