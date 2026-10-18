import test from "node:test";
import assert from "node:assert/strict";
import { DecisionCoordinator } from "../src/decisions/decisionCoordinator.js";
import { JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { rebindWorkflowTarget, WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";

function createObservation(overrides = {}) {
  return {
    evidenceId: "observation_initial",
    page: { url: "https://fixture.example/list", title: "Records" },
    headings: [{ level: 1, text: "Records" }],
    candidates: [{
      identity: "candidate_details",
      tag: "a",
      role: "link",
      name: "View details",
      contextName: "Record A",
      href: "https://fixture.example/records/a",
      type: "",
      visible: true,
      disabled: false
    }],
    scrollTargets: [],
    ...overrides
  };
}

const capabilities = [{
  id: "open_record_details",
  action: "click",
  effectClass: "navigation",
  targetRole: "record_details_link",
  observedRoles: ["link"],
  verificationCodes: ["details_route_observed"]
}];

const plan = {
  version: 1,
  steps: [{
    id: "open_details",
    capabilityId: "open_record_details",
    targetRole: "record_details_link",
    targetRef: "candidate_1",
    dependsOn: [],
    verifyCode: "details_route_observed",
    onMissing: "stop"
  }]
};

test("workflow synthesis binds a plan to trusted capabilities and current observed candidates once", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_workflow_plan", workflowId: "bounded_plan", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    let calls = 0;
    let request;
    const synthesizer = new WorkflowSynthesizer({
      provider: { async requestStructured(input) { calls++; request = input; return { result: plan, usage: { inputTokens: 120, outputTokens: 40 } }; } },
      eventStore: store,
      includePageLabels: false
    });
    const result = await synthesizer.synthesize({
      taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
      observation: createObservation(),
      capabilities,
      scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" },
      episodeId: episode.episodeId,
      runId: episode.runId
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "synthesized");
    assert.equal(result.plan.steps[0].capabilityId, "open_record_details");
    assert.equal(request.input.observation.candidates[0].label, undefined);
    assert.equal(request.input.trustedCapabilities[0].effectClass, "navigation");
    assert.deepEqual(request.input.task, { purposeCode: "open_record", outcomeCode: "details_page", targetRoles: [], constraints: [], inputRefs: [] });
    assert.equal(JSON.stringify(request.input).includes("Open record A details"), false);
    const event = store.getEvents(episode.episodeId).find(item => item.eventType === "workflow.plan_synthesized");
    assert.equal(event.decisionId, result.decisionId);
    assert.equal(event.payload.planHash, result.planHash);
    assert.equal(event.payload.planProjection[0].targetRole, "record_details_link");
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("workflow synthesis rejects invented capabilities, targets, and cycles before execution", async () => {
  const badPlans = [
    { ...plan, steps: [{ ...plan.steps[0], capabilityId: "admin_everything" }] },
    { ...plan, steps: [{ ...plan.steps[0], targetRef: "candidate_not_observed" }] },
    { version: 1, steps: [
      { ...plan.steps[0], id: "first", dependsOn: ["second"] },
      { ...plan.steps[0], id: "second", dependsOn: ["first"] }
    ] }
  ];
  for (const badPlan of badPlans) {
    const store = new DecisionEventStore({ databasePath: ":memory:" });
    try {
      const episode = store.startEpisode({ runId: "run_invalid_plan", workflowId: "invalid_plan", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
      const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: badPlan }; } }, eventStore: store });
      const result = await synthesizer.synthesize({ taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" }, observation: createObservation(), capabilities, episodeId: episode.episodeId, runId: episode.runId });
      assert.equal(result.status, "unavailable");
      assert.equal(result.failureCode, "schema");
      assert.equal(store.getEvents(episode.episodeId).some(item => item.eventType === "workflow.plan_failed" && item.payload.failureCode === "schema"), true);
    } finally { store.close(); }
  }
});

test("workflow targets rebind only when exactly one current candidate matches the recorded signature", () => {
  const original = createObservation().candidates[0];
  const signature = {
    tag: original.tag,
    role: original.role,
    name: original.name,
    contextName: original.contextName,
    href: original.href,
    type: original.type,
    pointerInteraction: false
  };
  const binding = { kind: "candidate", signature };
  const current = { ...original, identity: "candidate_fresh", backendNodeId: 81 };
  assert.equal(rebindWorkflowTarget(binding, createObservation({ evidenceId: "observation_fresh", candidates: [current] })).identity, "candidate_fresh");
  assert.equal(rebindWorkflowTarget(binding, createObservation({ candidates: [current, { ...current, identity: "candidate_duplicate" }] })), null);
});

test("workflow synthesis refuses missing typed intent without sending the natural-language goal", async () => {
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { calls++; return { result: plan }; } } });
  const result = await synthesizer.synthesize({ goal: "This free-form goal must stay local", observation: createObservation(), capabilities });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "missing_intent");
  assert.equal(calls, 0);
});

test("Jev reviews one compact workflow projection in a batched 1.14 request and never authorizes it", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_plan_review", workflowId: "plan_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    let calls = 0;
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: { async decide({ state, questions }) {
        calls++;
        assert.equal(state.step_count, 1);
        assert.deepEqual(Object.keys(questions), ["plan_coherence", "plan_verifiability", "plan_boundary_alignment"]);
        return {
          model: JEV_MODEL_ID,
          answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.96 }])),
          usage: { inputTokens: 80, outputTokens: 12 }
        };
      } }
    });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      decisionId: "decision_plan_review",
      observationId: "observation_initial",
      planProjection: [{ stepId: "open_details", capabilityId: "open_record_details", effectClass: "navigation", targetRole: "record_details_link", verificationCode: "details_route_observed", requiresApproval: false }]
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "reviewed");
    assert.equal(result.disposition, "supported");
    assert.equal(result.authorizesOperation, false);
    const events = store.getEvents(episode.episodeId);
    assert.equal(events.filter(item => item.eventType === "decision.predicted").length, 3);
    assert.equal(events.find(item => item.eventType === "decision.input_captured").payload.inputKind, "workflow_plan_review");
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("Jev unavailability is captured as advisory workflow-review state", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_plan_review_unavailable", workflowId: "plan_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    const coordinator = new DecisionCoordinator({ eventStore: store, client: { async decide() { throw Object.assign(new Error("offline"), { kind: "transport" }); } } });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      observationId: "observation_initial",
      planProjection: [{ stepId: "open_details", capabilityId: "open_record_details", effectClass: "navigation", targetRole: "record_details_link", verificationCode: "details_route_observed", requiresApproval: false }]
    });
    assert.deepEqual({ status: result.status, failureCode: result.failureCode, authorizesOperation: result.authorizesOperation }, { status: "unavailable", failureCode: "transport", authorizesOperation: false });
    assert.equal(store.getEvents(episode.episodeId).filter(item => item.eventType === "decision.failed").length, 3);
  } finally { store.close(); }
});

test("NavigationEngine executes a synthesized plan through its authorized browser executor", async () => {
  const session = {
    attached: true,
    target: { id: "workflow-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [{ level: 1, text: "Records" }],
      candidates: [{
        identity: "details_link",
        targetId: "workflow-target",
        documentGeneration: 1,
        backendNodeId: 15,
        tag: "a",
        role: "link",
        name: "View details",
        contextName: "Record A",
        href: "https://fixture.example/records/a",
        visible: true,
        disabled: false
      }],
      scrollTargets: []
    },
    observationCount: 0,
    dispatched: 0,
    async observe() {
      this.observationCount++;
      return { evidenceId: `workflow_observation_${this.observationCount}`, targetId: this.target.id, ...structuredClone(this.state) };
    },
    async waitForChange() {},
    async click(candidate) {
      assert.equal(candidate.backendNodeId, 15);
      this.dispatched++;
      this.state = { page: { url: "https://fixture.example/records/a", title: "Record details" }, headings: [{ level: 1, text: "Record details" }], candidates: [], scrollTargets: [] };
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  let jevCalls = 0;
  const decisionRuntime = createDecisionRuntime({
    eventStore,
    semanticAnalyzer: null,
    jevClient: { async decide({ questions }) {
      jevCalls++;
      return { model: JEV_MODEL_ID, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.94 }])) };
    } }
  });
  let modelCalls = 0;
  try {
    const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { modelCalls++; return { result: plan }; } }, eventStore });
    const engine = new NavigationEngine(session, {
      plannerMode: "workflow",
      workflowSynthesizer: synthesizer,
      workflowCapabilities: [{
        ...capabilities[0],
        verify({ verificationCode, beforeObservation, afterObservation }) {
          return verificationCode === "details_route_observed" && afterObservation.page.url.endsWith("/records/a")
            && beforeObservation.page.url !== afterObservation.page.url;
        }
      }],
      decisionRuntime,
      environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
      assertExecutionLease: async () => {},
      maxActions: 4
    });
    const result = await engine.run("Open record A details", { workflowIntent: { purposeCode: "open_record", outcomeCode: "details_page" } });
    assert.equal(result.status, "succeeded");
    assert.equal(result.attempts, 1);
    assert.equal(result.workflowPlan.status, "completed");
    assert.equal(result.workflowPlan.synthesisCalls, 1);
    assert.equal(modelCalls, 1);
    assert.equal(jevCalls, 1, "Jev reviews the complete plan in one batch instead of one request per click");
    assert.equal(session.dispatched, 1);
    const episode = eventStore.listEpisodes().at(-1);
    const events = eventStore.getEvents(episode.episode_id);
    assert.equal(events.filter(event => event.eventType === "workflow.plan_synthesized").length, 1);
    assert.equal(events.filter(event => event.eventType === "decision.predicted").length, 3);
    assert.equal(events.filter(event => event.eventType === "verification.completed").length, 1);
    assert.equal(eventStore.verifyEpisodeChain(episode.episode_id).ok, true);
  } finally { decisionRuntime.close(); }
});

test("NavigationEngine executes a verified conditional DAG without another planning call per action", async () => {
  const first = createObservation().candidates[0];
  const second = { ...first, identity: "candidate_next", name: "Continue", contextName: "Section one", href: "https://fixture.example/step-two" };
  const dag = {
    version: 1,
    steps: [
      { id: "open_first", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "open_second", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_2", dependsOn: ["open_first"], when: { stepId: "open_first", status: "passed" }, verifyCode: "details_route_observed", onMissing: "stop" }
    ]
  };
  const session = {
    attached: true,
    target: { id: "workflow-dag-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [{ level: 1, text: "Records" }],
      candidates: [first, second].map((candidate, index) => ({
        ...candidate,
        targetId: "workflow-dag-target",
        documentGeneration: 1,
        backendNodeId: 30 + index
      })),
      scrollTargets: []
    },
    dispatched: [],
    observations: 0,
    async observe() { this.observations++; return { evidenceId: `dag_observation_${this.observations}`, targetId: this.target.id, ...structuredClone(this.state) }; },
    async waitForChange() {},
    async click(candidate) {
      this.dispatched.push(candidate.backendNodeId);
      const path = this.dispatched.length === 1 ? "/step-one" : "/step-two";
      this.state.page = { url: `https://fixture.example${path}`, title: "Workflow step" };
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  let synthesisCalls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { synthesisCalls++; return { result: dag }; } } });
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [{
      ...capabilities[0],
      verify({ afterObservation }) {
        return afterObservation.page.url.endsWith("/step-one") || afterObservation.page.url.endsWith("/step-two");
      }
    }],
    environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
    assertExecutionLease: async () => {},
    maxActions: 4
  });
  const result = await engine.run("Complete the two section workflow", { workflowIntent: { purposeCode: "complete_sections", outcomeCode: "two_sections_complete" } });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(session.dispatched, [30, 31]);
  assert.equal(synthesisCalls, 1);
  assert.equal(result.workflowPlan.synthesisCalls, 1);
  assert.deepEqual(result.workflowPlan.stepStatuses, { open_first: "passed", open_second: "passed" });
});

test("workflow plans resolve registered target roles from fresh observations on later pages", async () => {
  const steps = {
    version: 1,
    steps: [
      { id: "open_details", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "continue", capabilityId: "continue_flow", targetRole: "continue_link", dependsOn: ["open_details"], when: { stepId: "open_details", status: "passed" }, verifyCode: "results_route_observed", onMissing: "stop" }
    ]
  };
  const session = {
    attached: true,
    target: { id: "workflow-future-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [],
      candidates: [{ identity: "details", tag: "a", role: "link", name: "Details", href: "https://fixture.example/details", visible: true, disabled: false, targetId: "workflow-future-target", documentGeneration: 1, backendNodeId: 41 }],
      scrollTargets: []
    },
    dispatched: [],
    observations: 0,
    async observe() { this.observations++; return { evidenceId: `future_observation_${this.observations}`, targetId: this.target.id, ...structuredClone(this.state) }; },
    async waitForChange() {},
    async click(candidate) {
      this.dispatched.push(candidate.identity);
      if (candidate.identity === "details") {
        this.state.page = { url: "https://fixture.example/details", title: "Details" };
        this.state.candidates = [{ identity: "continue_now", tag: "a", role: "link", name: "Continue", href: "https://fixture.example/results", visible: true, disabled: false, targetId: this.target.id, documentGeneration: 2, backendNodeId: 52 }];
      } else {
        this.state.page = { url: "https://fixture.example/results", title: "Results" };
        this.state.candidates = [];
      }
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  let synthesisCalls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { synthesisCalls++; return { result: steps }; } } });
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [
      { ...capabilities[0], verify({ afterObservation }) { return afterObservation.page.url.endsWith("/details"); } },
      {
        id: "continue_flow", action: "click", effectClass: "navigation", targetRole: "continue_link",
        observedRoles: [], observedTags: [],
        resolveTarget(observation) { return observation.candidates.filter(candidate => candidate.name === "Continue").map(candidate => candidate.identity); },
        verificationCodes: ["results_route_observed"],
        verify({ afterObservation }) { return afterObservation.page.url.endsWith("/results"); }
      }
    ],
    workflowIntent: { purposeCode: "complete_records_flow", outcomeCode: "results_page" },
    environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
    assertExecutionLease: async () => {},
    maxActions: 4
  });
  const result = await engine.run("Open details then continue");
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(session.dispatched, ["details", "continue_now"]);
  assert.equal(synthesisCalls, 1);
  assert.deepEqual(result.workflowPlan.stepStatuses, { open_details: "passed", continue: "passed" });
});
