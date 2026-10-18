import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkflowStepAdmission, deriveWorkflowRunStatus, estimateWorkflowExecutionCost } from "../src/testing/execution/workflowScheduler.js";
import { RUN_STATUS, STEP_STATUS } from "../src/testing/schema.js";

test("scheduler permits only a declared recovery branch after sequential failure", () => {
  const failedStepIds = new Set(["submit"]);
  const statuses = new Map([["submit", STEP_STATUS.FAIL]]);
  const workflow = { execution: "sequence" };

  assert.deepEqual(evaluateWorkflowStepAdmission({
    workflow,
    step: { id: "collect", type: "diagnostic_snapshot" },
    stepStatuses: statuses,
    failedStepIds
  }), {
    action: "block",
    reason: "Skipped because a prerequisite step failed (submit)."
  });
  assert.deepEqual(evaluateWorkflowStepAdmission({
    workflow,
    step: { id: "recover", type: "diagnostic_snapshot", recoveryBranch: true },
    stepStatuses: statuses,
    failedStepIds
  }), { action: "execute" });
});

test("scheduler blocks compensation while source effect is uncertain", () => {
  const decision = evaluateWorkflowStepAdmission({
    workflow: { execution: "dag" },
    step: { id: "cleanup", type: "cleanup", compensates: { stepId: "create", statuses: [STEP_STATUS.PASS] } },
    stepStatuses: new Map([["create", STEP_STATUS.UNCERTAIN]]),
    failedStepIds: new Set()
  });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /source effect is uncertain/u);
});

test("scheduler derives DAG terminal status and bounds nested execution cost", () => {
  const workflow = {
    execution: "dag",
    steps: [
      { id: "prepare", dependsOn: [] },
      { id: "finish", dependsOn: ["prepare"] }
    ]
  };
  assert.equal(deriveWorkflowRunStatus(workflow, new Map([
    ["prepare", STEP_STATUS.PASS], ["finish", STEP_STATUS.PASS]
  ])), RUN_STATUS.PASSED);
  assert.equal(deriveWorkflowRunStatus(workflow, new Map([
    ["prepare", STEP_STATUS.UNCERTAIN], ["finish", STEP_STATUS.BLOCKED]
  ])), RUN_STATUS.UNCERTAIN);

  const child = { id: "child", steps: [{ id: "a" }, { id: "b" }] };
  const parent = { id: "parent", steps: [{ id: "call", type: "subworkflow", workflowRef: "child" }] };
  assert.equal(estimateWorkflowExecutionCost({
    workflow: parent,
    maxSteps: 4,
    getWorkflow: reference => reference === "child" ? child : null
  }), 3);
});
