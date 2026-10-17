/**
 * OSSP — OpenSocket Session Protocol (RFC 0001, draft).
 * Types only; JSON Schemas and a generated client come later (M1).
 */

export const OSSP_VERSION = 1;

/** §2 — the only wire unit. */
export interface Envelope<T = unknown> {
  v: typeof OSSP_VERSION;
  id: string;
  ts: string; // RFC 3339 UTC
  sessionId: string;
  seq: number;
  type: EventType | RequestType | "ok" | "error" | "snapshot";
  payload: T;
}

// §4 — events (daemon → client)

export interface SessionStarted {
  workspace: string;
  harness: string;
  model?: string;
  resumeOf?: string;
  /** Harness-side session handle (e.g. pi's own session id) for resume. */
  remoteSessionId?: string;
  /** System prompt, persisted so restarts can rebuild provider context. */
  system?: string;
}
/** R1-additive: user-facing metadata updates (rename, archive). */
export interface SessionUpdated {
  name?: string;
  archived?: boolean;
}
export interface MessageDelta {
  messageId: string;
  role: "user" | "assistant" | "system";
  text: string;
}
export interface MessageCompleted {
  messageId: string;
  role?: "user" | "assistant" | "system";
  text: string;
  stopReason?: string;
}
export interface ToolCall {
  toolId: string;
  name: string;
  argsSummary: string;
  status: "running" | "done" | "error";
  detail?: unknown;
}
export interface ToolResult {
  toolId: string;
  summary: string;
  detail?: unknown;
  isError?: boolean;
}
export interface PermissionRequest {
  requestId: string;
  tool: string;
  argsSummary: string;
  riskHints?: string[];
}
export interface PermissionResolved {
  requestId: string;
  decision: PermissionDecision;
  scope: "once" | "session";
}
export type PermissionDecision = "allow_once" | "allow_session" | "deny";
export interface DiffHunk {
  kind: "add" | "del" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface Diff {
  path: string;
  hunks: DiffHunk[];
  applyState?: "applied" | "proposed" | "kept";
}
export interface TodoItem {
  id: string;
  text: string;
  state: "pending" | "done";
}
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costEstimate?: number;
  /** R4: open map; OSSP never interprets it. */
  annotations?: Record<string, unknown>;
}
export type StatusState =
  | "thinking"
  | "running"
  | "awaiting_permission"
  | "idle"
  | "error";
export interface ErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

export type EventPayload =
  | SessionStarted
  | MessageDelta
  | MessageCompleted
  | ToolCall
  | ToolResult
  | PermissionRequest
  | PermissionResolved
  | Diff
  | TodoItem[]
  | Usage
  | StatusState
  | ErrorPayload;

export type EventType =
  | "session.started"
  | "session.updated"
  | "message.delta"
  | "message.completed"
  | "tool.call"
  | "tool.result"
  | "permission.request"
  | "permission.resolved"
  | "diff"
  | "todo.updated"
  | "usage"
  | "status"
  | "error";

// §5 — requests (client → daemon)

export type RequestType =
  | "session.create"
  | "session.resume"
  | "session.list"
  | "prompt.send"
  | "interrupt"
  | "permission.respond"
  | "harness.list"
  | "model.list"
  | "file.list"
  | "file.read";

export interface SessionCreate {
  workspace: string;
  harness: string;
  model?: string;
}
export interface SessionResume {
  sessionId: string;
  afterSeq?: number;
}
export interface PromptSend {
  sessionId: string;
  text: string;
  attachmentIds?: string[];
}
export interface Interrupt {
  sessionId: string;
}
export interface PermissionRespond {
  sessionId: string;
  requestId: string;
  decision: PermissionDecision;
}
export interface ModelList {
  harness: string;
}
export interface FileRead {
  sessionId: string;
  path: string;
}
export interface FileList {
  sessionId: string;
  path?: string;
}

export type RequestPayload =
  | SessionCreate
  | SessionResume
  | Record<string, never> // session.list, harness.list
  | PromptSend
  | Interrupt
  | PermissionRespond
  | ModelList
  | FileRead
  | FileList;

// §7 — snapshot (transport artifact, never persisted)

export interface Snapshot {
  meta: {
    sessionId: string;
    workspace: string;
    harness: string;
    model?: string;
    remoteSessionId?: string;
    system?: string;
    /** User-facing metadata (session.updated events). */
    name?: string;
    archived?: boolean;
  };
  messages: { messageId: string; role: string; text: string }[];
  tools: { toolId: string; name: string; status: string }[];
  todos: TodoItem[];
  usage: { tokensIn: number; tokensOut: number };
  lastSeq: number;
}

// helpers

let seqCounter = 0;

/** Build an envelope. M0 uses a local counter; M1 switches to ULID + store-issued seq. */
export function makeEnvelope(
  sessionId: string,
  type: Envelope["type"],
  payload: unknown,
): Envelope {
  return {
    v: OSSP_VERSION,
    id: `evt_${Date.now().toString(36)}_${(seqCounter++).toString(36)}`,
    ts: new Date().toISOString(),
    sessionId,
    seq: seqCounter,
    type,
    payload,
  };
}
