import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/local-server.js";
import { RunStateStore } from "../src/testing/runState.js";
import { buildDurableRunReport } from "../src/testing/durableRunReport.js";

async function createCompletedDurableRun(store) {
  const run = await store.create({
    runId: "restart-report-fixture",
    workflowId: "fixture-workflow",
    workflowName: "Fixture workflow",
    environmentId: "fixture-local"
  });
  await store.updateCheckpoint(run.runId, {
    stepId: "verified-step",
    type: "verify",
    status: "PASS",
    evidenceIds: ["evidence-1"]
  });
  await store.update(run.runId, { status: "passed" });
  return run.runId;
}

test("durable report reconstruction preserves checkpoints and stays inconclusive without volatile evidence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-durable-report-"));
  try {
    const store = new RunStateStore(join(tempDir, "runs"));
    await store.init();
    const runId = await createCompletedDurableRun(store);
    const report = buildDurableRunReport(await store.getFresh(runId));

    assert.equal(report.runId, runId);
    assert.equal(report.findings.length, 1);
    assert.deepEqual(report.findings[0].evidenceIds, ["evidence-1"]);
    assert.equal(report.investigationStatus, "inconclusive");
    assert.ok(report.limitations.some(item => item.includes("Process-local observations")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("HTTP test report is recoverable after worker cache loss", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-api-durable-report-"));
  const store = new RunStateStore(join(tempDir, "runs"));
  await store.init();
  const runId = await createCompletedDurableRun(store);
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks"),
    runStateStore: store,
    navigationRunner: { run: async () => ({}) },
    apiToken: "test-token"
  });
  const { url } = await api.start();
  try {
    const response = await fetch(`${url}/v1/test/runs/${runId}/report`, {
      headers: { Authorization: "Bearer test-token" }
    });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.runId, runId);
    assert.equal(report.investigationStatus, "inconclusive");
    assert.equal(report.findings.length, 1);
  } finally {
    await api.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
