const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { includeGoogleQuic, adaptZapretPayload } = require("../electron/zapret-compat.cjs");

const quic = [
  "--filter-udp=443",
  '--hostlist="@LISTS@/list-general.txt"',
  '--hostlist="@LISTS@/list-general-user.txt"',
  '--hostlist-exclude="@LISTS@/list-exclude-user.txt"',
  '--ipset-exclude="@LISTS@/ipset-exclude.txt"',
  "--dpi-desync=fake",
  "--dpi-desync-repeats=6",
  '--dpi-desync-fake-quic="@BASE@/bin/quic.bin"',
].join("\n");
const tcp = '\n--new\n--filter-tcp=443\n--hostlist="@LISTS@/list-google.txt"\n--dpi-desync=fake,fakedsplit\n';
const google = '--hostlist="@LISTS@/list-google.txt"';

for (const filter of ["--filter-udp=443", "--filter-l7=quic"]) {
  test(`Google video domains are included in the first ${filter} profile`, () => {
    const input = quic.replace("--filter-udp=443", filter) + tcp;
    const output = includeGoogleQuic(input);
    const first = output.split("\n--new\n")[0];
    assert.ok(first.split("\n").includes(google));
    assert.equal(output.replace(`${google}\n`, ""), input, "only one new hostlist directive is added");
    assert.equal(includeGoogleQuic(output), output, "adaptation must be idempotent");
    assert.ok(output.endsWith(tcp), "TCP profiles must remain byte-for-byte unchanged");
  });
}

test("CRLF input and exclusion directives are preserved", () => {
  const input = `${quic}${tcp}`.replaceAll("\n", "\r\n");
  const output = includeGoogleQuic(input);
  assert.equal(output.replace(`${google}\r\n`, ""), input);
  assert.ok(output.includes('--hostlist-exclude="@LISTS@/list-exclude-user.txt"\r\n'));
});

test("an unknown initial profile is rejected rather than changing broad network policy", () => {
  for (const input of [
    "--filter-udp=443\n--dpi-desync=fake\n",
    quic.replace("--filter-udp=443", "--filter-tcp=443"),
    quic.replace("--dpi-desync-fake-quic=", "--unexpected="),
  ]) assert.throws(() => includeGoogleQuic(input), /Неизвестный формат/);
});

test("all manifest strategies are validated before any staged config is rewritten", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netbridge-quic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "strategies"));
  await fs.writeFile(path.join(root, "strategies.tsv"), "general\tGeneral\ngeneral-exp\tExperimental\n");
  const first = path.join(root, "strategies/general.conf.in");
  const second = path.join(root, "strategies/general-exp.conf.in");
  await fs.writeFile(first, quic + tcp);
  await fs.writeFile(second, "unknown");
  await assert.rejects(adaptZapretPayload(root), /Неизвестный формат/);
  assert.equal(await fs.readFile(first, "utf8"), quic + tcp);
  await fs.writeFile(second, quic.replace("--filter-udp=443", "--filter-l7=quic") + tcp);
  assert.equal(await adaptZapretPayload(root), 2);
  assert.equal(await adaptZapretPayload(root), 0);
  await fs.writeFile(path.join(root, "strategies.tsv"), "../escape\tBad\n");
  await assert.rejects(adaptZapretPayload(root), /Некорректный список/);
});
