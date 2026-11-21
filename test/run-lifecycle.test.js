import { test } from "node:test";
import assert from "node:assert/strict";
import { RunLifecycle } from "../src/api/run-lifecycle.js";
import { TaskStore } from "../src/api/task-store.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("stopAll waits for the worker's final task persistence", async () => {
  let persistCalls = 0;
  let announceFinalPersist;
  let releaseFinalPersist;
  const finalPersistStarted = new Promise(resolve => { announceFinalPersist = resolve; });
  const finalPersistGate = new Promise(resolve => { releaseFinalPersist = resolve; });
  const task = { task_id: "task-1", status: "queued" };
  const store = {
    update(_taskId, updates) { Object.assign(task, updates); return task; },
    async persist() {
      persistCalls += 1;
      if (persistCalls === 2) {
        announceFinalPersist();
        await finalPersistGate;
      }
    }
  };
  const lifecycle = new RunLifecycle({
    store,
    navigationRunner: { run: async () => ({ status: "succeeded" }) }
  });

  const { worker } = lifecycle.start(task.task_id, async () => ({ status: "succeeded" }));
  await finalPersistStarted;

  let stopFinished = false;
  const stopping = lifecycle.stopAll().then(() => { stopFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopFinished, false, "shutdown must keep waiting for the durable write");

  releaseFinalPersist();
  await Promise.all([worker, stopping]);
  assert.equal(stopFinished, true);
  assert.equal(lifecycle.running.size, 0);
});

test("TaskStore freezes all terminal task fields against late worker metadata", () => {
  const store = new TaskStore("unused");
  const task = store.create("remote-peer-run", {});
  store.update(task.task_id, {
    status: "finished",
    output: { verified: true },
    finished_at: "terminal-time"
  });
  const terminalReceipt = structuredClone(task);

  store.update(task.task_id, {
    status: "finished",
    output: { verified: false },
    error: "late worker update",
    usage: { actions: 99 }
  });

  assert.deepEqual(task, terminalReceipt);
});

test("cancellation before execute dispatch settles as canceled after write-ahead intent", async () => {
  const firstPersistStarted = deferred();
  const releaseFirstPersist = deferred();
  const task = { task_id: "pre-dispatch", status: "queued" };
  let persistCalls = 0;
  let executeCalls = 0;
  const store = {
    get: () => task,
    update(_taskId, updates) {
      if (["finished", "failed", "canceled"].includes(task.status)) return task;
      Object.assign(task, updates);
      return task;
    },
    async persist() {
      persistCalls++;
      if (persistCalls === 1) {
        firstPersistStarted.resolve();
        await releaseFirstPersist.promise;
      }
    }
  };
  const lifecycle = new RunLifecycle({ store, navigationRunner: { run: async () => ({ status: "canceled", uncertain: false }) } });
  const { worker } = lifecycle.start(task.task_id, async () => {
    executeCalls++;
    return { status: "canceled", uncertain: false };
  });

  await firstPersistStarted.promise;
  const cancelResult = await lifecycle.cancel(task.task_id);
  assert.equal(cancelResult.status, "cancel_requested");
  assert.equal(task.cancellation_requested, true);
  releaseFirstPersist.resolve();
  await worker;

  assert.equal(executeCalls, 0);
  assert.equal(task.status, "canceled");
  assert.match(task.error, /before dispatch/);
});

test("cancellation after dispatch remains reconciling when verification is interrupted", async () => {
  const verificationStarted = deferred();
  const task = { task_id: "post-dispatch", status: "queued" };
  const store = {
    get: () => task,
    update(_taskId, updates) {
      if (["finished", "failed", "canceled"].includes(task.status)) return task;
      Object.assign(task, updates);
      return task;
    },
    async persist() {}
  };
  const lifecycle = new RunLifecycle({ store, navigationRunner: { run: async () => ({ status: "canceled", uncertain: true }) } });
  const { worker } = lifecycle.start(task.task_id, async controller => {
    verificationStarted.resolve();
    return await new Promise(resolve => controller.signal.addEventListener("abort", () => resolve({
      status: "canceled",
      uncertain: true,
      reason: "The action was dispatched; cancellation interrupted outcome verification.",
      output: { status: "canceled", uncertain: true }
    }), { once: true }));
  });

  await verificationStarted.promise;
  const cancelResult = await lifecycle.cancel(task.task_id);
  assert.equal(cancelResult.status, "cancel_requested");
  await worker;

  assert.equal(task.status, "reconciling");
  assert.equal(task.output.uncertain, true);
  assert.match(task.error, /outcome verification/);
});
