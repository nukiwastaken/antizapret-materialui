const fs = require("node:fs/promises");
const path = require("node:path");

// Include adaptation changes in cache keys so old reachability results are not reused.
const PROFILE_REVISION = "youtube-quic-1";
const GENERAL_HOSTS = '--hostlist="@LISTS@/list-general.txt"';
const GOOGLE_HOSTS = '--hostlist="@LISTS@/list-google.txt"';

function includeGoogleQuic(config) {
  const eol = config.includes("\r\n") ? "\r\n" : "\n";
  const lines = config.split(/\r?\n/);
  const end = lines.indexOf("--new");
  const firstProfile = lines.slice(0, end < 0 ? lines.length : end);
  if ((!firstProfile.includes("--filter-udp=443") && !firstProfile.includes("--filter-l7=quic")) ||
      !firstProfile.some((line) => line.startsWith("--dpi-desync-fake-quic=")) ||
      !firstProfile.includes(GENERAL_HOSTS)) {
    throw new Error("Неизвестный формат QUIC-профиля ZapretMac. Системные файлы не изменены.");
  }
  if (firstProfile.includes(GOOGLE_HOSTS)) return config;
  lines.splice(firstProfile.indexOf(GENERAL_HOSTS) + 1, 0, GOOGLE_HOSTS);
  return lines.join(eol);
}

async function adaptZapretPayload(payload) {
  const manifest = await fs.readFile(path.join(payload, "strategies.tsv"), "utf8");
  const ids = manifest.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")[0]);
  if (!ids.length || ids.some((id) => !/^general(?:-[a-z0-9]+)*$/.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error("Некорректный список стратегий ZapretMac.");
  }
  const configs = await Promise.all(ids.map(async (id) => {
    const file = path.join(payload, "strategies", `${id}.conf.in`);
    const original = await fs.readFile(file, "utf8");
    return { file, original, adapted: includeGoogleQuic(original) };
  }));
  let changed = 0;
  for (const { file, original, adapted } of configs) {
    if (adapted === original) continue;
    await fs.writeFile(file, adapted);
    changed++;
  }
  return changed;
}

module.exports = { PROFILE_REVISION, includeGoogleQuic, adaptZapretPayload };
