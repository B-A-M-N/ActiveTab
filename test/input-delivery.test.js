import test from "node:test";
import assert from "node:assert/strict";
import { TestRunner } from "../src/testing/runner.js";
import { RUN_STATUS } from "../src/testing/schema.js";
import { createRunStateFixture } from "./runStateFixture.js";

test("partial text dispatch with unavailable reconciliation stays uncertain and is never replayed", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = {
    identity: "task-input", targetId: "fixture-target", documentGeneration: 1,
    backendNodeId: 41, name: "Task", role: "textbox", tag: "textarea", visible: true, disabled: false
  };
  let dispatchAttempts = 0;
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      return {
        targetId: "fixture-target", documentGeneration: 1,
        page: { url: "http://fixture.local/", title: "Composer" },
        candidates: [candidate], evidenceId: "ev-partial-text-dispatch"
      };
    },
    async fillField() {
      dispatchAttempts++;
      throw new Error("CDP failed after select-all began; final field state is unknown");
    },
    async verifyControlValue() { return { verified: false, matches: false }; },
    async waitForChange() {}
  };
  const runner = new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
    operationAuthorizer: { async authorize() { return { allowed: true }; } }
  });
  const receipt = await runner.run({
    id: "workflow-partial-text-input", name: "Partial text input",
    steps: [{
      id: "fill", type: "interact", action: {
        type: "fill", operationId: "task-input", target: { identity: "task-input" },
        value: "requested task", verifyValue: true
      }
    }]
  }, { runId: "run-partial-text-input" });
  assert.equal(receipt.status, RUN_STATUS.UNCERTAIN);
  assert.equal(dispatchAttempts, 1, "an uncertain input delivery is not automatically retried");
});
