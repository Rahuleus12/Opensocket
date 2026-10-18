import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Emit, Harness, SessionMeta } from "./harness.ts";
import { consumeSSE } from "./sse.ts";

/**
 * Adapter for opencode v2 (verified against `opencode serve` v2.0.32).
 *
 * The daemon talks to an external `opencode serve` instance over its v2 HTTP
 * API (start it with OPENCODE_PASSWORD=<secret>; auth is HTTP Basic with
 * username "opencode"). Contract, verified live:
 *
 *   POST /api/session                                {location?, title?, agent?, model?, permissions?} -> {data: Session}
 *   POST /api/session/{id}/prompt                    {id, text} -> {data: userMessage} (run is async)
 *   POST /api/session/{id}/interrupt                 -> 200
 *   GET  /api/session/{id}/permission                -> {data: pending asks[]}
 *   POST /api/session/{id}/permission/{perID}/reply  {decision: once|always|reject} -> 204
 *   GET  /api/event                                  -> SSE; frames `data: {id, created, type, location?, data}`
 *
 * Event mapping (opencode -> OSSP), filtered by data.sessionID:
 *   session.execution.started/succeeded/interrupted  -> status running/idle
 *   session.execution.failed, session.error          -> error + status error
 *   session.text.delta {assistantMessageID, delta}   -> message.delta
 *   session.step.ended {finish, tokens, cost}        -> message.completed + usage
 *   session.usage.updated (session-cumulative)       -> usage
 *   session.tool.input.started/called                -> tool.call (running)
 *   session.tool.success/failed                      -> tool.result
 *   permission.asked {id, action, resources}         -> permission.request (R3)
 *   permission.replied {requestID, reply}            -> permission.resolved
 *
 * R3: sessions are created with ask-rules for side-effecting tools (shell,
 * edit, write, patch, webfetch, websearch), so every side effect round-trips
 * through the client. Rule precedence is findLast (session rules are appended
 * after agent defaults and win).
 */

/** Side-effecting tool actions that ask before running (R3 default-deny posture). */
const ASK_PERMISSIONS = [
  "shell",
  "edit",
  "write",
  "patch",
  "webfetch",
  "websearch",
].map((action) => ({ action, resource: "*", effect: "ask" }));

interface OcEvent {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface OcSession {
  id: string;
}

/** Per-session runtime state keyed by OSSP session id. */
interface OcState {
  ocId: string;
  emit: Emit;
  /** assistantMessageID -> per-ordinal accumulated text (joined on completion). */
  text: Map<string, string[]>;
  /** tool call id -> tool name (tool.called carries no name). */
  toolNames: Map<string, string>;
  /** OSSP request id -> opencode permission id (currently 1:1, kept for safety). */
  permIds: Map<string, string>;
}

function joinText(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n");
}

export class OpencodeHarness implements Harness {
  private baseUrl: string;
  private password: string;
  private dataDir: string;
  private states = new Map<string, OcState>();
  private byOcId = new Map<string, string>();
  private bus: AbortController | null = null;
  private busStopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private msgSeq = 0;
  /** opencode message ids must be unique across its durable store. */
  private readonly instanceId = Math.random().toString(36).slice(2, 10);

  constructor(baseUrl: string, password = "", dataDir = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.password = password;
    this.dataDir = dataDir;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    }
    return headers;
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T | null; text: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      // non-JSON error body: keep the text
    }
    return { status: res.status, json, text };
  }

  private workspaceRoot(meta: SessionMeta): string {
    const safe = meta.workspace.replace(/[^\w.-]/g, "_") || "default";
    return join(this.dataDir, "workspaces", safe);
  }

  /** Parse an OSSP model string ("provider/model") into opencode's shape. */
  private modelBody(model?: string): { providerID: string; id: string } | undefined {
    if (!model || !model.includes("/")) return undefined;
    const i = model.indexOf("/");
    const providerID = model.slice(0, i);
    const id = model.slice(i + 1);
    if (!providerID || !id) return undefined;
    return { providerID, id };
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    await mkdir(this.workspaceRoot(meta), { recursive: true });
    const model = this.modelBody(meta.model);
    const { status, json, text } = await this.api<{ data: OcSession }>(
      "POST",
      "/api/session",
      {
        title: `opensocket-${meta.sessionId.slice(0, 16)}`,
        location: { directory: this.workspaceRoot(meta) },
        ...(model ? { model } : {}),
        permissions: ASK_PERMISSIONS,
      },
    );
    if (status !== 200 || !json?.data?.id) {
      throw new Error(`opencode: create session failed (${status}) ${text.slice(0, 200)}`);
    }
    const ocId = json.data.id;
    this.register(meta.sessionId, ocId, emit);
    this.subscribeBus();
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "opencode",
      model: meta.model,
      remoteSessionId: ocId,
    });
  }

  private register(sessionId: string, ocId: string, emit: Emit): void {
    this.states.set(sessionId, {
      ocId,
      emit,
      text: new Map(),
      toolNames: new Map(),
      permIds: new Map(),
    });
    this.byOcId.set(ocId, sessionId);
  }

  /**
   * Restart path: the opencode server owns session state, so resuming is just
   * re-registering the id mapping and keeping the event bus attached. No
   * events are emitted - the log already has them.
   */
  restoreSession(meta: SessionMeta): void {
    if (!meta.remoteSessionId) return;
    this.register(meta.sessionId, meta.remoteSessionId, async () => {});
    this.subscribeBus();
  }

  async sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void> {
    const state = this.states.get(meta.sessionId);
    if (!state) throw new Error("opencode: session was never created");
    this.msgSeq += 1;
    const { status, text: body } = await this.api("POST", `/api/session/${state.ocId}/prompt`, {
      id: `msg_oc_${this.instanceId}_${this.msgSeq}`,
      text,
    });
    if (status !== 200) {
      throw new Error(`opencode: prompt failed (${status}) ${body.slice(0, 200)}`);
    }
    await emit("status", "running");
  }

  interrupt(meta: SessionMeta): void {
    const state = this.states.get(meta.sessionId);
    if (!state) return;
    void this.api("POST", `/api/session/${state.ocId}/interrupt`).catch(() => {});
  }

  respondPermission(meta: SessionMeta, requestId: string, decision: string): void {
    const state = this.states.get(meta.sessionId);
    const perId = state?.permIds.get(requestId) ?? requestId;
    const mapped =
      decision === "allow_session" ? "always" : decision === "allow_once" ? "once" : "reject";
    if (state) {
      void this.api("POST", `/api/session/${state.ocId}/permission/${encodeURIComponent(perId)}/reply`, {
        decision: mapped,
      }).catch(() => {});
    }
  }

  /** One shared SSE bus for all sessions, demuxed by opencode session id. */
  private subscribeBus(): void {
    if (this.bus || this.busStopped) return;
    const ac = new AbortController();
    this.bus = ac;
    const run = async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(`${this.baseUrl}/api/event`, {
            headers: this.authHeaders(),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) throw new Error(`event stream failed (${res.status})`);
          await consumeSSE(res.body, async (data) => {
            this.onBusFrame(data);
          });
        } catch (err) {
          if (ac.signal.aborted) return;
          if ((err as Error).name === "AbortError") return;
          // reconnect with a small backoff; the bus is shared, so one flaky
          // connection must not take down every session
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void run();
  }

  private onBusFrame(data: string): void {
    if (!data || data === "[DONE]") return;
    let ev: OcEvent;
    try {
      ev = JSON.parse(data) as OcEvent;
    } catch {
      return; // malformed frame: skip
    }
    const d = ev.data ?? {};
    const sid = typeof d.sessionID === "string" ? d.sessionID : "";
    const osspId = this.byOcId.get(sid);
    if (!osspId) return; // not ours (other projects/sessions on the server)
    const state = this.states.get(osspId);
    if (!state) return;
    void this.onEvent(state, osspId, ev.type ?? "", d);
  }

  private async onEvent(
    state: OcState,
    sessionId: string,
    type: string,
    d: Record<string, unknown>,
  ): Promise<void> {
    const emit = state.emit;
    switch (type) {
      case "session.execution.started":
        await emit("status", "running");
        return;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        await emit("status", "idle");
        return;
      case "session.execution.failed": {
        const err = (d.error as { message?: string } | undefined) ?? {};
        await emit("error", {
          code: "opencode_execution_failed",
          message: err.message ?? "execution failed",
          retryable: false,
        });
        await emit("status", "error");
        return;
      }
      case "session.error": {
        const err = (d.error as { message?: string } | undefined) ?? {};
        await emit("error", {
          code: "opencode_error",
          message: err.message ?? "unknown opencode error",
          retryable: true,
        });
        return;
      }
      case "session.step.started":
        await emit("status", "running");
        return;
      case "session.text.delta": {
        const messageId = String(d.assistantMessageID ?? "");
        const delta = String(d.delta ?? "");
        if (!messageId || !delta) return;
        const parts = state.text.get(messageId) ?? [];
        parts[Number(d.ordinal ?? 0)] = (parts[Number(d.ordinal ?? 0)] ?? "") + delta;
        state.text.set(messageId, parts);
        await emit("message.delta", { messageId, role: "assistant", text: delta });
        return;
      }
      case "session.step.ended": {
        const messageId = String(d.assistantMessageID ?? "");
        const parts = state.text.get(messageId) ?? [];
        const finish = String(d.finish ?? "end_turn");
        if (messageId && joinText(parts)) {
          await emit("message.completed", {
            messageId,
            role: "assistant",
            text: joinText(parts),
            stopReason: finish === "tool-calls" ? "tool_use" : finish,
          });
        }
        if (messageId) state.text.delete(messageId);
        return;
      }
      case "session.usage.updated": {
        const t = (d.tokens as Record<string, number> | undefined) ?? {};
        const cache = (t.cache as unknown as { read?: number; write?: number } | undefined) ?? {};
        await emit("usage", {
          tokensIn: t.input ?? 0,
          tokensOut: t.output ?? 0,
          costEstimate: typeof d.cost === "number" ? d.cost : undefined,
          annotations: {
            reasoning: t.reasoning ?? 0,
            cache_read: cache.read ?? 0,
            cache_write: cache.write ?? 0,
          },
        });
        return;
      }
      case "session.tool.input.started": {
        const toolId = String(d.id ?? "");
        const name = String(d.name ?? "unknown");
        if (toolId) state.toolNames.set(toolId, name);
        return;
      }
      case "session.tool.called": {
        const toolId = String(d.id ?? "");
        if (!toolId) return;
        await emit("tool.call", {
          toolId,
          name: state.toolNames.get(toolId) ?? String(d.name ?? "unknown"),
          argsSummary: JSON.stringify(d.input ?? {}).slice(0, 300),
          status: "running",
        });
        return;
      }
      case "session.tool.success": {
        const content = Array.isArray(d.content) ? d.content : [];
        let summary = "";
        for (const c of content) {
          const b = c as { type?: string; text?: string };
          if (b?.type === "text" && typeof b.text === "string") summary += b.text;
        }
        await emit("tool.result", { toolId: String(d.id ?? ""), summary: summary.slice(0, 200) });
        return;
      }
      case "session.tool.failed": {
        const err = (d.error as { message?: string } | undefined) ?? {};
        await emit("tool.result", {
          toolId: String(d.id ?? ""),
          summary: String(err.message ?? "tool failed").slice(0, 200),
          isError: true,
        });
        return;
      }
      case "permission.asked": {
        const requestId = String(d.id ?? "");
        if (!requestId) return;
        const tool = String(d.action ?? "unknown");
        const resources = Array.isArray(d.resources) ? d.resources.map(String) : [];
        const riskHints = Array.isArray(d.save) && d.save.length > 0
          ? [`always-allow pattern offered: ${d.save.map(String).join(", ")}`]
          : undefined;
        state.permIds.set(requestId, requestId);
        await emit("permission.request", {
          requestId,
          tool,
          argsSummary: resources.join(" ").slice(0, 300),
          riskHints,
        });
        return;
      }
      case "permission.replied": {
        const requestId = String(d.requestID ?? "");
        const reply = String(d.reply ?? "");
        const decision = reply === "always" ? "allow_session" : reply === "once" ? "allow_once" : "deny";
        if (requestId) state.permIds.delete(requestId);
        await emit("permission.resolved", {
          requestId,
          decision,
          scope: decision === "allow_session" ? "session" : "once",
        });
        return;
      }
      default:
        return; // R1: tolerate unknown event types
    }
  }

  /** Stop the event bus (daemon shutdown, tests). */
  dispose(): void {
    this.busStopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.bus?.abort();
    this.bus = null;
  }
}
