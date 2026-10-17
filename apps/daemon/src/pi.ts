import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Emit, Harness, SessionMeta } from "./harness.ts";

/**
 * Adapter for the pi coding agent (@earendil-works/pi-coding-agent, v1.2.0).
 *
 * Drives `pi --mode rpc` as a long-lived child process per OSSP session:
 * strict JSONL on stdin/stdout (LF framing only - readline splits on U+2028,
 * which is legal inside JSON strings, so never use readline here). Contract
 * from the installed package's docs/rpc.md + docs/json.md.
 *
 * Commands:  {id, type:"prompt"|"abort"|"get_state", ...} -> {type:"response",
 *            id, command, success, data|error}
 * Events:    agent_start, message_update{assistantMessageEvent{text_delta,
 *            delta}, usage}, message_end{message{role,content,stopReason,
 *            usage}}, tool_execution_start|end, agent_settled{aborted}
 *
 * M0 simplifications (documented, deliberate):
 * - `--no-session`: pi procs are stateless; the OSSP JSONL log is the source
 *   of truth (R2). pi-side resumable sessions are M1+ work.
 * - No tool approvals: in RPC mode pi executes tools directly. The R3
 *   daemon-side policy (tool allowlists per workspace) lands with M2.
 */

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

interface PiMessage {
  role: string;
  content: unknown;
  stopReason?: string;
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
}

interface PiEvent {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: PiMessage;
  usage?: PiMessage["usage"];
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: { type?: string; text?: string }[] };
  isError?: boolean;
  aborted?: boolean;
}

/** Extract plain text from pi message content (string or typed blocks). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b && b.type === "text" && typeof b.text === "string") out += b.text;
    }
    return out;
  }
  return "";
}

/** One pi RPC child process, bound to one OSSP session. */
class PiProc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private run = 0;
  private currentMessageId: string | null = null;
  private emit: Emit;
  stopped = false;

  constructor(
    bin: string,
    args: string[],
    cwd: string,
    emit: Emit,
    extraEnv: Record<string, string> = {},
  ) {
    this.emit = emit;
    this.child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      // Windows: npm's global shim is pi.cmd; bare-name spawn needs a shell.
      shell: process.platform === "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[pi] ${line.slice(0, 200)}`);
    });
    this.child.on("error", (err) => {
      // Spawn failures (ENOENT etc.) surface here, not on 'exit'.
      this.stopped = true;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      void this.emit("error", { code: "pi_spawn_error", message: String(err), retryable: true });
    });
    this.child.on("exit", (code) => {
      this.stopped = true;
      for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code})`));
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.onLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let rec: PiEvent;
    try {
      rec = JSON.parse(line) as PiEvent;
    } catch {
      return; // malformed record: skip
    }
    if (rec.type === "response") {
      const p = rec.id ? this.pending.get(rec.id) : undefined;
      if (p && rec.id) {
        this.pending.delete(rec.id);
        if (rec.success) p.resolve(rec.data);
        else p.reject(new Error(`pi ${rec.command ?? "command"} failed: ${rec.error ?? "unknown"}`));
      }
      return;
    }
    void this.onEvent(rec);
  }

  private async onEvent(rec: PiEvent): Promise<void> {
    switch (rec.type) {
      case "agent_start":
        await this.emit("status", "running");
        break;
      case "message_update": {
        const ev = rec.assistantMessageEvent;
        if (ev?.type === "text_delta" && ev.delta) {
          if (!this.currentMessageId) {
            this.run += 1;
            this.currentMessageId = `pi_msg_${this.run}`;
          }
          await this.emit("message.delta", {
            messageId: this.currentMessageId,
            role: "assistant",
            text: ev.delta,
          });
        }
        break;
      }
      case "message_end": {
        const m = rec.message;
        if (!m || m.role !== "assistant") break; // user echoes are emitted server-side
        const messageId = this.currentMessageId ?? `pi_msg_${++this.run}`;
        this.currentMessageId = null;
        await this.emit("message.completed", {
          messageId,
          role: "assistant",
          text: contentText(m.content),
          stopReason: m.stopReason,
        });
        if (m.usage) {
          await this.emit("usage", {
            tokensIn: m.usage.input ?? 0,
            tokensOut: m.usage.output ?? 0,
            annotations: {
              total_tokens: m.usage.totalTokens ?? 0,
              cost: m.usage.cost?.total ?? 0,
            },
          });
        }
        break;
      }
      case "tool_execution_start":
        await this.emit("tool.call", {
          toolId: rec.toolCallId ?? `tool_${Date.now().toString(36)}`,
          name: rec.toolName ?? "unknown",
          argsSummary: JSON.stringify(rec.args ?? {}).slice(0, 200),
          status: "running",
        });
        break;
      case "tool_execution_end": {
        const text = contentText(rec.result?.content);
        await this.emit("tool.result", {
          toolId: rec.toolCallId ?? "",
          summary: text.slice(0, 200),
          isError: rec.isError === true,
        });
        break;
      }
      case "agent_settled":
        this.currentMessageId = null;
        await this.emit("status", "idle");
        break;
      default:
        break; // R1: tolerate unknown event types
    }
  }

  /** Send a command and await its correlated response (not run completion). */
  command(payload: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("pi process has exited"));
    const id = `cmd_${randomId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi ${String(payload.type)} timed out after 60s (child stuck in startup?)`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    });
  }

  kill(): void {
    this.child.kill();
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class PiHarness implements Harness {
  private procs = new Map<string, PiProc>();
  private piIds = new Map<string, string>();
  private bin: string;
  private dataDir: string;
  /** Loaded into every pi child; gates tools through the daemon (R3). */
  private extensionPath: string;
  private daemonUrl: string;
  private daemonToken: string;

  constructor(bin: string, dataDir: string, daemonUrl = "", daemonToken = "") {
    this.bin = bin;
    this.dataDir = dataDir;
    this.extensionPath = join(dataDir, "extensions", "opensocket-approval.js");
    this.daemonUrl = daemonUrl;
    this.daemonToken = daemonToken;
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    const proc = await this.spawnFor(meta, emit);
    this.procs.set(meta.sessionId, proc);
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "pi",
      model: meta.model,
      remoteSessionId: this.piIds.get(meta.sessionId),
    });
  }

  /**
   * Restart path: silently respawn the RPC child from the persisted pi
   * session id (session.started.remoteSessionId) so the agent keeps its
   * context. No events are emitted - the log already has them.
   */
  restoreSession(meta: SessionMeta): Promise<void> {
    if (!meta.remoteSessionId) return Promise.resolve();
    return this.spawnFor(meta, async () => {}).then((proc) => {
      this.procs.set(meta.sessionId, proc);
    });
  }

  private async spawnFor(meta: SessionMeta, emit: Emit): Promise<PiProc> {
    const workspace = meta.workspace.replace(/[^\w.-]/g, "_") || "default";
    const cwd = join(this.dataDir, "workspaces", workspace);
    await mkdir(cwd, { recursive: true });
    const sessionDir = join(this.dataDir, "pi-sessions");
    await mkdir(sessionDir, { recursive: true });

    // Resume the pi-side session when we have its id (daemon restart), else new.
    const piSessionId = meta.remoteSessionId ?? this.piIds.get(meta.sessionId) ?? randomId();
    const args = [
      "--mode", "rpc",
      "--session-id", piSessionId,
      "--session-dir", sessionDir,
    ];
    if (meta.model) args.push("--model", meta.model);
    // R3 tool policy: PI_TOOLS restricts pi's toolset at spawn time
    // (comma-separated allowlist, e.g. "read,ls,grep,find"). Default: all.
    const tools = process.env.PI_TOOLS;
    if (tools) args.push("--tools", tools);
    const extPath = this.extensionPath;
    if (existsSync(extPath)) args.push("--extension", extPath);

    const proc = new PiProc(this.bin, args, cwd, emit, {
      OPENSOCKET_DAEMON_URL: this.daemonUrl,
      OPENSOCKET_SESSION_ID: meta.sessionId,
      OPENSOCKET_TOKEN: this.daemonToken,
    });
    this.piIds.set(meta.sessionId, piSessionId);
    return proc;
  }

  async sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void> {
    const proc = this.procs.get(meta.sessionId);
    if (!proc) throw new Error("pi: session was never created");
    await emit("status", "thinking");
    // Resolves on disposition (prompt accepted/queued), not run completion;
    // the run streams out as events until agent_settled.
    await proc.command({ type: "prompt", message: text });
  }

  interrupt(meta: SessionMeta): void {
    this.procs.get(meta.sessionId)?.command({ type: "abort" }).catch(() => {});
  }

  respondPermission(): void {
    // RPC-mode pi executes tools directly; approvals come via the R3
    // daemon-side policy (per-workspace tool allowlists) in M2.
  }

  /** Stop all child processes (daemon shutdown, tests). */
  dispose(): void {
    for (const proc of this.procs.values()) proc.kill();
    this.procs.clear();
  }
}
