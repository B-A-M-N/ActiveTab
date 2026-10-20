import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowGraphPlanner } from "../src/navigation/workflowPlanner.js";
import { createWorkflowRoutePlanner } from "../src/navigation/workflowRoutePlanner.js";

test("unresolved task routes produce an explicit no-action abstention", async () => {
  const selected = createWorkflowRoutePlanner({
    requestedPlannerMode: "auto",
    classifiedTask: { requiredCapabilityIds: ["extract:trusted"], explicitReadRequest: true },
    trustedCapabilities: [],
    taskResolution: { status: "unresolved", reasonCode: "read_capability_unavailable" }
  });

  assert.equal(selected.executionRoute.kind, "unresolved");
  assert.equal(selected.effectiveWorkflowIntent, undefined);
  assert.deepEqual(await selected.planner.plan("read records", {}, {}), {
    status: "ambiguous",
    candidates: [],
    reason: "No trusted execution route can establish the requested outcome (requested_workflow_capability_unavailable); no browser action was selected."
  });
});

test("resolved task routes bind the same intent into the workflow planner", () => {
  const intent = Object.freeze({ purposeCode: "extract_records", outcomeCode: "observed_records_returned" });
  const selected = createWorkflowRoutePlanner({
    requestedPlannerMode: "workflow",
    classifiedTask: { explicitReadRequest: true },
    trustedCapabilities: [],
    taskResolution: { status: "resolved", intent },
    workflowIntent: null,
    synthesizer: {},
    knowledge: [],
    inputs: {},
    scope: { applicationId: "fixture-app", environmentClass: "local", principalId: "fixture-user" }
  });

  assert.equal(selected.executionRoute.kind, "workflow");
  assert.equal(selected.effectiveWorkflowIntent, intent);
  assert.ok(selected.planner instanceof WorkflowGraphPlanner);
});

test("unresolved search reads discard any caller workflow intent", () => {
  const callerIntent = Object.freeze({ purposeCode: "extract_records", outcomeCode: "observed_records_returned" });
  const selected = createWorkflowRoutePlanner({
    requestedPlannerMode: "auto",
    classifiedTask: { explicitReadRequest: true },
    trustedCapabilities: [],
    taskResolution: { status: "unresolved", reasonCode: "search_read_capability_unavailable" },
    workflowIntent: callerIntent,
    searchReadRequest: { query: "reports" }
  });

  assert.equal(selected.effectiveWorkflowIntent, null);
  assert.equal(selected.executionRoute.kind, "unresolved");
});
