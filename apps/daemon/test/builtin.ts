/**
 * Live test for the built-in agent against the local OpenAI-compatible mock:
 * streaming, usage extraction, history carry-over across prompts, interrupt.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuiltinHarness } from "../src/builtin.ts";
import { ApprovalGate } from "../src/approvals.ts";

const port = 8083;
const mock = spawn(process.execPath, ["scripts/mock-openai.ts"], {
  env: { ...process.env, MOCK_OPENAI_PORT: String(port) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const dataDir = await mkdtemp(join(tmpdir(), "os-builtin-"));
const wsRoot = join(dataDir, "workspaces", "demo");
await mkdir(wsRoot, { recursive: true });
await writeFile(join(wsRoot, "notes.txt"), "mock note content 42", "utf8");

try {
  const gate = new ApprovalGate(500); // fast auto-deny for the test
  const harness = new BuiltinHarness(`http://127.0.0.1:${port}/v1`, "mock", "mock-gpt", dataDir, gate);
  const events: { type: string; payload: unknown }[] = [];
  const emit = async (type: string, payload: unknown): Promise<void> => {
    events.push({ type, payload });
  };

  const meta = { sessionId: "sess_bi_test", workspace: "demo", harness: "builtin" };
  await harness.createSession(meta, emit);
  assert.ok(events.some((e) => e.type === "session.started"));
  console.log("ok  create");

  await harness.sendPrompt(meta, "Say OK", emit);
  const completed = events.find((e) => e.type === "message.completed");
  assert.ok(completed, "no message.completed");
  assert.equal(
    (completed.payload as { text?: string }).text,
    "Hello from the mock OpenAI endpoint. Pi drove this through the OpenSocket daemon; no API keys were involved.",
  );
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage && (usage.payload as { tokensOut?: number }).tokensOut === 20);
  console.log("ok  prompt streams + usage");

  const count = events.filter((e) => e.type === "message.delta").length;
  assert.ok(count > 3, "expected multiple deltas");
  console.log("ok  deltas:", count);

  harness.interrupt(meta); // stream already done; must not throw
  await harness.sendPrompt(meta, "Second prompt", emit); // history carried
  assert.ok(events.filter((e) => e.type === "message.completed").length === 2);
  console.log("ok  second prompt with history");

  // tool loop, denied: "!run" -> mock emits a bash tool_call -> gate times out
  await harness.sendPrompt(meta, "!run", emit);
  assert.ok(events.some((e) => e.type === "permission.request" && (e.payload as { tool?: string }).tool === "bash"), "no permission.request for bash");
  const denied = events.find((e) => e.type === "tool.result" && (e.payload as { isError?: boolean }).isError === true);
  assert.ok(denied, "bash tool.result should be an error (auto-denied)");
  const deniedText = events.filter((e) => e.type === "message.completed").pop();
  assert.ok(
    String((deniedText?.payload as { text?: string }).text ?? "").includes("TOOL RESULT SEEN"),
    "model did not see the denial",
  );
  console.log("ok  bash denied by gate, model informed");

  // tool loop, auto-allowed: "!read" -> read notes.txt -> model quotes it
  await harness.sendPrompt(meta, "!read", emit);
  const readText = events.filter((e) => e.type === "message.completed").pop();
  assert.ok(
    String((readText?.payload as { text?: string }).text ?? "").includes("mock note content 42"),
    "model did not see the file content",
  );
  const readOk = events.filter(
    (e) => e.type === "tool.result" && (e.payload as { isError?: boolean }).isError === false,
  );
  assert.ok(readOk.length >= 1, "no successful tool.result");
  console.log("ok  read tool auto-allowed, content reached model");

  console.log("BUILTIN_OK");
} finally {
  mock.kill();
}
