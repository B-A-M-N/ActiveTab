import test from "node:test";
import assert from "node:assert/strict";
import { trackRunResult } from "../src/mcp/runTracker.js";

test("run tracker reports RUNNING until the actual run promise settles", async () => {
  let resolveRun;
  const tracker = trackRunResult(new Promise(resolve => { resolveRun = resolve; }));

  assert.equal(tracker.status, "RUNNING");
  assert.equal(tracker.settled, false);
  assert.equal(tracker.receipt, null);

  const receipt = { status: "WAITING_FOR_AUTHENTICATION" };
  resolveRun(receipt);
  await tracker.completion;

  assert.equal(tracker.status, "WAITING_FOR_AUTHENTICATION");
  assert.equal(tracker.settled, true);
  assert.equal(tracker.receipt, receipt);
});

test("run tracker records failures as settled instead of leaving a false RUNNING state", async () => {
  const failure = new Error("workflow failed");
  const tracker = trackRunResult(Promise.reject(failure));

  await tracker.completion;

  assert.equal(tracker.status, "FAILED");
  assert.equal(tracker.settled, true);
  assert.equal(tracker.error, failure);
  assert.equal(tracker.receipt, null);
});
