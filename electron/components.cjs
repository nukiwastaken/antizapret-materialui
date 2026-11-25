const path = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
// Pin reviewed upstream versions: downloading a newer root payload needs a new app release.
const COMPONENTS = Object.freeze({
  zapret: {
    repo: "Flowseal/zapret-mac-discord-youtube", version: "1.1.2",
    asset: "ZapretMac-macOS-universal.zip", bundle: "ZapretMac.app",
    bundleId: "io.github.flowseal.zapretmac.app", executable: "ZapretMac",
    sha256: "9895b0ec5d13ec05676f755cde71107e72d2661538440c3cc4f06e0e6d47844f",
  },
  telegram: {
    repo: "Flowseal/tg-ws-proxy", version: "v1.12.0",
    asset: "TgWsProxy_macos_universal.dmg", bundle: "TG WS Proxy.app",
    bundleId: "com.tgwsproxy.app", executable: "TgWsProxy",
    sha256: "566c470e6eafef5c7d37dfb7d2829863c4e1666f00b888f248b619e793be334d",
  },
});

function component(key) {
  if (!Object.hasOwn(COMPONENTS, key)) throw new Error("Неизвестный компонент");
  return COMPONENTS[key];
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function validateArchiveEntries(text) {
  for (const entry of text.split(/\r?\n/).filter(Boolean)) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) {
      throw new Error("Небезопасный путь в архиве");
    }
  }
}

async function validateLinks(root, current = root, realRoot = null) {
  realRoot ||= await fs.realpath(root);
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await fs.realpath(file);
      if (!real.startsWith(`${realRoot}/`)) throw new Error("Ссылка выходит за пределы компонента");
    } else if (entry.isDirectory()) await validateLinks(root, file, realRoot);
  }
}

async function verifyBundle(bundle, spec) {
  await validateLinks(bundle);
  const { stdout } = await execute("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(bundle, "Contents/Info.plist")]);
  if (stdout.trim() !== spec.bundleId) throw new Error("Неверный идентификатор компонента");
  await fs.access(path.join(bundle, "Contents/MacOS", spec.executable), 1);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
}

class ComponentInstaller {
  constructor(root, notify, run = execute) {
    this.root = root;
    this.notify = notify;
    this.run = run;
  }

  location(key) {
    const spec = component(key);
    return path.join(this.root, key, spec.version, spec.bundle);
  }

  async installed(key) {
    try {
      const spec = component(key);
      const record = JSON.parse(await fs.readFile(path.join(this.location(key), "../installed.json"), "utf8"));
      await fs.access(path.join(this.location(key), "Contents/MacOS", spec.executable), 1);
      return record.sha256 === spec.sha256;
    } catch { return false; }
  }

  async ensure(key) {
    const spec = component(key);
    if (await this.installed(key)) {
      await verifyBundle(this.location(key), spec);
      return this.location(key);
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const scratch = await fs.mkdtemp(path.join(this.root, ".install-"));
    let mounted = false;
    const mount = path.join(scratch, "mount");
    try {
      this.notify(key, { phase: "download", message: "Загрузка официальной сборки…" });
      const archive = path.join(scratch, spec.asset);
      const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${spec.asset}`;
      await this.run("/usr/bin/curl", [
        "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "15", "--max-time", "300", "--retry", "2",
        "--max-filesize", "200000000", "--output", archive, url,
      ], { timeout: 930000, maxBuffer: 1024 * 1024 });
      this.notify(key, { phase: "verify", message: "Проверка SHA-256 и подписи…" });
      if (await digest(archive) !== spec.sha256) throw new Error("SHA-256 не совпадает. Компонент не установлен.");
      const extracted = path.join(scratch, "extracted");
      await fs.mkdir(extracted);
      if (spec.asset.endsWith(".zip")) {
        const { stdout } = await this.run("/usr/bin/unzip", ["-Z1", archive]);
        validateArchiveEntries(stdout);
        await this.run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
      } else {
        await fs.mkdir(mount);
        await this.run("/usr/bin/hdiutil", ["attach", archive, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount]);
        mounted = true;
        await this.run("/usr/bin/ditto", [path.join(mount, spec.bundle), path.join(extracted, spec.bundle)]);
        // DMG Finder metadata is not signed content. Keep quarantine attributes intact.
        for (const attr of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
          await this.run("/usr/bin/xattr", ["-dr", attr, path.join(extracted, spec.bundle)]);
        }
      }
      const bundle = path.join(extracted, spec.bundle);
      await verifyBundle(bundle, spec);
      await fs.writeFile(path.join(extracted, "installed.json"), JSON.stringify({ version: spec.version, sha256: spec.sha256 }));
      const destination = path.dirname(this.location(key));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      // The active directory is published only after the entire bundle is verified.
      const backup = path.join(scratch, "previous");
      let saved = false;
      try { await fs.rename(destination, backup); saved = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try { await fs.rename(extracted, destination); }
      catch (error) {
        if (saved) await fs.rename(backup, destination);
        throw error;
      }
      return this.location(key);
    } finally {
      if (mounted) {
        // Never recursively remove a still-mounted disk image.
        try { await this.run("/usr/bin/hdiutil", ["detach", mount]); mounted = false; } catch { /* Retain scratch for a later manual detach. */ }
      }
      if (!mounted) await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}

module.exports = { COMPONENTS, component, digest, validateArchiveEntries, ComponentInstaller };
