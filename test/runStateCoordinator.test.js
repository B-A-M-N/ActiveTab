import test from "node:test";
import assert from "node:assert/strict";
import { RunStateCoordinator } from "../src/testing/lifecycle/runStateCoordinator.js";
import { RUN_STATUS, STEP_STATUS } from "../src/testing/schema.js";
import { INTERVENTION_STATE } from "../src/runtime/interventions.js";

test("checkpoint persistence failure keeps the step uncertain for reconciliation", async () => {
  const step = { stepId: "submit", status: STEP_STATUS.PASS, reason: "UI changed" };
  const coordinator = new RunStateCoordinator({
    runStateStore: {
      async updateCheckpoint() { throw new Error("disk unavailable"); }
    }
  });
  const recorded = await coordinator.checkpointRecordedStep({ runId: "run-checkpoint-failure", steps: [step] }, "submit");
  assert.equal(recorded, false);
  assert.equal(step.status, STEP_STATUS.UNCERTAIN);
  assert.equal(step.reason, "The execution result could not be durably checkpointed; reconciliation is required.");
});

test("waiting run completion preserves the suspended step and intervention binding", async () => {
  let update = null;
  const coordinator = new RunStateCoordinator({
    runStateStore: {
      async getFresh() { return { currentStepId: "authenticate" }; },
      async update(_runId, state) { update = state; }
    }
  });
  await coordinator.completeRunState({
    runId: "run-waiting",
    status: RUN_STATUS.WAITING_FOR_AUTHENTICATION,
    interventions: [{ state: INTERVENTION_STATE.WAITING, interventionId: "intervention-auth" }]
  });
  assert.deepEqual(update, {
    status: "waiting_for_authentication",
    currentStepId: "authenticate",
    pendingInterventionId: "intervention-auth"
  });
});

test("run coordinator reuses an outer target lease without releasing it", async () => {
  let currentAssertions = 0;
  let targetReleases = 0;
  let runReleases = 0;
  const targetLease = {
    fencingToken: 12,
    async assertCurrent() { currentAssertions++; },
    async release() { targetReleases++; }
  };
  const coordinator = new RunStateCoordinator({
    runStateStore: { async acquireExecutionLease() { return async () => { runReleases++; }; } },
    session: { attached: true, target: { id: "target-outer" } },
    targetLease
  });
  const releaseRun = await coordinator.acquireExecutionLeases("run_outer_lease");
  assert.equal(currentAssertions, 1);
  assert.equal(coordinator.targetLease, targetLease);
  await releaseRun();
  assert.equal(targetReleases, 0);
  assert.equal(runReleases, 1);
  assert.equal(coordinator.targetLease, targetLease);
});
