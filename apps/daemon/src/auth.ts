import type { Config } from "./env";

/**
 * M0: single shared bearer token (DAEMON_TOKEN). Empty token = open, dev-only.
 * M1: pairing flow, per-device tokens bound to tailnet identity (PLAN §4.4).
 */
export function checkAuth(req: Request, cfg: Config): boolean {
  if (!cfg.daemonToken) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${cfg.daemonToken}`;
}
