import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { selectAutomaticNavigationRoute, selectPreActionDecisionRoute, selectWorkflowPlanningRoute, selectWorkflowReviewRoute } from "../src/decisions/callPolicy.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { DeterministicPlanner } from "../src/navigation/planner.js";
import { WorkflowGraphPlanner } from "../src/navigation/workflowPlanner.js";
import { WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { buildEpisode } from "../src/telemetry/episodeBuilder.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";

const simpleObservation = {
  evidenceId: "routing_observation",
  targetId: "routing_target",
  documentGeneration: 1,
  viewport: { width: 1280, height: 720 },
  page: { url: "https://fixture.example/settings", title: "Settings" },
  headings: [],
  candidates: [{
    identity: "save_button",
    tag: "button",
    role: "button",
    name: "Save",
    visible: true,
    disabled: false,
    submitsForm: false
  }],
  scrollTargets: []
};
const visualScreenshot = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

test("simple unique fresh target routes to deterministic planning without a model call", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: null,
    jevClient: { async decide() { throw new Error("Jev should not be called"); } }
  });
  let modelCalls = 0;
  try {
    const episode = runtime.startEpisode({
      runId: "run_inference_route",
      workflowId: "inference_route",
      applicationId: "fixture_app",
      environmentClass: "local",
      executionMode: "standalone"
    });
    const planner = new WorkflowGraphPlanner({
      synthesizer: { async synthesize() { modelCalls++; throw new Error("secondary model should not be called"); } },
      decisionRuntime: runtime,
      episodeId: episode.episodeId,
      runId: episode.runId,
      taskIntent: { purposeCode: "click_control", outcomeCode: "control_selected", cardinality: "atomic" },
      allowDeterministicShortcut: true,
      fallbackPlanner: new DeterministicPlanner()
    });

    const result = await planner.plan("Click Save", simpleObservation);
    assert.equal(result.status, "planned");
    assert.equal(result.action.target.identity, "save_button");
    assert.equal(modelCalls, 0);
    const route = store.getEvents(episode.episodeId).find(event => event.eventType === "inference.route_selected");
    assert.deepEqual(route.payload, {
      route: "deterministic",
      reasonCode: "unique_fresh_candidate",
      providers: ["deterministic"],
      visualEvidenceUsed: false,
      inputModality: "text_only"
    });
  } finally {
    runtime.close();
  }
});

test("pre-action semantic mapping avoids a duplicate Jev request when its result is clear", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let semanticCalls = 0;
  let jevCalls = 0;
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: {
      providerId: "freeinference_production",
      model: "GLM5.3-flash",
      async analyzePage({ requestedRoles }) {
        semanticCalls++;
        return {
          annotations: requestedRoles.map(semanticRole => ({
            semanticRole,
            candidateRef: "save_button",
            resultCode: "mapped",
            confidence: 0.98
          })),
          eventIds: []
        };
      }
    },
    jevClient: { async decide() { jevCalls++; throw new Error("Jev should not be called"); } }
  });
  try {
    const episode = runtime.startEpisode({
      runId: "run_semantic_route",
      workflowId: "semantic_route",
      applicationId: "fixture_app",
      environmentClass: "local",
      executionMode: "standalone"
    });
    const result = await runtime.reviewBeforeAction({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "save",
      decisionId: "decision_semantic_route",
      observation: simpleObservation,
      operation: "click",
      operationClass: "navigation",
      targetRole: "save_control",
      semanticRoles: ["save_control"]
    });

    assert.equal(semanticCalls, 1);
    assert.equal(jevCalls, 0);
    assert.equal(result.semantic.annotations[0].candidateRef, "save_button");
    assert.equal(result.jevSkipped, true);
    const events = store.getEvents(episode.episodeId);
    const routes = events.filter(event => event.eventType === "inference.route_selected");
    assert.deepEqual(routes.map(event => event.payload.route), ["semantic_only", "deterministic"]);
    assert.ok(routes[0].sequence < events.find(event => event.eventType === "intent.proposed").sequence);
    assert.ok(routes[1].sequence < events.find(event => event.eventType === "decision.skipped").sequence);
  } finally {
    runtime.close();
  }
});

test("pre-action Jev review skips unsupported judgments without intent-bound visual evidence", async () => {
  const insufficient = selectPreActionDecisionRoute({
    reviewRequired: true,
    riskClass: "shared_mutation",
    visualEvidenceAvailable: false,
    reviewIntentAvailable: true
  });
  assert.equal(insufficient.route, "deterministic");
  assert.equal(insufficient.reasonCode, "review_insufficient_evidence");
  assert.equal(selectPreActionDecisionRoute({
    uncertaintyClass: "ambiguous",
    visualEvidenceAvailable: true,
    reviewIntentAvailable: false
  }).reasonCode, "review_insufficient_evidence");
  assert.equal(selectPreActionDecisionRoute({
    reviewRequired: true,
    riskClass: "shared_mutation",
    visualEvidenceAvailable: true,
    reviewIntentAvailable: true
  }).route, "jev_only");

  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let jevCalls = 0;
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: null,
    jevClient: { async decide() { jevCalls++; throw new Error("Jev must not receive an ungrounded request"); } }
  });
  try {
    const episode = runtime.startEpisode({ runId: "run_insufficient_review", workflowId: "insufficient_review", applicationId: "test", environmentClass: "local" });
    const result = await runtime.reviewBeforeAction({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "submit",
      decisionId: "decision_insufficient_review",
      observation: simpleObservation,
      operation: "submit",
      operationClass: "shared_mutation",
      targetRole: "submit_button",
      purposeCode: "submit_report"
    });
    assert.equal(jevCalls, 0);
    assert.equal(result.evidenceStatus, "insufficient_evidence");
    assert.equal(result.reasonCode, "review_insufficient_evidence");
    const skipped = store.getEvents(episode.episodeId).find(event => event.eventType === "decision.skipped");
    assert.equal(skipped.payload.reasonCode, "review_insufficient_evidence");
  } finally {
    runtime.close();
  }
});

test("compound and explicitly constrained tasks keep the secondary planner route", async () => {
  const deterministicPlan = await new DeterministicPlanner().plan("Click Save then open the receipt", simpleObservation);
  assert.equal(selectWorkflowPlanningRoute({
    goal: "Click Save then open the receipt",
    deterministicPlan,
    allowDeterministic: true,
    taskIntent: { purposeCode: "save_and_open", outcomeCode: "receipt_opened", cardinality: "compound" }
  }).route, "semantic_only");

  const exactPlan = await new DeterministicPlanner().plan("Click Save", simpleObservation);
  assert.equal(selectWorkflowPlanningRoute({
    goal: "Click Save",
    deterministicPlan: exactPlan,
    allowDeterministic: true,
    taskIntent: { purposeCode: "save", outcomeCode: "saved", cardinality: "atomic", targetRoles: ["save_control"] }
  }).reasonCode, "workflow_intent_requires_planning");

  assert.deepEqual(selectWorkflowPlanningRoute({
    goal: "Read product names and prices",
    deterministicReadAvailable: true,
    semanticAvailable: true,
    taskIntent: {
      purposeCode: "extract_records",
      outcomeCode: "observed_records_returned",
      cardinality: "atomic",
      requiredCapabilityIds: ["observed_read_123"]
    }
  }), {
    route: "deterministic",
    reasonCode: "single_bound_observed_read",
    providers: ["deterministic"],
    visualEvidenceUsed: false
  });
});

test("automatic navigation routes unique work locally, ambiguous targets to visual grounding when permitted, and unknown pages to Jev", () => {
  assert.deepEqual(selectAutomaticNavigationRoute({
    goal: "Click Save",
    deterministicPlan: { status: "planned", confidence: 0.94 },
    intentShape: "atomic",
    semanticAvailable: true,
    visualAssessmentAvailable: true
  }), {
    route: "deterministic", reasonCode: "unique_fresh_candidate", providers: ["deterministic"], visualEvidenceUsed: false
  });
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Open invoice 24 page",
    deterministicPlan: { status: "planned", confidence: 0.6, action: { type: "scroll" } },
    intentShape: "atomic",
    semanticAvailable: true
  }).reasonCode, "unique_fresh_scroll_region");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Click the Save button",
    deterministicPlan: { status: "ambiguous", candidates: [{ identity: "save_1" }, { identity: "save_2" }] },
    intentShape: "atomic",
    semanticAvailable: true,
    visualAssessmentAvailable: true,
    visualGroundingAvailable: true
  }).reasonCode, "ambiguous_visual_target_grounding");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Click the Save button",
    deterministicPlan: { status: "ambiguous", candidates: [{ identity: "save_1" }, { identity: "save_2" }] },
    intentShape: "atomic",
    semanticAvailable: true,
    visualAssessmentAvailable: true
  }).route, "semantic_only");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Open the account page",
    deterministicPlan: { status: "ambiguous", candidates: [] },
    intentShape: "atomic",
    semanticAvailable: true,
    visualAssessmentAvailable: true
  }).route, "jev_only");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Open settings then save",
    deterministicPlan: { status: "planned", confidence: 0.99 },
    intentShape: "compound",
    semanticAvailable: true
  }).route, "semantic_only");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Open the account page",
    deterministicPlan: { status: "planned", confidence: 0.99 },
    intentShape: "unknown",
    semanticAvailable: true
  }).reasonCode, "intent_cardinality_unclassified");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Click Save",
    deterministicPlan: { status: "planned", confidence: 0.99 },
    semanticAvailable: false
  }).route, "abstain", "plain wording cannot substitute for a typed atomicity contract");
  assert.equal(selectAutomaticNavigationRoute({
    goal: "Open the account page",
    deterministicPlan: { status: "ambiguous", candidates: [{ identity: "candidate" }] },
    semanticAvailable: false
  }).reasonCode, "intent_contract_unavailable");
});

test("workflow routing does not infer atomicity from simple imperative wording", () => {
  const route = selectWorkflowPlanningRoute({
    goal: "Click Save",
    deterministicPlan: { status: "planned", confidence: 0.99, action: { type: "click", target: { submitsForm: false } } },
    allowDeterministic: true,
    semanticAvailable: false
  });
  assert.equal(route.route, "abstain");
  assert.equal(route.reasonCode, "workflow_synthesizer_unconfigured");
});

test("Jev reviews only multi-step, consequential, or image-grounded workflow plans", () => {
  const capability = { id: "open", action: "click", effectClass: "navigation", requiresApproval: false };
  const oneStep = {
    plan: { steps: [{ id: "open", capabilityId: "open", targetRef: "target" }] },
    capabilities: { byId: new Map([["open", capability]]) },
    bindings: new Map([["target", { identity: "save_button" }]])
  };
  assert.equal(selectWorkflowReviewRoute({ result: oneStep, observation: simpleObservation, jevAvailable: true }).review, false);

  const multiStep = { ...oneStep, plan: { steps: [...oneStep.plan.steps, { id: "next", capabilityId: "open" }] } };
  assert.equal(selectWorkflowReviewRoute({ result: multiStep, observation: simpleObservation, jevAvailable: true }).route, "jev_only");

  const consequential = { ...oneStep, capabilities: { byId: new Map([["open", { ...capability, effectClass: "shared_mutation" }]]) } };
  assert.equal(selectWorkflowReviewRoute({ result: consequential, observation: simpleObservation, jevAvailable: true }).reasonCode, "consequential_plan_review");

  const visualObservation = {
    ...simpleObservation,
    viewport: { width: 780, height: 437 },
    visualEvidence: {
      evidenceId: "routing_observation",
      targetId: "routing_target",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      screenshotBase64: visualScreenshot
    }
  };
  assert.equal(selectWorkflowReviewRoute({ result: oneStep, observation: visualObservation, jevAvailable: true, jevImageAvailable: true }).visualEvidenceUsed, true);
});

test("route telemetry rejects unknown providers and records no arbitrary call metadata", () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_bad_route", workflowId: "bad_route", applicationId: "fixture_app", environmentClass: "local" });
    assert.throws(() => store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      decisionId: "decision_bad_route",
      observationId: "routing_observation",
      eventType: "inference.route_selected",
      payload: { route: "semantic_only", reasonCode: "test", providers: ["untrusted_endpoint"], visualEvidenceUsed: false }
    }), /supported providers/u);
  } finally {
    store.close();
  }
});

test("compound workflow invokes the secondary model, then Jev, with route events before each call", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let secondaryCalls = 0;
  let jevCalls = 0;
  const twoStepPlan = {
    version: 1,
    steps: [
      { id: "open_first", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "open_second", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_2", dependsOn: ["open_first"], when: { stepId: "open_first", status: "passed" }, verifyCode: "details_route_observed", onMissing: "stop" }
    ]
  };
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: null,
    jevClient: {
      async decide({ questions }) {
        jevCalls++;
        return { model: JEV_MODEL_ID, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.95 }])) };
      }
    }
  });
  try {
    const episode = runtime.startEpisode({
      runId: "run_routed_compound",
      workflowId: "routed_compound",
      applicationId: "fixture_app",
      environmentClass: "local",
      executionMode: "standalone"
    });
    const synthesizer = new WorkflowSynthesizer({
      eventStore: store,
      provider: { async requestStructured() { secondaryCalls++; return { result: twoStepPlan }; } }
    });
    const planner = new WorkflowGraphPlanner({
      synthesizer,
      capabilities: [{
        id: "open_record_details",
        action: "click",
        effectClass: "navigation",
        intentBinding: "generic_navigation",
        targetRole: "record_details_link",
        purposeCodes: ["complete_sections"],
        preconditionCodes: ["observed_authorized_target"],
        postconditionCodes: ["two_sections_complete"],
        observedRoles: ["link"],
        verificationCodes: ["details_route_observed"]
      }],
      taskIntent: { purposeCode: "complete_sections", outcomeCode: "two_sections_complete", cardinality: "compound" },
      decisionRuntime: runtime,
      episodeId: episode.episodeId,
      runId: episode.runId,
      allowDeterministicShortcut: true
    });
    const observation = {
      ...simpleObservation,
      evidenceId: "compound_observation",
      candidates: [
        { ...simpleObservation.candidates[0], identity: "details_link", tag: "a", role: "link", name: "Details", contextName: "Section one", href: "https://fixture.example/section-one" },
        { ...simpleObservation.candidates[0], identity: "continue_link", tag: "a", role: "link", name: "Continue", contextName: "Section two", href: "https://fixture.example/section-two" }
      ]
    };

    const result = await planner.plan("Complete the first section then continue to the second", observation);
    assert.equal(result.status, "planned");
    assert.equal(secondaryCalls, 1);
    const events = store.getEvents(episode.episodeId);
    assert.equal(planner.getStatus().status, "synthesized", JSON.stringify(events.filter(event => event.eventType.startsWith("workflow.plan_"))));
    assert.equal(jevCalls, 1);
    const routes = events.filter(event => event.eventType === "inference.route_selected");
    assert.deepEqual(routes.map(event => event.payload.route), ["semantic_only", "jev_only"]);
    const synthesis = events.find(event => event.eventType === "workflow.plan_synthesized");
    const reviewInput = events.find(event => event.eventType === "decision.input_captured");
    assert.ok(routes[0].sequence < synthesis.sequence);
    assert.ok(synthesis.sequence < routes[1].sequence);
    assert.ok(routes[1].sequence < reviewInput.sequence);
    assert.equal(routes[0].decisionId, synthesis.decisionId);
    assert.equal(routes[1].decisionId, synthesis.decisionId);
    assert.deepEqual(buildEpisode(store, episode.episodeId).inferenceRoutes.map(route => route.route), ["semantic_only", "jev_only"]);
  } finally {
    runtime.close();
  }
});
