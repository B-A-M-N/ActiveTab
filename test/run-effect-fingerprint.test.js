import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStateStore } from "../src/testing/runState.js";
import { RunDecisionRecorder } from "../src/testing/telemetry/runDecisionRecorder.js";
import { STEP_STATUS } from "../src/testing/schema.js";

test("durable effect fingerprints block equivalent replans without storing input values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-effect-fingerprint-"));
  let firstStore;
  let restartedStore;
  try {
    firstStore = new RunStateStore(directory);
    await firstStore.init();
    const run = await firstStore.create({
      runId: "effect-alias-run",
      workflowId: "workflow-fixture",
      workflowName: "Effect fingerprint fixture",
      environmentId: "local-fixture",
      targetId: "target-fixture"
    });
    const environment = { environmentId: "local-fixture" };
    const session = { target: { id: "target-fixture" } };
    const secretValue = "fixture-secret-9124-not-for-storage";
    const createRecorder = store => new RunDecisionRecorder({ runStateStore: store, environment, session });
    const candidate = generation => ({
      identity: `target-fixture:root:frame:${generation}:1`,
      role: "textbox",
      tag: "input",
      type: "password",
      name: "Password",
      contextName: "Sign in",
      attributes: { id: "password", name: "password", type: "password" }
    });
    const createHooks = (recorder, stepId, value = secretValue, generation = stepId) => recorder.createHooks({
      receipt: { runId: run.runId, workflowId: run.workflowId, cleanup: [] },
      action: "fill",
      candidate: candidate(generation),
      decisionContext: stepId === "step-replanned"
        ? { operationClass: "different_capability_class", targetRole: "renamed_capability_target" }
        : { operationClass: "unknown", targetRole: "password_field" },
      effectIntent: {
        goal: "Enter the requested sign-in value",
        target: { role: "textbox", name: "Password" },
        value
      },
      runtimeStepId: stepId,
      telemetryStepId: stepId
    });

    const initialHooks = await createHooks(createRecorder(firstStore), "step-original");
    await initialHooks.onReserve({ observation: { evidenceId: "before-original" } });
    const initial = await firstStore.getFresh(run.runId);
    const originalDigest = initial.pendingOperations[0].effectDigest;
    assert.match(originalDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(initial).includes(secretValue), false);

    firstStore.close();
    restartedStore = new RunStateStore(directory);
    await restartedStore.init();
    const restartedRecorder = createRecorder(restartedStore);
    const replannedHooks = await createHooks(restartedRecorder, "step-replanned", secretValue, "new-document-generation");
    await assert.rejects(
      () => replannedHooks.onReserve({ observation: { evidenceId: "before-replanned" } }),
      /Equivalent effect is already RESERVED/
    );

    const resumedOriginalHooks = await createHooks(restartedRecorder, "step-original");
    await resumedOriginalHooks.onDispatch({ dispatchStatus: "dispatched", observation: { evidenceId: "dispatch-original" } });
    await resumedOriginalHooks.recordVerification({ status: STEP_STATUS.PASS, evidenceIds: ["verified-original"] });

    const changedValueHooks = await createHooks(restartedRecorder, "step-new-value", "different-fixture-secret-7182");
    await changedValueHooks.onReserve({ observation: { evidenceId: "before-new-value" } });
    const afterNewValue = await restartedStore.getFresh(run.runId);
    assert.notEqual(afterNewValue.pendingOperations[0].effectDigest, afterNewValue.pendingOperations[1].effectDigest);
    assert.equal(JSON.stringify(afterNewValue).includes("different-fixture-secret-7182"), false);

    const keyFile = (await readdir(directory)).find(name => name.startsWith(".effect-key-"));
    assert.ok(keyFile, "a stable private key must survive a process restart");
    assert.equal((await readFile(join(directory, keyFile))).length, 32);
    assert.equal((await stat(join(directory, keyFile))).mode & 0o777, 0o600);
  } finally {
    firstStore?.close();
    restartedStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
