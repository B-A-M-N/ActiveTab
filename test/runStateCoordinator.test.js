import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStateCoordinator } from "../src/testing/lifecycle/runStateCoordinator.js";
import { RUN_STATUS, STEP_STATUS } from "../src/testing/schema.js";
import { INTERVENTION_STATE } from "../src/runtime/interventions.js";
import { RunStateStore } from "../src/testing/runState.js";

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

test("declared run realm remains stable while an authorized workflow crosses application realms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-cross-app-realm-"));
  const store = new RunStateStore(directory);
  try {
    await store.init();
    const environment = {
      environmentId: "staging",
      entryOrigin: "https://staging.example.org",
      authorizedOrigins: ["https://staging.example.org", "https://agents-staging.example.org"],
      authenticationRealms: [
        { realmId: "fi-session" },
        { realmId: "agents-session" }
      ],
      applications: [
        { applicationId: "dashboard", authenticationRealm: "fi-session", candidateEntry: "/dashboard" },
        { applicationId: "agents", authenticationRealm: "agents-session", candidateEntry: "https://agents-staging.example.org/" }
      ]
    };
    const session = {
      attached: true,
      target: { id: "cross-app-target", url: "https://staging.example.org/dashboard" }
    };
    const runId = "cross-app-run";
    const workflow = {
      id: "cloud-agent-staging-qualification",
      name: "Cloud Agent qualification",
      steps: [{ id: "inspect", type: "assert", assertion: { type: "page_title_contains", value: "Cloud Agent" } }]
    };
    await store.create({
      runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      environmentId: environment.environmentId,
      authenticationRealm: "agents-session",
      targetId: session.target.id,
      profileId: "cloud-agent-staging"
    });
    const options = {
      runStateStore: store,
      session,
      environment,
      authenticationRealm: "agents-session",
      profileId: "cloud-agent-staging"
    };
    const receipt = { runId };
    await assert.rejects(
      new RunStateCoordinator({ ...options, authenticationRealm: "undeclared-session" }).initializeRunState(workflow, receipt, {
        existingRunStateId: runId,
        workflowHash: "cross-app-workflow-hash"
      }),
      /not present in the verified environment profile/u
    );
    await assert.rejects(
      new RunStateCoordinator({ ...options, authenticationRealm: null }).initializeRunState(workflow, receipt, {
        existingRunStateId: runId,
        workflowHash: "cross-app-workflow-hash"
      }),
      /does not match the current run/u
    );
    await new RunStateCoordinator(options).initializeRunState(workflow, receipt, {
      existingRunStateId: runId,
      workflowHash: "cross-app-workflow-hash"
    });
    session.target.url = "https://agents-staging.example.org/runs";
    await new RunStateCoordinator(options).initializeRunState(workflow, receipt, {
      existingRunStateId: runId,
      workflowHash: "cross-app-workflow-hash"
    });
    assert.equal((await store.getFresh(runId)).authenticationRealm, "agents-session");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
