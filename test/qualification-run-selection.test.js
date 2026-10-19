import test from "node:test";
import assert from "node:assert/strict";
import { selectQualificationRunState } from "../src/testing/qualificationRunSelection.js";

const binding = { environmentId: "staging" };

function makeStore(runs) {
  const updates = [];
  return {
    updates,
    listSuspended: () => runs.filter(run => run.status.startsWith("waiting_")),
    listActive: () => runs.filter(run => run.status === "running"),
    async update(runId, patch) { updates.push({ runId, patch }); }
  };
}

function resumableRun(overrides = {}) {
  return {
    runId: "resume-me",
    workflowId: "cloud-agent-staging-qualification",
    environmentId: "staging",
    profileId: "profile-a",
    mode: "owned",
    status: "waiting_for_authentication",
    pendingInterventionId: "intervention-a",
    resumeCursor: { schemaVersion: 1 },
    target: { targetId: "target-a" },
    ...overrides
  };
}

test("qualification run selection blocks a replacement while a matching run is unfinished", async () => {
  const store = makeStore([resumableRun()]);
  const result = await selectQualificationRunState({
    runStore: store,
    binding,
    profileId: "profile-a",
    mode: "owned",
    runStoreDir: "/local/run-state"
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.messages.join("\n"), /unfinished run.*\/local\/run-state/);
  assert.match(result.messages.join("\n"), /runId=resume-me/);
  assert.deepEqual(store.updates, []);
});

test("qualification run selection resumes only the exact eligible profile, mode, and target", async () => {
  const run = resumableRun();
  const store = makeStore([run]);
  const result = await selectQualificationRunState({
    runStore: store,
    binding,
    profileId: "profile-a",
    mode: "owned",
    resumeRunId: "resume-me",
    requestedTargetId: "target-a"
  });

  assert.equal(result.ok, true);
  assert.equal(result.resumeRunState, run);
  assert.deepEqual(store.updates, []);
});

test("qualification run selection rejects a target mismatch before browser attachment", async () => {
  const store = makeStore([resumableRun()]);
  const result = await selectQualificationRunState({
    runStore: store,
    binding,
    profileId: "profile-a",
    mode: "owned",
    resumeRunId: "resume-me",
    requestedTargetId: "other-target"
  });

  assert.equal(result.ok, false);
  assert.match(result.messages[0], /does not match run 'resume-me'/);
});

test("qualification run selection explicitly clears only the chosen run before replacement", async () => {
  const runs = [resumableRun(), resumableRun({ runId: "other-run", target: { targetId: "target-b" } })];
  const store = makeStore(runs);
  const result = await selectQualificationRunState({
    runStore: store,
    binding,
    profileId: "profile-a",
    mode: "owned",
    discardRunId: "resume-me"
  });

  assert.equal(result.ok, false, "the second unfinished run must continue to block replacement");
  assert.deepEqual(store.updates, [{
    runId: "resume-me",
    patch: { status: "abandoned", pendingInterventionId: null, suspendedStepId: null, resumeCursor: null }
  }]);
  assert.match(result.messages.join("\n"), /other-run/);
});

test("environment discard flag selects a run only when exactly one matching run is pending", async () => {
  const oneStore = makeStore([resumableRun()]);
  const one = await selectQualificationRunState({
    runStore: oneStore,
    binding,
    profileId: "profile-a",
    mode: "owned",
    discardSinglePending: true
  });
  assert.equal(one.ok, true);
  assert.equal(oneStore.updates[0].runId, "resume-me");

  const multipleStore = makeStore([resumableRun(), resumableRun({ runId: "other-run" })]);
  const multiple = await selectQualificationRunState({
    runStore: multipleStore,
    binding,
    profileId: "profile-a",
    mode: "owned",
    discardSinglePending: true
  });
  assert.equal(multiple.ok, false);
  assert.deepEqual(multipleStore.updates, []);
});
