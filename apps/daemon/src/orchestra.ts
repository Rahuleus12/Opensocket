import type { Emit, Harness, SessionMeta } from "./harness.ts";

/**
 * Adapter for Orchestra (C:/Users/Administrator/projects/Orchestra) - Go
 * multi-agent engine. Contract verified against internal/server/handlers.go
 * and internal/agent/events.go:
 *
 *   POST /v1/agents                 {name, model?, system_prompt?} -> {id}
 *   POST /v1/agents/{id}/stream     {input} -> SSE `data: {AgentEvent}` lines
 *   SSE stream ends with `data: [DONE]`
 *
 * AgentEvent -> OSSP mapping:
 *   thinking        -> status thinking
 *   generate_start  -> status running
 *   generate_chunk  -> message.delta
 *   generate_done   -> usage captured
 *   tool_call_start -> tool.call
 *   tool_call_end   -> tool.result
 *   done            -> finalizes message.completed + usage + idle
 *   error           -> error (see quirk below)
 *
 * Known upstream quirk: AgentEvent.Error is tagged json:"-" in Orchestra,
 * so error events arrive without their message text.
 */

interface OrchestraEvent {
  type:
    | "thinking"
    | "generate_start"
    | "generate_chunk"
    | "generate_done"
    | "tool_call_start"
    | "tool_call_end"
    | "done"
    | "error";
  chunk?: string;
  tool_call?: { id?: string; function?: { name?: string; arguments?: string } };
  result?: {
    call?: { id?: string };
    result?: { content?: string; is_error?: boolean };
  };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  turn?: number;
}

export class OrchestraHarness implements Harness {
  private agentIds = new Map<string, string>();
  private runs = new Map<string, number>();
  private controllers = new Map<string, AbortController>();

  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `opensocket-${meta.sessionId}`,
        model: meta.model,
        system_prompt: meta.system,
      }),
    });
    if (!res.ok) throw new Error(`orchestra: create agent failed (${res.status})`);
    const body = (await res.json()) as { id?: string; ID?: string };
    const agentId = body.id ?? body.ID;
    if (!agentId) throw new Error("orchestra: agent create returned no id");
    this.agentIds.set(meta.sessionId, agentId);
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "orchestra",
      model: meta.model,
    });
  }

  async sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void> {
    const agentId = this.agentIds.get(meta.sessionId);
    if (!agentId) throw new Error("orchestra: session was never created");

    const run = (this.runs.get(meta.sessionId) ?? 0) + 1;
    this.runs.set(meta.sessionId, run);
    const messageId = `msg_${run}`;

    const ac = new AbortController();
    this.controllers.set(meta.sessionId, ac);
    await emit("status", "running");

    let finalText = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let totalTokens = 0;
    let sawError = false;

    try {
      const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`orchestra: stream failed (${res.status})`);

      await consumeSSE(res.body, async (data) => {
        if (data === "[DONE]") return;
        let ev: OrchestraEvent;
        try {
          ev = JSON.parse(data) as OrchestraEvent;
        } catch {
          return; // malformed line: skip, keep the stream alive
        }
        switch (ev.type) {
          case "thinking":
            await emit("status", "thinking");
            break;
          case "generate_start":
            await emit("status", "running");
            break;
          case "generate_chunk":
            if (ev.chunk) {
              finalText += ev.chunk;
              await emit("message.delta", { messageId, role: "assistant", text: ev.chunk });
            }
            break;
          case "tool_call_start":
            await emit("tool.call", {
              toolId: ev.tool_call?.id ?? `tool_${ev.turn ?? 0}`,
              name: ev.tool_call?.function?.name ?? "unknown",
              argsSummary: ev.tool_call?.function?.arguments ?? "",
              status: "running",
            });
            break;
          case "tool_call_end": {
            const content = ev.result?.result?.content ?? "";
            await emit("tool.result", {
              toolId: ev.result?.call?.id ?? `tool_${ev.turn ?? 0}`,
              summary: content.slice(0, 200),
              isError: ev.result?.result?.is_error === true,
            });
            break;
          }
          case "generate_done":
            tokensIn = ev.usage?.prompt_tokens ?? tokensIn;
            tokensOut = ev.usage?.completion_tokens ?? tokensOut;
            totalTokens = ev.usage?.total_tokens ?? totalTokens;
            break;
          case "error":
            sawError = true;
            await emit("error", {
              code: "orchestra_error",
              message: "orchestra run failed (error detail not serialized upstream)",
              retryable: false,
            });
            break;
          default:
            break; // R1: tolerate unknown event types
        }
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        const text = finalText || "(interrupted)";
        await emit("message.completed", { messageId, role: "assistant", text, stopReason: "interrupted" });
        await emit("status", "idle");
        return;
      }
      throw err;
    } finally {
      this.controllers.delete(meta.sessionId);
    }

    if (finalText) {
      await emit("message.completed", {
        messageId,
        role: "assistant",
        text: finalText,
        stopReason: sawError ? "error" : "end_turn",
      });
    }
    await emit("usage", {
      tokensIn,
      tokensOut,
      annotations: { total_tokens: totalTokens },
    });
    await emit("status", sawError ? "error" : "idle");
  }

  interrupt(meta: SessionMeta): void {
    this.controllers.get(meta.sessionId)?.abort();
  }

  respondPermission(): void {
    // Orchestra has no permission round-trip yet; approvals land with
    // harness-builtin (M2) plus a daemon-side policy for the rest (R3).
  }
}

/** Parse an SSE body: `data: <payload>` lines, `[DONE]` sentinel passes through. */
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) await onData(line.slice(5).trim());
      nl = buffer.indexOf("\n");
    }
  }
}
