import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Envelope, Snapshot } from "@opensocket/protocol";

/**
 * JSONL is the source of truth (RFC 0001 §6 R2): one envelope per line,
 * ordered by seq. Sessions reload from disk on startup; fold() builds the
 * snapshot a client receives on (re)connect (RFC 0001 §7).
 *
 * Every session also renders a derived plain-text `session.log` next to the
 * JSONL (PLAN §4.6): the zero-client escape hatch —
 *   ssh host -- tail -f ~/.opensocket/sessions/<id>/session.log
 * Logs are derived, never authoritative; regenerateLog() rebuilds one from
 * the event log at any time.
 */
export class SessionStore {
  private sessions = new Map<string, Envelope[]>();
  private seqs = new Map<string, number>();

  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Rebuild in-memory state from sessions/<id>/events.jsonl. Returns event count. */
  async loadAll(): Promise<number> {
    let count = 0;
    const root = join(this.dataDir, "sessions");
    let ids: string[] = [];
    try {
      ids = await readdir(root);
    } catch {
      return 0; // no sessions dir yet
    }
    for (const id of ids) {
      try {
        const raw = await readFile(join(root, id, "events.jsonl"), "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            this.remember(JSON.parse(line) as Envelope);
            count++;
          } catch {
            // Skip a corrupt line; the rest of the log stays usable.
          }
        }
        // Derived log missing (crash, or predates the feature): regenerate.
        try {
          await readFile(join(root, id, "session.log"), "utf8");
        } catch {
          await this.regenerateLog(id);
        }
      } catch {
        // Directory without events.jsonl — ignore.
      }
    }
    return count;
  }

  private remember(env: Envelope): void {
    const list = this.sessions.get(env.sessionId) ?? [];
    list.push(env);
    this.sessions.set(env.sessionId, list);
    this.seqs.set(env.sessionId, env.seq);
  }

  nextSeq(sessionId: string): number {
    return (this.seqs.get(sessionId) ?? 0) + 1;
  }

  async append(env: Envelope): Promise<void> {
    this.remember(env);
    const dir = join(this.dataDir, "sessions", env.sessionId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "events.jsonl"), JSON.stringify(env) + "\n", "utf8");
    const line = renderLogLine(env);
    if (line) await appendFile(join(dir, "session.log"), line, "utf8");
  }

  /** Rebuild session.log from the event log (derived, never authoritative). */
  async regenerateLog(sessionId: string): Promise<void> {
    const dir = join(this.dataDir, "sessions", sessionId);
    let out = "";
    for (const env of this.events(sessionId)) {
      const line = renderLogLine(env);
      if (line) out += line;
    }
    if (out) await writeFile(join(dir, "session.log"), out, "utf8");
  }

  events(sessionId: string): Envelope[] {
    return this.sessions.get(sessionId) ?? [];
  }

  lastSeq(sessionId: string): number {
    return this.seqs.get(sessionId) ?? 0;
  }

  list(): { sessionId: string; lastSeq: number }[] {
    return [...this.sessions.keys()].map((sessionId) => ({
      sessionId,
      lastSeq: this.seqs.get(sessionId) ?? 0,
    }));
  }

  /** Fold the event log into a joined snapshot (RFC 0001 §7). */
  fold(sessionId: string): Snapshot | null {
    const events = this.events(sessionId);
    if (events.length === 0) return null;
    const snap: Snapshot = {
      meta: { sessionId, workspace: "", harness: "", model: undefined },
      messages: [],
      tools: [],
      todos: [],
      usage: { tokensIn: 0, tokensOut: 0 },
      lastSeq: this.lastSeq(sessionId),
    };
    const open = new Map<string, { messageId: string; role: string; text: string }>();
    const toolIdx = new Map<string, number>();
    for (const env of events) {
      switch (env.type) {
        case "session.started": {
          const p = env.payload as {
            workspace: string;
            harness: string;
            model?: string;
            remoteSessionId?: string;
            system?: string;
          };
          snap.meta = {
            sessionId,
            workspace: p.workspace,
            harness: p.harness,
            model: p.model,
            remoteSessionId: p.remoteSessionId,
            system: p.system,
          };
          break;
        }
        case "session.updated": {
          const p = env.payload as { name?: string; archived?: boolean };
          if (p.name !== undefined) snap.meta.name = p.name;
          if (p.archived !== undefined) snap.meta.archived = p.archived;
          break;
        }
        case "message.delta": {
          const p = env.payload as { messageId: string; role: string; text: string };
          const m = open.get(p.messageId) ?? { messageId: p.messageId, role: p.role, text: "" };
          m.text += p.text;
          open.set(p.messageId, m);
          break;
        }
        case "message.completed": {
          const p = env.payload as { messageId: string; text: string };
          const existing = open.get(p.messageId);
          open.set(p.messageId, {
            messageId: p.messageId,
            role: existing?.role ?? "assistant",
            text: p.text,
          });
          break;
        }
        case "tool.call": {
          const p = env.payload as { toolId: string; name: string; status: string };
          toolIdx.set(p.toolId, snap.tools.length);
          snap.tools.push({ toolId: p.toolId, name: p.name, status: p.status });
          break;
        }
        case "tool.result": {
          const p = env.payload as { toolId: string };
          const i = toolIdx.get(p.toolId);
          if (i !== undefined) snap.tools[i].status = "done";
          break;
        }
        case "todo.updated":
          snap.todos = env.payload as Snapshot["todos"];
          break;
        case "usage":
          snap.usage = env.payload as Snapshot["usage"];
          break;
        default:
          break; // R1: ignore what the fold doesn't need
      }
    }
    snap.messages = [...open.values()];
    return snap;
  }
}

/**
 * Render one envelope as plain text for session.log (PLAN §4.6). Returns
 * "" for events that carry no human-readable weight (deltas join into the
 * completed message; status churn is noise). Compact, greppable, tail-able.
 */
export function renderLogLine(env: Envelope): string {
  const t = env.ts ? new Date(env.ts) : new Date();
  const hhmmss = t.toISOString().slice(11, 19);
  const p = (env.payload ?? {}) as Record<string, unknown>;
  const block = (label: string, text: string): string => {
    const body = String(text)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    return `[${hhmmss}] ${label}:\n${body}\n`;
  };
  switch (env.type) {
    case "session.started": {
      const model = p.model ? `/${String(p.model)}` : "";
      return `=== ${env.sessionId} · ${String(p.harness ?? "?")}${model} · workspace ${String(p.workspace ?? "?")} · ${env.ts} ===\n`;
    }
    case "message.completed": {
      if (!p.text) return "";
      const role = p.role === "user" ? "you" : p.role === "system" ? "sys" : "agent";
      return block(role, String(p.text));
    }
    case "tool.call":
      return `[${hhmmss}] tool ${String(p.name)}: ${String(p.argsSummary ?? "")}\n`;
    case "tool.result":
      return `[${hhmmss}]   -> ${String(p.summary ?? "")}${p.isError ? "  [ERROR]" : ""}\n`;
    case "permission.request":
      return `[${hhmmss}] APPROVAL NEEDED ${String(p.tool)}: ${String(p.argsSummary ?? "")}\n`;
    case "permission.resolved":
      return `[${hhmmss}]   approval: ${String(p.decision)}\n`;
    case "todo.updated": {
      const items = Array.isArray(p) ? p : [];
      const line = items.map((i) => `${(i as { state?: string }).state === "done" ? "[x]" : "[ ]"} ${(i as { text?: string }).text ?? ""}`).join(" · ");
      return line ? `[${hhmmss}] plan: ${line}\n` : "";
    }
    case "diff":
      return `[${hhmmss}] diff ${String(p.path)}\n`;
    case "usage":
      return `[${hhmmss}] usage: ${String(p.tokensIn ?? 0)} in / ${String(p.tokensOut ?? 0)} out tok\n`;
    case "error":
      return `[${hhmmss}] ERROR ${String(p.code ?? "?")}: ${String(p.message ?? "")}\n`;
    default:
      return ""; // deltas, status churn, metadata updates
  }
}
