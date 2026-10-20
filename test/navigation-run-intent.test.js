import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationRunIntent } from "../src/navigation/runIntent.js";
import { SEARCH_SUBMIT_OPERATION_ID } from "../src/navigation/search.js";

test("automatic mode routes an exact search-and-read request through workflow planning", () => {
  const intent = createNavigationRunIntent({ goal: "Search for green tea and return product names" });

  assert.deepEqual(intent.searchReadRequest, { query: "green tea", resultRequest: "product names" });
  assert.equal(intent.searchPhrase, "green tea");
  assert.equal(intent.taskRequest.explicitReadRequest, true);
  assert.equal(intent.explicitReadWorkflowRequest, true);
  assert.equal(intent.workflowModeActive, true);
  assert.ok(intent.searchSubmitAuthorizer);
});

test("automatic mode keeps ordinary navigation on the direct-navigation route", () => {
  const intent = createNavigationRunIntent({ goal: "Open the account page" });

  assert.equal(intent.searchReadRequest, null);
  assert.equal(intent.searchPhrase, undefined);
  assert.equal(intent.workflowModeActive, false);
  assert.equal(intent.searchSubmitAuthorizer, null);
});

test("standalone search binds its single-use submit authorization to the exact caller phrase", () => {
  const intent = createNavigationRunIntent({ goal: "Search for green tea" });
  const candidate = { tag: "input", type: "search", visible: true };

  assert.equal(intent.workflowModeActive, false);
  assert.equal(intent.searchSubmitAuthorizer.authorize({
    operationId: SEARCH_SUBMIT_OPERATION_ID,
    action: "type",
    candidate,
    value: "green tea"
  }).allowed, true);
  assert.equal(intent.searchSubmitAuthorizer.authorize({
    operationId: SEARCH_SUBMIT_OPERATION_ID,
    action: "type",
    candidate,
    value: "green tea or another query"
  }).allowed, false);
});

test("explicit workflow mode remains active for ordinary navigation but preserves search routing", () => {
  assert.equal(createNavigationRunIntent({ goal: "Open the account page", plannerMode: "workflow" }).workflowModeActive, true);
  assert.equal(createNavigationRunIntent({ goal: "Search for green tea", plannerMode: "workflow" }).workflowModeActive, false);
  assert.equal(createNavigationRunIntent({ goal: "Search for green tea and return product names", plannerMode: "workflow" }).workflowModeActive, true);
});

test("resume suppresses workflow re-synthesis unless a checkpoint is available", () => {
  const options = { goal: "Read product names", plannerMode: "auto", resumeState: { status: "running" } };

  assert.equal(createNavigationRunIntent(options).workflowModeActive, false);
  assert.equal(createNavigationRunIntent({ ...options, canResumeWorkflowCheckpoint: true }).workflowModeActive, true);
});
