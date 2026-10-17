import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Envelope, Snapshot } from "@opensocket/protocol";

/**
 * JSONL is the source of truth (RFC 0001 §6 R2): one envelope per line,
 * ordered by seq. Sessions reload from disk on startup; fold() builds the
 * snapshot a client receives on (re)connect (RFC 0001 §7).
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
          };
          snap.meta = {
            sessionId,
            workspace: p.workspace,
            harness: p.harness,
            model: p.model,
            remoteSessionId: p.remoteSessionId,
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
