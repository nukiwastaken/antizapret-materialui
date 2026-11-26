const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Diagnostics } = require("../electron/diagnostics.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netbridge-diag-"));
  const manager = new EventEmitter();
  manager.root = root;
  manager.busy = new Set();
  manager.snapshot = () => ({ zapret: { running: false }, telegram: { running: true } });
  manager.refresh = async () => manager.emit("state", manager.snapshot());
  let gateway = "192.168.1.1";
  const calls = [];
  manager.run = async (exe, args) => {
    calls.push(exe);
    if (exe === "/sbin/route") return { stdout: `gateway: ${gateway}\ninterface: en1\n` };
    assert.equal(exe, "/usr/bin/curl");
    assert.equal(args[0], "-q");
    const url = args.at(-1);
    if (url.includes("googlevideo")) throw new Error("Sensitive command output");
    return { stdout: url.includes("youtube") ? "204\t0.04" : "403\t0.08" };
  };
  const diagnostics = new Diagnostics(manager);
  t.after(async () => { await diagnostics.pending; await fs.rm(root, { recursive: true, force: true }); });
  return { diagnostics, manager, calls, setGateway: (value) => { gateway = value; } };
}

test("manual checks distinguish HTTPS from service state and never mutate services", async (t) => {
  const { diagnostics, calls } = await fixture(t);
  await diagnostics.check();
  const { result, events } = diagnostics.snapshot();
  assert.deepEqual(result.https, [
    { id: "youtube", ok: true, code: 204, ms: 40 },
    { id: "thumbnail", ok: false, code: 403, ms: 80 },
    { id: "video-route", ok: false, code: null, ms: null },
  ]);
  assert.equal(result.zapretRunning, false);
  assert.equal(result.telegramListening, true);
  assert.equal(events[0].outcome, "partial");
  assert.deepEqual(new Set(calls), new Set(["/sbin/route", "/usr/bin/curl"]));
  assert.doesNotMatch(diagnostics.export(), /192\.168|Sensitive command output/);
});

test("route changes, sleep, and service operations only invalidate diagnostics", async (t) => {
  const { diagnostics, manager, setGateway, calls } = await fixture(t);
  await diagnostics.observeRoute();
  assert.equal(calls.length, 0);
  await diagnostics.check();
  setGateway("192.168.2.1");
  await diagnostics.observeRoute();
  assert.equal(diagnostics.snapshot().result.stale, "route");
  await diagnostics.check();
  diagnostics.sleep(true);
  assert.equal(diagnostics.snapshot().result.stale, "sleep");
  await assert.rejects(diagnostics.check(), /недоступна/);
  diagnostics.sleep(false);
  await diagnostics.check();
  manager.emit("operation", { service: "zapret", operation: "stop", outcome: "started" });
  assert.equal(diagnostics.snapshot().result.stale, "service");
  assert.equal(calls.filter((exe) => exe === "/usr/bin/curl").length, 9);
});

test("a route change during checks makes the newly published result stale", async (t) => {
  const { diagnostics, manager, setGateway } = await fixture(t);
  const run = manager.run;
  manager.run = (...args) => {
    if (args[0] === "/usr/bin/curl") setGateway("192.168.2.1");
    return run(...args);
  };
  await diagnostics.check();
  assert.equal(diagnostics.snapshot().result.stale, "route");
  assert.equal(diagnostics.snapshot().events[0].outcome, "stale");
});

test("saved and exported history is bounded and rebuilds entries using only allowed fields", async (t) => {
  const { diagnostics, manager } = await fixture(t);
  const extra = { link: "tg://proxy?secret=private", path: "/Users/private/config.json" };
  await fs.writeFile(diagnostics.file, JSON.stringify([
    { at: new Date().toISOString(), service: "telegram", operation: "connect", outcome: "ok", ...extra },
    { at: new Date().toISOString(), service: "telegram", operation: "connect", outcome: extra.link },
    { at: new Date().toISOString(), service: "__proto__", operation: "start", outcome: "ok" },
  ]));
  await diagnostics.load();
  assert.equal(diagnostics.events.length, 1);
  assert.doesNotMatch(diagnostics.export(), /private|tg:\/\//);
  for (let i = 0; i < 105; i++) diagnostics.record({ service: "telegram", operation: "start", outcome: "ok", ...extra });
  await diagnostics.pending;
  const restored = new Diagnostics(manager);
  await restored.load();
  assert.equal(restored.events.length, 100);
  assert.doesNotMatch(restored.export(), /private|tg:\/\//);
});
