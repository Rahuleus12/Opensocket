import type { Envelope } from "@opensocket/protocol";
import { HttpError } from "./errors.ts";
import { httpFetch } from "./runtime.ts";

/**
 * SSE fallback (RFC §3): GET /sse/{sessionId} replays the whole stored log,
 * then tails live events. The endpoint has no resume-from-seq, so state is
 * rebuilt by replaying events (this is exactly what the daemon's web UI
 * does); the WebSocket transport is the only one that yields a snapshot.
 *
 * Resolves once the stream is open; rejects if the daemon refuses (bad
 * token -> 401, unknown session still opens with an empty replay). Aborts
 * via the caller's signal.
 */
export async function streamSse(opts: {
  baseUrl: string;
  token: string;
  sessionId: string;
  signal: AbortSignal;
  onEnvelope: (env: Envelope) => void;
}): Promise<void> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const res = await httpFetch(
    `${base}/sse/${encodeURIComponent(opts.sessionId)}`,
    {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    },
  );
  if (!res.ok) {
    throw new HttpError(res.status, `sse stream failed: HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("sse response has no stream body");
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value as Uint8Array, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          opts.onEnvelope(JSON.parse(line.slice(5)) as Envelope);
        } catch {
          /* skip unparseable line */
        }
      }
    }
  }
}
