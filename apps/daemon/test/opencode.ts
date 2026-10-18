/**
 * Live protocol check for the opencode harness (no cloud keys, no cost):
 * spawns an isolated `opencode serve` (own config dir + password) plus the
 * local OpenAI mock as its provider, then drives the adapter end to end:
 * create -> stream -> tool call -> approval round-trip (allow + deny).
 *
 * Requires `opencode` on PATH; exits early (code 0) when it is missing so the
 * suite stays green on machines without it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { OpencodeHarness } from "../src/opencode.ts";

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

function spawnAndWait(
  bin: string,
  args: string[],
  env: Record<string, string>,
  ready: RegExp,
  timeoutMs = 20_000,
): Promise<{ proc: ReturnType<typeof spawn>; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: process.platform === "win32", // npm shims are .cmd on Windows
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`opencode serve did not become ready: ${output.slice(0, 300)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (ready.test(output)) {
        clearTimeout(timer);
        resolve({ proc, output });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (code !== null && code !== 0 && !ready.test(output)) {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited (${code}): ${output.slice(0, 300)}`));
      }
    });
  });
}

type Ev = { type: string; payload: unknown };

async function waitFor(events: Ev[], pred: (e: Ev) => boolean, what: string, timeoutMs = 30_000): Promise<Ev> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}; got: ${events.map((e) => e.type).join(", ")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Guard: skip (successfully) when opencode is not installed.
const ocBin = process.env.OPENCODE_BIN ?? "opencode";
const hasOc = await new Promise<boolean>((resolve) => {
  const p = spawn(ocBin, ["--version"], { shell: process.platform === "win32", stdio: "ignore" });
  p.on("error", () => resolve(false));
  p.on("exit", (code) => resolve(code === 0));
});
if (!hasOc) {
  console.log("skip opencode not on PATH");
  console.log("OPENCODE_OK");
  process.exit(0);
}

const ocPort = await freePort();
const mockPort = await freePort();
const password = `oc-test-${Math.random().toString(36).slice(2, 10)}`;

const cfgDir = await mkdtemp(join(tmpdir(), "os-oc-cfg-"));
await writeFile(
  join(cfgDir, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      providers: {
        mock: {
          name: "Mock",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { apiKey: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1` },
          models: {
            "mock-gpt": { name: "Mock GPT", limit: { context: 128000 }, capabilities: { tools: true } },
          },
        },
      },
      autoupdate: false,
    },
    null,
    2,
  ),
  "utf8",
);

// Isolation: own config dir, fixed password, no catalog fetches.
const server = await spawnAndWait(
  ocBin,
  ["serve", "--port", String(ocPort), "--hostname", "127.0.0.1"],
  {
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_DIR: cfgDir,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  },
  /server listening/,
);
const mock = spawn(process.execPath, ["scripts/mock-openai.ts"], {
  env: { ...process.env, MOCK_OPENAI_PORT: String(mockPort) },
  stdio: "ignore",
});

const dataDir = await mkdtemp(join(tmpdir(), "os-oc-data-"));

try {
  const harness = new OpencodeHarness(`http://127.0.0.1:${ocPort}`, password, dataDir);
  const events: Ev[] = [];
  const emit = async (type: string, payload: unknown): Promise<void> => {
    events.push({ type, payload });
  };

  // 1. createSession -> session.started with the opencode session id
  const meta = { sessionId: "sess_oc_test", workspace: "demo", harness: "opencode", model: "mock/mock-gpt" };
  await harness.createSession(meta, emit);
  const started = events.find((e) => e.type === "session.started");
  assert.ok(started, "no session.started");
  assert.ok((started.payload as { remoteSessionId?: string }).remoteSessionId, "no remoteSessionId");
  console.log("ok  create + session.started (remoteSessionId recorded)");

  // 2. plain prompt streams deltas and completes (via the shared event bus)
  await harness.sendPrompt(meta, "Say OK", emit);
  const completed = await waitFor(
    events,
    (e) => e.type === "message.completed",
    "message.completed",
  );
  assert.ok(
    String((completed.payload as { text?: string }).text ?? "").includes("Hello from the mock"),
    `unexpected text: ${JSON.stringify(completed.payload)}`,
  );
  assert.ok(events.some((e) => e.type === "message.delta"), "no deltas");
  await waitFor(events, (e) => e.type === "usage", "usage");
  const idle = await waitFor(events, (e) => e.type === "status" && e.payload === "idle", "idle");
  assert.ok(idle, "no idle");
  console.log("ok  prompt streams + usage + idle");

  // 3. tool call -> permission.request (R3) -> allow_once -> tool runs
  events.length = 0;
  await harness.sendPrompt(meta, "!shell echo hi", emit);
  const ask = await waitFor(
    events,
    (e) => e.type === "permission.request",
    "permission.request",
  );
  assert.equal((ask.payload as { tool?: string }).tool, "shell");
  harness.respondPermission(meta, (ask.payload as { requestId?: string }).requestId ?? "", "allow_once");
  const resolved = await waitFor(
    events,
    (e) => e.type === "permission.resolved",
    "permission.resolved",
  );
  assert.equal((resolved.payload as { decision?: string }).decision, "allow_once");
  const toolCall = await waitFor(events, (e) => e.type === "tool.call", "tool.call");
  assert.equal((toolCall.payload as { name?: string }).name, "shell");
  const result = await waitFor(
    events,
    (e) => e.type === "tool.result" && (e.payload as { isError?: boolean }).isError !== true,
    "successful tool.result",
  );
  assert.ok(String((result.payload as { summary?: string }).summary ?? "").includes("tool-ran-ok"));
  await waitFor(events, (e) => e.type === "status" && e.payload === "idle", "idle after tool");
  console.log("ok  approval round-trip: allow_once -> shell ran");

  // 4. deny blocks the tool (R3 fail-safe)
  events.length = 0;
  await harness.sendPrompt(meta, "!shell echo again", emit);
  const ask2 = await waitFor(
    events,
    (e) => e.type === "permission.request",
    "second permission.request",
  );
  harness.respondPermission(meta, (ask2.payload as { requestId?: string }).requestId ?? "", "deny");
  const denied = await waitFor(
    events,
    (e) => e.type === "tool.result" && (e.payload as { isError?: boolean }).isError === true,
    "denied tool.result",
  );
  assert.ok(denied, "denied tool should produce an error result");
  console.log("ok  approval round-trip: deny -> tool blocked");

  // 5. interrupt must not throw (nothing running; API no-ops)
  harness.interrupt(meta);
  console.log("ok  interrupt");

  harness.dispose();
} finally {
  server.proc.kill();
  mock.kill();
}

console.log("OPENCODE_OK");
