import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCloudAgentTaskPlan, CLOUD_AGENT_TASK_ROLES, verifyCloudAgentRunOutcome } from "../src/integrations/freeinference/cloudAgentWorkflow.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";
import { TestRunner } from "../src/testing/runner.js";
import { createRunStateFixture } from "./runStateFixture.js";
import { isBoundVisualEvidence } from "../src/navigation/visualEvidence.js";

const profile = {
  profile_id: "cloud-agent-staging",
  environment: {
    environment_id: "freeinference-staging",
    platform: "freeinference",
    application_entry_url: "https://staging.freeinference.org",
    authorized_origins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"],
    applications: [{
      application_id: "fi-agents",
      authentication_realm: "agents-session",
      candidate_entry: "https://agents-staging.freeinference.org/",
      status: "candidate"
    }]
  },
  test_workspace_grants: [{ provider: "github", repository_ids: ["activetab/fixture"], base_refs: ["main"] }]
  }
};
const visualFixtureBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

// Synthetic observation fixture. This models the staging form shape; it is not
// loaded from or evidence about the live FreeInference product.
function observedPage({ origin = "https://agents-staging.freeinference.org", submit = true } = {}) {
  const candidates = [
    { identity: "target:root:frame:repository:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 1, tag: "select", role: "combobox", name: "Repository", visible: true, disabled: false },
    { identity: "target:root:frame:ref:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 2, tag: "select", role: "combobox", name: "Base branch", visible: true, disabled: false },
    { identity: "target:root:frame:runtime:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 3, tag: "select", role: "combobox", name: "Runtime", visible: true, disabled: false },
    { identity: "target:root:frame:model:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 4, tag: "select", role: "combobox", name: "Model", visible: true, disabled: false },
    { identity: "target:root:frame:prompt:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 5, tag: "textarea", role: "textbox", name: "Task", visible: true, disabled: false, formIdentity: "form-task" },
    { identity: "target:root:frame:submit:1", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 6, tag: "button", role: "button", name: "Run task", visible: true, disabled: false, submitsForm: submit, formIdentity: "form-task" }
  ];
  return {
    evidenceId: "observation-1",
    targetId: "target-1",
    page: { url: `${origin}/tasks/new`, title: "Cloud Agent" },
    candidates,
    mapping: {
      observationId: "observation-1",
      roles: {
        [CLOUD_AGENT_TASK_ROLES.REPOSITORY_SELECTOR]: candidates[0].identity,
        [CLOUD_AGENT_TASK_ROLES.REF_SELECTOR]: candidates[1].identity,
        [CLOUD_AGENT_TASK_ROLES.RUNTIME_SELECTOR]: candidates[2].identity,
        [CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR]: candidates[3].identity,
        [CLOUD_AGENT_TASK_ROLES.TASK_PROMPT]: candidates[4].identity,
        [CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK]: candidates[5].identity
      }
    }
  };
}

function taskRequest(overrides = {}) {
  return {
    version: 2,
    requestId: "pr-42-regression-check",
    environmentId: "freeinference-staging",
    repository: { provider: "github", repositoryId: "activetab/fixture", baseRef: "main", expectedCommit: null },
    runtimeId: "node-22",
    modelId: "glm-5.3-flash",
    prompt: "Run the caller-supplied test against the isolated fixture.",
    options: { reasoning: null, skills: [], plugins: [], mcpServers: [], attachments: [] },
    effectGrantId: "grant-fixture-task",
    expectedOutcome: { kind: "run_status", value: "succeeded" },
    diagnosticSources: ["cloud-agent-runs", "cloud-agent-steps", "cloud-agent-usage"],
    cleanupPolicyId: "fixture-cleanup-v1",
    ...overrides
  };
}

test("Cloud Agent adapter compiles exact caller inputs against a synthetic observed-target fixture", () => {
  const page = observedPage();
  const plan = createCloudAgentTaskPlan({ profile, request: taskRequest(), observation: page, mapping: page.mapping });

  assert.equal(plan.workflow.steps.length, 6);
  assert.equal(plan.workflow.steps[0].action.value, "activetab/fixture");
  assert.equal(plan.workflow.steps[1].action.value, "main");
  assert.equal(plan.workflow.steps[2].action.value, "node-22");
  assert.equal(plan.workflow.steps[3].action.value, "glm-5.3-flash");
  assert.equal(plan.workflow.steps[4].action.value, taskRequest().prompt);
  assert.equal(plan.workflow.steps[5].action.type, "click");
  assert.deepEqual(plan.expectedOutcome, { kind: "run_status", value: "succeeded" });
  assert.deepEqual(plan.diagnosticSources, ["cloud-agent-runs", "cloud-agent-steps", "cloud-agent-usage"]);
  assert.equal(plan.verificationRequired, true);
});

test("Cloud Agent adapter rejects changed environment, stale mappings, and unverified submit controls", () => {
  const page = observedPage();
  assert.throws(() => createCloudAgentTaskPlan({
    profile,
    request: taskRequest({ environmentId: "freeinference-production" }),
    observation: page,
    mapping: page.mapping
  }), /environment/);
  assert.throws(() => createCloudAgentTaskPlan({
    profile,
    request: taskRequest(),
    observation: page,
    mapping: { ...page.mapping, observationId: "older-observation" }
  }), /exact current observation/);
  const noSubmit = observedPage({ submit: false });
  assert.throws(() => createCloudAgentTaskPlan({ profile, request: taskRequest(), observation: noSubmit, mapping: noSubmit.mapping }), /non-form task button requires/);
  const dashboard = observedPage({ origin: "https://staging.freeinference.org" });
  assert.throws(() => createCloudAgentTaskPlan({ profile, request: taskRequest(), observation: dashboard, mapping: dashboard.mapping }), /Cloud Agent application origin/);
  assert.throws(() => createCloudAgentTaskPlan({
    profile,
    request: taskRequest({ diagnosticSources: ["cloud-agent-conversations"] }),
    observation: page,
    mapping: page.mapping
  }), /Diagnostic source/);
  assert.throws(() => createCloudAgentTaskPlan({
    profile,
    request: taskRequest({ expectedOutcome: { kind: "unbounded", value: "whatever" } }),
    observation: page,
    mapping: page.mapping
  }), /exact terminal run_status/);
});

test("Cloud Agent outcome requires an exact terminal run-status match", () => {
  assert.deepEqual(verifyCloudAgentRunOutcome({ kind: "run_status", value: "succeeded" }, { id: "job-1", status: "succeeded" }), {
    status: "VERIFIED", reasonCode: "exact_run_status_match", reason: "Exact backend run status 'succeeded' matches the caller's expected status."
  });
  assert.equal(verifyCloudAgentRunOutcome({ kind: "run_status", value: "succeeded" }, { id: "job-1", status: "running" }).status, "UNCERTAIN");
  assert.equal(verifyCloudAgentRunOutcome({ kind: "run_status", value: "succeeded" }, { id: "job-1", status: "failed" }).status, "FAILED");
  assert.equal(verifyCloudAgentRunOutcome({ kind: "run_status", value: "running" }, { id: "job-1", status: "running" }).status, "UNCERTAIN");
});

test("the compiled operation capability is exact, ordered, staging-bound, and input-bound", async () => {
  const page = observedPage();
  const plan = createCloudAgentTaskPlan({ profile, request: taskRequest(), observation: page, mapping: page.mapping });
  const [repository, ref, runtime, select, fill, submit] = plan.workflow.steps.map(step => step.action);
  const binding = buildEnvironmentBinding(profile);
  const fresh = { ...page, evidenceId: "fresh-observation" };
  const selectedCandidate = page.candidates[3];

  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: fill.operationId, action: "fill", candidate: page.candidates[4], value: fill.value,
    observation: fresh, environment: binding
  })).allowed, false);
  for (const [action, candidate] of [[repository, page.candidates[0]], [ref, page.candidates[1]], [runtime, page.candidates[2]]]) {
    assert.equal((await plan.operationAuthorizer.authorize({
      operationId: action.operationId, action: "select", candidate, value: action.value,
      observation: fresh, environment: binding
    })).allowed, false, "later job inputs cannot bypass their declared operation order");
  }
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: select.operationId, action: "select", candidate: selectedCandidate, value: "other-model",
    observation: fresh, environment: binding
  })).allowed, false);
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: select.operationId, action: "select", candidate: selectedCandidate, value: select.value,
    observation: fresh, environment: binding
  })).allowed, true);
  assert.equal(plan.operationAuthorizer.decisionContext(select.operationId).reviewRequired, false);
  assert.equal(plan.operationAuthorizer.decisionContext(fill.operationId).reviewRequired, false);
  assert.equal(plan.operationAuthorizer.decisionContext(submit.operationId).reviewRequired, true);
  for (const action of [repository, ref, runtime]) plan.operationAuthorizer.recordDispatch({ operationId: action.operationId, dispatchStatus: "dispatched" });
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: select.operationId, action: "select", candidate: selectedCandidate, value: select.value,
    observation: fresh, environment: binding
  })).allowed, true);
  plan.operationAuthorizer.recordDispatch({ operationId: select.operationId, dispatchStatus: "dispatched" });
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: fill.operationId, action: "fill", candidate: page.candidates[4], value: fill.value,
    observation: fresh, environment: binding
  })).allowed, true);
  plan.operationAuthorizer.recordDispatch({ operationId: fill.operationId, dispatchStatus: "dispatched" });
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: submit.operationId, action: "click", candidate: page.candidates[5], value: null,
    observation: fresh, environment: binding
  })).allowed, true);
  assert.equal((await plan.operationAuthorizer.authorize({
    operationId: submit.operationId, action: "click", candidate: page.candidates[5], value: null,
    observation: { ...fresh, page: { ...fresh.page, url: "https://staging.freeinference.org/dashboard/admin/settings" } }, environment: binding
  })).allowed, false);
});

test("Jev service refusal falls back to policy and the workflow uses exact model and prompt without false PASS", async t => {
  const runState = await createRunStateFixture("activetab-cloud-agent-workflow-");
  t.after(() => runState.cleanup());
  const page = observedPage();
  const plan = createCloudAgentTaskPlan({ profile, request: taskRequest(), observation: page, mapping: page.mapping });
  const dispatched = [];
  const reviews = [];
  const skippedReviews = [];
  const routes = [];
  let current = {
    ...page,
    documentGeneration: 1,
    viewport: { width: 780, height: 437 },
    visualEvidence: {
      evidenceId: page.evidenceId,
      targetId: page.targetId,
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      screenshotBase64: visualFixtureBase64
    },
    pageChangeFingerprint: "composer"
  };
  const session = {
    target: { id: page.targetId, url: page.page.url },
    attached: true,
    async observe() {
      const evidenceId = `runtime-${dispatched.length}-${Date.now()}`;
      return { ...structuredClone(current), evidenceId, visualEvidence: { ...current.visualEvidence, evidenceId } };
    },
    async selectOption(candidate, value) { dispatched.push(["select", candidate.identity, value]); return { dispatched: true }; },
    async fillField(candidate, value) { dispatched.push(["fill", candidate.identity, value]); return { dispatched: true }; },
    async click(candidate) {
      dispatched.push(["click", candidate.identity]);
      current = { ...current, pageChangeFingerprint: "task-page", page: { ...current.page, url: `${current.page.url}/run` } };
      return { dispatched: true };
    },
    async verifyControlValue(_candidate, value) { return { verified: true, matches: ["activetab/fixture", "main", "node-22", "glm-5.3-flash", taskRequest().prompt].includes(value) }; },
    async waitForChange() {}
  };

  const decisionRuntime = {
    jevClient: { allowImages: true },
    startEpisode({ runId }) { return { episodeId: `episode-${runId}` }; },
    completeEpisode() {},
    async reviewBeforeAction(input) {
      reviews.push(input);
      return { decisionId: input.decisionId, jevFailureCode: "refusal", authorizesOperation: false };
    },
    recordInferenceRoute(input) { routes.push(input); },
    recordReviewSkipped(input) { skippedReviews.push(input); },
    recordPolicy() {},
    reserveExecution() {},
    recordDispatch() {},
    recordObserved() {}
  };
  const preflightObservation = await session.observe();
  assert.equal(decisionRuntime.jevClient.allowImages, true);
  assert.equal(isBoundVisualEvidence(preflightObservation, preflightObservation.visualEvidence), true);
  const receipt = await new TestRunner({
    session,
    environment: buildEnvironmentBinding(profile),
    operationAuthorizer: plan.operationAuthorizer,
    decisionRuntime,
    runStateStore: runState.store
  }).run(plan.workflow, { runId: "cloud-agent-adapter-test" });

  assert.deepEqual(dispatched.map(item => item[0]), ["select", "select", "select", "select", "fill", "click"], JSON.stringify(receipt.toObject(), null, 2));
  assert.deepEqual(reviews.map(item => item.targetRole), [CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK]);
  assert.equal(skippedReviews.length, 2);
  assert.deepEqual(skippedReviews.map(item => item.operation), ["select", "fill"]);
  assert.deepEqual(routes.map(item => item.route), ["deterministic", "deterministic", "jev_only"]);
  assert.deepEqual(receipt.steps.slice(0, 5).map(step => step.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(receipt.steps[5].status, "UNCERTAIN");
  assert.equal(receipt.status, "UNCERTAIN");
  assert.equal(receipt.steps[2].details.dispatchStatus, "dispatched");
  assert.ok(receipt.steps[2].details.beforeEvidenceId);
  assert.ok(receipt.steps[2].details.afterEvidenceId);
  assert.equal(JSON.stringify(receipt.toObject()).includes(taskRequest().prompt), false);
  assert.equal(receipt.reconcileStep("submit-authorized-test-task", {
    status: "PASS", reason: "Exact browser/backend run outcome correlated.", evidenceIds: ["browser_ev", "backend_ev"]
  }), true);
  assert.equal(receipt.status, "PASSED");
});
