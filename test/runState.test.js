/** Durable resumable run state across restarts (P1-4) + TaskStore suspension semantics (P0-3). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStateStore } from "../src/testing/runState.js";
import { TaskStore, TERMINAL_STATUSES, SUSPENDED_STATUSES } from "../src/api/task-store.js";

async function withRunState(fn) {
  const dir = await mkdtemp(join(tmpdir(), "activetab-runs-"));
  const store = new RunStateStore(dir);
  await store.init();
  try { return await fn(store, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("suspended runs survive restarts and are never auto-failed", () =>
  withRunState(async (store, dir) => {
    const run = await store.create({ workflowId: "wf", workflowName: "Enter Agents", environmentId: "freeinference-staging", authenticationRealm: "agents-session", targetId: "tab-1" });
    await store.update(run.runId, { status: "waiting_for_authentication", suspendedStepId: "enter-agents", pendingInterventionId: "iv-1" });
    // Simulate process restart: brand-new store over the same directory.
    const restarted = new RunStateStore(dir);
    await restarted.init();
    const suspended = restarted.listSuspended();
    assert.equal(suspended.length, 1);
    assert.equal(suspended[0].runId, run.runId);
    assert.equal(suspended[0].suspendedStepId, "enter-agents");
    assert.equal(suspended[0].pendingInterventionId, "iv-1");
    assert.equal(suspended[0].environmentId, "freeinference-staging");
  }));

test("restart reconciliation drops stale grants for an unverified environment", () =>
  withRunState(async store => {
    const run = await store.create({ workflowId: "wf", workflowName: "x", environmentId: "freeinference-staging", targetId: "tab-1" });
    await store.update(run.runId, { status: "running", authorizationState: { grants: ["grant-1"], realm: "fi-admin" } });
    const reconciled = await store.reconcileRestart(run.runId, {
      attachmentCheck: async () => false,
      environmentCheck: async () => ({ ok: false })
    });
    assert.equal(reconciled.target.attached, false);
    assert.equal(reconciled.status, "waiting_for_human_decision");
    assert.equal(reconciled.authorizationState.grants.length, 0, "stale administrative grants must not carry into an unverified environment");
  }));

test("test-owned resources and their cleanup obligations persist", () =>
  withRunState(async (store, dir) => {
    const run = await store.create({ workflowId: "wf", workflowName: "x" });
    await store.registerTestOwnedResource(run.runId, { resourceId: "conn-123", type: "connector", cleanupAction: "delete" });
    const restarted = new RunStateStore(dir);
    await restarted.init();
    const reloaded = restarted.get(run.runId);
    assert.equal(reloaded.testOwnedResources.length, 1);
    assert.equal(reloaded.testOwnedResources[0].resourceId, "conn-123");
    await restarted.markResourceCleaned(run.runId, "conn-123");
    assert.ok(restarted.get(run.runId).testOwnedResources[0].cleanedAt);
  }));

test("needs_human and waiting_* are suspensions, not terminals; cancellation works mid-suspension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-tasks-"));
  try {
    const store = new TaskStore(dir);
    await store.init();
    const task = store.create("tpl", {});
    store.update(task.task_id, { status: "waiting_for_authentication" });
    // Terminal fencing must NOT block updates between suspension states.
    store.update(task.task_id, { status: "needs_human" });
    assert.equal(store.get(task.task_id).status, "needs_human");
    assert.ok(!TERMINAL_STATUSES.has("needs_human"));
    assert.ok(SUSPENDED_STATUSES.has("needs_human"));
    assert.ok(SUSPENDED_STATUSES.has("waiting_for_authentication"));
    // A finished task stays finished (fencing intact for real terminals).
    store.update(task.task_id, { status: "finished" });
    store.update(task.task_id, { status: "failed" });
    assert.equal(store.get(task.task_id).status, "finished");
    // Cancellation during suspension.
    const task2 = store.create("tpl", {});
    store.update(task2.task_id, { status: "waiting_for_mfa" });
    store.forceCancel(task2.task_id);
    assert.equal(store.get(task2.task_id).status, "canceled");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
