import test from "node:test";
import assert from "node:assert/strict";
import { prepareCloudAgentTask } from "../src/integrations/freeinference/prepareCloudAgentTask.js";
import { CLOUD_AGENT_TASK_ROLES } from "../src/integrations/freeinference/cloudAgentWorkflow.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";

const profile = {
  profile_id: "cloud-agent-staging",
  environment: {
    environment_id: "freeinference-staging",
    application_entry_url: "https://staging.freeinference.org",
    authorized_origins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"],
    applications: [{
      application_id: "fi-agents",
      authentication_realm: "agents-session",
      candidate_entry: "https://agents-staging.freeinference.org/"
    }]
  }
};

const roles = Object.values(CLOUD_AGENT_TASK_ROLES);

// All observations in this unit suite are synthetic fixtures. Their labels and
// control shapes are not evidence about the current staging UI.
function input() {
  const candidates = [
    { identity: "model", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 1, tag: "select", role: "combobox", name: "Model", visible: true, disabled: false },
    { identity: "prompt", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 2, tag: "textarea", role: "textbox", name: "Task", visible: true, disabled: false, formIdentity: "form-task" },
    { identity: "submit", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 3, tag: "button", role: "button", name: "Run task", visible: true, disabled: false, submitsForm: true, formIdentity: "form-task" }
  ];
  return {
    session: {
      attached: true,
      target: { id: "target-1", url: "https://agents-staging.freeinference.org/tasks/new" },
      async observe() { return { evidenceId: "observation-1", targetId: "target-1", page: { url: "https://agents-staging.freeinference.org/tasks/new" }, candidates }; }
    },
    request: {
      requestId: "pr-42-regression-check",
      environmentId: "freeinference-staging",
      modelId: "glm-5.3-flash",
      prompt: "Run the caller-supplied test against the isolated fixture.",
      expectedOutcome: { kind: "run_status", value: "succeeded" }
    }
  };
}

function decisionRuntime({ confidence = 0.98, semanticFailure = null, semanticUnavailable = null } = {}) {
  const annotations = new Map([
    [CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR, "model"],
    [CLOUD_AGENT_TASK_ROLES.TASK_PROMPT, "prompt"],
    [CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK, "submit"]
  ]);
  const reviews = [];
  const targetResolutions = [];
  let semanticCalls = 0;
  return {
    reviews,
    targetResolutions,
    get semanticCalls() { return semanticCalls; },
    startEpisode({ runId }) { return { episodeId: `episode-${runId}` }; },
    semanticAnalyzer: {
      async analyzePage(args) {
        semanticCalls++;
        if (semanticFailure) throw Object.assign(new Error("Semantic provider refused the request."), { kind: semanticFailure });
        assert.equal(Object.hasOwn(args, "includePageLabels"), false);
        assert.equal(args.observation.evidenceId, "observation-1");
        assert.deepEqual(args.requestedRoles, roles);
        return {
          eventIds: ["semantic-event-1"],
          annotations: roles.map(semanticRole => ({ semanticRole, candidateRef: annotations.get(semanticRole), resultCode: "mapped", confidence }))
        };
      }
    },
    coordinator: {
      async reviewBeforeAction(args) {
        reviews.push(args);
        return { disposition: "supported", answers: {}, authorizesOperation: false };
      }
    },
    async annotateRoles(args) {
      if (!this.semanticAnalyzer) {
        semanticUnavailable?.push(args);
        return { decisionId: args.decisionId, semantic: null, semanticFailureCode: "configuration", eventIds: [] };
      }
      try {
        const semantic = await this.semanticAnalyzer.analyzePage(args);
        return { decisionId: args.decisionId, semantic, eventIds: semantic.eventIds };
      } catch (error) {
        if (!error?.kind) throw error;
        return { decisionId: args.decisionId, semantic: null, semanticFailureCode: error.kind, eventIds: [] };
      }
    },
    recordTargetResolution(args) {
      targetResolutions.push(args);
      return { eventId: "target-resolution-event-1" };
    }
  };
}

test("Cloud Agent composition uses unique structural mapping without calling either model", async () => {
  const { session, request } = input();
  const decisions = decisionRuntime();
  let effectCalls = 0;
  session.click = session.fillField = session.selectOption = () => { effectCalls++; };

  const prepared = await prepareCloudAgentTask({ session, profile, request, decisionRuntime: decisions, runId: "run-42" });

  assert.equal(prepared.workflow.steps.length, 3);
  assert.equal(prepared.workflow.steps[0].action.value, request.modelId);
  assert.equal(prepared.workflow.steps[1].action.value, request.prompt);
  assert.equal(prepared.workflow.steps[2].action.operationId, "freeinference.cloud_agent.submit_task");
  assert.equal(prepared.operationAuthorizer.authorize instanceof Function, true);
  assert.equal(decisions.reviews.length, 0);
  assert.equal(prepared.semanticMapping, null);
  assert.equal(prepared.semanticMappingSource, "deterministic_structural");
  assert.equal(decisions.semanticCalls, 0);
  assert.equal(decisions.targetResolutions[0].resolver, "deterministic_structural");
  assert.equal(prepared.targetResolutionEventId, "target-resolution-event-1");
  assert.equal(prepared.operationAuthorizer.decisionContext("freeinference.cloud_agent.submit_task").targetRole, CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK);
  assert.equal(effectCalls, 0);
});

function ambiguousInput() {
  const base = input();
  base.session.observe = async () => {
    const observation = await input().session.observe();
    observation.candidates.push({ identity: "extra-text", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 4, tag: "textarea", role: "textbox", name: "Another text field", visible: true, disabled: false, formIdentity: "form-task" });
    return observation;
  };
  return base;
}

test("Cloud Agent calls semantic mapping only when structural form mapping is ambiguous", async () => {
  const base = input();
  const configuredButUnneeded = await prepareCloudAgentTask({ ...base, profile, decisionRuntime: decisionRuntime({ semanticFailure: "refusal" }), runId: "run-unique-no-semantic" });
  assert.equal(configuredButUnneeded.workflow.steps.length, 3);
  assert.equal(configuredButUnneeded.semanticMappingSource, "deterministic_structural");

  const mapped = await prepareCloudAgentTask({ ...ambiguousInput(), profile, decisionRuntime: decisionRuntime(), runId: "run-semantic-map" });
  assert.equal(mapped.semanticMappingSource, "semantic_annotation");
  assert.equal(mapped.semanticMapping.annotations.length, 3);
  const submitContext = mapped.operationAuthorizer.decisionContext("freeinference.cloud_agent.submit_task");
  assert.equal(submitContext.semanticAnnotation.semanticRole, CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK);
  assert.deepEqual(submitContext.semanticEventIds, ["semantic-event-1"]);
  assert.equal(mapped.workflow.steps.length, 3);

  const weak = await prepareCloudAgentTask({ ...ambiguousInput(), profile, decisionRuntime: decisionRuntime({ confidence: 0.79 }), runId: "run-low-confidence" }).catch(error => error);
  assert.equal(weak.code, "semantic_mapping_unresolved");

  const refused = await prepareCloudAgentTask({ ...ambiguousInput(), profile, decisionRuntime: decisionRuntime({ semanticFailure: "refusal" }), runId: "run-semantic-refused" }).catch(error => error);
  assert.equal(refused.code, "semantic_mapping_unresolved");
});

test("Cloud Agent adapter resolves observed ARIA controls without assuming the native test-fixture form", async () => {
  const base = input();
  const candidates = [
    { identity: "model-combobox", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 11, tag: "button", role: "combobox", name: "Choose model", visible: true, disabled: false },
    { identity: "task-editor", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 12, tag: "div", role: "textbox", name: "Task instructions", contentEditable: true, visible: true, disabled: false },
    { identity: "start-task", targetId: "target-1", frameTargetId: null, documentGeneration: 1, backendNodeId: 13, tag: "button", role: "button", name: "Start task", visible: true, disabled: false }
  ];
  base.session.observe = async () => ({
    evidenceId: "observation-aria-fixture",
    targetId: "target-1",
    page: { url: "https://agents-staging.freeinference.org/tasks/new", title: "Cloud Agent" },
    candidates
  });
  const decisions = decisionRuntime();
  decisions.semanticAnalyzer.analyzePage = async args => ({
    observationId: args.observation.evidenceId,
    eventIds: ["semantic-aria-event"],
    annotations: [
      { semanticRole: CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR, candidateRef: "model-combobox", resultCode: "mapped", confidence: 0.96 },
      { semanticRole: CLOUD_AGENT_TASK_ROLES.TASK_PROMPT, candidateRef: "task-editor", resultCode: "mapped", confidence: 0.97 },
      { semanticRole: CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK, candidateRef: "start-task", resultCode: "mapped", confidence: 0.95 }
    ]
  });

  const prepared = await prepareCloudAgentTask({
    session: base.session,
    profile,
    request: base.request,
    decisionRuntime: decisions,
    runId: "run-aria-controls"
  });
  const binding = buildEnvironmentBinding(profile);
  const [modelStep, promptStep, submitStep] = prepared.workflow.steps;

  assert.equal(prepared.semanticMappingSource, "semantic_annotation");
  assert.deepEqual(prepared.workflow.steps.map(step => step.action.target.identity), candidates.map(candidate => candidate.identity));
  assert.equal((await prepared.operationAuthorizer.authorize({
    operationId: modelStep.action.operationId,
    action: "select",
    candidate: candidates[0],
    value: base.request.modelId,
    observation: prepared.observation,
    environment: binding
  })).allowed, true);
  prepared.operationAuthorizer.recordDispatch({ operationId: modelStep.action.operationId, dispatchStatus: "dispatched" });
  assert.equal((await prepared.operationAuthorizer.authorize({
    operationId: promptStep.action.operationId,
    action: "fill",
    candidate: candidates[1],
    value: base.request.prompt,
    observation: prepared.observation,
    environment: binding
  })).allowed, true);
  prepared.operationAuthorizer.recordDispatch({ operationId: promptStep.action.operationId, dispatchStatus: "dispatched" });
  assert.equal((await prepared.operationAuthorizer.authorize({
    operationId: submitStep.action.operationId,
    action: "click",
    candidate: candidates[2],
    observation: prepared.observation,
    environment: binding
  })).allowed, true);
});

test("missing semantic service is recorded only when structural control mapping is ambiguous", async () => {
  const base = input();
  const unavailable = [];
  const decisions = decisionRuntime({ semanticUnavailable: unavailable });
  decisions.semanticAnalyzer = null;
  const prepared = await prepareCloudAgentTask({ ...base, profile, decisionRuntime: decisions, runId: "run-semantic-unavailable" });
  assert.equal(prepared.workflow.steps.length, 3);
  assert.equal(unavailable.length, 0);

  const ambiguous = input();
  ambiguous.session.observe = async () => {
    const observation = await base.session.observe();
    observation.candidates.push({ ...observation.candidates[0], identity: "second-model", backendNodeId: 4 });
    return observation;
  };
  const unavailableWhenAmbiguous = [];
  const noSemantic = decisionRuntime({ semanticUnavailable: unavailableWhenAmbiguous });
  noSemantic.semanticAnalyzer = null;
  await assert.rejects(
    prepareCloudAgentTask({ ...ambiguous, profile, decisionRuntime: noSemantic, runId: "run-ambiguous" }),
    error => error.code === "semantic_mapping_unresolved"
  );
  assert.equal(noSemantic.targetResolutions.length, 0);
  assert.equal(unavailableWhenAmbiguous.length, 1);
});
