/**
 * Push notifications via ntfy (self-hostable) — PLAN §2 goal 7.
 *
 * Enabled by NTFY_URL (full topic URL, e.g. https://ntfy.sh/my-topic-123);
 * optional NTFY_TOKEN for authenticated self-hosted servers. Without NTFY_URL
 * everything is a silent no-op.
 *
 * The daemon hooks this on its emit path (server.ts emitFor), so every
 * harness's stream is covered:
 *   - permission.request -> "Approval needed" (high; work is blocked on you)
 *   - error              -> "Session error"   (high)
 *   - status idle        -> "Task finished"   (normal, 15s cooldown/session)
 */

const IDLE_COOLDOWN_MS = 15_000;

export class Notifier {
  private url: string;
  private token: string;
  private lastIdle = new Map<string, number>();

  constructor(url = "", token = "") {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  get configured(): boolean {
    return this.url.length > 0;
  }

  /** POST one message to the ntfy topic. Never throws; never blocks callers. */
  async notify(
    title: string,
    message: string,
    priority = 3,
    tags: string[] = [],
  ): Promise<void> {
    if (!this.configured) return;
    try {
      const headers: Record<string, string> = {
        Title: title,
        Priority: String(priority),
        Tags: tags.join(","),
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(this.url, { method: "POST", headers, body: message });
      if (!res.ok) console.log(`[notify] ntfy failed (${res.status})`);
    } catch (err) {
      console.log(`[notify] failed: ${String(err).slice(0, 120)}`);
    }
  }

  /** Filter an OSSP event down to a push notification (fire-and-forget). */
  onOsspEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    ctx: { harness?: string; workspace?: string },
  ): void {
    if (!this.configured) return;
    const where = `${ctx.harness ?? "agent"} · ${ctx.workspace ?? "workspace"}`;
    if (type === "permission.request") {
      const p = payload as { tool?: string; argsSummary?: string };
      void this.notify(
        `Approval needed: ${p.tool ?? "tool"}`,
        `${where} — ${(p.argsSummary ?? "").slice(0, 240)}`,
        4,
        ["bell"],
      );
      return;
    }
    if (type === "error") {
      const p = payload as { message?: string };
      void this.notify(
        "Session error",
        `${where} — ${(p.message ?? "unknown").slice(0, 240)}`,
        4,
        ["rotating_light"],
      );
      return;
    }
    if (type === "status" && payload === "idle") {
      const now = Date.now();
      const last = this.lastIdle.get(sessionId) ?? 0;
      if (now - last < IDLE_COOLDOWN_MS) return;
      this.lastIdle.set(sessionId, now);
      void this.notify("Task finished", `${where} is idle`, 3, ["white_check_mark"]);
    }
  }
}
