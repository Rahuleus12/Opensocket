import type { Emit, Harness, SessionMeta } from "./harness.ts";

/**
 * WIP adapter: opencode's server API surface is not yet verified against an
 * installed version (opencode is not on this machine). Routes and payload
 * shapes below are placeholders gated by TODO(M0) - see PLAN 4.2. Orchestra
 * is the validated reference harness for now.
 */
export class OpencodeHarness implements Harness {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async createSession(meta: SessionMeta, emit: Emit): Promise<void> {
    // TODO(M0): POST the real session-create route and store opencode's id.
    await emit("session.started", {
      workspace: meta.workspace,
      harness: "opencode",
      model: meta.model,
    });
  }

  async sendPrompt(meta: SessionMeta, text: string, _emit: Emit): Promise<void> {
    // TODO(M0): verify route + payload against the installed opencode and
    // wire its event stream into emit() (map onto OSSP like orchestra.ts).
    const res = await fetch(
      `${this.baseUrl}/session/${meta.sessionId}/message`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      },
    );
    if (!res.ok) throw new Error(`opencode: prompt failed (${res.status})`);
  }

  interrupt(): void {
    // TODO(M0): map to opencode's abort route.
  }

  respondPermission(): void {
    // opencode permission round-trip lands in M2.
  }
}
