import test from "node:test";
import assert from "node:assert/strict";
import { projectGoalOutcome } from "../src/testing/steps/goalOutcome.js";
import { STEP_STATUS } from "../src/testing/schema.js";

test("goal outcome projection preserves uncertainty after dispatched cancellation", () => {
  const outcome = projectGoalOutcome("Submit the form", {
    status: "canceled",
    uncertain: true,
    dispatchDisposition: "dispatched_unverified",
    evidenceId: "evidence-1",
    attempts: 1
  });

  assert.equal(outcome.status, STEP_STATUS.UNCERTAIN);
  assert.match(outcome.reason, /must be reconciled/u);
  assert.equal(outcome.details.uncertain, true);
  assert.equal(outcome.details.dispatchDisposition, "dispatched_unverified");
  assert.deepEqual(outcome.evidenceIds, ["evidence-1"]);
});

test("goal outcome projection only calls cancellation definitive with pre-dispatch evidence", () => {
  const canceled = projectGoalOutcome("Open the settings page", {
    status: "canceled",
    uncertain: false,
    dispatchDisposition: "refused_pre_dispatch"
  });
  const unknown = projectGoalOutcome("Open the settings page", { status: "canceled" });

  assert.equal(canceled.status, STEP_STATUS.CANCELED);
  assert.equal(canceled.details.uncertain, false);
  assert.equal(unknown.status, STEP_STATUS.UNCERTAIN);
});
