import type { Snapshot } from "@opensocket/protocol";
import { HttpError } from "./errors.ts";
import { httpFetch, type FetchInit } from "./runtime.ts";

export interface DeviceInfo {
  id: string;
  name: string;
  identity?: string;
  created?: string;
  lastSeen?: string;
  revoked?: boolean;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface PairedDevice {
  deviceId: string;
  token: string;
}

export interface SessionSummary {
  sessionId: string;
  workspace?: string;
  harness?: string;
  model?: string;
  name?: string;
  archived?: boolean;
  usage?: { tokensIn?: number; tokensOut?: number; costEstimate?: number };
  [key: string]: unknown;
}

export interface SessionCreateOpts {
  workspace?: string;
  harness?: string;
  model?: string;
  name?: string;
  system?: string;
}

export interface HarnessInfo {
  id: string;
  capabilities: Record<string, unknown>;
}

/**
 * Thin REST wrapper over the daemon's /api surface (RFC §3/§8). Auth is the
 * Bearer device token everywhere except /api/pair and /health, which are the
 * two pre-auth routes the daemon exposes.
 */
export class HttpApi {
  baseUrl: string;
  getToken: () => string;

  constructor(baseUrl: string, getToken: () => string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.getToken = getToken;
  }

  private async call<T>(
    path: string,
    init: FetchInit,
    auth: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (auth) headers.authorization = `Bearer ${this.getToken()}`;
    const res = await httpFetch(this.baseUrl + path, { ...init, headers });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const msg =
        (body as { error?: string } | null)?.error ??
        `HTTP ${res.status} ${path}`;
      throw new HttpError(res.status, msg);
    }
    return body as T;
  }

  /** Pair this client with a code printed/minted by the daemon. No auth. */
  pair(code: string, name: string): Promise<PairedDevice> {
    return this.call<PairedDevice>(
      "/api/pair",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name }),
      },
      false,
    );
  }

  /** Mint a new single-use pairing code (requires a working token). */
  mintPairingCode(): Promise<PairingCode> {
    return this.call<PairingCode>("/api/pair/code", { method: "POST" }, true);
  }

  async devices(): Promise<DeviceInfo[]> {
    const body = await this.call<{ devices: DeviceInfo[] }>(
      "/api/device",
      {},
      true,
    );
    return body.devices;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.call(`/api/device/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
    }, true);
  }

  async harnesses(): Promise<HarnessInfo[]> {
    const body = await this.call<{ harnesses: HarnessInfo[] }>(
      "/api/harnesses",
      {},
      true,
    );
    return body.harnesses;
  }

  async sessions(all = false): Promise<SessionSummary[]> {
    const body = await this.call<{ sessions: SessionSummary[] }>(
      `/api/session${all ? "?all=1" : ""}`,
      {},
      true,
    );
    return body.sessions;
  }

  createSession(opts: SessionCreateOpts): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>(
      "/api/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts),
      },
      true,
    );
  }

  /** Folded snapshot (derived view; never persisted — RFC §7). */
  snapshot(sessionId: string): Promise<Snapshot> {
    return this.call<Snapshot>(
      `/api/session/${encodeURIComponent(sessionId)}/snapshot`,
      {},
      true,
    );
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.call(
      `/api/session/${encodeURIComponent(sessionId)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
      true,
    );
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.call(
      `/api/session/${encodeURIComponent(sessionId)}/archive`,
      { method: "POST" },
      true,
    );
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.call(
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
      true,
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.call(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
      true,
    );
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: string,
  ): Promise<void> {
    await this.call(
      `/api/session/${encodeURIComponent(sessionId)}/permission`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, decision }),
      },
      true,
    );
  }

  /** Only pre-auth route; useful as a reachability check. */
  health(): Promise<{ ok: boolean; sessions: number }> {
    return this.call<{ ok: boolean; sessions: number }>(
      "/health",
      {},
      false,
    );
  }
}
