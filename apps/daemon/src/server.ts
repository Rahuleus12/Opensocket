import type { Envelope } from "@opensocket/protocol";
import type { Config } from "./env";
import { checkAuth } from "./auth";
import { SessionStore } from "./store";
import { OpencodeBridge } from "./opencode";

/**
 * M0 server (PLAN §6 M0): SSE fan-out + a WS endpoint, JSONL persistence, and
 * the opencode bridge. Auth is a shared bearer token until M1 pairing lands.
 */
export function startServer(cfg: Config) {
  const store = new SessionStore(cfg.dataDir);
  const bridge = new OpencodeBridge(cfg.opencodeUrl);
  const subscribers = new Set<(env: Envelope) => void>();

  const fanout = (env: Envelope) => {
    void store.append(env);
    for (const send of subscribers) send(env);
  };

  const server = Bun.serve({
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true, sessions: store.list().length });
      }

      if (!checkAuth(req, cfg)) {
        return new Response("unauthorized", { status: 401 });
      }

      // SSE event stream (RFC 0001 §3 fallback path).
      if (url.pathname.startsWith("/sse/")) {
        const sessionId = url.pathname.slice("/sse/".length);
        let push: ((env: Envelope) => void) | null = null;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const write = (env: Envelope) =>
              controller.enqueue(enc.encode(`id: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`));
            for (const env of store.events(sessionId)) write(env);
            push = write;
            subscribers.add(write);
          },
          cancel() {
            if (push) subscribers.delete(push);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      // Forward a prompt to the opencode engine.
      if (req.method === "POST" && url.pathname.startsWith("/api/session/")) {
        const sessionId = url.pathname.split("/")[3] ?? "";
        const body = (await req.json()) as { text?: string };
        await bridge.sendPrompt(sessionId, body.text ?? "");
        return Response.json({ ok: true });
      }

      // Bridge opencode's SSE feed into OSSP (M0 wiring; WS endpoint lands in M1).
      if (url.pathname === "/api/bridge/start") {
        void bridge.consume(url.searchParams.get("session") ?? "default", fanout);
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`opensocketd v0 on :${server.port} (opencode: ${cfg.opencodeUrl})`);
  return server;
}
