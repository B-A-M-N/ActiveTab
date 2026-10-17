import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ORIGIN } from "../src/extension/broker.js";

const installer = new URL("../scripts/install-native-host.js", import.meta.url).pathname;

function run(args) {
  return spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
}

test("Native Messaging registration is dry-run-first, additive, and idempotent", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-native-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, "com.activetab.bridge.json");

  const preview = run(["--dry-run", "--manifest-dir", dir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Dry run/);
  assert.match(preview.stdout, /activetab-native-host/);
  await assert.rejects(stat(manifestPath), { code: "ENOENT" });

  const applied = run(["--apply", "--manifest-dir", dir]);
  assert.equal(applied.status, 0, applied.stderr);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "com.activetab.bridge");
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);

  const repeated = run(["--apply", "--manifest-dir", dir]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Already configured/);
});

test("Native Messaging installer refuses to overwrite a different host manifest", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-native-conflict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, "com.activetab.bridge.json");
  await writeFile(manifestPath, "{\"name\":\"other-host\"}\n", { mode: 0o600 });
  const before = await readFile(manifestPath, "utf8");
  const result = run(["--apply", "--manifest-dir", dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /left untouched/);
  assert.equal(await readFile(manifestPath, "utf8"), before);
});
