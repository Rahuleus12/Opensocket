import { mkdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Envelope } from "@opensocket/protocol";

/**
 * JSONL is the source of truth (RFC 0001 §6 R2): one envelope per line,
 * ordered by seq. M0 keeps a full in-memory copy per session; M1 adds
 * compaction so long sessions don't hold everything in RAM.
 */
export class SessionStore {
  private sessions = new Map<string, Envelope[]>();
  private seqs = new Map<string, number>();

  constructor(private dataDir: string) {}

  async append(env: Envelope): Promise<void> {
    const list = this.sessions.get(env.sessionId) ?? [];
    list.push(env);
    this.sessions.set(env.sessionId, list);
    this.seqs.set(env.sessionId, env.seq);

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
}
