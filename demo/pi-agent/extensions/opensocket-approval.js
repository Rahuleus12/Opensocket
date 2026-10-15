/**
 * OpenSocket approval gate for pi.
 *
 * Registers a `tool_call` handler: every tool execution asks the OpenSocket
 * daemon (which round-trips to the paired phone/client as an OSSP
 * permission.request) and blocks until a decision arrives.
 *
 * Config via environment:
 *   OPENSOCKET_DAEMON_URL  default http://127.0.0.1:8097
 *   OPENSOCKET_SESSION_ID  OSSP session id (set by the daemon per spawn)
 *   OPENSOCKET_TOKEN       daemon bearer token
 *   OPENSOCKET_APPROVAL_TIMEOUT_MS  default 120000
 *
 * Behavior: `allow_once`/`allow_session` -> tool runs; `deny`/timeout ->
 * handler throws, which blocks the tool (pi fail-safe).
 */

const daemonUrl = (process.env.OPENSOCKET_DAEMON_URL ?? "http://127.0.0.1:8097").replace(/\/$/, "");
const sessionId = process.env.OPENSOCKET_SESSION_ID ?? "";
const token = process.env.OPENSOCKET_TOKEN ?? "";
const timeoutMs = Number(process.env.OPENSOCKET_APPROVAL_TIMEOUT_MS ?? 120000);

const sessionAllowed = new Set();

async function askDaemon(toolName, args) {
  const res = await fetch(`${daemonUrl}/api/session/${sessionId}/permission-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool: toolName, argsSummary: JSON.stringify(args ?? {}).slice(0, 300) }),
  });
  if (!res.ok) throw new Error(`opensocket: permission request failed (${res.status})`);
  const body = await res.json();
  return body.decision; // "allow_once" | "allow_session" | "deny"
}

export default function (pi) {
  pi.on("tool_call", async (event) => {
    const toolName = event.name ?? "unknown";
    if (sessionId === "") return; // not managed by opensocket: run unrestricted
    if (sessionAllowed.has(toolName)) return;

    let decision;
    try {
      decision = await askDaemon(toolName, event.input ?? event.args);
    } catch (err) {
      throw new Error(`opensocket approval gate: ${String(err)}`);
    }
    if (decision === "allow_session") {
      sessionAllowed.add(toolName);
      return;
    }
    if (decision !== "allow_once") {
      throw new Error(`opensocket: ${toolName} denied by user`);
    }
  });
}
