import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { plannerModeFromArgs } from "../src/navigation/plannerMode.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "src/cli.js");

test("CLI planner mode defaults to auto and preserves an explicit override", () => {
  assert.equal(plannerModeFromArgs(["run", "--target", "tab", "--goal", "List records"]), "auto");
  for (const mode of ["deterministic", "auto", "model", "workflow"]) {
    assert.equal(plannerModeFromArgs(["run", "--planner-mode", mode]), mode);
  }
});

test("CLI documents profile binding for navigation and resume", () => {
  const result = spawnSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run --target ID --goal TEXT \[--planner-mode auto\|deterministic\|model\|workflow\] \[--profile ID\|--scope current-origin\]/);
  assert.match(result.stdout, /Navigation runs default to --planner-mode auto/);
  assert.match(result.stdout, /--planner-mode auto\|deterministic\|model\|workflow/);
  assert.match(result.stdout, /observe --target ID \[--profile lightweight\|interaction\|structural\|visual\]/);
  assert.match(result.stdout, /same profile or scope authorization used when it started/);
  assert.match(result.stdout, /ACTIVETAB_AUTHORIZED_ORIGIN/);
  assert.match(result.stdout, /inspect-run <runId>/);
  assert.match(result.stdout, /export-trace <runId> --redacted/);
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

test("operator CLI keeps inspection local and requires redacted trace export", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-cli-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runStateDir = join(directory, "runs");
  const telemetryDb = join(directory, "missing.sqlite");

  const inspected = spawnSync(process.execPath, [cli, "inspect-run", "run_missing", "--run-state-dir", runStateDir, "--format", "markdown"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(inspected.status, 2);
  assert.match(inspected.stdout, /run_state_directory_missing/u);

  const sections = spawnSync(process.execPath, [cli, "inspect-run", "run_missing", "--run-state-dir", runStateDir, "--format", "markdown", "--list-sections"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(sections.status, 2);
  assert.match(sections.stdout, /\| ID \| Parent \| Heading \| Level \| Bytes \|/u);
  assert.match(sections.stdout, /run-run-missing/u);

  const unredacted = spawnSync(process.execPath, [cli, "export-trace", "run_missing", "--telemetry-db", telemetryDb], {
    cwd: root,
    encoding: "utf8"
  });
  assert.notEqual(unredacted.status, 0);
  assert.match(unredacted.stderr, /requires --redacted/u);

  const missingTrace = spawnSync(process.execPath, [cli, "export-trace", "run_missing", "--redacted", "--telemetry-db", telemetryDb, "--format", "markdown"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(missingTrace.status, 2);
  assert.match(missingTrace.stdout, /telemetry_database_missing/u);
});
