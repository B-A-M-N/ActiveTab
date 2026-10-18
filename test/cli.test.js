import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "src/cli.js");

test("CLI documents profile binding for navigation and resume", () => {
  const result = spawnSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run --target ID --goal TEXT \[--profile ID\]/);
  assert.match(result.stdout, /same profile binding used when it started/);
});

test("CLI rejects unknown environment profiles before connecting to a browser", () => {
  const result = spawnSync(process.execPath, [cli, "run", "--target", "unused", "--goal", "Open the account page", "--profile", "missing-local-profile"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ACTIVETAB_CDP_ENDPOINT: "http://127.0.0.1:1" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No local environment profile 'missing-local-profile' exists/);
  assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
});
