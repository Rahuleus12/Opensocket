import type { Envelope, Snapshot } from "@opensocket/protocol";
import { HttpApi } from "./http.ts";
import type {
  DeviceInfo,
  HarnessInfo,
  PairedDevice,
  PairingCode,
  SessionCreateOpts,
  SessionSummary,
} from "./http.ts";
import { streamSse } from "./sse.ts";
import { WsTransport } from "./ws.ts";

export type TransportMode = "ws" | "sse" | "off";

export interface OpenSocketClientOptions {
  /** Daemon origin, e.g. "http://localhost:8098" or "https://host.example". */
  baseUrl: string;
  /** Device token (or the dev-only DAEMON_TOKEN). Mutable via setToken(). */
  token: string;
  /** Prefer the WebSocket transport with SSE fallback (default true). */
  ws?: boolean;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
}

type ListenerMap = {
  /** Any OSSP event for a subscribed session (not snapshots, not replies). */
  envelope: (env: Envelope) => void;
  /** A session's folded snapshot (initial subscribe, and every reconnect). */
  snapshot: (sessionId: string, snap: Snapshot, via: TransportMode) => void;
  /** Active transport changed ("ws" | "sse" | "off"). */
  transport: (mode: TransportMode) => void;
  /** Background failures: reconnect loops, SSE stream drops, re-subscribe errors. */
  error: (err: Error, sessionId?: string) => void;
};

function toWsUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}/ws`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}/ws`;
  return `ws://${u}/ws`;
}

/**
 * Framework-agnostic OSSP client (ADR 0001): pairing + device management and
 * session RPC over REST, event streaming over WebSocket (hello-auth,
 * snapshot + tail, auto-resume) with the SSE endpoint as fallback.
 *
 * Runtime contract: any JS runtime with fetch + WebSocket (browsers, the
 * Tauri webview, Node >= 22). No framework, no node: imports, no deps
 * beyond @opensocket/protocol types.
 */
export class OpenSocketClient {
  /** Direct REST access (pairing, devices, metadata, escape hatch). */
  http: HttpApi;
  private token: string;
  private preferWs: boolean;
  private mode: TransportMode = "off";
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private wsTransport: WsTransport | null = null;
  private sseSubs = new Map<string, AbortController>();

  constructor(options: OpenSocketClientOptions) {
    this.token = options.token;
    this.preferWs = options.ws !== false;
    this.http = new HttpApi(options.baseUrl, () => this.token);
    if (this.preferWs) {
      this.wsTransport = new WsTransport({
        url: toWsUrl(options.baseUrl),
        token: () => this.token,
        reconnectDelayMs: options.reconnectDelayMs,
        requestTimeoutMs: options.requestTimeoutMs,
        handlers: {
          onEnvelope: (env) => this.emit("envelope", env),
          onSnapshot: (sessionId, snap) =>
            this.emit("snapshot", sessionId, snap, "ws"),
          onStatus: (status) => {
            if (status === "open") this.setMode("ws");
            else if (status === "closed" && this.mode === "ws") {
              this.setMode("off");
            }
          },
          onError: (err) => this.emit("error", err),
        },
      });
    }
  }

  on<K extends keyof ListenerMap>(event: K, fn: ListenerMap[K]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof ListenerMap>(event: K, fn: ListenerMap[K]): this {
    this.listeners.get(event)?.delete(fn as (...args: unknown[]) => void);
    return this;
  }

  get transport(): TransportMode {
    return this.mode;
  }

  /** Update the device token (e.g. after pairing) and reconnect if on WS. */
  setToken(token: string): void {
    this.token = token;
    if (this.wsTransport?.open) this.wsTransport.drop();
  }

  /** Open the WS transport (hello-auth). Resolves in "ws" or leaves "off". */
  async connect(): Promise<void> {
    if (!this.wsTransport) return;
    try {
      await this.wsTransport.connect();
      this.setMode("ws");
    } catch (err) {
      // Transport stays off; streamSse fallback covers streaming, HTTP covers
      // requests. The reconnect loop keeps trying in the background.
      this.emit("error", err as Error);
    }
  }

  /** Force-close the socket; auto-reconnect + re-subscribe follows. */
  dropConnection(): void {
    this.wsTransport?.drop();
  }

  async close(): Promise<void> {
    this.wsTransport?.close();
    for (const [, ctrl] of this.sseSubs) ctrl.abort();
    this.sseSubs.clear();
    this.setMode("off");
  }

  // ------------------------------------------------------------------
  // streaming
  // ------------------------------------------------------------------

  /**
   * Stream a session. WS mode: resolves with the folded snapshot (also
   * emitted as a snapshot event). SSE mode: resolves null and rebuilds
   * state by replaying stored events (no resume-from-seq on /sse).
   */
  async subscribe(sessionId: string): Promise<Snapshot | null> {
    if (this.wsTransport) {
      try {
        await this.wsTransport.connect();
        this.setMode("ws");
      } catch (err) {
        this.emit("error", err as Error);
      }
      if (this.wsTransport.open) {
        const snap = await this.wsTransport.resume(sessionId);
        return snap;
      }
    }
    this.unsubscribeSse(sessionId);
    const ctrl = new AbortController();
    this.sseSubs.set(sessionId, ctrl);
    this.setMode("sse");
    void streamSse({
      baseUrl: this.http.baseUrl,
      token: this.token,
      sessionId,
      signal: ctrl.signal,
      onEnvelope: (env) => this.emit("envelope", env),
    }).catch((err: Error) => {
      if (ctrl.signal.aborted) return;
      this.sseSubs.delete(sessionId);
      this.emit("error", err, sessionId);
    });
    return null;
  }

  /** Stop consuming a session (SSE aborts; WS drops it client-side). */
  unsubscribe(sessionId: string): void {
    this.wsTransport?.unsubscribe(sessionId);
    this.unsubscribeSse(sessionId);
  }

  /** Session ids currently subscribed (WS + SSE). */
  subscriptions(): string[] {
    return [
      ...new Set([
        ...(this.wsTransport?.subscriptions() ?? []),
        ...this.sseSubs.keys(),
      ]),
    ];
  }

  private unsubscribeSse(sessionId: string): void {
    const ctrl = this.sseSubs.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      this.sseSubs.delete(sessionId);
    }
  }

  // ------------------------------------------------------------------
  // requests — WS first, HTTP fallback (mirrors the daemon's web UI)
  // ------------------------------------------------------------------

  async createSession(
    opts: SessionCreateOpts,
  ): Promise<{ sessionId: string }> {
    const viaWs = await this.rpc("session.create", { ...opts });
    if (viaWs) return { sessionId: String(viaWs.sessionId) };
    return this.http.createSession(opts);
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const viaWs = await this.rpc("prompt.send", { sessionId, text });
    if (viaWs) return;
    await this.http.prompt(sessionId, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const viaWs = await this.rpc("interrupt", { sessionId });
    if (viaWs) return;
    await this.http.interrupt(sessionId);
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: "allow_once" | "allow_session" | "deny",
  ): Promise<void> {
    const viaWs = await this.rpc("permission.respond", {
      sessionId,
      requestId,
      decision,
    });
    if (viaWs) return;
    await this.http.respondPermission(sessionId, requestId, decision);
  }

  /**
   * WS RPC, or null when the socket is down (caller falls back to REST).
   * A failure *after* the request was sent propagates — falling back then
   * could re-submit a prompt the daemon is already running.
   */
  private rpc(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!this.wsTransport?.open) return Promise.resolve(null);
    return this.wsTransport.request(type, payload);
  }

  // ------------------------------------------------------------------
  // REST-only conveniences (pairing, devices, metadata, views)
  // ------------------------------------------------------------------

  pair(code: string, name: string): Promise<PairedDevice> {
    return this.http.pair(code, name);
  }

  mintPairingCode(): Promise<PairingCode> {
    return this.http.mintPairingCode();
  }

  devices(): Promise<DeviceInfo[]> {
    return this.http.devices();
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.http.revokeDevice(deviceId);
  }

  harnesses(): Promise<HarnessInfo[]> {
    return this.http.harnesses();
  }

  sessions(all = false): Promise<SessionSummary[]> {
    return this.http.sessions(all);
  }

  snapshot(sessionId: string): Promise<Snapshot> {
    return this.http.snapshot(sessionId);
  }

  renameSession(sessionId: string, name: string): Promise<void> {
    return this.http.renameSession(sessionId, name);
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.http.archiveSession(sessionId);
  }

  // ------------------------------------------------------------------

  private setMode(mode: TransportMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit("transport", mode);
  }

  private emit(event: keyof ListenerMap, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch {
        /* listener errors must not break the transport */
      }
    }
  }
}
