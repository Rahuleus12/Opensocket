import type { IncomingMessage } from "node:http";
import type { Config } from "./env.ts";

/**
 * M0: single shared bearer token (DAEMON_TOKEN). Empty token = open, dev-only.
 * M1: pairing flow, per-device tokens bound to tailnet identity (PLAN §4.4).
 */
export function checkAuth(req: IncomingMessage, cfg: Config): boolean {
  if (!cfg.daemonToken) return true;
  return req.headers.authorization === `Bearer ${cfg.daemonToken}`;
}
