import type { Emit, Harness, SessionMeta } from "./harness.ts";
import { consumeSSE } from "./sse.ts";

/**
 * Built-in agent (PLAN §4.2): a deliberately small direct-to-provider chat
 * loop with no subprocess. Speaks the OpenAI streaming completions API, so it
 * works with DeepSeek, OpenRouter, OpenAI, Ollama, or the local mock.
 *
 * - No tools in v1 -> nothing to approve; approvals apply when tools land.
 * - History lives in memory per session; the OSSP JSONL keeps the transcript,
 *   so a daemon restart preserves the visible conversation but the provider
 *   context restarts empty (documented M0.5 limitation).
 * - Providers are a harness concern (R4): config comes from BUILTIN_* env.
 */

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChunk {
  choices?: {
    delta?: { content?: string };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class BuiltinHarness implements Harness {
  private history = new Map<string, ChatMessage[]>();
  private controllers = new Map<string, AbortController>();
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(baseUrl: string, apiKey: string, defaultModel: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    const msgs: ChatMessage[] = [];
    if (meta.system) msgs.push({ role: "system", content: meta.system });
    this.history.set(meta.sessionId, msgs);
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "builtin",
      model: meta.model ?? this.defaultModel,
    });
  }

  async sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void> {
    const msgs = this.history.get(meta.sessionId);
    if (!msgs) throw new Error("builtin: session was never created");
    const model = meta.model ?? this.defaultModel;

    msgs.push({ role: "user", content: text });
    const messageId = `bi_msg_${Date.now().toString(36)}`;
    const ac = new AbortController();
    this.controllers.set(meta.sessionId, ac);
    await emit("status", "running");

    let finalText = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let totalTokens = 0;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `builtin: provider failed (${res.status}) ${detail.slice(0, 200)}`,
        );
      }
      await consumeSSE(res.body, async (data) => {
        if (data === "[DONE]") return;
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(data) as OpenAIChunk;
        } catch {
          return; // malformed line: skip, keep the stream alive
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          finalText += delta;
          await emit("message.delta", { messageId, role: "assistant", text: delta });
        }
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
          tokensOut = chunk.usage.completion_tokens ?? tokensOut;
          totalTokens = chunk.usage.total_tokens ?? totalTokens;
        }
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        const out = finalText || "(interrupted)";
        msgs.push({ role: "assistant", content: out });
        await emit("message.completed", { messageId, role: "assistant", text: out, stopReason: "interrupted" });
        await emit("status", "idle");
        return;
      }
      throw err;
    } finally {
      this.controllers.delete(meta.sessionId);
    }

    msgs.push({ role: "assistant", content: finalText });
    await emit("message.completed", {
      messageId,
      role: "assistant",
      text: finalText,
      stopReason: "end_turn",
    });
    await emit("usage", {
      tokensIn,
      tokensOut,
      annotations: { total_tokens: totalTokens },
    });
    await emit("status", "idle");
  }

  interrupt(meta: SessionMeta): void {
    this.controllers.get(meta.sessionId)?.abort();
  }

  respondPermission(): void {
    // No tools in v1: nothing to approve.
  }
}
