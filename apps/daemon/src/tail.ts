import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "./store.ts";

/**
 * `opensocket tail <sessionId>` — the thin CLI from PLAN §4.6: follow a
 * session's derived plain-text log with no app, no pairing, no protocol.
 *
 *   node apps/daemon/src/tail.ts sess_xxx [--data ~/.opensocket]
 *
 * If session.log is missing but the JSONL exists, it is regenerated first
 * (logs are derived, never authoritative). Follows by polling so it works
 * everywhere (including Windows). Ctrl-C exits.
 */

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--"));
const dataArg = args.find((a) => a.startsWith("--data="))?.slice("--data=".length);

if (!sessionId) {
  console.log("usage: opensocket tail <sessionId> [--data=<dir>]");
  process.exit(1);
}

const dataDir = resolve((dataArg ?? "~/.opensocket").replace("~", homedir()));
const logPath = join(dataDir, "sessions", sessionId, "session.log");

// Regenerate the derived log if it is missing but events exist.
try {
  await stat(logPath);
} catch {
  const store = new SessionStore(dataDir);
  await store.loadAll();
  if (store.events(sessionId).length === 0) {
    console.error(`no such session: ${sessionId} (looked in ${join(dataDir, "sessions")})`);
    process.exit(1);
  }
  await store.regenerateLog(sessionId);
}

// Print the tail, then follow.
const PRINT_LAST_BYTES = 16 * 1024;
let size = (await stat(logPath)).size;
const start = Math.max(0, size - PRINT_LAST_BYTES);
if (start > 0) process.stdout.write("[...older lines trimmed...]\n");
let first = true;
let printed = start;
for (;;) {
  try {
    const raw = await readFile(logPath, "utf8");
    if (raw.length > printed) {
      process.stdout.write(raw.slice(printed)); // one append per loop keeps lines intact
      printed = raw.length;
      first = false;
    } else if (raw.length < printed) {
      // truncated/regenerated: reset to head
      printed = 0;
    }
  } catch {
    if (first) {
      console.error(`cannot read ${logPath}`);
      process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 400));
}
