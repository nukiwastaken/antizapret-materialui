const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { createHash, randomBytes } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");
const { ComponentInstaller, component } = require("./components.cjs");

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const appleString = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;

async function readText(file, fallback = "") {
  try { return (await fs.readFile(file, "utf8")).trim(); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWrite(file, value) {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function ensurePlain(file, directory = false) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Небезопасный путь: ${file}`);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function validConfig(config) {
  return config?.host === "127.0.0.1" &&
    Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535 &&
    typeof config.secret === "string" && /^[a-f0-9]{32}$/.test(config.secret);
}

function proxyLink(config) {
  if (!validConfig(config)) throw new Error("Неверная конфигурация прокси");
  return `tg://proxy?server=127.0.0.1&port=${config.port}&secret=dd${config.secret}`;
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

class ServiceManager extends EventEmitter {
  constructor(root, deps = {}) {
    super();
    this.root = root;
    this.home = deps.home || os.homedir();
    this.run = deps.run || execute;
    this.platform = deps.platform || process.platform;
    this.zapretData = path.join(this.home, "Library/Application Support/ZapretMac");
    this.tgHome = path.join(root, "telegram-home");
    this.tgDir = path.join(this.tgHome, "Library/Application Support/TgWsProxy");
    this.installer = deps.installer || new ComponentInstaller(path.join(root, "components"), (key, state) => this.update(key, state));
    this.busy = new Set();
    this.cancelRequested = false;
    this.refreshing = false;
    this.process = null;
    this.state = {
      zapret: { phase: "idle", running: false, installed: false, message: "Выключен" },
      telegram: { phase: "idle", running: false, installed: false, message: "Выключен" },
    };
  }

  update(key, values) {
    this.state[key] = { ...this.state[key], ...values, busy: this.busy.has(key) };
    this.emit("state", this.snapshot());
  }

  snapshot() { return structuredClone(this.state); }

  async exclusive(key, action) {
    component(key);
    if (this.platform !== "darwin") throw new Error("Управление доступно только в приложении macOS");
    if (this.busy.has(key)) throw new Error("Операция уже выполняется");
    this.busy.add(key);
    this.update(key, { error: null, phase: "prepare", message: "Подготовка…" });
    try {
      await action();
      this.update(key, { phase: "idle", message: null });
    } catch (error) {
      this.update(key, { phase: "error", error: error.message, message: null });
      throw error;
    } finally {
      this.busy.delete(key);
      await this.refresh();
      this.update(key, {});
    }
  }

  async zapretRunning() {
    try {
      const { stdout } = await this.run("/bin/launchctl", ["print", "system/io.github.flowseal.zapretmac"], { timeout: 3000 });
      if (!/state = running/.test(stdout)) return false;
      await this.run("/usr/bin/pgrep", ["-x", "utunws"], { timeout: 3000 });
      await this.run("/sbin/ifconfig", ["utun50"], { timeout: 3000 });
      return true;
    } catch { return false; }
  }

  async tgConfig() {
    const raw = await readText(path.join(this.tgDir, "config.json"));
    if (!raw) return null;
    const config = JSON.parse(raw);
    if (!validConfig(config)) throw new Error("Повреждён конфиг Telegram. Проверьте config.json Netbridge.");
    return config;
  }

  async tgPID(config) {
    if (!config) return null;
    try {
      const { stdout } = await this.run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${config.port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 3000 });
      const pid = Number(stdout.match(/^p(\d+)$/m)?.[1]);
      if (!Number.isInteger(pid) || pid <= 1) return null;
      const command = (await this.run("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000 })).stdout.trim();
      const expected = path.join(this.installer.location("telegram"), "Contents/MacOS/TgWsProxy");
      return command === expected ? pid : null;
    } catch { return null; }
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all(["zapret", "telegram"].map(async (key) => {
        try {
          const installed = await this.installer.installed(key);
          if (key === "zapret") {
            this.update(key, { installed, running: await this.zapretRunning(),
              strategy: await readText(path.join(this.zapretData, "selected-strategy")) });
          } else {
            const config = await this.tgConfig();
            this.update(key, { installed, running: Boolean(await this.tgPID(config)),
              address: config ? `127.0.0.1:${config.port}` : null });
          }
        } catch (error) { this.update(key, { running: false, error: error.message }); }
      }));
    } finally { this.refreshing = false; }
  }

  async prepareZapret(bundle) {
    const payload = path.join(bundle, "Contents/Resources/Payload");
    await ensurePlain(this.zapretData, true);
    await fs.mkdir(this.zapretData, { recursive: true, mode: 0o700 });
    const lists = path.join(this.zapretData, "lists");
    await ensurePlain(lists, true);
    await fs.mkdir(lists, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(path.join(payload, "default-lists"))) {
      const target = path.join(lists, entry);
      await ensurePlain(target);
      try { await fs.copyFile(path.join(payload, "default-lists", entry), target, 1); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    for (const [name, value] of [["selected-strategy", "general-simple-fake"], ["ipset-mode", "none"]]) {
      const file = path.join(this.zapretData, name);
      await ensurePlain(file);
      try { await fs.writeFile(file, `${value}\n`, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const work = path.join(this.zapretData, "netbridge-test");
    await ensurePlain(work, true);
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    if (await readText(path.join(this.zapretData, "strategy-test-progress"))) {
      throw new Error("В ZapretMac уже выполняется тест стратегий");
    }
    return payload;
  }

  async networkKey() {
    const { stdout } = await this.run("/sbin/route", ["-n", "get", "default"]);
    const gateway = stdout.match(/gateway:\s*(\S+)/)?.[1];
    const iface = stdout.match(/interface:\s*(\S+)/)?.[1];
    if (!gateway || !iface) throw new Error("Не найдено активное сетевое подключение");
    return createHash("sha256").update(`${gateway}|${iface}|${component("zapret").version}`).digest("hex");
  }

  async privileged(payload, mode, preferred = "") {
    const work = path.join(this.zapretData, "netbridge-test");
    for (const name of ["cancel", "best", "progress", "results.tsv", "cached", "outcome"]) {
      await fs.rm(path.join(work, name), { force: true });
    }
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "netbridge-run-"));
    await fs.chmod(stage, 0o700);
    let timer;
    let finished = false;
    try {
      const source = path.join(stage, "Payload");
      await fs.cp(payload, source, { recursive: true });
      const runner = path.join(stage, "runner.sh");
      await fs.copyFile(path.join(__dirname, "zapret-runner.sh"), runner);
      const args = ["/bin/sh", runner, source, this.zapretData, process.getuid(), process.getgid(), mode, preferred];
      const command = args.map(shellQuote).join(" ");
      if (this.cancelRequested && mode !== "stop") throw new Error("Операция отменена до запуска сервиса");
      this.update("zapret", { phase: mode === "optimize" ? "optimize" : "authorize",
        cancellable: mode !== "stop", message: "Ожидание подтверждения macOS…" });
      timer = setInterval(async () => {
        try {
          const message = await readText(path.join(work, "progress"));
          if (!message || finished) return;
          const completing = ["Стратегия применена", "Сохранённый профиль проверен"].includes(message);
          if (completing) {
            this.update("zapret", { message, phase: "finishing", cancellable: false });
          } else if (!this.cancelRequested) {
            this.update("zapret", { message });
          }
        } catch { /* A transient read must not stop a privileged operation. */ }
      }, 700);
      await this.run("/usr/bin/osascript", [
        "-e", "with timeout of 3600 seconds",
        "-e", `do shell script ${appleString(command)} with administrator privileges`,
        "-e", "end timeout",
      ], { maxBuffer: 2 * 1024 * 1024 });
      return await readText(path.join(work, "best"));
    } catch (error) {
      if (await readText(path.join(work, "outcome")) === "cancelled") {
        throw new Error("Операция отменена. Прежние настройки восстановлены.");
      }
      const progress = await readText(path.join(work, "progress"));
      throw new Error(`${progress || "Системная операция не выполнена"}. ${error.stderr || error.message}`);
    } finally {
      finished = true;
      clearInterval(timer);
      this.update("zapret", { cancellable: false });
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  async enableZapret(forceOptimize = false) {
    return this.exclusive("zapret", async () => {
      this.cancelRequested = false;
      const bundle = await this.installer.ensure("zapret");
      const payload = await this.prepareZapret(bundle);
      const network = await this.networkKey();
      const profilesFile = path.join(this.root, "profiles.json");
      let profiles;
      try { profiles = JSON.parse(await readText(profilesFile, "{}")); }
      catch { profiles = {}; }
      if (!profiles || Array.isArray(profiles) || typeof profiles !== "object") profiles = {};
      const cached = profiles[network];
      const strategies = (await fs.readFile(path.join(payload, "strategies.tsv"), "utf8")).split(/\r?\n/).map((line) => line.split("\t")[0]);
      if (this.cancelRequested) throw new Error("Операция отменена до запуска сервиса");
      const preferred = !forceOptimize && cached && strategies.includes(cached.strategy) ? cached.strategy : "";
      const best = await this.privileged(payload, "optimize", preferred);
      if (!strategies.includes(best)) throw new Error("Подбор не вернул допустимую стратегию");
      if (await readText(path.join(this.zapretData, "netbridge-test/cached")) === "yes") {
        this.update("zapret", { report: { ...cached, cached: true } });
        return;
      }
      const report = {
        strategy: best, testedAt: new Date().toISOString(), cached: false,
        results: await readText(path.join(this.zapretData, "netbridge-test/results.tsv")),
      };
      profiles[network] = report;
      await atomicWrite(profilesFile, JSON.stringify(profiles, null, 2));
      this.update("zapret", { report });
    });
  }

  async stopZapret() {
    return this.exclusive("zapret", async () => {
      const bundle = await this.installer.ensure("zapret");
      const payload = await this.prepareZapret(bundle);
      await this.privileged(payload, "stop");
      if (await this.zapretRunning()) throw new Error("Сервис не остановился");
    });
  }

  async cancel() {
    if (!this.busy.has("zapret") || !this.state.zapret.cancellable) return;
    this.cancelRequested = true;
    const work = path.join(this.zapretData, "netbridge-test");
    await ensurePlain(this.zapretData, true);
    await ensurePlain(work, true);
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(work, "cancel"), "");
    this.update("zapret", { phase: "cancelling", cancellable: false, message: "Отмена и восстановление настроек…" });
  }

  async startTelegram() {
    return this.exclusive("telegram", async () => {
      const bundle = await this.installer.ensure("telegram");
      await fs.mkdir(this.tgDir, { recursive: true, mode: 0o700 });
      let config = await this.tgConfig();
      if (await this.tgPID(config)) return;
      if (!config) {
        let port = 1443;
        while (port <= 1453 && await portOpen(port)) port += 1;
        if (port > 1453) throw new Error("Локальные порты 1443–1453 заняты");
        config = {
          host: "127.0.0.1", port, secret: randomBytes(16).toString("hex"),
          language: "ru", check_updates: false,
        };
        await atomicWrite(path.join(this.tgDir, "config.json"), JSON.stringify(config, null, 2));
      } else if (await portOpen(config.port)) {
        throw new Error(`Порт ${config.port} занят другим процессом. Освободите его и повторите запуск.`);
      }
      this.update("telegram", { phase: "start", message: "Запуск локального прокси…" });
      const child = spawn(path.join(bundle, "Contents/MacOS/TgWsProxy"), [], {
        env: { ...process.env, HOME: this.tgHome }, stdio: "ignore", detached: true,
      });
      this.process = child;
      let failure;
      child.once("error", (error) => { failure = error; });
      child.once("exit", () => { if (this.process === child) this.process = null; });
      for (let i = 0; i < 120; i += 1) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode) throw new Error("TG WS Proxy завершился до запуска. Проверьте защиту macOS.");
        if (await this.tgPID(config)) return;
        await sleep(500);
      }
      child.kill("SIGTERM");
      throw new Error("Прокси не начал слушать порт за 60 секунд. Проверьте запросы macOS.");
    });
  }

  async stopTelegram() {
    return this.exclusive("telegram", async () => {
      const config = await this.tgConfig();
      const pid = await this.tgPID(config);
      if (!pid) return;
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 30; i += 1) {
        if (!await this.tgPID(config)) return;
        await sleep(200);
      }
      throw new Error("Прокси не завершился. Закройте TG WS Proxy из его меню.");
    });
  }

  async telegramLink() {
    const config = await this.tgConfig();
    if (!await this.tgPID(config)) throw new Error("Сначала включите Telegram-прокси");
    return proxyLink(config);
  }
}

module.exports = { ServiceManager, shellQuote, appleString, validConfig, proxyLink, atomicWrite };
