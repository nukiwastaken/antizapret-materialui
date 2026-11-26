const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const { component, validateArchiveEntries, digest, ComponentInstaller } = require("../electron/components.cjs");
const { ServiceManager, shellQuote, appleString, validConfig, proxyLink } = require("../electron/service-manager.cjs");
const { PROFILE_REVISION } = require("../electron/zapret-compat.cjs");
const run = promisify(execFile);

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netbridge-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function manager(root, overrides = {}) {
  return new ServiceManager(root, {
    platform: "darwin", home: root,
    installer: { installed: async () => false, location: () => "/private/component" },
    run: async () => { throw new Error("Mock: unavailable"); }, ...overrides,
  });
}

test("component allowlist and ZIP paths", () => {
  assert.equal(component("zapret").version, "1.1.2");
  for (const key of ["__proto__", "constructor", "../zapret", "unknown"]) assert.throws(() => component(key));
  validateArchiveEntries("ZapretMac.app/Contents/Info.plist\n");
  for (const name of ["/etc/passwd", "a/../../b", "a\\b"]) assert.throws(() => validateArchiveEntries(name));
});

test("shell and AppleScript quoting cannot create extra commands", async () => {
  for (const value of ["a'b", "$(false); exit 9", 'a"b\\c', "a\nb", "space in path"]) {
    assert.equal((await run("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`])).stdout, value);
  }
  assert.equal(appleString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
});

test("only localhost configs and valid MTProto secrets can become deep links", () => {
  const good = { host: "127.0.0.1", port: 1443, secret: "ab".repeat(16) };
  assert.equal(validConfig(good), true);
  assert.equal(proxyLink(good), `tg://proxy?server=127.0.0.1&port=1443&secret=dd${good.secret}`);
  for (const changed of [{ host: "0.0.0.0" }, { port: "1443" }, { port: 80 }, { secret: "bad&server=evil" }]) {
    assert.throws(() => proxyLink({ ...good, ...changed }));
  }
});

test("digest mismatch aborts before extraction", async (t) => {
  const root = await temporary(t);
  const commands = [];
  const installer = new ComponentInstaller(root, () => {}, async (exe, args) => {
    commands.push(exe);
    await fs.writeFile(args[args.indexOf("--output") + 1], "tampered");
  });
  await assert.rejects(installer.ensure("zapret"), /SHA-256/);
  assert.deepEqual(commands, ["/usr/bin/curl"]);
  assert.deepEqual(await fs.readdir(root), []);
  const sample = path.join(root, "sample");
  await fs.writeFile(sample, "abc");
  assert.equal(await digest(sample), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("operation exclusion resets busy after success and errors", async (t) => {
  const m = manager(await temporary(t));
  let release;
  const first = m.exclusive("zapret", () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(m.exclusive("zapret", async () => {}), /уже выполняется/);
  release();
  await first;
  assert.equal(m.state.zapret.busy, false);
  await assert.rejects(m.exclusive("zapret", async () => { throw new Error("fixture"); }), /fixture/);
  assert.equal(m.state.zapret.busy, false);
  assert.equal(m.state.zapret.phase, "error");
});

test("broken Telegram config does not hide Zapret status", async (t) => {
  const m = manager(await temporary(t));
  m.tgConfig = async () => { throw new Error("bad config"); };
  m.zapretRunning = async () => true;
  await m.refresh();
  assert.equal(m.state.zapret.running, true);
  assert.equal(m.state.telegram.running, false);
  assert.equal(m.state.telegram.error, "bad config");
});

test("a foreign process on the proxy port is never treated as ours", async (t) => {
  const m = manager(await temporary(t), {
    run: async (exe) => ({ stdout: exe.endsWith("lsof") ? "p321\n" : "/other/TgWsProxy" }),
  });
  assert.equal(await m.tgPID({ port: 1443 }), null);
  m.run = async (exe) => ({ stdout: exe.endsWith("lsof") ? "p321\n" : "/private/component/Contents/MacOS/TgWsProxy" });
  assert.equal(await m.tgPID({ port: 1443 }), 321);
});

test("ordinary gateway routes scope the cache to the adapted config revision", async (t) => {
  const m = manager(await temporary(t), {
    run: async (exe, args, options) => {
      assert.equal(exe, "/sbin/route");
      assert.deepEqual(args, ["-n", "get", "default"]);
      assert.equal(options.timeout, 3000);
      return { stdout: "    gateway: 192.168.1.1\n  interface: en1\n" };
    },
  });
  const expected = createHash("sha256").update(`192.168.1.1|en1|${component("zapret").version}|${PROFILE_REVISION}`).digest("hex");
  assert.equal(await m.networkKey(), expected);
  const legacy = createHash("sha256").update(`192.168.1.1|en1|${component("zapret").version}`).digest("hex");
  assert.notEqual(expected, legacy);
});

test("active gatewayless tunnel routes are accepted without an unsafe cache identity", async (t) => {
  const m = manager(await temporary(t), {
    run: async () => ({ stdout: "destination: default\n  interface: utun4\n flags: <UP,DONE>\n" }),
  });
  assert.equal(await m.networkKey(), null);
  m.run = async () => ({ stdout: "gateway: \ninterface: utun4\n" });
  assert.equal(await m.networkKey(), null);
});

for (const ipv4 of ["unavailable", "missing interface", "loopback"]) {
  test(`IPv6 default route is used when IPv4 is ${ipv4}`, async (t) => {
    let calls = 0;
    const m = manager(await temporary(t), {
      run: async (_exe, args, options) => {
        calls++;
        assert.equal(options.timeout, 3000);
        if (!args.includes("-inet6")) {
          if (ipv4 === "unavailable") throw new Error("route timeout");
          return { stdout: ipv4 === "loopback" ? "interface: lo0\n" : "destination: default\n" };
        }
        return { stdout: "gateway: fe80::1%en1\ninterface: en1\n" };
      },
    });
    assert.match(await m.networkKey(), /^[a-f0-9]{64}$/);
    assert.equal(calls, 2);
  });
}

test("missing IPv4 and IPv6 routes produce an actionable error", async (t) => {
  let calls = 0;
  const m = manager(await temporary(t), {
    run: async () => { calls++; throw new Error("not in table"); },
  });
  await assert.rejects(m.networkKey(), /Проверьте подключение/);
  assert.equal(calls, 2);
});

test("Zapret preflight accepts an ordinary IPv4 gateway", async (t) => {
  const m = manager(await temporary(t), {
    run: async (_exe, _args, options) => {
      assert.equal(options.timeout, 3000);
      return { stdout: "gateway: 192.168.1.1\ninterface: en1\n" };
    },
  });
  await m.checkZapretNetwork();
});

for (const route of [
  "interface: utun4\n",
  "gateway: 10.0.0.1\ninterface: utun7\n",
  "interface: en1\n",
  "gateway: fe80::1\ninterface: en1\n",
]) {
  test(`unsupported route is rejected before download, config writes or authorization: ${route.trim()}`, async (t) => {
    const root = await temporary(t);
    const m = manager(root, { run: async () => ({ stdout: route }) });
    m.installer.ensure = async () => assert.fail("must not download");
    m.prepareZapret = async () => assert.fail("must not change config");
    m.privileged = async () => assert.fail("must not request authorization");
    await assert.rejects(m.enableZapret(true), /туннель|маршрут не подходит/);
    assert.equal(m.busy.size, 0);
    assert.deepEqual(await fs.readdir(root), []);
  });
}

test("Zapret preflight reports unavailable IPv4 routes without authorization", async (t) => {
  const m = manager(await temporary(t));
  await assert.rejects(m.enableZapret(), /требует подключения IPv4/);
  assert.equal(m.busy.size, 0);
});

test("cache selection is passed into the privileged transaction without pre-writing config", async (t) => {
  const root = await temporary(t);
  const m = manager(root);
  const payload = path.join(root, "payload");
  await fs.mkdir(payload);
  await fs.writeFile(path.join(payload, "strategies.tsv"), "general\tGeneral\n");
  await fs.writeFile(path.join(root, "profiles.json"), JSON.stringify({ network: { strategy: "general", results: "old" } }));
  m.installer.ensure = async () => payload;
  m.prepareZapret = async () => payload;
  m.networkKey = async () => "network";
  m.checkZapretNetwork = async () => {};
  const work = path.join(m.zapretData, "netbridge-test");
  await fs.mkdir(work, { recursive: true });
  const selected = path.join(m.zapretData, "selected-strategy");
  await fs.writeFile(selected, "original");
  m.privileged = async (_payload, mode, preferred) => {
    assert.equal(mode, "optimize");
    assert.equal(preferred, "general");
    assert.equal(await fs.readFile(selected, "utf8"), "original");
    await fs.writeFile(path.join(work, "cached"), "yes");
    return "general";
  };
  await m.enableZapret();
  assert.equal(m.state.zapret.report.cached, true);
  assert.equal(m.state.zapret.report.results, "old");
  m.privileged = async (_payload, _mode, preferred) => {
    assert.equal(preferred, "");
    throw new Error("cancelled");
  };
  await assert.rejects(m.enableZapret(true), /cancelled/);
  assert.equal(m.busy.size, 0);
  m.networkKey = async () => null;
  const oldProfiles = await fs.readFile(path.join(root, "profiles.json"), "utf8");
  m.privileged = async (_payload, _mode, preferred) => {
    assert.equal(preferred, "");
    await fs.rm(path.join(work, "cached"), { force: true });
    return "general";
  };
  await m.enableZapret();
  assert.equal(m.state.zapret.report.strategy, "general");
  assert.equal(m.state.zapret.report.cached, false);
  assert.equal(await fs.readFile(path.join(root, "profiles.json"), "utf8"), oldProfiles);
});

test("cancellation never follows a work directory symlink", async (t) => {
  const root = await temporary(t);
  const m = manager(root);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(m.zapretData, { recursive: true });
  await fs.symlink(outside, path.join(m.zapretData, "netbridge-test"));
  m.busy.add("zapret");
  m.state.zapret.cancellable = true;
  await assert.rejects(m.cancel(), /Небезопасный путь/);
  assert.deepEqual(await fs.readdir(outside), []);
});

// Replace OS commands only in a temporary COPY of the runner. No root or network changes.
async function stagedPayload(payload) {
  await fs.mkdir(path.join(payload, "strategies"), { recursive: true });
  await fs.writeFile(path.join(payload, "strategies.tsv"), "general\tGeneral\n");
  await fs.writeFile(path.join(payload, "strategies/general.conf.in"),
    '--filter-udp=443\n--hostlist="@LISTS@/list-general.txt"\n--dpi-desync-fake-quic="@BASE@/bin/quic.bin"\n');
}

test("only the staging payload is adapted before requesting administrator approval", async (t) => {
  const root = await temporary(t);
  const payload = path.join(root, "payload");
  await stagedPayload(payload);
  const original = await fs.readFile(path.join(payload, "strategies/general.conf.in"), "utf8");
  let staged;
  const m = manager(root, { run: async (_exe, args) => {
    staged = args.join(" ").match(/'([^']+\/Payload)'/)?.[1];
    assert.ok(staged);
    const adapted = await fs.readFile(path.join(staged, "strategies/general.conf.in"), "utf8");
    assert.match(adapted, /list-google\.txt/);
    assert.equal(await fs.readFile(path.join(payload, "strategies/general.conf.in"), "utf8"), original);
    return { stdout: "" };
  } });
  await fs.mkdir(path.join(m.zapretData, "netbridge-test"), { recursive: true });
  await m.privileged(payload, "optimize");
  await assert.rejects(fs.access(staged), { code: "ENOENT" });
});

async function runnerFixture(t, behavior = "success") {
  const root = await temporary(t);
  const data = path.join(root, "homes/test/Library/Application Support/ZapretMac");
  const source = path.join(root, "Payload");
  const work = path.join(data, "netbridge-test");
  const bin = path.join(root, "bin");
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(bin);
  await fs.mkdir(path.join(source, "strategies"), { recursive: true });
  await fs.writeFile(path.join(data, "selected-strategy"), "general-original\n");
  await fs.writeFile(path.join(data, "ipset-mode"), "none\n");
  await fs.writeFile(path.join(source, "strategies.tsv"), "general-slow\tSlow\ngeneral-fast\tFast\n");
  for (const strategy of ["general-slow", "general-fast"]) await fs.writeFile(path.join(source, "strategies", `${strategy}.conf.in`), "");
  const state = path.join(root, "running");
  const code = {
    sudo: '#!/bin/sh\nshift; shift; shift\nexec "$@"\n',
    launchctl: `#!/bin/sh\n[ -f ${shellQuote(state)} ]\n`,
    pgrep: `#!/bin/sh\nif [ "$1" = -P ]; then exec /usr/bin/pgrep "$@"; fi\n[ "$2" != ZapretMac ] && /bin/cat ${shellQuote(state)}\n`,
    ifconfig: `#!/bin/sh\n[ -f ${shellQuote(state)} ]\n`,
    pfctl: '#!/bin/sh\nprintf "route-to\\n"\n',
    route: '#!/bin/sh\nprintf "gateway: 192.168.1.1\\ninterface: en1\\n"\n',
    curl: `#!/bin/sh
strategy=$(/bin/cat ${shellQuote(path.join(data, "selected-strategy"))})
${behavior === "slow" ? `printf '%s\\n' "$$" >> ${shellQuote(path.join(work, "probe-pids"))}\n/bin/sleep 60` : ""}
${behavior === "cancel" ? `/usr/bin/touch ${shellQuote(path.join(work, "cancel"))}` : ""}
case "$strategy" in general-fast) time=0.1;; *) time=1;; esac
case "$*" in *generate_204*) code=204;; *) code=200;; esac
${behavior === "failure" ? "code=403" : ""}
${behavior === "cached-failure" ? '[ "$strategy" != general-slow ] || code=403' : ""}
${behavior === "final-failure" ? `[ "$(/bin/cat ${shellQuote(state)})" -lt 4 ] || code=403` : ""}
printf '%s\\t%s' "$code" "$time"
`,
  };
  for (const [name, body] of Object.entries(code)) await fs.writeFile(path.join(bin, name), body, { mode: 0o700 });
  const restart = `#!/bin/sh\nn=$(/bin/cat ${shellQuote(state)} 2>/dev/null || printf 0)\nprintf '%s\\n' "$((n + 1))" > ${shellQuote(state)}\n`;
  for (const name of ["restart.sh", "install.sh"]) await fs.writeFile(path.join(source, name), restart);
  await fs.writeFile(path.join(source, "stop.sh"), `#!/bin/sh\n/bin/rm -f ${shellQuote(state)}\n`);
  let script = await fs.readFile(path.join(__dirname, "../electron/zapret-runner.sh"), "utf8");
  script = script.replace("/Users/*/", `${root}/homes/*/`)
    .replace("BASE='/Library/Application Support/ZapretMac'", `BASE=${shellQuote(source)}`)
    .replace("LOCK=/var/run/netbridge-zapret.lock", `LOCK=${shellQuote(path.join(root, "lock"))}`);
  for (const [exe, name] of [
    ["/usr/bin/sudo", "sudo"], ["/bin/launchctl", "launchctl"], ["/usr/bin/pgrep", "pgrep"],
    ["/sbin/ifconfig", "ifconfig"], ["/sbin/pfctl", "pfctl"], ["/usr/bin/curl", "curl"],
    ["/sbin/route", "route"],
  ]) script = script.replaceAll(exe, shellQuote(path.join(bin, name)));
  const file = path.join(root, "runner.sh");
  await fs.writeFile(file, script);
  const args = [file, source, data, "501", "20", "optimize"];
  return { root, data, work, state, source,
    run: (preferred = "") => run("/bin/sh", [...args, preferred], { timeout: 15000 }),
    appleRun: () => run("/usr/bin/osascript", ["-e",
      `do shell script ${appleString(["/bin/sh", ...args].map(shellQuote).join(" "))}`], { timeout: 10000 }),
  };
}

async function waitForFile(file) {
  for (let i = 0; i < 150; i += 1) {
    try { return await fs.readFile(file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test("cancel stays non-repeatable and stale progress cannot hide restoration", async (t) => {
  const root = await temporary(t);
  let finish;
  const m = manager(root, { run: () => new Promise((_resolve, reject) => {
    finish = () => reject(new Error("osascript: exit 130"));
  }) });
  const payload = path.join(root, "payload");
  const work = path.join(m.zapretData, "netbridge-test");
  await stagedPayload(payload);
  await fs.mkdir(work, { recursive: true });
  m.busy.add("zapret");
  const result = assert.rejects(m.privileged(payload, "optimize"), /Прежние настройки восстановлены/);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(path.join(work, "progress"), "Стратегия 1/2");
  await m.cancel();
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(m.state.zapret.phase, "cancelling");
  assert.equal(m.state.zapret.cancellable, false);
  assert.equal(m.state.zapret.message, "Отмена и восстановление настроек…");
  assert.equal(m.state.zapret.busy, true);
  await m.cancel();
  await fs.writeFile(path.join(work, "outcome"), "cancelled");
  finish();
  await result;
});

test("committed progress disables cancel until the real process returns", async (t) => {
  const root = await temporary(t);
  let finish;
  const m = manager(root, { run: () => new Promise((resolve) => { finish = resolve; }) });
  const payload = path.join(root, "payload");
  const work = path.join(m.zapretData, "netbridge-test");
  await stagedPayload(payload);
  await fs.mkdir(work, { recursive: true });
  m.busy.add("zapret");
  const result = m.privileged(payload, "optimize");
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(path.join(work, "progress"), "Стратегия применена");
  await fs.writeFile(path.join(work, "best"), "general-fast");
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(m.state.zapret.phase, "finishing");
  assert.equal(m.state.zapret.cancellable, false);
  assert.equal(m.state.zapret.busy, true);
  await m.cancel();
  await assert.rejects(fs.access(path.join(work, "cancel")));
  finish({ stdout: "" });
  assert.equal(await result, "general-fast");
});

test("upstream installation error survives successful rollback", async (t) => {
  const f = await runnerFixture(t);
  await fs.writeFile(path.join(f.source, "install.sh"), "#!/bin/sh\necho 'utunws did not stay running' >&2\nexit 1\n");
  await assert.rejects(f.run(), { code: 1 });
  assert.match(await fs.readFile(path.join(f.work, "failure"), "utf8"), /utunws did not stay running/);
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  await assert.rejects(fs.access(f.state));
  await assert.rejects(fs.access(path.join(f.root, "lock")));
});

test("tunnel enabled during authorization is rejected without stopping an existing service", async (t) => {
  const f = await runnerFixture(t);
  await fs.writeFile(f.state, "100\n");
  await fs.writeFile(path.join(f.root, "bin/route"), "#!/bin/sh\nprintf 'interface: utun4\\n'\n");
  await assert.rejects(f.run(), { code: 7 });
  assert.equal(await fs.readFile(f.state, "utf8"), "100\n");
  assert.equal(await fs.readFile(path.join(f.data, "selected-strategy"), "utf8"), "general-original\n");
  assert.match(await fs.readFile(path.join(f.work, "progress"), "utf8"), /Отключите VPN/);
  await assert.rejects(fs.access(path.join(f.root, "lock")));
});

test("service error shows the original failure instead of rollback progress", async (t) => {
  const root = await temporary(t);
  let work;
  const m = manager(root, { run: async () => {
    await fs.writeFile(path.join(work, "failure"), "Не удалось запустить ZapretMac: fixture error");
    await fs.writeFile(path.join(work, "progress"), "Восстановление прежних настроек");
    throw new Error("osascript exit 1");
  } });
  const payload = path.join(root, "payload");
  work = path.join(m.zapretData, "netbridge-test");
  await stagedPayload(payload);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, "failure"), "STALE");
  await assert.rejects(m.privileged(payload, "optimize"), (error) => {
    assert.match(error.message, /fixture error/);
    assert.match(error.message, /Прежние настройки восстановлены/);
    assert.doesNotMatch(error.message, /STALE/);
    return true;
  });
});

test("slow probes are interrupted on cancel and rollback completes promptly", async (t) => {
  const f = await runnerFixture(t, "slow");
  await fs.writeFile(f.state, "100\n");
  const outcome = assert.rejects(f.run(), { code: 130 });
  const probeFile = path.join(f.work, "probe-pids");
  await waitForFile(probeFile);
  const started = Date.now();
  await fs.writeFile(path.join(f.work, "cancel"), "");
  await outcome;
  assert.ok(Date.now() - started < 3000, "cancel must not wait for curl timeout");
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  assert.ok(Number(await fs.readFile(f.state, "utf8")) > 100);
  assert.equal((await fs.readFile(path.join(f.work, "outcome"), "utf8")).trim(), "cancelled");
  for (const pid of (await fs.readFile(probeFile, "utf8")).trim().split(/\s+/)) {
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
  }
  await assert.rejects(fs.access(path.join(f.root, "lock")));
  await assert.rejects(fs.access(path.join(f.work, "results.tsv")));
});

test("AppleScript cancellation returns promptly with no retained background jobs", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await runnerFixture(t, "slow");
  const result = assert.rejects(f.appleRun(), /130/);
  await waitForFile(path.join(f.work, "probe-pids"));
  const started = Date.now();
  await fs.writeFile(path.join(f.work, "cancel"), "");
  await result;
  assert.ok(Date.now() - started < 3000);
  assert.equal((await fs.readFile(path.join(f.work, "outcome"), "utf8")).trim(), "cancelled");
  await assert.rejects(fs.access(f.state));
});

test("rollback failure is not reported as successful cancellation", async (t) => {
  const f = await runnerFixture(t, "cancel");
  await fs.writeFile(path.join(f.source, "stop.sh"), "#!/bin/sh\nexit 1\n");
  await assert.rejects(f.run(), { code: 5 });
  await assert.rejects(fs.access(path.join(f.work, "outcome")));
  assert.match(await fs.readFile(path.join(f.work, "progress"), "utf8"), /Ошибка восстановления/);
});

test("AppleScript launch returns promptly after successful strategy commit", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await runnerFixture(t);
  const started = Date.now();
  await f.appleRun();
  assert.ok(Date.now() - started < 8000, "no background watchdog may hold AppleScript open");
  assert.equal((await fs.readFile(path.join(f.work, "best"), "utf8")).trim(), "general-fast");
});

test("cancel interrupts service readiness waiting and restores the stopped state", async (t) => {
  const f = await runnerFixture(t);
  await fs.writeFile(path.join(f.source, "install.sh"), "#!/bin/sh\nexit 0\n");
  const outcome = assert.rejects(f.run(), { code: 130 });
  await waitForFile(path.join(f.work, "progress"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(path.join(f.work, "cancel"), "");
  await outcome;
  await assert.rejects(fs.access(f.state));
  await assert.rejects(fs.access(path.join(f.root, "lock")));
});

test("runner ranks passing strategies and commits the fastest", async (t) => {
  const f = await runnerFixture(t);
  await f.run();
  assert.equal((await fs.readFile(path.join(f.work, "best"), "utf8")).trim(), "general-fast");
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-fast");
  assert.match(await fs.readFile(path.join(f.work, "results.tsv"), "utf8"), /general-slow\t6/);
  await assert.rejects(fs.access(path.join(f.root, "lock")));
});

test("runner validates the cache and skips full search", async (t) => {
  const f = await runnerFixture(t);
  await f.run("general-slow");
  assert.equal((await fs.readFile(path.join(f.work, "cached"), "utf8")).trim(), "yes");
  await assert.rejects(fs.access(path.join(f.work, "results.tsv")));
});

test("a failed cached profile triggers a complete search in the same transaction", async (t) => {
  const f = await runnerFixture(t, "cached-failure");
  await f.run("general-slow");
  assert.equal((await fs.readFile(path.join(f.work, "best"), "utf8")).trim(), "general-fast");
  await assert.rejects(fs.access(path.join(f.work, "cached")));
});

test("cancellation before authorization completes makes no service changes", async (t) => {
  const f = await runnerFixture(t);
  await fs.writeFile(path.join(f.work, "cancel"), "");
  await assert.rejects(f.run(), { code: 130 });
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  await assert.rejects(fs.access(f.state));
});

for (const behavior of ["failure", "cancel"]) {
  test(`runner restores strategy and stopped state on ${behavior}`, async (t) => {
    const f = await runnerFixture(t, behavior);
    await assert.rejects(f.run("general-fast"), { code: behavior === "failure" ? 3 : 130 });
    assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
    assert.equal((await fs.readFile(path.join(f.data, "ipset-mode"), "utf8")).trim(), "none");
    await assert.rejects(fs.access(f.state));
    await assert.rejects(fs.access(path.join(f.root, "lock")));
  });
}

test("runner restores a previously running service on failure", async (t) => {
  const f = await runnerFixture(t, "failure");
  await fs.writeFile(f.state, "100\n");
  await assert.rejects(f.run(), { code: 3 });
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  assert.equal(Number(await fs.readFile(f.state, "utf8")) > 100, true);
});

test("failed final verification rolls back instead of committing a candidate", async (t) => {
  const f = await runnerFixture(t, "final-failure");
  await assert.rejects(f.run(), { code: 4 });
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  await assert.rejects(fs.access(f.state));
  await assert.rejects(fs.access(path.join(f.work, "best")));
});

test("an existing lock prevents touching the current service", async (t) => {
  const f = await runnerFixture(t);
  await fs.mkdir(path.join(f.root, "lock"));
  await fs.writeFile(f.state, "100\n");
  await assert.rejects(f.run(), { code: 6 });
  assert.equal((await fs.readFile(path.join(f.data, "selected-strategy"), "utf8")).trim(), "general-original");
  assert.equal((await fs.readFile(f.state, "utf8")).trim(), "100");
});
