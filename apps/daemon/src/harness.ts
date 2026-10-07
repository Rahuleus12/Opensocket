/** Common harness seam (PLAN §4.2). All engines normalize to this. */

export interface SessionMeta {
  sessionId: string; // daemon-issued OSSP session id
  workspace: string;
  harness: string;
  model?: string;
  system?: string;
}

/** Emit an OSSP event into the daemon (store + fan-out handled server-side). */
export type Emit = (type: string, payload: unknown) => Promise<void>;

export interface Harness {
  createSession(meta: SessionMeta, emit: Emit): Promise<void>;
  sendPrompt(meta: SessionMeta, text: string, emit: Emit): Promise<void>;
  interrupt(meta: SessionMeta): void;
  respondPermission(meta: SessionMeta, requestId: string, decision: string): void;
}
