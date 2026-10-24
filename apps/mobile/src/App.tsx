import { useEffect, useRef, useState } from "preact/hooks";
import { OpenSocketClient } from "@opensocket/client";
import type { SessionSummary } from "@opensocket/client";
import type { Envelope, Snapshot } from "@opensocket/protocol";

/**
 * OpenSocket companion app (ADR 0001): a reading surface over OSSP.
 * Everything transport-related lives in @opensocket/client — this file only
 * renders state and maps user intent onto client calls.
 */

type Item =
  | { kind: "msg"; id: string; role: string; text: string }
  | { kind: "tool"; id: string; name: string; status: string; summary: string }
  | { kind: "perm"; id: string; tool: string; args: string; decided?: string }
  | { kind: "banner"; id: string; text: string };

const LS_BASE = "os_base";
const LS_TOKEN = "os_token";
const FALLBACK_HARNESS = ["builtin", "pi", "opencode", "orchestra"];

interface DeviceRow {
  deviceId: string;
  name?: string;
  pairedAt?: string;
  lastSeen?: string;
}

function md(text: string): string {
  let h = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  h = h.replace(/```([\s\S]*?)```/g, (_m, c: string) => `<pre><code>${c.trim()}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return h.replace(/\n/g, "<br>");
}

function upsertMsg(items: Item[], id: string, role: string, text: string, append: boolean): Item[] {
  const i = items.findIndex((it) => it.kind === "msg" && it.id === id);
  if (i < 0) return [...items, { kind: "msg", id, role, text }];
  const old = items[i] as Extract<Item, { kind: "msg" }>;
  const next = append ? old.text + text : text;
  const copy = items.slice();
  copy[i] = { ...old, role, text: next };
  return copy;
}

function upsertTool(items: Item[], p: Record<string, unknown>): Item[] {
  const id = String(p.toolId);
  const i = items.findIndex((it) => it.kind === "tool" && it.id === id);
  const card: Item = {
    kind: "tool",
    id,
    name: String(p.name ?? "tool"),
    status: String(p.status ?? "running"),
    summary: String(p.argsSummary ?? ""),
  };
  if (i < 0) return [...items, card];
  const copy = items.slice();
  copy[i] = { ...(items[i] as Extract<Item, { kind: "tool" }>), ...card };
  return copy;
}

export function App() {
  const [base, setBase] = useState(localStorage.getItem(LS_BASE) ?? "http://localhost:8098");
  const [token, setToken] = useState(localStorage.getItem(LS_TOKEN) ?? "");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const [client, setClient] = useState<OpenSocketClient | null>(null);
  const [transport, setTransport] = useState<"ws" | "sse" | "off">("off");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("idle");
  const [usage, setUsage] = useState({ in: 0, out: 0 });
  const [draft, setDraft] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"sessions" | "devices">("sessions");
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [pairCode, setPairCode] = useState("");
  const [harnessOpts, setHarnessOpts] = useState<string[]>(FALLBACK_HARNESS);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [form, setForm] = useState({
    harness: "builtin",
    model: "",
    workspace: "default",
    name: "",
    system: "",
  });

  const clientRef = useRef<OpenSocketClient | null>(null);
  const currentRef = useRef<string | null>(null);
  clientRef.current = client;
  currentRef.current = current;
  const logRef = useRef<HTMLDivElement | null>(null);

  function loadSnapshot(snap: Snapshot): void {
    const list: Item[] = [];
    for (const m of snap.messages ?? []) {
      list.push({ kind: "msg", id: m.messageId, role: m.role || "assistant", text: m.text || "" });
    }
    const seen = new Set<string>();
    for (const t of snap.tools ?? []) {
      if (seen.has(t.toolId)) continue;
      seen.add(t.toolId);
      list.push({ kind: "tool", id: t.toolId, name: t.name, status: t.status, summary: "" });
    }
    setItems(list);
    setUsage({ in: snap.usage?.tokensIn ?? 0, out: snap.usage?.tokensOut ?? 0 });
    setStatus("idle");
  }

  function applyEvent(env: Envelope): void {
    const p = env.payload as Record<string, unknown>;
    switch (env.type) {
      case "message.delta":
        setItems((xs) => upsertMsg(xs, String(p.messageId), String(p.role ?? "assistant"), String(p.text ?? ""), true));
        break;
      case "message.completed":
        setItems((xs) => upsertMsg(xs, String(p.messageId), String(p.role ?? "assistant"), String(p.text ?? ""), false));
        break;
      case "tool.call":
        setItems((xs) => upsertTool(xs, p));
        break;
      case "tool.result":
        setItems((xs) =>
          xs.map((it) =>
            it.kind === "tool" && it.id === p.toolId
              ? { ...it, status: p.isError ? "error" : "done", summary: String(p.summary ?? it.summary) }
              : it,
          ),
        );
        break;
      case "permission.request":
        setItems((xs) => [
          ...xs,
          { kind: "perm", id: String(p.requestId), tool: String(p.tool ?? "tool"), args: String(p.argsSummary ?? "") },
        ]);
        break;
      case "permission.resolved":
        setItems((xs) =>
          xs.map((it) => (it.kind === "perm" && it.id === p.requestId ? { ...it, decided: String(p.decision) } : it)),
        );
        break;
      case "status":
        setStatus(typeof p === "string" ? p : "idle");
        break;
      case "usage":
        setUsage({ in: Number(p.tokensIn ?? 0), out: Number(p.tokensOut ?? 0) });
        break;
      case "error":
        setItems((xs) => [...xs, { kind: "banner", id: env.id, text: String(p.message ?? "error") }]);
        break;
    }
  }

  // Client listeners registered once; state setters are all functional, and
  // session filtering goes through refs. The snapshot event fires before the
  // stored tail, so reset-then-apply keeps ordering correct — do not load
  // from subscribe()'s return value instead.
  useEffect(() => {
    if (!client) return;
    const onTransport = (m: "ws" | "sse" | "off") => setTransport(m);
    const onSnapshot = (sid: string, snap: Snapshot) => {
      if (sid === currentRef.current) loadSnapshot(snap);
    };
    const onEnvelope = (env: Envelope) => {
      if (env.sessionId === currentRef.current) applyEvent(env);
    };
    const onError = (err: Error) => setNotice(err.message || String(err));
    client.on("transport", onTransport).on("snapshot", onSnapshot).on("envelope", onEnvelope).on("error", onError);
    return () => {
      client.off("transport", onTransport).off("snapshot", onSnapshot).off("envelope", onEnvelope).off("error", onError);
    };
  }, [client]);

  // Keep the transcript pinned to the bottom while streaming.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, status]);

  async function refresh(c: OpenSocketClient): Promise<void> {
    setSessions(await c.sessions(true).catch(() => []));
    const hs = await c.harnesses().catch(() => []);
    if (hs.length > 0) {
      const ids = hs.map((h) => (typeof h === "string" ? h : String((h as { id?: string }).id ?? h))).filter(Boolean);
      if (ids.length) setHarnessOpts(ids);
    }
  }

  async function refreshDevices(c: OpenSocketClient): Promise<void> {
    setDevices((await c.devices().catch(() => [])) as DeviceRow[]);
  }

  async function adopt(c: OpenSocketClient): Promise<void> {
    setClient(c);
    await c.connect();
    await refresh(c);
  }

  async function connect(): Promise<void> {
    setNotice("");
    const c = new OpenSocketClient({ baseUrl: base.trim(), token: token.trim() });
    localStorage.setItem(LS_BASE, base.trim());
    localStorage.setItem(LS_TOKEN, token.trim());
    try {
      await c.connect();
    } catch {
      setNotice("daemon refused that token — pair with a code below");
      return;
    }
    await adopt(c);
    await refreshDevices(c);
  }

  async function pair(): Promise<void> {
    setNotice("");
    const c = new OpenSocketClient({ baseUrl: base.trim(), token: "" });
    try {
      const { token: t } = await c.pair(code.trim(), "opensocket-mobile");
      setToken(t);
      localStorage.setItem(LS_BASE, base.trim());
      localStorage.setItem(LS_TOKEN, t);
      setCode("");
      await adopt(c);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function openSession(sid: string): Promise<void> {
    const c = clientRef.current;
    if (!c) return;
    currentRef.current = sid;
    setCurrent(sid);
    setItems([]);
    setStatus("idle");
    setUsage({ in: 0, out: 0 });
    setDrawer(false);
    setNotice("");
    await c.subscribe(sid);
  }

  async function newSession(): Promise<void> {
    const c = clientRef.current;
    if (!c) return;
    try {
      const { sessionId } = await c.createSession({
        harness: form.harness,
        model: form.model.trim() || undefined,
        workspace: form.workspace.trim() || "default",
        name: form.name.trim() || undefined,
        system: form.system.trim() || undefined,
      });
      setForm((f) => ({ ...f, model: "", name: "", system: "" }));
      await refresh(c);
      await openSession(sessionId);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function rename(sid: string): Promise<void> {
    const c = clientRef.current;
    if (!c || !editName.trim()) return;
    await c.renameSession(sid, editName.trim()).catch((e) => setNotice(String(e)));
    setEditing(null);
    await refresh(c);
  }

  async function archive(sid: string): Promise<void> {
    const c = clientRef.current;
    if (!c) return;
    await c.archiveSession(sid).catch((e) => setNotice(String(e)));
    if (currentRef.current === sid) {
      currentRef.current = null;
      setCurrent(null);
      setItems([]);
    }
    await refresh(c);
  }

  async function mintCode(): Promise<void> {
    const c = clientRef.current;
    if (!c) return;
    try {
      const { code } = await c.mintPairingCode();
      setPairCode(code);
      await refreshDevices(c);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function revoke(deviceId: string): Promise<void> {
    const c = clientRef.current;
    if (!c) return;
    await c.revokeDevice(deviceId).catch((e) => setNotice(String(e)));
    await refreshDevices(c);
  }

  async function send(): Promise<void> {
    const c = clientRef.current;
    const text = draft.trim();
    if (!c || !current || !text) return;
    setDraft("");
    try {
      await c.prompt(current, text);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function stop(): Promise<void> {
    if (clientRef.current && current) await clientRef.current.interrupt(current);
  }

  async function decide(requestId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    if (clientRef.current && current) {
      await clientRef.current.respondPermission(current, requestId, decision).catch(() => {});
    }
  }

  // ------------------------------------------------------------------

  if (!client) {
    return (
      <div class="setup">
        <h1>OpenSocket</h1>
        <p class="dim">Your daemon. Your hardware. Your models.</p>
        <label>
          Daemon URL
          <input value={base} onInput={(e) => setBase(e.currentTarget.value)} spellcheck={false} />
        </label>
        <label>
          Device token
          <input
            type="password"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            placeholder="paste a paired token"
          />
        </label>
        <button class="primary" onClick={connect}>
          Connect
        </button>
        <div class="sep">or pair with a code</div>
        <label>
          Pairing code
          <input
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
            placeholder="six words from the daemon console"
          />
        </label>
        <button class="primary" onClick={pair}>
          Pair
        </button>
        {notice ? <div class="banner">{notice}</div> : null}
      </div>
    );
  }

  const live = sessions.filter((s) => !s.archived);
  const currentSession = sessions.find((s) => s.sessionId === current);

  return (
    <div class="shell">
      <header>
        <button onClick={() => setDrawer(!drawer)} title="Sessions">
          ☰
        </button>
        <strong>{currentSession ? currentSession.name || "session" : "OpenSocket"}</strong>
        <span class={`pill ${transport}`}>{transport}</span>
        <span class={`pill ${status === "running" || status === "thinking" ? "run" : status === "error" ? "err" : ""}`}>
          {status}
        </span>
        <span class="pill grow right">
          {usage.in}/{usage.out} tok
        </span>
        <button
          class="ghost"
          title="disconnect (session stays on the daemon)"
          onClick={() => {
            clientRef.current?.close();
            setClient(null);
            setCurrent(null);
            setItems([]);
            setTransport("off");
          }}
        >
          ⏏
        </button>
      </header>

      {drawer ? (
        <div class="drawer">
          <div class="tabs">
            <button class={drawerTab === "sessions" ? "tab on" : "tab"} onClick={() => setDrawerTab("sessions")}>
              Sessions
            </button>
            <button class={drawerTab === "devices" ? "tab on" : "tab"} onClick={() => { setDrawerTab("devices"); if (client) refreshDevices(client); }}>
              Devices
            </button>
            <span class="grow" />
            <button class="tab" onClick={() => refresh(client)} title="reload">
              ⟳
            </button>
          </div>

          {drawerTab === "sessions" ? (
            <>
              <div class="row">
                <button class="primary" onClick={newSession}>
                  + New session
                </button>
              </div>
              <div class="form">
                <div class="row">
                  <select value={form.harness} onInput={(e) => setForm({ ...form, harness: e.currentTarget.value })}>
                    {harnessOpts.map((h) => (
                      <option value={h} key={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="model (optional)"
                    value={form.model}
                    onInput={(e) => setForm({ ...form, model: e.currentTarget.value })}
                    spellcheck={false}
                  />
                </div>
                <div class="row">
                  <input
                    placeholder="workspace"
                    value={form.workspace}
                    onInput={(e) => setForm({ ...form, workspace: e.currentTarget.value })}
                    spellcheck={false}
                  />
                  <input
                    placeholder="name (optional)"
                    value={form.name}
                    onInput={(e) => setForm({ ...form, name: e.currentTarget.value })}
                    spellcheck={false}
                  />
                </div>
                <input
                  placeholder="system prompt (optional)"
                  value={form.system}
                  onInput={(e) => setForm({ ...form, system: e.currentTarget.value })}
                  spellcheck={false}
                />
              </div>
              {live.map((s) => (
                <div
                  class={`sess ${s.sessionId === current ? "cur" : ""}`}
                  onClick={() => openSession(s.sessionId)}
                  key={s.sessionId}
                >
                  {editing === s.sessionId ? (
                    <span class="row" onClick={(e) => e.stopPropagation()}>
                      <input
                        value={editName}
                        onInput={(e) => setEditName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void rename(s.sessionId);
                        }}
                        spellcheck={false}
                      />
                      <button class="primary" onClick={() => void rename(s.sessionId)}>
                        save
                      </button>
                      <button onClick={() => setEditing(null)}>×</button>
                    </span>
                  ) : (
                    <>
                      <div class="nm">{s.name || s.sessionId.slice(0, 16) + "…"}</div>
                      <div class="meta">
                        <span>{s.harness}</span>
                        {s.model ? <span>· {s.model}</span> : null}
                        {s.workspace ? <span>· {s.workspace}</span> : null}
                        {s.usage ? (
                          <span>
                            · {s.usage.tokensIn ?? 0}/{s.usage.tokensOut ?? 0} tok
                            {s.usage.costEstimate ? ` · $${Number(s.usage.costEstimate).toFixed(4)}` : ""}
                          </span>
                        ) : null}
                      </div>
                      <div class="acts">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(s.sessionId);
                            setEditName(s.name || "");
                          }}
                        >
                          rename
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void archive(s.sessionId);
                          }}
                        >
                          archive
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              {live.length === 0 ? <div class="dim pad">no sessions yet</div> : null}
              {sessions.some((s) => s.archived) ? (
                <>
                  <div class="archh">archived</div>
                  {sessions
                    .filter((s) => s.archived)
                    .map((s) => (
                      <div class="sess archived" key={s.sessionId}>
                        <div class="nm">{s.name || s.sessionId.slice(0, 16) + "…"}</div>
                        <div class="meta">{s.harness}</div>
                      </div>
                    ))}
                </>
              ) : null}
            </>
          ) : null}

          {drawerTab === "devices" ? (
            <>
              <div class="row">
                <button class="primary" onClick={mintCode}>
                  Mint pairing code
                </button>
              </div>
              {pairCode ? (
                <div class="paircode" onClick={() => navigator.clipboard?.writeText(pairCode)} title="tap to copy">
                  {pairCode}
                </div>
              ) : null}
              {devices.map((d) => (
                <div class="sess" key={d.deviceId}>
                  <div class="nm">{d.name || d.deviceId.slice(0, 12)}</div>
                  <div class="meta">
                    {d.lastSeen ? <span>last seen {d.lastSeen}</span> : null}
                    <span class="grow" />
                    <button class="danger" onClick={() => revoke(d.deviceId)}>
                      revoke
                    </button>
                  </div>
                </div>
              ))}
              {devices.length === 0 ? <div class="dim pad">no paired devices</div> : null}
              <div class="dim pad small">
                Pairing code + revoke apply to the daemon — any device you revoke
                loses access immediately.
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <main ref={logRef} class="log">
        {!current ? <div class="dim pad">Open a session from the ☰ menu.</div> : null}
        {items.map((it) => {
          if (it.kind === "msg") {
            return (
              <div class={`msg ${it.role}`} key={it.id}>
                <div class="role">{it.role}</div>
                <div dangerouslySetInnerHTML={{ __html: md(it.text || "(…)") }} />
              </div>
            );
          }
          if (it.kind === "tool") {
            return (
              <details class="tool" key={it.id}>
                <summary>
                  tool {it.name} {it.status === "done" ? "✓" : it.status === "error" ? "✗" : "…"}
                </summary>
                <pre>{it.summary}</pre>
              </details>
            );
          }
          if (it.kind === "perm") {
            return (
              <div class="perm" key={it.id}>
                <div class="ptitle">approval needed: {it.tool}</div>
                <pre>{it.args || "(no arguments)"}</pre>
                {it.decided ? (
                  <div class="pdone">decision: {it.decided}</div>
                ) : (
                  <div class="prow">
                    <button onClick={() => decide(it.id, "allow_once")}>Allow once</button>
                    <button onClick={() => decide(it.id, "allow_session")}>Always</button>
                    <button class="danger" onClick={() => decide(it.id, "deny")}>
                      Deny
                    </button>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div class="banner" key={it.id}>
              {it.text}
            </div>
          );
        })}
      </main>

      {notice ? <div class="banner pad">{notice}</div> : null}

      <footer>
        <textarea
          rows={2}
          placeholder={current ? "Say something…" : "open a session first"}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <button class="primary" onClick={send} disabled={!current}>
          Send
        </button>
        <button onClick={stop} disabled={!current}>
          Stop
        </button>
      </footer>
    </div>
  );
}
