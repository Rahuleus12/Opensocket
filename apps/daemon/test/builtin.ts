/**
 * Live test for the built-in agent against the local OpenAI-compatible mock:
 * streaming, usage extraction, history carry-over across prompts, interrupt.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { BuiltinHarness } from "../src/builtin.ts";

const port = 8083;
const mock = spawn(process.execPath, ["scripts/mock-openai.ts"], {
  env: { ...process.env, MOCK_OPENAI_PORT: String(port) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

try {
  const harness = new BuiltinHarness(`http://127.0.0.1:${port}/v1`, "mock", "mock-gpt");
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

  console.log("BUILTIN_OK");
} finally {
  mock.kill();
}
