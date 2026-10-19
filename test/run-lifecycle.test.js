import { test } from "node:test";
import assert from "node:assert/strict";
import { RunLifecycle } from "../src/api/run-lifecycle.js";

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
