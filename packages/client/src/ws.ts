import type { Envelope, Snapshot } from "@opensocket/protocol";
import { RpcError } from "./errors.ts";
import { openWebSocket, type WsCloseEvent, type WsLike } from "./runtime.ts";

/**
 * WebSocket transport (RFC §3): one socket per client, hello-auth first,
 * envelope requests with ok/error replies, `session.resume` for
 * snapshot + tail. Auto-reconnects and re-establishes subscriptions
 * (the daemon answers each re-resume with a fresh snapshot, so listeners
 * can rebuild state; the server-side seq guard prevents duplicates).
 */

interface ReplyPayload {
  reqId?: unknown;
  code?: unknown;
  message?: unknown;
}

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResumeWaiter {
  resolve: (snap: Snapshot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WsTransportOptions {
  url: string;
  token: () => string;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
  handlers: {
    onEnvelope: (env: Envelope) => void;
    onSnapshot: (sessionId: string, snap: Snapshot) => void;
    onStatus: (status: "connecting" | "open" | "closed") => void;
    onError: (err: Error) => void;
  };
}

interface AnyFrame {
  type?: unknown;
  payload?: unknown;
  sessionId?: unknown;
  seq?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : null;
}

export class WsTransport {
  private opts: WsTransportOptions & {
    helloTimeoutMs: number;
    requestTimeoutMs: number;
    reconnectDelayMs: number;
  };
  private ws: WsLike | null = null;
  private want = false;
  private closedByUs = false;
  private handshaking: Promise<void> | null = null;
  private helloCb: ((err: Error | null) => void) | null = null;
  private pending = new Map<string, Pending>();
  /** sessionId -> waiters for an in-flight session.resume snapshot. */
  private waiters = new Map<string, ResumeWaiter[]>();
  /** Session ids with an established (snapshot-received) subscription. */
  private subs = new Set<string>();
  private reqSeq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsTransportOptions) {
    this.opts = {
      ...options,
      helloTimeoutMs: options.helloTimeoutMs ?? 10_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      reconnectDelayMs: options.reconnectDelayMs ?? 1_500,
    };
  }

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  isSubscribed(sessionId: string): boolean {
    return this.subs.has(sessionId);
  }

  /** Session ids with an established subscription (for callers restoring UI). */
  subscriptions(): string[] {
    return [...this.subs];
  }

  /** Open + hello. Idempotent; resolves once the daemon accepts the token. */
  connect(): Promise<void> {
    this.want = true;
    if (this.open) return Promise.resolve();
    if (this.handshaking) return this.handshaking;
    this.handshaking = this.handshake();
    return this.handshaking;
  }

  /** Envelope request; resolves with the ok payload or throws RpcError. */
  async request(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      throw new RpcError("not_connected", "websocket is not open");
    }
    const id = `req_${++this.reqSeq}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcError(
            "timeout",
            `no reply to ${type} within ${this.opts.requestTimeoutMs}ms`,
          ),
        );
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  /**
   * Subscribe to a session: resolves with the snapshot; live events flow to
   * the onEnvelope handler from then on (including the stored tail).
   */
  async resume(sessionId: string): Promise<Snapshot> {
    await this.connect();
    const reply = new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(sessionId, waiter);
        reject(
          new RpcError(
            "timeout",
            `no snapshot for ${sessionId} within ${this.opts.requestTimeoutMs}ms`,
          ),
        );
      }, this.opts.requestTimeoutMs);
      const waiter: ResumeWaiter = { resolve, reject, timer };
      this.pushWaiter(sessionId, waiter);
    });
    try {
      await this.request("session.resume", { sessionId });
    } catch (err) {
      this.rejectWaiters(sessionId, err as Error);
      throw err;
    }
    return reply;
  }

  /** Drop the socket but keep wanting it; reconnect + re-subscribe follows. */
  drop(): void {
    this.closedByUs = false;
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(4000, "client drop");
      } catch {
        /* onclose handles the rest */
      }
    }
  }

  /** Stop using the transport entirely (no reconnect). */
  close(): void {
    this.want = false;
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAll(new RpcError("closed", "client closed"));
    const ws = this.ws;
    this.ws = null;
    this.helloCb = null;
    if (ws) {
      try {
        ws.close(1000, "client close");
      } catch {
        /* already gone */
      }
    }
    this.opts.handlers.onStatus("closed");
  }

  /** Stop forwarding events for a session (server keeps it until socket close). */
  unsubscribe(sessionId: string): void {
    this.subs.delete(sessionId);
  }

  // ------------------------------------------------------------------

  private pushWaiter(sessionId: string, waiter: ResumeWaiter): void {
    let list = this.waiters.get(sessionId);
    if (!list) {
      list = [];
      this.waiters.set(sessionId, list);
    }
    list.push(waiter);
  }

  private removeWaiter(sessionId: string, waiter: ResumeWaiter): void {
    const list = this.waiters.get(sessionId);
    if (!list) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
    clearTimeout(waiter.timer);
  }

  private rejectWaiters(sessionId: string, err: Error): void {
    const list = this.waiters.get(sessionId) ?? [];
    this.waiters.set(sessionId, []);
    for (const w of list) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [sid] of this.waiters) this.rejectWaiters(sid, err);
  }

  private scheduleReconnect(): void {
    if (!this.want || this.reconnectTimer || this.ws) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.want && !this.ws) void this.reconnect();
    }, this.opts.reconnectDelayMs);
  }

  private async reconnect(): Promise<void> {
    this.handshaking = this.handshake()
      .then(() => {
        // Re-establish established subscriptions; each re-resume makes the
        // daemon send a fresh snapshot so listeners can rebuild state.
        for (const sid of [...this.subs]) {
          void this.request("session.resume", { sessionId: sid }).catch(
            (err: Error) => this.opts.handlers.onError(err),
          );
        }
      })
      .catch((err: Error) => {
        this.opts.handlers.onError(err);
        this.scheduleReconnect();
      });
    await this.handshaking;
  }

  private handshake(): Promise<void> {
    this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      this.opts.handlers.onStatus("connecting");
      let settled = false;
      let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          this.helloCb = null;
          this.dropSocket(4000, "hello timeout");
          reject(new RpcError("hello_timeout", "daemon did not answer hello"));
        },
        this.opts.helloTimeoutMs,
      );

      this.helloCb = (err) => {
        if (settled) return;
        settled = true;
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        this.helloCb = null;
        if (err) {
          this.dropSocket(4000, "hello refused");
          reject(err);
          return;
        }
        this.opts.handlers.onStatus("open");
        resolve();
      };

      let ws: WsLike;
      try {
        ws = openWebSocket(this.opts.url);
      } catch (err) {
        settled = true;
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        this.helloCb = null;
        this.opts.handlers.onStatus("closed");
        this.scheduleReconnect();
        reject(err as Error);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({ type: "hello", payload: { token: this.opts.token() } }),
        );
      };
      ws.onmessage = (ev) => {
        const text = typeof ev.data === "string" ? ev.data : "";
        let frame: AnyFrame;
        try {
          frame = JSON.parse(text) as AnyFrame;
        } catch {
          return;
        }
        this.onFrame(frame);
      };
      ws.onclose = (ev: WsCloseEvent) => {
        this.ws = null;
        const detail = `connection closed (${ev.code})`;
        this.failAll(new RpcError("ws_closed", detail));
        if (!settled) {
          settled = true;
          if (helloTimer) {
            clearTimeout(helloTimer);
            helloTimer = null;
          }
          this.helloCb = null;
          reject(new RpcError("hello_refused", detail));
        } else {
          this.opts.handlers.onStatus("closed");
        }
        if (!this.closedByUs) this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* a close always follows an error */
      };
    });
  }

  private dropSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }

  private onFrame(frame: AnyFrame): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    const payload = asRecord(frame.payload);

    if (type === "ok" || type === "error") {
      const reqId = typeof payload?.reqId === "string" ? payload.reqId : "";
      if (reqId === "") {
        // Hello reply (the daemon answers hello with an empty reqId).
        if (type === "ok") {
          this.helloCb?.(null);
        } else {
          const code = typeof payload?.code === "string" ? payload.code : "error";
          const msg =
            typeof payload?.message === "string" ? payload.message : code;
          this.helloCb?.(new RpcError(code, msg));
        }
        return;
      }
      const p = this.pending.get(reqId);
      if (!p) return;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (type === "ok") p.resolve(payload ?? {});
      else {
        const code = typeof payload?.code === "string" ? payload.code : "error";
        const msg =
          typeof payload?.message === "string" ? payload.message : code;
        p.reject(new RpcError(code, msg));
      }
      return;
    }

    if (type === "snapshot") {
      const meta = asRecord(payload?.meta);
      const sessionId = typeof meta?.sessionId === "string" ? meta.sessionId : "";
      if (!sessionId) return;
      this.subs.add(sessionId);
      const list = this.waiters.get(sessionId) ?? [];
      this.waiters.set(sessionId, []);
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve(payload as unknown as Snapshot);
      }
      this.opts.handlers.onSnapshot(sessionId, payload as unknown as Snapshot);
      return;
    }

    // Plain OSSP event: forward only for sessions we still want. The server
    // only pushes subscribed sessions anyway, but an unsubscribe() must
    // actually stop the flow (the server has no unsubscribe request in v1).
    if (
      typeof frame.sessionId === "string" &&
      typeof frame.seq === "number" &&
      this.subs.has(frame.sessionId)
    ) {
      this.opts.handlers.onEnvelope(frame as unknown as Envelope);
    }
  }
}
