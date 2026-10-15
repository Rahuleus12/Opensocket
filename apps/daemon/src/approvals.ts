import type { Emit } from "./harness.ts";

export type Decision = "allow_once" | "allow_session" | "deny";

/**
 * Shared approval gate (RFC 0001 R3). Emits an OSSP permission.request and
 * blocks until permission.respond resolves it; silence auto-denies.
 * Consumers: the daemon HTTP route (pi's extension) and harness-internal
 * tool execution (builtin).
 */
export class ApprovalGate {
  private pending = new Map<string, (d: Decision) => void>();
  private seq = 0;
  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  async ask(
    emit: Emit,
    sessionId: string,
    tool: string,
    argsSummary: string,
  ): Promise<Decision> {
    const requestId = `perm_${++this.seq}`;
    const riskHints =
      tool === "bash" || tool === "powershell"
        ? ["executes commands"]
        : tool === "write"
          ? ["writes files"]
          : undefined;
    await emit("permission.request", { requestId, tool, argsSummary, riskHints });
    const key = `${sessionId}|${requestId}`;
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve("deny"); // fail-safe: silence means no
      }, this.timeoutMs);
      this.pending.set(key, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
  }

  resolve(sessionId: string, requestId: string, decision: string): void {
    const key = `${sessionId}|${requestId}`;
    const resolver = this.pending.get(key);
    if (resolver) {
      this.pending.delete(key);
      resolver(decision as Decision);
    }
  }
}
