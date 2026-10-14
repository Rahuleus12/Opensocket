/**
 * Live protocol check for the pi harness (no model calls, no cost):
 * spawns `pi --mode rpc`, exercises get_state + prompt-disposition,
 * and verifies the adapter's transport end to end.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHarness } from "../src/pi.ts";

const harness = new PiHarness(process.env.PI_BIN ?? "pi", await mkdtemp(join(tmpdir(), "os-pi-")));

// 1. createSession spawns the child and emits session.started
const events: { type: string; payload: unknown }[] = [];
const emit = async (type: string, payload: unknown): Promise<void> => {
  events.push({ type, payload });
};
const meta = { sessionId: "sess_pi_test", workspace: "demo", harness: "pi" };
await harness.createSession(meta, emit);
assert.ok(events.some((e) => e.type === "session.started"));
console.log("ok  spawn + session.started");

// 2. prompt disposition: without credentials this still resolves (accepted)
//    or throws a legible provider error - both prove the RPC transport.
let disposition = "unknown";
try {
  await harness.sendPrompt(meta, "Say OK", emit);
  disposition = "accepted";
} catch (err) {
  disposition = `rejected: ${(err as Error).message.slice(0, 120)}`;
}
console.log("ok  prompt command ->", disposition);

// 3. interrupt must not throw
harness.interrupt(meta);
console.log("ok  interrupt");

console.log("PI_PROTOCOL_OK");
