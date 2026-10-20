import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunStateStore } from "../src/testing/runState.js";
import { spawnLifecycleWorker } from "../test-lab/fault-injection/runLifecycleHarness.js";

async function withRunState(callback) {
  const baseDir = await mkdtemp(join(tmpdir(), "activetab-multiprocess-"));
  const store = new RunStateStore(baseDir);
  await store.init();
  try { await callback(store, baseDir); }
  finally {
    store.close();
    await rm(baseDir, { recursive: true, force: true });
  }
}

function operation(operationId, effectDigest = "same-effect") {
  return {
    operationId,
    stepId: "submit",
    action: "click",
    effectDigest,
    environmentId: "fixture-env",
    targetId: "tab-exact"
  };
}

test("target lease serializes separate processes and advances fencing after owner crash", async () => {
  await withRunState(async (store, baseDir) => {
    const worker = spawnLifecycleWorker("hold-target-lease", baseDir, {
      targetId: "shared-target",
      runId: "child-owner",
      ttlMs: 1_000
    });
    let successor;
    try {
      const owned = await worker.nextMessage();
      assert.equal(owned.event, "acquired", worker.stderr);

      const targetKey = createHash("sha256").update("shared-target").digest("hex");
      const heartbeatBefore = Number(store.targetLeaseDb.prepare("SELECT heartbeat_at FROM target_leases WHERE target_key = ?").get(targetKey)?.heartbeat_at);
      await delay(1_250);
      const heartbeatAfter = Number(store.targetLeaseDb.prepare("SELECT heartbeat_at FROM target_leases WHERE target_key = ?").get(targetKey)?.heartbeat_at);
      assert.ok(heartbeatAfter > heartbeatBefore, "the remote owner heartbeat must refresh the SQLite lease");

      const independent = await store.acquireTargetLease("independent-target", "parent-run");
      await independent.release();

      await assert.rejects(
        () => store.acquireTargetLease("shared-target", "parent-contender"),
        error => error.code === "RUN_TARGET_LEASE_HELD"
      );

      await worker.kill("SIGKILL");
      successor = await store.acquireTargetLease("shared-target", "parent-successor");
      assert.ok(successor.fencingToken > owned.fencingToken);
      assert.equal(await successor.assertCurrent(), successor.fencingToken);
    } finally {
      if (successor) await successor.release();
      await worker.kill();
    }
  });
});

test("process restart keeps a dispatched effect uncertain and refuses replay", async () => {
  await withRunState(async (store, baseDir) => {
    const run = await store.create({
      runId: "restart-dispatch",
      workflowId: "fixture-workflow",
      workflowName: "Cross-process dispatch recovery",
      environmentId: "fixture-env",
      targetId: "tab-exact"
    });
    const worker = spawnLifecycleWorker("reserve-operation", baseDir, {
      runId: run.runId,
      operation: operation("submitted-effect"),
      dispatchStatus: "DISPATCHED",
      receiptId: "dispatch-receipt",
      crashAfterCommit: true
    });
    try {
      assert.equal((await worker.nextMessage()).event, "ready");
      worker.send({ action: "continue" });
      assert.deepEqual(await worker.nextMessage(), { event: "operation-result", outcome: "committed" });
      assert.equal((await worker.kill("SIGKILL")).signal, "SIGKILL");
    } finally { await worker.kill(); }

    const restarted = new RunStateStore(baseDir);
    await restarted.init();
    try {
      const first = await restarted.reconcileRestart(run.runId, {
        attachmentCheck: async targetId => targetId === "tab-exact",
        environmentCheck: async environmentId => ({ ok: environmentId === "fixture-env" })
      });
      const second = await restarted.reconcileRestart(run.runId, {
        attachmentCheck: async targetId => targetId === "tab-exact",
        environmentCheck: async environmentId => ({ ok: environmentId === "fixture-env" })
      });
      assert.equal(first.status, "reconciling");
      assert.deepEqual(first.pendingOperations.map(item => [item.operationId, item.status]), [["submitted-effect", "UNCERTAIN"]]);
      assert.deepEqual(second.pendingOperations.map(item => [item.operationId, item.status]), [["submitted-effect", "UNCERTAIN"]]);
      assert.deepEqual(second.uncertainOperations.map(item => [item.operationId, item.status]), [["submitted-effect", "UNCERTAIN"]]);
      await assert.rejects(() => restarted.reserveOperation(run.runId, operation("submitted-effect")), /already reached UNCERTAIN/);
      await assert.rejects(() => restarted.reserveOperation(run.runId, operation("replanned-effect")), /Equivalent effect is already UNCERTAIN/);
      assert.equal((await restarted.getFresh(run.runId)).pendingOperations[0].status, "UNCERTAIN");
    } finally { restarted.close(); }
  });
});

test("crash after durable reservation but before dispatch remains uncertain after restart", async () => {
  await withRunState(async (store, baseDir) => {
    const run = await store.create({
      runId: "restart-reservation",
      workflowId: "fixture-workflow",
      workflowName: "Reservation crash recovery",
      environmentId: "fixture-env",
      targetId: "tab-exact"
    });
    const worker = spawnLifecycleWorker("reserve-operation", baseDir, {
      runId: run.runId,
      operation: operation("reserved-before-dispatch"),
      crashAfterCommit: true
    });
    try {
      assert.equal((await worker.nextMessage()).event, "ready");
      worker.send({ action: "continue" });
      assert.deepEqual(await worker.nextMessage(), { event: "operation-result", outcome: "committed" });
      assert.equal((await worker.kill("SIGKILL")).signal, "SIGKILL");
    } finally { await worker.kill(); }

    const restarted = new RunStateStore(baseDir);
    await restarted.init();
    try {
      const recovered = await restarted.reconcileRestart(run.runId, {
        attachmentCheck: async () => true,
        environmentCheck: async () => ({ ok: true })
      });
      assert.equal(recovered.pendingOperations[0].status, "UNCERTAIN");
      await assert.rejects(() => restarted.reserveOperation(run.runId, operation("replacement-reservation")), /Equivalent effect is already UNCERTAIN/);
    } finally { restarted.close(); }
  });
});

test("separate processes admit only one reservation for an equivalent effect", async () => {
  await withRunState(async (store, baseDir) => {
    const run = await store.create({
      runId: "competing-reservations",
      workflowId: "fixture-workflow",
      workflowName: "Concurrent operation reservation",
      environmentId: "fixture-env",
      targetId: "tab-exact"
    });
    const worker = spawnLifecycleWorker("reserve-operation", baseDir, {
      runId: run.runId,
      operation: operation("child-operation")
    });
    try {
      assert.equal((await worker.nextMessage()).event, "ready");
      const parentReservation = store.reserveOperation(run.runId, operation("parent-operation"));
      worker.send({ action: "continue" });
      const [parent, child] = await Promise.allSettled([parentReservation, worker.nextMessage()]);
      assert.equal(child.status, "fulfilled");
      assert.equal(child.value.event, "operation-result");
      if (parent.status === "fulfilled") {
        assert.equal(child.value.outcome, "rejected");
        assert.match(child.value.message, /Equivalent effect is already RESERVED/);
      } else {
        assert.match(parent.reason.message, /Equivalent effect is already RESERVED/);
        assert.equal(child.value.outcome, "committed");
      }
      assert.equal((await worker.waitForExit()).code, 0, worker.stderr);
      const persisted = await store.getFresh(run.runId);
      assert.equal(persisted.pendingOperations.filter(item => item.effectDigest === "same-effect").length, 1);
    } finally { await worker.kill(); }
  });
});

test("cross-process run updates use revision compare-and-swap and owner-private modes", async () => {
  await withRunState(async (store, baseDir) => {
    const run = await store.create({ runId: "cross-process-revision", workflowId: "fixture-workflow", workflowName: "CAS" });
    const initialRevision = run.revision;
    const directoryMode = (await stat(baseDir)).mode & 0o777;
    const runFileMode = (await stat(join(baseDir, `${run.runId}.json`))).mode & 0o777;
    const databaseMode = (await stat(join(baseDir, "target-leases.sqlite"))).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(runFileMode, 0o600);
    assert.equal(databaseMode, 0o600);

    const worker = spawnLifecycleWorker("compare-and-swap", baseDir, {
      runId: run.runId,
      expectedRevision: initialRevision,
      status: "waiting_for_authentication"
    });
    try {
      assert.equal((await worker.nextMessage()).event, "ready");
      const parentUpdate = store.update(run.runId, { status: "running" }, { expectedRevision: initialRevision });
      worker.send({ action: "continue" });
      const [parent, child] = await Promise.allSettled([parentUpdate, worker.nextMessage()]);
      assert.equal(child.status, "fulfilled");
      assert.equal(child.value.event, "update-result");
      if (parent.status === "fulfilled") {
        assert.equal(child.value.outcome, "rejected");
        assert.equal(child.value.code, "RUN_STATE_REVISION_CONFLICT");
      } else {
        assert.equal(parent.reason.code, "RUN_STATE_REVISION_CONFLICT");
        assert.equal(child.value.outcome, "committed");
      }
      assert.equal((await worker.waitForExit()).code, 0, worker.stderr);
      assert.equal((await store.getFresh(run.runId)).revision, initialRevision + 1);
    } finally { await worker.kill(); }
  });
});

test("crash with an owned resource leaves cleanup required after restart", async () => {
  await withRunState(async (store, baseDir) => {
    const run = await store.create({ runId: "restart-cleanup", workflowId: "fixture-workflow", workflowName: "Cleanup crash recovery" });
    const worker = spawnLifecycleWorker("register-resource", baseDir, {
      runId: run.runId,
      resource: { resourceId: "fixture-resource", type: "connector", cleanupAction: "delete" },
      crashAfterCommit: true
    });
    try {
      assert.deepEqual(await worker.nextMessage(), { event: "resource-result", outcome: "committed" });
      assert.equal((await worker.kill("SIGKILL")).signal, "SIGKILL");
    } finally { await worker.kill(); }

    const restarted = new RunStateStore(baseDir);
    await restarted.init();
    try {
      const recovered = await restarted.getFresh(run.runId);
      assert.equal(recovered.testOwnedResources[0].cleanupStatus, "required");
      assert.equal(recovered.testOwnedResources[0].cleanupVerifiedAt, undefined);
    } finally { restarted.close(); }
  });
});
