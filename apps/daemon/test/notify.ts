/**
 * Notify checks against a local ntfy stand-in: publish shape, event
 * filtering (permission/error/idle), idle cooldown, unconfigured no-op.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { Notifier } from "../src/notify.ts";

const received: { title: string; priority: string; body: string; tags: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    received.push({
      title: String(req.headers.title ?? ""),
      priority: String(req.headers.priority ?? "3"),
      body,
      tags: String(req.headers.tags ?? ""),
    });
    res.writeHead(200);
    res.end("OK");
  });
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;

const notifier = new Notifier(`http://127.0.0.1:${port}/opensocket-test`, "secret");
const settle = () => new Promise((r) => setTimeout(r, 120));

// 1. raw publish shape
await notifier.notify("Hello", "World", 4, ["bell"]);
assert.equal(received.length, 1);
assert.equal(received[0].title, "Hello");
assert.equal(received[0].priority, "4");
assert.equal(received[0].body, "World");
assert.equal(received[0].tags, "bell");
console.log("ok  publish");

// 2. permission.request -> high-priority approval push
notifier.onOsspEvent("s1", "permission.request", { tool: "bash", argsSummary: "rm -rf ./build" }, { harness: "pi", workspace: "w" });
await settle();
assert.equal(received.length, 2);
assert.ok(received[1].title.includes("bash"));
assert.equal(received[1].priority, "4");
assert.ok(received[1].body.includes("pi · w"));
console.log("ok  permission push");

// 3. error -> high-priority push
notifier.onOsspEvent("s1", "error", { message: "provider exploded" }, { harness: "pi", workspace: "w" });
await settle();
assert.equal(received.length, 3);
assert.ok(received[2].body.includes("provider exploded"));
console.log("ok  error push");

// 4. idle fires once, then cooldown suppresses
notifier.onOsspEvent("s1", "status", "idle", { harness: "pi", workspace: "w" });
await settle();
assert.equal(received.length, 4);
notifier.onOsspEvent("s1", "status", "idle", { harness: "pi", workspace: "w" });
await settle();
assert.equal(received.length, 4, "idle cooldown failed");
notifier.onOsspEvent("s1", "status", "running", { harness: "pi", workspace: "w" }); // ignored type
await settle();
assert.equal(received.length, 4);
console.log("ok  idle cooldown + ignored types");

// 5. unconfigured notifier: silently nothing
const off = new Notifier();
off.onOsspEvent("s2", "permission.request", { tool: "bash" }, {});
await off.notify("x", "y");
assert.equal(received.length, 4);
console.log("ok  unconfigured no-op");

server.close();
console.log("NOTIFY_OK");
