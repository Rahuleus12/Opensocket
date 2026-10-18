import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { makeEnvelope, type Envelope } from "@opensocket/protocol";
import type { Config } from "./env.ts";
import { Authenticator } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { SessionStore } from "./store.ts";
import type { Emit, Harness, SessionMeta } from "./harness.ts";
import { OrchestraHarness } from "./orchestra.ts";
import { OpencodeHarness } from "./opencode.ts";
import { PiHarness } from "./pi.ts";
import { BuiltinHarness } from "./builtin.ts";
import { ApprovalGate } from "./approvals.ts";
import { Notifier } from "./notify.ts";
import { WsConn } from "./ws.ts";

/**
 * M1 server: JSONL persistence, per-session fan-out (SSE + WebSocket), and
 * harness routing. Auth is per-device tokens minted via pairing; the shared
 * DAEMON_TOKEN remains as the dev-only quick start (PLAN §4.4, RFC §3/§8).
 */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Build an ok/error reply envelope for a request (RFC §2/§5). */
function reply(reqId: string, type: "ok" | "error", payload: Record<string, unknown>, sessionId = ""): string {
  const env = makeEnvelope(sessionId, type, { reqId, ...payload });
  env.seq = 0; // replies are transport artifacts, not logged events
  return JSON.stringify(env);
}

const HELLO_TIMEOUT_MS = 10_000;

export async function startServer(cfg: Config): Promise<http.Server> {
  const store = new SessionStore(cfg.dataDir);
  const restored = await store.loadAll();
  const devices = new DeviceStore(cfg.dataDir);
  await devices.load();
  const auth = new Authenticator(cfg, devices);

  // Rebuild session metadata from the logs (survives daemon restarts).
  const meta = new Map<string, SessionMeta & { name?: string; archived?: boolean; usage?: { tokensIn: number; tokensOut: number } }>();
  for (const { sessionId } of store.list()) {
    const snap = store.fold(sessionId);
    if (snap) {
      meta.set(sessionId, {
        sessionId,
        workspace: snap.meta.workspace,
        harness: snap.meta.harness,
        model: snap.meta.model,
        remoteSessionId: snap.meta.remoteSessionId,
        system: snap.meta.system,
        name: snap.meta.name,
        archived: snap.meta.archived,
        usage: snap.usage,
      });
    }
  }

  const subscribers = new Map<string, Set<(env: Envelope) => void>>();

  /** Shared approval gate (R3): pi's HTTP route and builtin's tools both use it. */
  const gate = new ApprovalGate(cfg.approvalTimeoutMs ?? 120_000);

  /** Push notifications (ntfy). No-op unless NTFY_URL is set. */
  const notifier = new Notifier(cfg.ntfyUrl ?? "", cfg.ntfyToken ?? "");

  const harnesses = new Map<string, Harness>([
    ["orchestra", new OrchestraHarness(cfg.orchestraUrl)],
    ["opencode", new OpencodeHarness(cfg.opencodeUrl, cfg.opencodePassword, cfg.dataDir)],
    ["pi", new PiHarness(cfg.piBin, cfg.dataDir, `http://127.0.0.1:${cfg.port}`, cfg.daemonToken)],
    ["builtin", new BuiltinHarness(cfg.builtinBaseUrl, cfg.builtinApiKey, cfg.builtinModel, cfg.dataDir, gate)],
  ]);

  // Restart path: let harnesses rebuild provider/session state from the logs
  // (builtin conversation history; pi respawns its RPC child). One failing
  // session must not block startup.
  for (const [sessionId, m] of meta) {
    const impl = harnesses.get(m.harness);
    if (!impl?.restoreSession) continue;
    try {
      const snap = store.fold(sessionId);
      if (snap) await impl.restoreSession(m, snap.messages);
    } catch (err) {
      console.log(`[restore] ${sessionId} failed: ${String(err).slice(0, 120)}`);
    }
  }

  const emitFor = (sessionId: string): Emit => async (type, payload) => {
    const env = makeEnvelope(sessionId, type as Envelope["type"], payload);
    env.seq = store.nextSeq(sessionId);
    await store.append(env);
    for (const write of subscribers.get(sessionId) ?? []) write(env);
    // Push notifications ride the same path as persistence + fan-out, so
    // every harness is covered (permission/error/idle; see notify.ts).
    const m = meta.get(sessionId);
    notifier.onOsspEvent(sessionId, type, payload, {
      harness: m?.harness,
      workspace: m?.workspace,
    });
  };

  // ------------------------------------------------------------------
  // Shared request handlers (used by both the HTTP routes and /ws)
  // ------------------------------------------------------------------

  async function createSessionImpl(body: {
    workspace?: string;
    harness?: string;
    model?: string;
    system?: string;
    name?: string;
  }): Promise<string> {
    const harness = body.harness ?? "orchestra";
    const impl = harnesses.get(harness);
    if (!impl) throw new Error(`unknown harness: ${harness}`);
    const sessionId = `sess_${randomUUID()}`;
    const m: SessionMeta = {
      sessionId,
      workspace: body.workspace ?? "default",
      harness,
      model: body.model ?? cfg.defaultModel,
      system: body.system,
    };
    await impl.createSession(m, emitFor(sessionId));
    meta.set(sessionId, m);
    if (body.name) {
      const name = body.name.trim().slice(0, 80);
      await emitFor(sessionId)("session.updated", { name });
      (m as SessionMeta & { name?: string }).name = name;
    }
    return sessionId;
  }

  function getSession(sessionId: string): SessionMeta {
    const session = meta.get(sessionId);
    if (!session) throw new Error("no such session");
    return session;
  }

  async function promptImpl(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    const impl = harnesses.get(session.harness);
    if (!impl) throw new Error("harness missing");
    const emit = emitFor(sessionId);
    const userMessageId = `user_${store.nextSeq(sessionId)}`;
    await emit("message.delta", { messageId: userMessageId, role: "user", text });
    await emit("message.completed", { messageId: userMessageId, role: "user", text, stopReason: "sent" });
    // Fire-and-forget: the run streams out via SSE/WS; failures land as error events.
    impl.sendPrompt(session, text, emit).catch(async (err) => {
      await emit("error", { code: "harness_error", message: String(err), retryable: true });
      await emit("status", "error");
    });
  }

  async function permissionImpl(sessionId: string, requestId: string, decision: string): Promise<void> {
    const session = getSession(sessionId);
    const impl = harnesses.get(session.harness);
    if (!impl) throw new Error("harness missing");
    impl.respondPermission(session, requestId, decision);
    gate.resolve(sessionId, requestId, decision);
    await emitFor(sessionId)("permission.resolved", {
      requestId,
      decision,
      scope: decision === "allow_session" ? "session" : "once",
    });
  }

  function interruptImpl(sessionId: string): void {
    const session = getSession(sessionId);
    harnesses.get(session.harness)?.interrupt(session);
  }

  function listSessions(all: boolean): unknown[] {
    return store
      .list()
      .filter((s) => all || !meta.get(s.sessionId)?.archived)
      .map((s) => ({ ...s, ...(meta.get(s.sessionId) ?? {}) }));
  }

  function harnessList(): unknown {
    const caps: Record<string, { permissions: boolean; resume: boolean }> = {
      orchestra: { permissions: false, resume: false },
      opencode: { permissions: true, resume: true },
      pi: { permissions: true, resume: true },
      builtin: { permissions: true, resume: true },
    };
    return { harnesses: [...harnesses.keys()].map((id) => ({ id, capabilities: caps[id] ?? {} })) };
  }

  // ------------------------------------------------------------------
  // WebSocket transport (RFC §3): events out, requests in, one per client.
  // Auth is the first message: {"type":"hello","payload":{"token":...}}.
  // ------------------------------------------------------------------

  interface WsClient {
    conn: WsConn;
    auth: ReturnType<Authenticator["checkToken"]>;
    /** sessionId -> last pushed seq (snapshot/tail dedupe). */
    subs: Map<string, number>;
    senders: Map<string, (env: Envelope) => void>;
  }

  function wsSubscribe(client: WsClient, sessionId: string, initialLastSeq = 0): void {
    if (client.subs.has(sessionId)) return;
    let lastSeq = initialLastSeq;
    const sender = (env: Envelope) => {
      if (env.seq <= lastSeq) return; // snapshot already covers it
      lastSeq = env.seq;
      client.subs.set(sessionId, lastSeq);
      client.conn.send(JSON.stringify(env));
    };
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    set.add(sender);
    client.senders.set(sessionId, sender);
    client.subs.set(sessionId, lastSeq);
  }

  function wsUnsubscribeAll(client: WsClient): void {
    for (const [sessionId, sender] of client.senders) {
      subscribers.get(sessionId)?.delete(sender);
    }
    client.senders.clear();
    client.subs.clear();
  }

  function wsDispatch(client: WsClient, text: string): void {
    let msg: { id?: string; type?: string; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      client.conn.send(reply("", "error", { code: "bad_json", message: "unparseable frame" }));
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : "";
    const p = msg.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const ok = (extra: Record<string, unknown> = {}) => client.conn.send(reply(id, "ok", extra, sessionId));
    const err = (code: string, message: string) => client.conn.send(reply(id, "error", { code, message }, sessionId));

    try {
      switch (msg.type) {
        case "session.create":
          void createSessionImpl(p as Parameters<typeof createSessionImpl>[0])
            .then((newId) => ok({ sessionId: newId }))
            .catch((e) => err("create_failed", String((e as Error).message ?? e).slice(0, 200)));
          return;
        case "session.list":
          ok({ sessions: listSessions(p.all === true) });
          return;
        case "session.resume": {
          const sid = sessionId;
          const snap = store.fold(sid);
          if (!snap) {
            err("no_such_session", "no such session");
            return;
          }
          wsSubscribe(client, sid, snap.lastSeq); // live events first, then snapshot + stored tail
          const env = makeEnvelope(sid, "snapshot", snap);
          env.seq = snap.lastSeq;
          client.conn.send(JSON.stringify(env));
          // Stored tail through the same lastSeq guard as live pushes, so an
          // event emitted between fold() and this loop is never sent twice.
          const sender = client.senders.get(sid);
          for (const e of store.events(sid)) sender?.(e);
          ok({ lastSeq: snap.lastSeq });
          return;
        }
        case "prompt.send": {
          const text = typeof p.text === "string" ? p.text : "";
          if (!sessionId || !text) {
            err("bad_request", "sessionId and text required");
            return;
          }
          void promptImpl(sessionId, text).then(() => ok(), (e) => err("prompt_failed", String((e as Error).message ?? e).slice(0, 200)));
          return;
        }
        case "interrupt":
          if (!sessionId) {
            err("bad_request", "sessionId required");
            return;
          }
          interruptImpl(sessionId);
          ok();
          return;
        case "permission.respond": {
          const requestId = typeof p.requestId === "string" ? p.requestId : "";
          const decision = typeof p.decision === "string" ? p.decision : "deny";
          if (!sessionId || !requestId) {
            err("bad_request", "sessionId and requestId required");
            return;
          }
          void permissionImpl(sessionId, requestId, decision).then(() => ok(), (e) => err("permission_failed", String((e as Error).message ?? e).slice(0, 200)));
          return;
        }
        case "harness.list":
          ok(harnessList() as Record<string, unknown>);
          return;
        default:
          err("unknown_request", `unsupported request type: ${String(msg.type)}`);
      }
    } catch (e) {
      err("request_failed", String((e as Error).message ?? e).slice(0, 200));
    }
  }

  function handleUpgrade(req: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const conn = WsConn.accept(req, socket);
    if (!conn) return;
    if (head.length > 0) conn.feed(head);
    let client: WsClient | null = null;
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) conn.close(4001, "authentication timeout");
    }, HELLO_TIMEOUT_MS);

    // Pre-auth phase: the first frame must be the hello envelope.
    conn.setHandlers({
      onMessage: (text: string) => {
        let msg: { type?: string; payload?: { token?: string } };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          conn.close(4002, "bad json");
          return;
        }
        if (msg.type !== "hello") {
          conn.close(4001, "expected hello first");
          return;
        }
        const info = auth.checkToken(String(msg.payload?.token ?? ""), req.headers);
        if (!info) {
          conn.close(4003, "invalid token");
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        client = { conn, auth: info, subs: new Map(), senders: new Map() };
        conn.send(reply("", "ok", { via: info.via, deviceId: info.deviceId }, ""));
        conn.setHandlers({
          onMessage: (t: string) => wsDispatch(client as WsClient, t),
          onClose: () => {
            if (client) wsUnsubscribeAll(client);
          },
        });
      },
      onClose: () => clearTimeout(helloTimer),
    });
  }

  // ------------------------------------------------------------------
  // HTTP server
  // ------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // CORS preflight for browser/webview clients (Tauri companion app, PWA):
    // auth is a Bearer header, not cookies, so "*" relaxes nothing.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }
    try {
      // Web transcript UI (public; the page itself asks for the daemon token).
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        const html = await readFile(
          fileURLToPath(new URL("../public/index.html", import.meta.url)),
          "utf8",
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true, sessions: meta.size });
        return;
      }

      // Pairing: the code itself is the credential (rate-limited, single-use).
      if (req.method === "POST" && path === "/api/pair") {
        const ip = req.socket.remoteAddress ?? "?";
        const throttled = devices.throttle(ip);
        if (throttled) {
          json(res, 429, { error: throttled });
          return;
        }
        const body = JSON.parse((await readBody(req)) || "{}") as { code?: string; name?: string };
        if (!body.code) {
          json(res, 400, { error: "code required" });
          return;
        }
        try {
          const identity = auth.proxyIdentity(req);
          const { device, token } = await devices.pair(body.code, body.name ?? "device", identity);
          console.log(`[pair] device paired: ${device.id} (${device.name})${identity ? ` identity=${identity}` : ""}`);
          json(res, 200, { deviceId: device.id, token });
        } catch (err) {
          json(res, 403, { error: String((err as Error).message ?? err) });
        }
        return;
      }

      if (!auth.check(req)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      // Mint a new pairing code (from an already-trusted device).
      if (req.method === "POST" && path === "/api/pair/code") {
        const { code, expiresAt } = devices.mintCode();
        json(res, 200, { code, expiresAt: new Date(expiresAt).toISOString() });
        return;
      }

      // Device management: list + revoke.
      if (req.method === "GET" && path === "/api/device") {
        json(res, 200, { devices: devices.list() });
        return;
      }
      const revokeMatch = path.match(/^\/api\/device\/([\w-]+)\/revoke$/);
      if (req.method === "POST" && revokeMatch) {
        const okRevoked = devices.revoke(revokeMatch[1]);
        if (!okRevoked) {
          json(res, 404, { error: "no such device" });
          return;
        }
        console.log(`[pair] device revoked: ${revokeMatch[1]}`);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === "/api/harnesses") {
        json(res, 200, harnessList());
        return;
      }

      // POST /api/session - create a session on a harness
      if (req.method === "POST" && path === "/api/session") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          workspace?: string;
          harness?: string;
          model?: string;
          system?: string;
          name?: string;
        };
        try {
          const sessionId = await createSessionImpl(body);
          json(res, 200, { sessionId });
        } catch (err) {
          json(res, 400, { error: String((err as Error).message ?? err) });
        }
        return;
      }

      // GET /api/session - list sessions (archived ones only with ?all=1)
      if (req.method === "GET" && path === "/api/session") {
        const all = new URL(req.url ?? "/", "http://localhost").searchParams.get("all") === "1";
        json(res, 200, { sessions: listSessions(all) });
        return;
      }

      // POST /api/session/:id/rename {name} / archive {} - metadata updates,
      // persisted as session.updated events so they survive restarts (R2).
      const metaMatch = path.match(/^\/api\/session\/([\w-]+)\/(rename|archive)$/);
      if (req.method === "POST" && metaMatch) {
        const sessionId = metaMatch[1];
        const action = metaMatch[2];
        const session = meta.get(sessionId);
        if (!session) {
          json(res, 404, { error: "no such session" });
          return;
        }
        const body = action === "rename"
          ? (JSON.parse((await readBody(req)) || "{}") as { name?: string })
          : {};
        const name = action === "rename" ? (body.name ?? "").trim().slice(0, 80) : undefined;
        if (action === "rename" && !name) {
          json(res, 400, { error: "name required" });
          return;
        }
        const archived = action === "archive" ? true : undefined;
        if (archived) {
          // Stop live harness children for the session (pi RPC proc, etc.).
          const impl = harnesses.get(session.harness);
          impl?.respondPermission(session, "", "deny");
          impl?.interrupt?.(session);
        }
        const emit = emitFor(sessionId);
        await emit("session.updated", {
          ...(name !== undefined ? { name } : {}),
          ...(archived !== undefined ? { archived } : {}),
        });
        if (name !== undefined) session.name = name;
        if (archived !== undefined) session.archived = archived;
        json(res, 200, { ok: true, name, archived });
        return;
      }

      let m: RegExpMatchArray | null;

      // POST /api/session/:id/permission-request - called by harness-side
      // approval gates (e.g. the opensocket pi extension). Emits the OSSP
      // permission.request and long-polls until the client decides.
      m = path.match(/^\/api\/session\/([\w-]+)\/permission-request$/);
      if (req.method === "POST" && m) {
        const sessionId = m[1];
        if (!meta.has(sessionId)) {
          json(res, 404, { error: "no such session" });
          return;
        }
        const body = JSON.parse((await readBody(req)) || "{}") as {
          tool?: string;
          argsSummary?: string;
        };
        const decision = await gate.ask(
          emitFor(sessionId),
          sessionId,
          body.tool ?? "unknown",
          body.argsSummary ?? "",
        );
        json(res, 200, { decision });
        return;
      }

      m = path.match(/^\/api\/session\/([\w-]+)\/(prompt|permission|interrupt)$/);
      if (req.method === "POST" && m) {
        const sessionId = m[1];
        const action = m[2];
        try {
          if (action === "prompt") {
            const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
            await promptImpl(sessionId, body.text ?? "");
            json(res, 200, { ok: true });
            return;
          }
          if (action === "permission") {
            const body = JSON.parse((await readBody(req)) || "{}") as {
              requestId?: string;
              decision?: string;
            };
            await permissionImpl(sessionId, body.requestId ?? "", body.decision ?? "deny");
            json(res, 200, { ok: true });
            return;
          }
          // interrupt
          interruptImpl(sessionId);
          json(res, 200, { ok: true });
          return;
        } catch (err) {
          json(res, err instanceof Error && err.message === "no such session" ? 404 : 500, {
            error: String((err as Error).message ?? err),
          });
          return;
        }
      }

      m = path.match(/^\/api\/session\/([\w-]+)\/snapshot$/);
      if (req.method === "GET" && m) {
        const snap = store.fold(m[1]);
        if (!snap) {
          json(res, 404, { error: "no such session" });
          return;
        }
        json(res, 200, snap);
        return;
      }

      m = path.match(/^\/sse\/([\w-]+)$/);
      if (req.method === "GET" && m) {
        const sessionId = m[1];
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        const write = (env: Envelope) => {
          res.write(`id: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`);
        };
        for (const env of store.events(sessionId)) write(env); // replay
        let set = subscribers.get(sessionId);
        if (!set) {
          set = new Set();
          subscribers.set(sessionId, set);
        }
        set.add(write);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => {
          clearInterval(heartbeat);
          set?.delete(write);
        });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      handleUpgrade(req, socket as import("node:net").Socket, head);
    } catch (err) {
      console.log(`[ws] upgrade failed: ${String(err).slice(0, 120)}`);
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const addr = server.address() as AddressInfo;
  console.log(
    `opensocketd v0 on :${addr.port} (orchestra: ${cfg.orchestraUrl}, opencode: ${cfg.opencodeUrl}) - ${restored} events restored${notifier.configured ? " - notifications: on" : ""}`,
  );

  // Pairing banner: with no paired devices, mint a code so the first phone/
  // browser can pair immediately (PLAN §4.4: daemon prints a code, no cloud).
  if (devices.count === 0) {
    const { code, expiresAt } = devices.mintCode();
    const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    console.log("");
    console.log("  ─── Pair your first device ───");
    console.log(`  Open http://localhost:${addr.port} and choose "Pair with code", or:`);
    console.log(`  curl -X POST http://localhost:${addr.port}/api/pair \\`);
    console.log(`    -H 'content-type: application/json' -d '{"code":"${code}","name":"my phone"}'`);
    console.log(`  Code (expires in ${mins} min): ${code}`);
    if (!cfg.daemonToken) {
      console.log("  WARNING: open mode - no auth until a device is paired or DAEMON_TOKEN is set.");
    }
    console.log("");
  }

  return server;
}
