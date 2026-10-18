import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { makeEnvelope, type Envelope } from "@opensocket/protocol";
import type { Config } from "./env.ts";
import { checkAuth } from "./auth.ts";
import { SessionStore } from "./store.ts";
import type { Emit, Harness, SessionMeta } from "./harness.ts";
import { OrchestraHarness } from "./orchestra.ts";
import { OpencodeHarness } from "./opencode.ts";
import { PiHarness } from "./pi.ts";
import { BuiltinHarness } from "./builtin.ts";
import { ApprovalGate } from "./approvals.ts";
import { Notifier } from "./notify.ts";

/**
 * M0 server (PLAN §6 M0): JSONL persistence, per-session SSE fan-out with
 * replay, and harness routing (orchestra validated, opencode WIP).
 * Auth is a shared bearer token until M1 pairing lands.
 */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
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

export async function startServer(cfg: Config): Promise<http.Server> {
  const store = new SessionStore(cfg.dataDir);
  const restored = await store.loadAll();

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
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

      if (!checkAuth(req, cfg)) {
        json(res, 401, { error: "unauthorized" });
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
        const harness = body.harness ?? "orchestra";
        const impl = harnesses.get(harness);
        if (!impl) {
          json(res, 400, { error: `unknown harness: ${harness}` });
          return;
        }
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
        json(res, 200, { sessionId });
        return;
      }

      // GET /api/session - list sessions (archived ones only with ?all=1)
      if (req.method === "GET" && path === "/api/session") {
        const all = new URL(req.url ?? "/", "http://localhost").searchParams.get("all") === "1";
        const sessions = store.list()
          .filter((s) => {
            const m = meta.get(s.sessionId);
            return all || !m?.archived;
          })
          .map((s) => ({
            ...s,
            ...(meta.get(s.sessionId) ?? {}),
          }));
        json(res, 200, { sessions });
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
        const session = meta.get(sessionId);
        if (!session) {
          json(res, 404, { error: "no such session" });
          return;
        }
        const impl = harnesses.get(session.harness);
        if (!impl) {
          json(res, 500, { error: "harness missing" });
          return;
        }
        const emit = emitFor(sessionId);

        if (action === "prompt") {
          const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
          const text = body.text ?? "";
          const userMessageId = `user_${store.nextSeq(sessionId)}`;
          await emit("message.delta", { messageId: userMessageId, role: "user", text });
          await emit("message.completed", { messageId: userMessageId, role: "user", text, stopReason: "sent" });
          // Fire-and-forget: the run streams out via SSE; failures land as error events.
          impl.sendPrompt(session, text, emit).catch(async (err) => {
            await emit("error", { code: "harness_error", message: String(err), retryable: true });
            await emit("status", "error");
          });
          json(res, 200, { ok: true });
          return;
        }

        if (action === "permission") {
          const body = JSON.parse((await readBody(req)) || "{}") as {
            requestId?: string;
            decision?: string;
          };
          const requestId = body.requestId ?? "";
          const decision = body.decision ?? "deny";
          impl.respondPermission(session, requestId, decision);
          gate.resolve(sessionId, requestId, decision);
          await emitFor(sessionId)("permission.resolved", { requestId, decision, scope: decision === "allow_session" ? "session" : "once" });
          json(res, 200, { ok: true });
          return;
        }

        // interrupt
        impl.interrupt(session);
        json(res, 200, { ok: true });
        return;
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

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const addr = server.address() as AddressInfo;
  console.log(
    `opensocketd v0 on :${addr.port} (orchestra: ${cfg.orchestraUrl}, opencode: ${cfg.opencodeUrl}) - ${restored} events restored${notifier.configured ? " - notifications: on" : ""}`,
  );
  return server;
}
