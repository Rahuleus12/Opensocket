/**
 * M1 auth test: pairing, per-device tokens, revocation, devsecret fallback,
 * brute-force throttling, and optional proxy-identity binding — driven
 * against a real daemon child process.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface Child {
  proc: ReturnType<typeof spawn>;
  port: number;
  code: string;
}

async function startDaemon(env: Record<string, string>, wantBanner: boolean): Promise<Child> {
  const port = await freePort();
  const proc = spawn(process.execPath, ["apps/daemon/src/index.ts"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon not ready: ${output.slice(0, 400)}`)),
      20_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const ready = output.includes(`opensocketd v0 on :${port}`);
      const m = output.match(/Code \(expires in \d+ min\): ([a-z ]+)$/m);
      if (ready && (!wantBanner || m)) {
        clearTimeout(timer);
        resolve(wantBanner ? (m?.[1] ?? "") : "");
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited (${code}): ${output.slice(0, 400)}`));
    });
  });
  return { proc, port, code };
}

const dataDir = await mkdtemp(join(tmpdir(), "os-auth-"));
const d1 = await startDaemon(
  {
    DAEMON_TOKEN: "devsecret",
    OPENSOCKET_DATA: dataDir,
    ORCHESTRA_URL: "http://127.0.0.1:1",
    BUILTIN_BASE_URL: "http://127.0.0.1:1/v1",
    OPENCODE_URL: "http://127.0.0.1:1",
  },
  true,
);
const base = `http://127.0.0.1:${d1.port}`;

try {
  const H = (token: string) => ({ authorization: `Bearer ${token}` });

  // 1. health is public; API requires auth
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  console.log("ok  health public, api gated");

  // 2. banner code pairs a device
  assert.ok(d1.code.split(" ").length === 6, `banner code shape: ${d1.code}`);
  const pair = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: d1.code, name: "test phone" }),
  });
  assert.equal(pair.status, 200);
  const { deviceId, token } = (await pair.json()) as { deviceId: string; token: string };
  assert.ok(deviceId.startsWith("dev_"));
  assert.ok(token.length >= 64);
  console.log("ok  paired with banner code -> device token");

  // 3. device token works; wrong token does not; code is single-use
  assert.equal((await fetch(`${base}/api/session`, { headers: H(token) })).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: H("wrong" + token) })).status, 401);
  const reuse = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: d1.code, name: "again" }),
  });
  assert.equal(reuse.status, 403);
  console.log("ok  device token auth + single-use code");

  // 4. an authed device can mint a code for the next device
  const mint = await fetch(`${base}/api/pair/code`, { method: "POST", headers: H(token) });
  assert.equal(mint.status, 200);
  const { code: code2 } = (await mint.json()) as { code: string };
  const pair2 = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code2, name: "laptop" }),
  });
  assert.equal(pair2.status, 200);
  const dev2 = (await pair2.json()) as { deviceId: string; token: string };
  console.log("ok  authed device mints new pairing code");

  // 5. device list + revocation
  const list = await fetch(`${base}/api/device`, { headers: H(token) });
  const { devices } = (await list.json()) as { devices: { id: string; name: string; revoked: boolean }[] };
  assert.equal(devices.filter((d) => !d.revoked).length, 2);
  const revoke = await fetch(`${base}/api/device/${dev2.deviceId}/revoke`, {
    method: "POST",
    headers: H(token),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: H(dev2.token) })).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { headers: H(token) })).status, 200);
  console.log("ok  revocation kills only the revoked device");

  // 6. shared devsecret still works (loudly dev-only path)
  assert.equal((await fetch(`${base}/api/session`, { headers: H("devsecret") })).status, 200);
  console.log("ok  devsecret fallback works");

  // 7. brute-force throttle: garbage codes eventually 429
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: `bogus code ${i}`, name: "x" }),
    });
    if (r.status === 429) {
      saw429 = true;
      break;
    }
  }
  assert.ok(saw429, "expected a 429 after repeated bad codes");
  console.log("ok  pairing brute-force throttle");

  // 8. persistence across restart: the paired token survives
  d1.proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  const d2 = await startDaemon(
    {
      DAEMON_TOKEN: "devsecret",
      OPENSOCKET_DATA: dataDir,
      ORCHESTRA_URL: "http://127.0.0.1:1",
      BUILTIN_BASE_URL: "http://127.0.0.1:1/v1",
      OPENCODE_URL: "http://127.0.0.1:1",
    },
    false, // devices exist now: no banner
  );
  try {
    assert.equal((await fetch(`http://127.0.0.1:${d2.port}/api/session`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${d2.port}/api/session`, { headers: H(dev2.token) })).status, 401);
    console.log("ok  devices persist across daemon restart");
  } finally {
    d2.proc.kill();
  }

  // 9. proxy identity binding (e.g. Tailscale WhoIS in front of the daemon)
  const dir2 = await mkdtemp(join(tmpdir(), "os-auth-id-"));
  const d3 = await startDaemon(
    {
      DAEMON_TOKEN: "devsecret",
      OPENSOCKET_DATA: dir2,
      ORCHESTRA_URL: "http://127.0.0.1:1",
      BUILTIN_BASE_URL: "http://127.0.0.1:1/v1",
      OPENCODE_URL: "http://127.0.0.1:1",
      OPENSOCKET_IDENTITY_HEADERS: "x-test-user",
      OPENSOCKET_IDENTITY_ENFORCE: "1",
    },
    true,
  );
  try {
    const b3 = `http://127.0.0.1:${d3.port}`;
    const p3 = await fetch(`${b3}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "alice@example.com" },
      body: JSON.stringify({ code: d3.code, name: "phone" }),
    });
    assert.equal(p3.status, 200);
    const t3 = (await p3.json()) as { token: string };
    // matching identity passes; mismatching is refused; absent is allowed
    assert.equal(
      (await fetch(`${b3}/api/session`, { headers: { ...H(t3.token), "x-test-user": "alice@example.com" } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${b3}/api/session`, { headers: { ...H(t3.token), "x-test-user": "mallory@example.com" } })).status,
      401,
    );
    assert.equal((await fetch(`${b3}/api/session`, { headers: H(t3.token) })).status, 200);
    const dev3 = await fetch(`${b3}/api/device`, { headers: H(t3.token) });
    const dl3 = (await dev3.json()) as { devices: { identity?: string }[] };
    assert.equal(dl3.devices[0].identity, "alice@example.com");
    console.log("ok  proxy identity recorded + enforced as second signal");
  } finally {
    d3.proc.kill();
  }
} finally {
  d1.proc.kill();
}

console.log("AUTH_OK");
