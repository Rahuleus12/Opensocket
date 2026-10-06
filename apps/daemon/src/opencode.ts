import { makeEnvelope, type Envelope } from "@opensocket/protocol";

/**
 * M0 bridge to `opencode serve` (PLAN §4.2, RFC 0001). opencode is the session
 * engine; this adapter translates its event stream onto OSSP.
 *
 * opencode's server API is still settling, so event shapes live in one table
 * (`mapEvent`) and anything unrecognized is dropped + counted rather than
 * forwarded. Fill the table against the installed opencode version.
 */
export class OpencodeBridge {
  private unmapped = 0;

  constructor(private baseUrl: string) {}

  /** Map one raw opencode SSE event to zero or more OSSP envelopes. */
  mapEvent(sessionId: string, raw: { type?: string; [k: string]: unknown }): Envelope[] {
    switch (raw.type) {
      // TODO(M0): verify exact opencode event names/payloads against the
      // installed version (opencode --version) and fill these in.
      case "message.updated":
      case "message.part.updated": {
        const part = (raw.properties ?? {}) as Record<string, unknown>;
        const text = typeof part.text === "string" ? part.text : "";
        return [makeEnvelope(sessionId, "message.delta", {
          messageId: String(part.id ?? "unknown"),
          role: "assistant",
          text,
        })];
      }
      default:
        this.unmapped++;
        if (this.unmapped % 10 === 1) {
          console.log(`[opencode] unmapped event type=${String(raw.type)} (total ${this.unmapped})`);
        }
        return [];
    }
  }

  /** Consume opencode's SSE event feed. Resolves when the stream ends. */
  async consume(sessionId: string, onEvent: (env: Envelope) => void): Promise<void> {
    const res = await fetch(`${this.baseUrl}/event`);
    if (!res.body) throw new Error(`opencode /event returned no body (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const raw = JSON.parse(line.slice(5).trim()) as { type?: string };
          for (const env of this.mapEvent(sessionId, raw)) onEvent(env);
        } catch {
          // Malformed line: log and move on; never crash the bridge mid-session.
          console.log(`[opencode] unparseable SSE line: ${line.slice(0, 80)}`);
        }
      }
    }
  }

  /** Forward a user prompt. TODO(M0): match the installed opencode API route. */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    if (!res.ok) throw new Error(`opencode prompt failed: ${res.status}`);
  }
}
