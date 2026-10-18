import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/env.ts";
import { startServer } from "../src/server.ts";

/**
 * M0 smoke test: exercises the full pipeline against an Orchestra test double
 * serving the REAL SSE contract from internal/agent/events.go:
 *   create session -> prompt -> SSE events -> OSSP store -> snapshot fold,
 * plus auth, SSE replay, and durability across a daemon restart.
 */

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function startOrchestraDouble(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "agent_1" }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/agents/agent_1/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const events: object[] = [
        { type: "thinking", turn: 0, timestamp: "2026-10-06T00:00:00Z" },
        { type: "generate_chunk", chunk: "Hello ", turn: 0 },
        { type: "generate_chunk", chunk: "from ", turn: 0 },
        { type: "generate_chunk", chunk: "Orchestra.", turn: 0 },
        {
          type: "tool_call_start",
          tool_call: { id: "call_1", type: "function", function: { name: "echo", arguments: "{\"x\":1}" } },
          turn: 0,
        },
        {
          type: "tool_call_end",
          result: {
            turn: 0,
            call: { id: "call_1", type: "function", function: { name: "echo", arguments: "" } },
            result: { content: "x=1", is_error: false },
            duration: 1000000,
          },
          turn: 0,
        },
        { type: "generate_done", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, turn: 0 },
        { type: "done", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, turn: 0 },
      ];
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function snapshot(
  api: (p: string) => string,
  auth: Record<string, string>,
  sessionId: string,
) {
  const res = await fetch(api(`/api/session/${sessionId}/snapshot`), { headers: auth });
  return (await res.json()) as {
    meta: { harness: string };
    messages: { messageId: string; role: string; text: string }[];
    tools: { toolId: string; name: string; status: string }[];
    usage: { tokensIn: number; tokensOut: number; annotations?: Record<string, unknown> };
    lastSeq: number;
  };
}

// --- setup ---

const orch = startOrchestraDouble();
const orchPort = await listen(orch);

const dataDir = await mkdtemp(join(tmpdir(), "opensocket-smoke-"));
const cfg: Config = {
  port: 0,
  daemonToken: "t",
  opencodeUrl: "http://127.0.0.1:1", // nothing there; adapter tests run their own server
  opencodePassword: "",
  orchestraUrl: `http://127.0.0.1:${orchPort}`,
  piBin: "pi",
  builtinBaseUrl: "http://127.0.0.1:1/v1",
  builtinApiKey: "mock",
  builtinModel: "mock-gpt",
  dataDir,
  identityHeaders: [],
  identityEnforce: false,
};

const server = await startServer(cfg);
const port = (server.address() as AddressInfo).port;
const api = (p: string) => `http://127.0.0.1:${port}${p}`;
const auth = { authorization: "Bearer t" };

try {
  // 1. health (no auth) + auth enforcement
  assert.equal((await fetch(api("/health"))).status, 200);
  assert.equal((await fetch(api("/api/session"))).status, 401);
  console.log("ok  health + auth");

  // 2. create session on orchestra harness
  const created = (await (
    await fetch(api("/api/session"), {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ harness: "orchestra", workspace: "w" }),
    })
  ).json()) as { sessionId: string };
  assert.match(created.sessionId, /^sess_/);
  console.log("ok  session create:", created.sessionId);

  // 3. SSE replay contains session.started
  const ac = new AbortController();
  const sse = await fetch(api(`/sse/${created.sessionId}`), { headers: auth, signal: ac.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes("session.started"), "SSE replay missing session.started");
  ac.abort();
  console.log("ok  SSE replay");

  // 4. prompt -> streamed run
  await fetch(api(`/api/session/${created.sessionId}/prompt`), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ text: "hi" }),
  });

  // 5. snapshot folds deltas + tools + usage
  let snap = await snapshot(api, auth, created.sessionId);
  for (let i = 0; i < 50 && snap.usage.tokensOut === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    snap = await snapshot(api, auth, created.sessionId);
  }
  assert.equal(snap.meta.harness, "orchestra");
  assert.ok(
    snap.messages.some((m) => m.role === "assistant" && m.text === "Hello from Orchestra."),
    `assistant text wrong: ${JSON.stringify(snap.messages)}`,
  );
  assert.ok(snap.messages.some((m) => m.role === "user" && m.text === "hi"));
  assert.equal(snap.tools.length, 1);
  assert.equal(snap.tools[0].status, "done");
  assert.equal(snap.usage.tokensIn, 10);
  assert.equal(snap.usage.tokensOut, 5);
  assert.equal(snap.usage.annotations?.total_tokens, 15);
  console.log("ok  snapshot fold (messages, tools, usage)");

  // 5.5 derived session.log (PLAN §4.6): plain-text, regenerable, greppable
  const logPath = join(dataDir, "sessions", created.sessionId, "session.log");
  const logText = await readFile(logPath, "utf8");
  assert.ok(logText.includes("=== " + created.sessionId), "log header missing");
  assert.ok(logText.includes("you:\n  hi"), `log user line missing:\n${logText}`);
  assert.ok(logText.includes("agent:\n  Hello from Orchestra."), "log agent line missing");
  assert.ok(logText.includes("tool "), "log tool line missing");
  assert.ok(logText.includes("usage: 10 in / 5 out tok"), "log usage line missing");
  console.log("ok  session.log derived transcript");
} finally {
  server.close();
  orch.close();
}

// 6. durability: restart daemon on the same data dir
{
  // delete the derived log: it must regenerate from the JSONL on boot
  const sessions = await readdir(join(dataDir, "sessions"));
  for (const id of sessions) {
    await rm(join(dataDir, "sessions", id, "session.log"), { force: true });
  }
  const server2 = await startServer(cfg);
  const port2 = (server2.address() as AddressInfo).port;
  const api2 = (p: string) => `http://127.0.0.1:${port2}${p}`;
  const res = await fetch(api2("/api/session"), { headers: { authorization: "Bearer t" } });
  const list = (await res.json()) as { sessions: { sessionId: string; lastSeq: number }[] };
  assert.ok(
    list.sessions.some((s) => s.lastSeq > 0 && s.sessionId.length > 0),
    "session not restored after restart",
  );
  // the derived log was regenerated from events.jsonl
  let regen = false;
  for (const s of list.sessions) {
    try {
      const t = await readFile(join(dataDir, "sessions", s.sessionId, "session.log"), "utf8");
      if (t.includes("agent:")) regen = true;
    } catch {
      // fold found no renderable events for this one
    }
  }
  assert.ok(regen, "session.log not regenerated after restart");
  server2.close();
  console.log("ok  durability across restart + log regeneration");
}

console.log("SMOKE_OK");
