import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { runReporter } from "../src/runtime/reports.js";
import { createDiagnostics } from "../src/runtime/diagnostics.js";
import { bound, logger } from "../src/runtime/logger.js";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("health exposes diagnostics snapshot with counters and uptime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-log-"));
  const api = createApiServer({
    port: 0, taskStoreDir: join(dir, "tasks"),
    navigationRunner: { async run() { return { status: "succeeded", output: {}, usage: { actions: 1 } }; } },
    apiToken: "test-token"
  });
  const { url } = await api.start();
  try {
    await fetch(`${url}/v3/bots`, { headers: { "Authorization": "Bearer test-token" } }); // generate some http counters
    const health = await fetch(`${url}/health`).then(r => r.json());
    assert.equal(health.diagnostics.counters["http.GET"] >= 1, true);
    assert.equal(typeof health.diagnostics.uptime_ms, "number");
    assert.ok(Array.isArray(health.diagnostics.recent_events));
  } finally {
    await api.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostics redacts task ids from request paths", () => {
  const diag = createDiagnostics();
  const req = { method: "GET", url: "/v3/bots/runs/550e8400-e29b-41d4-a716-446655440000/status" };
  const res = { statusCode: 200, on: () => {} };
  diag.httpLogger(req, res, Date.now() - 5);
  const ev = diag.snapshot().recent_events.at(-1);
  assert.equal(ev.path.includes("550e8400"), false, "task ids are redacted from logged paths");
  assert.equal(ev.path, "/v3/bots/runs/:id/status");
});

test("runReporter captures phases, counters, and terminal classification", () => {
  const reporter = runReporter({ taskId: "t1", executor: "local", kind: "template" });
  const p = reporter.phase("execute");
  reporter.count("actions", 3);
  p.end({ status: "succeeded" });
  reporter.markTerminal("finished", null);
  const summary = reporter.report();
  assert.equal(summary.executor, "local");
  assert.equal(summary.phases[0].name, "execute");
  assert.equal(summary.phases[0].status, "succeeded");
  assert.equal(summary.counters.actions, 3);
  assert.equal(summary.terminal.status, "finished");
});

test("run reports are persisted per task with 0600 permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-report-"));
  const reportDir = join(dir, "reports");
  const api = createApiServer({
    port: 0, taskStoreDir: join(dir, "tasks"), reportDir,
    navigationRunner: {
      async run() { await new Promise(r => setTimeout(r, 10)); return { status: "succeeded", output: { ok: 1 }, usage: { actions: 1 } }; }
    },
    apiToken: "test-token"
  });
  const { url } = await api.start();
  try {
    const create = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
      body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
    }).then(r => r.json());
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const d = await fetch(`${url}/v3/bots/runs/${create.task_id}`, { headers: { "Authorization": "Bearer test-token" } }).then(r => r.json());
      if (["finished", "failed"].includes(d.status)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const files = await readdir(reportDir);
    assert.equal(files.length, 1);
    const report = JSON.parse(await readFile(join(reportDir, files[0]), "utf8"));
    assert.equal(report.terminal.status, "finished");
    assert.equal(report.executor, "local");
    assert.equal(report.phases[0].name, "execute");
  } finally {
    await api.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bound truncates long strings for safe log fields", () => {
  assert.equal(bound("x".repeat(500), 100).length, 100);
  assert.equal(bound("short", 100), "short");
});

test("concurrent logging does not interleave partial lines", async () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];
  let partial = "";
  process.stdout.write = (chunk) => {
    partial += chunk;
    let idx;
    while ((idx = partial.indexOf("\n")) !== -1) {
      lines.push(partial.slice(0, idx));
      partial = partial.slice(idx + 1);
    }
    return true;
  };
  try {
    const TASKS = 20;
    const LOGGERS_PER_TASK = 50;
    await Promise.all(Array.from({ length: TASKS }, async (_, taskId) => {
      for (let i = 0; i < LOGGERS_PER_TASK; i++) {
        logger.info("stress.test", { task: taskId, iteration: i });
      }
    }));
  } finally {
    process.stdout.write = originalWrite;
  }
  // Every line must be a complete, non-interleaved log entry.
  const expectedLines = 20 * 50;
  assert.ok(lines.length >= expectedLines, `Expected at least ${expectedLines} lines, got ${lines.length}`);
  let malformed = 0;
  for (const line of lines) {
    // Each line must start with a timestamp and not contain a second timestamp.
    const firstTimestamp = line.match(/^\d{4}-\d{2}-\d{2}T/);
    if (!firstTimestamp) { malformed++; continue; }
    const rest = line.slice(firstTimestamp[0].length);
    if (/^\d{4}-\d{2}-\d{2}T/.test(rest)) { malformed++; continue; }
    if (!/INFO /.test(line) && !/WARN /.test(line) && !/ERROR /.test(line) && !/DEBUG /.test(line)) { malformed++; continue; }
  }
  assert.equal(malformed, 0, `${malformed}/${lines.length} lines were malformed or interleaved.`);
});
