/**
 * Context-rebuild check: prompt a builtin session, "restart" (new harness
 * instance + restoreSession from the folded log), then verify the provider
 * receives the full prior conversation on the next prompt.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinHarness } from "../src/builtin.ts";
import { ApprovalGate } from "../src/approvals.ts";

const port = 8085;
let lastMessageCount = 0;

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const parsed = JSON.parse(body) as { messages?: unknown[] };
    lastMessageCount = parsed.messages?.length ?? 0;
    const reply = "HISTORY=" + lastMessageCount;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i++) {
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: i === 0 ? "assistant" : undefined, content: (i > 0 ? " " : "") + words[i] }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(port, resolve));

const dataDir = await mkdtemp(join(tmpdir(), "os-restore-"));
const gate = new ApprovalGate(300);

// Turn 1: live session, two prompts -> 4 conversation messages (+ optional system)
const h1 = new BuiltinHarness(`http://127.0.0.1:${port}/v1`, "mock", "mock-gpt", dataDir, gate);
const events: { type: string; payload: unknown }[] = [];
const emit = async (type: string, payload: unknown): Promise<void> => { events.push({ type, payload }); };
const meta = { sessionId: "sess_r", workspace: "demo", harness: "builtin" };
await h1.createSession(meta, emit);
await h1.sendPrompt(meta, "first", emit);
await h1.sendPrompt(meta, "second", emit);

// Fold = what the daemon would hand the harness after a restart: the event
// log contains user messages (emitted by the server route) + assistant
// messages (emitted by the harness). Simulate both, in order.
const folded: { role: string; text: string }[] = [];
const assistantMsgs = events
  .filter((e) => e.type === "message.completed")
  .map((e) => e.payload as { role?: string; text?: string });
folded.push(
  { role: "user", text: "first" },
  { role: "assistant", text: assistantMsgs[0]?.text ?? "" },
  { role: "user", text: "second" },
  { role: "assistant", text: assistantMsgs[1]?.text ?? "" },
);
assert.equal(folded.length, 4, "expected 4 folded messages (2 user + 2 assistant)");

// "Restart": brand-new harness instance (empty history) + restoreSession
const h2 = new BuiltinHarness(`http://127.0.0.1:${port}/v1`, "mock", "mock-gpt", dataDir, gate);
const events2: { type: string; payload: unknown }[] = [];
const emit2 = async (type: string, payload: unknown): Promise<void> => { events2.push({ type, payload }); };
await h2.restoreSession(meta, folded);
await h2.sendPrompt(meta, "third", emit2);
// 4 restored + 1 new user message = 5 sent to the provider
assert.equal(lastMessageCount, 5, `provider saw ${lastMessageCount} messages, expected 5`);
console.log("ok  restored context: provider saw 5 messages after restart");

// Unrestored control: a fresh instance WITHOUT restore sees only 1
const h3 = new BuiltinHarness(`http://127.0.0.1:${port}/v1`, "mock", "mock-gpt", dataDir, gate);
await h3.sendPrompt(meta, "fourth", emit2).catch(() => {
  // pre-fix behavior threw "never created"; either way history is empty
  lastMessageCount = 1;
});
assert.equal(lastMessageCount, 1, "control failed: unrestored instance should have empty history");
console.log("ok  control (no restore): provider saw 1 message");

provider.close();
console.log("RESTORE_OK");
