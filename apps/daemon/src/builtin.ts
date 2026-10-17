import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import type { Emit, Harness, RestoreMessage, SessionMeta } from "./harness.ts";
import { consumeSSE } from "./sse.ts";
import type { ApprovalGate } from "./approvals.ts";

/**
 * Built-in agent (PLAN §4.2): a small direct-to-provider agent loop with no
 * subprocess. Speaks the OpenAI streaming completions API (DeepSeek,
 * OpenRouter, OpenAI, Ollama, or the local mock — providers are a harness
 * concern, R4; config via BUILTIN_* env, defaulting to the env's key).
 *
 * Tools: read/ls (auto-allowed, workspace-rooted) and write/bash (gated —
 * every call emits permission.request and blocks until the client decides;
 * deny or timeout blocks the tool, R3). Tool calls stream in OpenAI format,
 * execute against the workspace, and feed back into the loop (max 5 turns).
 * History lives in memory; the OSSP JSONL keeps the transcript.
 */

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file from the workspace",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path, relative to the workspace" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "List files in a workspace directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path, relative to the workspace" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write (or overwrite) a text file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace directory",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

export class BuiltinHarness implements Harness {
  private history = new Map<string, ChatMessage[]>();
  private controllers = new Map<string, AbortController>();
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private dataDir: string;
  private gate: ApprovalGate;

  constructor(
    baseUrl: string,
    apiKey: string,
    defaultModel: string,
    dataDir: string,
    gate: ApprovalGate,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    this.dataDir = dataDir;
    this.gate = gate;
  }

  private workspaceRoot(meta: SessionMeta): string {
    const safe = meta.workspace.replace(/[^\w.-]/g, "_") || "default";
    return join(this.dataDir, "workspaces", safe);
  }

  /** Resolve a relative path inside the workspace; reject traversal. */
  private safeJoin(root: string, rel: string): string {
    const p = resolvePath(root, rel);
    const r = resolvePath(root);
    if (p !== r && !p.startsWith(r + sep)) {
      throw new Error(`path escapes workspace: ${rel}`);
    }
    return p;
  }

  private runBash(cwd: string, command: string): Promise<string> {
    return new Promise((res) => {
      exec(command, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          res(
            `ERROR: ${String(err.message).slice(0, 400)}${stderr ? `\nstderr: ${String(stderr).slice(0, 800)}` : ""}${stdout ? `\nstdout: ${String(stdout).slice(0, 2000)}` : ""}`,
          );
        } else {
          res((String(stdout) + (stderr ? `\nstderr: ${String(stderr).slice(0, 800)}` : "")).slice(0, 4000) || "(no output)");
        }
      });
    });
  }

  /** Execute one tool call. Throws on deny/failure; returns result text. */
  private async runTool(
    meta: SessionMeta,
    root: string,
    name: string,
    args: Record<string, unknown>,
    emit: Emit,
  ): Promise<string> {
    switch (name) {
      case "read": {
        const p = this.safeJoin(root, String(args.path ?? ""));
        return (await readFile(p, "utf8")).slice(0, 16_384);
      }
      case "ls": {
        const p = this.safeJoin(root, String(args.path ?? "."));
        const entries = await readdir(p, { withFileTypes: true });
        const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return (names.join("\n") || "(empty)").slice(0, 4096);
      }
      case "write": {
        const summary = `${String(args.path ?? "")} (${String(args.content ?? "").length} bytes)`;
        const decision = await this.gate.ask(emit, meta.sessionId, "write", summary);
        if (decision === "deny") throw new Error("denied by user");
        const p = this.safeJoin(root, String(args.path ?? ""));
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, String(args.content ?? ""), "utf8");
        return `wrote ${String(args.path)}`;
      }
      case "bash": {
        const command = String(args.command ?? "");
        const decision = await this.gate.ask(emit, meta.sessionId, "bash", command.slice(0, 300));
        if (decision === "deny") throw new Error("denied by user");
        return await this.runBash(root, command);
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    const msgs: ChatMessage[] = [];
    if (meta.system) msgs.push({ role: "system", content: meta.system });
    this.history.set(meta.sessionId, msgs);
    await mkdir(this.workspaceRoot(meta), { recursive: true });
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "builtin",
      model: meta.model ?? this.defaultModel,
      system: meta.system,
    });
  }

  restoreSession(meta: SessionMeta, messages: RestoreMessage[]): void {
    // Rebuild the provider conversation from the event log so prompts after a
    // daemon restart keep their context (transcript -> history, R2).
    const msgs: ChatMessage[] = [];
    if (meta.system) msgs.push({ role: "system", content: meta.system });
    for (const m of messages) {
      if ((m.role === "user" || m.role === "assistant") && m.text) {
        msgs.push({ role: m.role, content: m.text });
      }
    }
    this.history.set(meta.sessionId, msgs);
    mkdir(this.workspaceRoot(meta), { recursive: true }).catch(() => {});
  }

  async sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void> {
    const msgs = this.history.get(meta.sessionId);
    if (!msgs) throw new Error("builtin: session was never created");
    const model = meta.model ?? this.defaultModel;
    const root = this.workspaceRoot(meta);
    await mkdir(root, { recursive: true });

    msgs.push({ role: "user", content: text });
    const ac = new AbortController();
    this.controllers.set(meta.sessionId, ac);

    try {
      for (let iteration = 0; iteration < 5; iteration++) {
        await emit("status", "running");
        const messageId = `bi_msg_${iteration + 1}_${Date.now().toString(36)}`;
        let finalText = "";
        let finish: string | null = null;
        let tokensIn = 0;
        let tokensOut = 0;
        let totalTokens = 0;
        const acc = new Map<number, { id: string; name: string; args: string }>();

        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: msgs,
            tools: TOOLS,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new Error(`builtin: provider failed (${res.status}) ${detail.slice(0, 200)}`);
        }

        await consumeSSE(res.body, async (data) => {
          if (data === "[DONE]") return;
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(data) as OpenAIChunk;
          } catch {
            return; // malformed line: skip, keep the stream alive
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            finalText += delta.content;
            await emit("message.delta", { messageId, role: "assistant", text: delta.content });
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
          for (const tc of delta?.tool_calls ?? []) {
            const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(tc.index, cur);
          }
          if (chunk.usage) {
            tokensIn = chunk.usage.prompt_tokens ?? 0;
            tokensOut = chunk.usage.completion_tokens ?? 0;
            totalTokens = chunk.usage.total_tokens ?? 0;
          }
        });

        await emit("usage", {
          tokensIn,
          tokensOut,
          annotations: { total_tokens: totalTokens, iteration: iteration + 1 },
        });

        const toolCalls = [...acc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([i, t]) => ({
            id: t.id || `call_${i}`,
            type: "function" as const,
            function: { name: t.name, arguments: t.args || "{}" },
          }));

        if (finish === "tool_calls" && toolCalls.length > 0) {
          if (finalText) {
            await emit("message.completed", {
              messageId,
              role: "assistant",
              text: finalText,
              stopReason: "tool_use",
            });
          }
          msgs.push({ role: "assistant", content: finalText, tool_calls: toolCalls });
          for (const tc of toolCalls) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              // unparseable args: runTool will misbehave, hand the model an error
            }
            await emit("tool.call", {
              toolId: tc.id,
              name: tc.function.name,
              argsSummary: JSON.stringify(parsed).slice(0, 300),
              status: "running",
            });
            let resultText: string;
            let isError = false;
            try {
              resultText = await this.runTool(meta, root, tc.function.name, parsed, emit);
            } catch (err) {
              isError = true;
              resultText = `DENIED OR FAILED: ${String((err as Error).message).slice(0, 200)}`;
            }
            await emit("tool.result", {
              toolId: tc.id,
              summary: resultText.slice(0, 200),
              isError,
            });
            msgs.push({ role: "tool", tool_call_id: tc.id, content: resultText });
          }
          if (ac.signal.aborted) break;
          continue; // model sees the tool results next iteration
        }

        // Plain completion: the turn is done.
        msgs.push({ role: "assistant", content: finalText });
        await emit("message.completed", {
          messageId,
          role: "assistant",
          text: finalText,
          stopReason: finish ?? "end_turn",
        });
        await emit("status", "idle");
        return;
      }
      await emit("error", { code: "builtin_loop_limit", message: "tool loop exceeded 5 iterations", retryable: false });
      await emit("status", "error");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        await emit("message.completed", {
          messageId: `bi_msg_interrupted_${Date.now().toString(36)}`,
          role: "assistant",
          text: "(interrupted)",
          stopReason: "interrupted",
        });
        await emit("status", "idle");
        return;
      }
      throw err;
    } finally {
      this.controllers.delete(meta.sessionId);
    }
  }

  interrupt(meta: SessionMeta): void {
    this.controllers.get(meta.sessionId)?.abort();
  }

  respondPermission(): void {
    // decisions flow through ApprovalGate.resolve
  }
}
