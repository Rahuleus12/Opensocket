import type { IncomingMessage } from "node:http";
import type { Config } from "./env.ts";
import type { DeviceStore, DevicePublic } from "./devices.ts";

/**
 * M1 auth (PLAN §4.4, RFC §8): per-device revocable tokens minted via
 * pairing, with the shared DAEMON_TOKEN as the loudly dev-only quick start.
 *
 * - Bearer <device token>  -> that device (hash-verified, revocable)
 * - Bearer <DAEMON_TOKEN>  -> "devsecret" pseudo-device (not listed/revocable)
 * - no token configured at all -> open mode, dev-only, warned at startup
 *
 * Optional proxy identity (e.g. Tailscale WhoIS headers in front of a
 * `tailscale serve` deployment): OPENSOCKET_IDENTITY_HEADERS names the
 * headers to trust; they are recorded on the device at pair time and, with
 * OPENSOCKET_IDENTITY_ENFORCE=1, must match on every request. Identity is a
 * second signal, never the only factor (the token always stays required).
 */

export interface AuthInfo {
  via: "device" | "devsecret" | "open";
  deviceId?: string;
  deviceName?: string;
}

export class Authenticator {
  private cfg: Config;
  private devices: DeviceStore;

  constructor(cfg: Config, devices: DeviceStore) {
    this.cfg = cfg;
    this.devices = devices;
  }

  private bearer(req: IncomingMessage): string {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return "";
    return h.slice(7).trim();
  }

  /** Trusted proxy identity for this request, if configured and present. */
  proxyIdentity(req: IncomingMessage): string | undefined {
    const names = this.cfg.identityHeaders;
    if (names.length === 0) return undefined;
    for (const name of names) {
      const v = req.headers[name.toLowerCase()];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
    }
    return undefined;
  }

  check(req: IncomingMessage): AuthInfo | null {
    // Open mode: no DAEMON_TOKEN and no paired devices -> everything passes.
    // Loudly dev-only; the startup banner tells the user to pair.
    if (!this.cfg.daemonToken && this.devices.count === 0) return { via: "open" };
    return this.checkToken(this.bearer(req), req.headers);
  }

  /**
   * Token check shared by HTTP and WebSocket (the WS client authenticates
   * with a hello message instead of headers). `headers` is only used for the
   * optional proxy-identity cross-check.
   */
  checkToken(
    token: string,
    headers: Record<string, string | string[] | undefined> = {},
  ): AuthInfo | null {
    if (!this.cfg.daemonToken && this.devices.count === 0) return { via: "open" };
    if (!token) return null;

    if (this.cfg.daemonToken && token === this.cfg.daemonToken) {
      return { via: "devsecret" };
    }

    const device = this.devices.verify(token);
    if (!device) return null;

    if (this.cfg.identityEnforce && device.identity) {
      for (const name of this.cfg.identityHeaders) {
        const v = headers[name.toLowerCase()];
        const current = typeof v === "string" ? v.trim().slice(0, 200) : undefined;
        if (current !== undefined && current !== device.identity) return null;
        // A missing header is allowed: the proxy may only front some routes.
      }
    }
    return { via: "device", deviceId: device.id, deviceName: device.name };
  }
}

/** Flatten a device for the wire (no hashes). */
export function publicDevice(d: DevicePublic): DevicePublic {
  return d;
}
