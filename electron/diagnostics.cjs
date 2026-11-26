const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { atomicWrite } = require("./service-manager.cjs");

const ENDPOINTS = [
  ["youtube", "https://www.youtube.com/generate_204", 204],
  ["thumbnail", "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg", 200],
  ["video-route", "https://redirector.googlevideo.com/report_mapping", 200],
];
const EVENTS = {
  zapret: { start: ["started", "ok", "cancelled", "failed"], optimize: ["started", "ok", "cancelled", "failed"],
    stop: ["started", "ok", "failed"], import: ["started", "ok", "failed"] },
  telegram: { start: ["started", "ok", "failed"], stop: ["started", "ok", "failed"],
    import: ["started", "ok", "failed"], connect: ["ok", "failed"] },
  diagnostics: { check: ["ok", "partial", "failed", "stale"],
    invalidate: ["route", "sleep", "service"] },
};
const LIMIT = 100;

function historyEntry(entry) {
  if (!entry || typeof entry.service !== "string" || typeof entry.operation !== "string" ||
      !Object.hasOwn(EVENTS, entry.service) || !Object.hasOwn(EVENTS[entry.service], entry.operation) ||
      !EVENTS[entry.service][entry.operation].includes(entry.outcome) ||
      !Number.isFinite(Date.parse(entry.at))) return null;
  // Rebuild from an allowlist: no command output, links, paths, credentials or network identifiers.
  return { at: new Date(entry.at).toISOString(), service: entry.service, operation: entry.operation, outcome: entry.outcome };
}

class Diagnostics extends EventEmitter {
  constructor(manager) {
    super();
    this.manager = manager;
    this.file = path.join(manager.root, "history.json");
    this.events = [];
    this.pending = Promise.resolve();
    this.checking = false;
    this.result = null;
    this.warning = false;
    this.revision = 0;
    this.observing = false;
    this.suspended = false;
    this.signature = null;
    this.staleReason = null;
    manager.on("operation", (entry) => {
      if (entry.outcome === "started" && entry.operation !== "import") this.invalidate("service");
      this.record(entry);
    });
    manager.on("state", ({ zapret, telegram }) => {
      const signature = JSON.stringify([zapret.running, zapret.strategy, telegram.running, telegram.address]);
      if (this.signature !== null && this.signature !== signature) this.invalidate("service");
      this.signature = signature;
    });
  }

  async load() {
    try {
      const entries = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (Array.isArray(entries)) this.events = entries.map(historyEntry).filter(Boolean).slice(0, LIMIT);
    } catch { /* No history yet, or a damaged history file. */ }
  }

  snapshot() {
    return structuredClone({ events: this.events, checking: this.checking,
      result: this.result, warning: this.warning, suspended: this.suspended });
  }

  publish() { this.emit("state", this.snapshot()); }

  record(data) {
    const entry = historyEntry({ ...data, at: new Date().toISOString() });
    if (!entry) return;
    this.events = [entry, ...this.events].slice(0, LIMIT);
    this.pending = this.pending.then(async () => {
      try {
        await fs.mkdir(this.manager.root, { recursive: true, mode: 0o700 });
        await atomicWrite(this.file, JSON.stringify(this.events));
        if (this.warning) { this.warning = false; this.publish(); }
      } catch { if (!this.warning) { this.warning = true; this.publish(); } }
    });
    this.publish();
  }

  export() { return JSON.stringify({ schema: 1, events: this.events }, null, 2); }

  invalidate(reason) {
    this.revision++;
    this.staleReason = reason;
    if (!this.result || this.result.stale) return;
    this.result = { ...this.result, stale: reason };
    this.record({ service: "diagnostics", operation: "invalidate", outcome: reason });
  }

  sleep(suspended) {
    this.suspended = suspended;
    this.invalidate("sleep");
    this.publish();
  }

  async routeFingerprint() {
    const routes = await Promise.all([[], ["-inet6"]].map(async (family) => {
      try {
        const { stdout } = await this.manager.run("/sbin/route", ["-n", "get", ...family, "default"], { timeout: 2000 });
        return [stdout.match(/^\s*interface:[ \t]*(\S+)/m)?.[1], stdout.match(/^\s*gateway:[ \t]*(\S+)/m)?.[1]];
      } catch { return null; }
    }));
    return createHash("sha256").update(JSON.stringify(routes)).digest("hex");
  }

  async observeRoute() {
    if (!this.result || this.result.stale || this.suspended || this.checking || this.observing) return;
    this.observing = true;
    const result = this.result;
    try {
      const current = await this.routeFingerprint();
      if (this.result === result && !this.checking && current !== this.lastRoute) this.invalidate("route");
    } finally { this.observing = false; }
  }

  async probe([id, url, expected]) {
    try {
      const { stdout } = await this.manager.run("/usr/bin/curl", [
        "-q", "--noproxy", "*", "--proto", "=https", "--connect-timeout", "3", "--max-time", "8",
        "--max-filesize", "2097152", "--silent", "--output", "/dev/null",
        "--write-out", "%{http_code}\t%{time_total}", url,
      ], { timeout: 9000, maxBuffer: 1024 });
      const [code, duration] = stdout.trim().split("\t");
      if (!/^[1-5]\d\d$/.test(code) || !/^\d+(\.\d+)?$/.test(duration)) throw new Error("Invalid probe output");
      return { id, ok: Number(code) === expected, code: Number(code), ms: Math.round(Number(duration) * 1000) };
    } catch { return { id, ok: false, code: null, ms: null }; }
  }

  async check() {
    if (this.checking || this.manager.busy.size || this.suspended) throw new Error("Проверка сейчас недоступна");
    this.checking = true;
    this.publish();
    try {
      await this.manager.refresh();
      if (this.manager.busy.size || this.suspended) throw new Error("Проверка сейчас недоступна");
      const revision = this.revision;
      const { zapret, telegram } = this.manager.snapshot();
      const before = await this.routeFingerprint();
      const https = await Promise.all(ENDPOINTS.map((endpoint) => this.probe(endpoint)));
      const after = await this.routeFingerprint();
      await this.manager.refresh();
      this.lastRoute = after;
      const stale = revision !== this.revision ? this.staleReason : before !== after ? "route" : null;
      this.result = { at: new Date().toISOString(), zapretRunning: zapret.running,
        telegramListening: telegram.running, https, stale };
      const passed = https.filter(({ ok }) => ok).length;
      this.record({ service: "diagnostics", operation: "check", outcome: stale ? "stale" :
        passed === https.length ? "ok" : passed ? "partial" : "failed" });
    } finally {
      this.checking = false;
      this.publish();
    }
  }
}

module.exports = { Diagnostics };
