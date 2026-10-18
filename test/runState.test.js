/** Durable resumable run state across restarts (P1-4) + TaskStore suspension semantics (P0-3). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RunStateStore, requestRunCancellation, acquireBrowserTargetLease, browserTargetLeaseId } from "../src/testing/runState.js";
import { TaskStore, TERMINAL_STATUSES, SUSPENDED_STATUSES } from "../src/api/task-store.js";

async function withRunState(fn) {
  const dir = await mkdtemp(join(tmpdir(), "activetab-runs-"));
  const store = new RunStateStore(dir);
  await store.init();
  try { return await fn(store, dir); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
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

test("run-state updates use cross-instance compare-and-swap revisions", () =>
  withRunState(async (store, dir) => {
    const run = await store.create({ runId: "cross-process-cas", workflowId: "wf", workflowName: "CAS" });
    const other = new RunStateStore(dir);
    await other.init();
    const revision = run.revision;
    const results = await Promise.allSettled([
      store.update(run.runId, { status: "running" }, { expectedRevision: revision }),
      other.update(run.runId, { status: "waiting_for_authentication" }, { expectedRevision: revision })
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal((await other.getFresh(run.runId)).revision, revision + 1);
  }));

test("one durable run has a single execution owner across store instances", () =>
  withRunState(async (store, dir) => {
    const other = new RunStateStore(dir);
    await other.init();
    const release = await store.acquireExecutionLease("exclusive-run");
    await assert.rejects(() => other.acquireExecutionLease("exclusive-run"), error => error.code === "RUN_EXECUTION_LEASE_HELD");
    await release();
    const releaseAfterOwnerExit = await other.acquireExecutionLease("exclusive-run");
    await releaseAfterOwnerExit();
  }));

test("different runs cannot control the same browser target concurrently and fencing advances", () =>
  withRunState(async (store, dir) => {
    const other = new RunStateStore(dir);
    await other.init();
    const first = await store.acquireTargetLease("target-shared", "run-one");
    await assert.rejects(
      () => other.acquireTargetLease("target-shared", "run-two"),
      error => error.code === "RUN_TARGET_LEASE_HELD"
    );
    await first.assertCurrent();
    await first.release();

    const second = await other.acquireTargetLease("target-shared", "run-two");
    assert.ok(second.fencingToken > first.fencingToken);
    await assert.rejects(() => first.assertCurrent(), error => error.code === "RUN_TARGET_LEASE_LOST");
    await second.release();
  }));

test("target leases refuse a competing process and can be acquired after release", () =>
  withRunState(async (store, dir) => {
    const targetId = "cross-process-target";
    const childScript = fileURLToPath(new URL("../scripts/targetLeaseChild.js", import.meta.url));
    const first = await store.acquireTargetLease(targetId, "parent-run");
    const refused = spawnSync(process.execPath, [childScript, dir, targetId, "child-run"], { encoding: "utf8" });
    assert.equal(refused.status, 23, refused.stderr || refused.stdout);
    await first.release();

    const acquired = spawnSync(process.execPath, [childScript, dir, targetId, "child-run"], { encoding: "utf8" });
    assert.equal(acquired.status, 0, acquired.stderr || acquired.stdout);
  }));

test("browser target lease is bound to the attached endpoint and target identity", () =>
  withRunState(async store => {
    const session = { attached: true, target: { id: "tab-original", endpoint: "http://127.0.0.1:9222" } };
    const lease = await acquireBrowserTargetLease(store, session, "identity-bound-run");
    assert.notEqual(browserTargetLeaseId(session.target), browserTargetLeaseId({ id: session.target.id, endpoint: "http://127.0.0.1:9223" }));
    session.target = { id: "tab-substituted", endpoint: "http://127.0.0.1:9222" };
    await assert.rejects(() => lease.assertCurrent(), error => error.code === "RUN_TARGET_LEASE_LOST");
    await lease.release();
  }));

test("cancellation remains available from durable run state after the worker cache is gone", () =>
  withRunState(async (store, dir) => {
    const run = await store.create({ runId: "cancel-after-restart", workflowId: "wf", workflowName: "Cancellation recovery", environmentId: "staging", targetId: "tab-exact" });
    await store.reserveOperation(run.runId, {
      operationId: "submit-operation",
      stepId: "submit",
      action: "click",
      effectDigest: "submit-contract",
      environmentId: "staging",
      targetId: "tab-exact"
    });
    const restarted = new RunStateStore(dir);
    await restarted.init();
    const cancellation = await requestRunCancellation(restarted, run.runId);
    assert.equal(cancellation.requested, true);
    assert.equal(cancellation.requiresReconciliation, true);
    assert.equal(cancellation.run.cancellationRequested, true);
    assert.equal(cancellation.run.pendingOperations[0].status, "RESERVED");
  }));

test("reserved and possibly dispatched operations become uncertain across restart and cannot be replayed", () =>
  withRunState(async (store, dir) => {
    const run = await store.create({
      runId: "operation-recovery",
      workflowId: "wf",
      workflowName: "Operation recovery",
      environmentId: "freeinference-staging",
      targetId: "tab-exact"
    });
    await store.reserveOperation(run.runId, {
      operationId: "operation-1",
      stepId: "submit-task",
      action: "click",
      effectDigest: "contract-1",
      environmentId: "freeinference-staging",
      targetId: "tab-exact"
    });
    await store.recordOperationDispatch(run.runId, { operationId: "operation-1", status: "UNCERTAIN" });

    const restarted = new RunStateStore(dir);
    await restarted.init();
    const reconciled = await restarted.reconcileRestart(run.runId, {
      attachmentCheck: async targetId => targetId === "tab-exact",
      environmentCheck: async environmentId => ({ ok: environmentId === "freeinference-staging" })
    });
    assert.equal(reconciled.status, "reconciling");
    assert.equal(reconciled.uncertainOperations[0].status, "UNCERTAIN");
    await assert.rejects(() => restarted.reserveOperation(run.runId, {
      operationId: "operation-1", stepId: "submit-task", action: "click", effectDigest: "contract-1",
      environmentId: "freeinference-staging", targetId: "tab-exact"
    }), /already reached UNCERTAIN/);
    await restarted.reconcileOperation(run.runId, { operationId: "operation-1", status: "VERIFIED", evidenceIds: ["browser-evidence", "backend-evidence"] });
    assert.equal((await restarted.getFresh(run.runId)).pendingOperations[0].status, "VERIFIED");
  }));

test("run bindings cannot be retargeted after creation", () =>
  withRunState(async store => {
    const run = await store.create({ workflowId: "wf", workflowName: "Bound", environmentId: "staging", targetId: "tab-one" });
    await assert.rejects(() => store.update(run.runId, { environmentId: "production" }), /immutable/);
    await assert.rejects(() => store.update(run.runId, { target: { targetId: "tab-two", attached: true } }), /cannot change/);
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
