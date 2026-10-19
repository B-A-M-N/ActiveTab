import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_MODEL_ID, JevDecisionClient } from "../src/decisions/jevClient.js";
import { DecisionCoordinator } from "../src/decisions/decisionCoordinator.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { createWorkflowReviewBinding } from "../src/navigation/workflowReviewBinding.js";

const QUESTION = { intent_alignment: { type: "noul", instructions: "Is the typed evidence aligned?" } };
const PRE_ACTION_STATE = {
  operation_code: "click",
  operation_class: "navigation",
  requested_target_role: "browser_target",
  proposed_control: { candidate_ref: "target-1:root:frame-1:1:2", role: "link", tag: "a", visible: true, disabled: false },
  page_surface: "observed_browser_surface",
  alternative_count: 0
};

test("Jev client pins 1.14, preserves typed probabilities and usage, and never returns its credential", async () => {
  let request;
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        model: "typesafe/jev-1.14-20261014",
        id: "request_1",
        answers: { intent_alignment: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 42, output_tokens: 7, prompt_tokens_details: { cached_tokens: 12 }, cost: 0.001 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await client.decide({ state: PRE_ACTION_STATE, questions: QUESTION });
  assert.equal(JSON.parse(request.options.body).model, "typesafe/jev-1.14");
  assert.equal(request.options.headers.authorization, "Bearer test-secret-not-for-output");
  assert.equal(Object.hasOwn(client, "apiKey"), false, "the Jev credential is held in a private class field");
  assert.equal(JSON.stringify(client).includes("test-secret-not-for-output"), false);
  assert.equal(result.model, "typesafe/jev-1.14");
  assert.equal(result.modelSnapshot, "typesafe/jev-1.14-20261014");
  assert.deepEqual(result.answers.intent_alignment, { type: "noul", probabilityYes: 0.93 });
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 7, cachedInputTokens: 12, cost: 0.001 });
  assert.equal(JSON.stringify(result).includes("test-secret-not-for-output"), false);
});

test("Jev client rejects a response that identifies a different model", async () => {
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async () => new Response(JSON.stringify({ model: "typesafe/jev-latest", answers: { intent_alignment: { type: "noul", noul: 0.8 } } }), { status: 200 })
  });
  await assert.rejects(client.decide({ state: PRE_ACTION_STATE, questions: QUESTION }), /pinned decision model/);
});

test("Jev client accepts only the minimized typed state and does not send free text", async () => {
  let fetchCount = 0;
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    fetchImpl: async () => {
      fetchCount++;
      return new Response(JSON.stringify({ model: JEV_MODEL_ID, answers: { intent_alignment: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }
  });
  await assert.rejects(client.decide({
    state: { ...PRE_ACTION_STATE, page_text: "private page text" },
    questions: QUESTION
  }), error => error.kind === "privacy");
  assert.equal(fetchCount, 0);
});

test("Jev image input sends a bound JPEG as an experimental multimodal decision part", async () => {
  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  const imageEvidence = {
    evidenceId: "obs_jev_image",
    targetId: "target_jev_image",
    documentGeneration: 3,
    viewport: { width: 780, height: 437 },
    screenshotBase64
  };
  let request;
  const client = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    allowImages: true,
    fetchImpl: async (_url, options) => {
      request = options;
      return new Response(JSON.stringify({
        model: "typesafe/jev-1.14-20261014",
        answers: { intent_alignment: { type: "noul", noul: 0.9 } }
      }), { status: 200 });
    }
  });
  const result = await client.decide({ state: PRE_ACTION_STATE, questions: QUESTION, imageEvidence });
  const body = JSON.parse(request.body);
  assert.equal(request.headers["TypeSafe-Danger-Zone-Images"], "true");
  assert.equal(body.state.length, 2);
  assert.match(body.state[0], /imageSha256/u);
  assert.equal(body.state[1].type, "image_url");
  assert.equal(body.state[1].image_url.url, `data:image/jpeg;base64,${screenshotBase64}`);
  assert.equal(result.model, JEV_MODEL_ID, "dated snapshots normalize to the pinned Jev family ID");
  assert.equal(result.answers.intent_alignment.probabilityYes, 0.9);
});

test("Jev rejects image input unless explicitly enabled and rejects images outside its experimental size bounds", async () => {
  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  const imageEvidence = {
    evidenceId: "obs_jev_image",
    targetId: "target_jev_image",
    documentGeneration: 3,
    viewport: { width: 780, height: 437 },
    screenshotBase64
  };
  let requests = 0;
  const disabled = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    allowImages: false,
    fetchImpl: async () => { requests++; throw new Error("must not send"); }
  });
  await assert.rejects(disabled.decide({ state: PRE_ACTION_STATE, questions: QUESTION, imageEvidence }), error => error.kind === "privacy");
  const enabled = new JevDecisionClient({
    apiKey: "test-secret-not-for-output",
    allowImages: true,
    fetchImpl: async () => { requests++; throw new Error("must not send"); }
  });
  await assert.rejects(enabled.decide({
    state: PRE_ACTION_STATE,
    questions: QUESTION,
    imageEvidence: { ...imageEvidence, screenshotBase64: Buffer.alloc(80, 0x61).toString("base64") }
  }), error => error.kind === "size");
  assert.equal(requests, 0);
});

test("workflow-plan state reaches Jev through the coordinator with typed input and prediction lineage", async () => {
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = eventStore.startEpisode({ runId: "run_jev_workflow", workflowId: "workflow_jev", applicationId: "fixture_app", environmentClass: "local" });
    let calls = 0;
    let sent;
    const client = new JevDecisionClient({
      apiKey: "fixture-jev-key",
      fetchImpl: async (_url, options) => {
        calls++;
        sent = JSON.parse(options.body);
        return new Response(JSON.stringify({
          model: "typesafe/jev-1.14-20261014",
          answers: Object.fromEntries(Object.keys(sent.questions).map(id => [id, { type: "noul", noul: 0.95 }]))
        }), { status: 200 })
      }
    });
    const coordinator = new DecisionCoordinator({ client, eventStore });
    const observation = {
      evidenceId: "obs_workflow_jev",
      targetId: "target_workflow_jev",
      documentGeneration: 2
    };
    const planHash = "a".repeat(64);
    const binding = createWorkflowReviewBinding({
      planHash,
      taskContractHash: "b".repeat(64),
      capabilityCatalogHash: "c".repeat(64),
      taskOutcomeCode: "destination_visible",
      observationId: observation.evidenceId,
      targetId: observation.targetId,
      documentGeneration: observation.documentGeneration
    });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "plan_review",
      observationId: observation.evidenceId,
      observation,
      planHash,
      reviewBinding: binding,
      planProjection: [{
        stepId: "open_home",
        capabilityId: "open_link",
        effectClass: "navigation",
        targetRole: "home_link",
        verificationCode: "destination_visible",
        requiresApproval: false,
        dependsOn: [],
        condition: null,
        purposeCodes: ["navigate"],
        preconditionCodes: ["observed_authorized_target"],
        postconditionCodes: ["destination_visible"]
      }]
    });
    assert.equal(calls, 1, JSON.stringify(result));
    assert.equal(result.status, "reviewed");
    assert.equal(sent.state.plan_version, 1);
    assert.equal(sent.state.steps[0].effect_class, "navigation");
    const events = eventStore.getEvents(episode.episodeId);
    const input = events.find(event => event.eventType === "decision.input_captured");
    const predictions = events.filter(event => event.eventType === "decision.predicted");
    const jevRoutes = events.filter(event => event.eventType === "inference.route_selected" && event.payload.providers.includes("jev"));
    assert.equal(input.payload.inputKind, "workflow_plan_review");
    assert.equal(predictions.length, 3);
    assert.equal(jevRoutes.length, 1);
    assert.equal(jevRoutes[0].payload.inputModality, "text_only");
    assert.ok(predictions.every(event => event.payload.modelSnapshot === "typesafe/jev-1.14-20261014"));
    assert.ok(predictions.every(event => event.payload.inputEventIds.includes(input.eventId)));
    assert.equal(eventStore.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { eventStore.close(); }
});

test("workflow-plan Jev rejects unsupported effects and oversized plans before inference", async () => {
  let calls = 0;
  const client = new JevDecisionClient({ apiKey: "fixture-jev-key", fetchImpl: async () => { calls++; throw new Error("must not call provider"); } });
  const step = {
    step_id: "open_home",
    capability_id: "open_link",
    effect_class: "unbounded_effect",
    target_role: "home_link",
    verification_code: "destination_visible",
    requires_approval: false,
    depends_on: [],
    condition: null,
    purpose_codes: ["navigate"],
    precondition_codes: ["observed_target"],
    postcondition_codes: ["destination_visible"]
  };
  const baseState = { plan_version: 1, step_count: 1, task_outcome_code: "destination_visible", review_binding_hash: "a".repeat(64), steps: [step] };
  await assert.rejects(client.decide({
    reviewKind: "workflow_plan_review",
    state: { ...baseState, steps: [{ ...step, effect_class: "unbounded_effect" }] },
    questions: QUESTION
  }), error => error.kind === "privacy");
  await assert.rejects(client.decide({
    reviewKind: "workflow_plan_review",
    state: { ...baseState, steps: [{ ...step, effect_class: "navigation", unexpected: true }] },
    questions: QUESTION
  }), error => error.kind === "privacy");
  await assert.rejects(client.decide({
    reviewKind: "workflow_plan_review",
    state: { ...baseState, step_count: 25, steps: Array.from({ length: 25 }, (_, index) => ({ ...step, step_id: `step_${index}`, effect_class: "navigation" })) },
    questions: QUESTION
  }), error => error.kind === "privacy");
  assert.equal(calls, 0);
});

test("workflow review refuses a binding from another target revision before inference", async () => {
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = eventStore.startEpisode({ runId: "run_stale_workflow_review", workflowId: "stale_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    const observed = { evidenceId: "obs_stale_review", targetId: "target_original", documentGeneration: 8 };
    const planHash = "d".repeat(64);
    const binding = createWorkflowReviewBinding({
      planHash,
      taskContractHash: "e".repeat(64),
      capabilityCatalogHash: "f".repeat(64),
      taskOutcomeCode: "destination_visible",
      observationId: observed.evidenceId,
      targetId: observed.targetId,
      documentGeneration: observed.documentGeneration
    });
    let calls = 0;
    const coordinator = new DecisionCoordinator({ eventStore, client: { async decide() { calls++; return {}; } } });
    await assert.rejects(coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "plan_review",
      observationId: observed.evidenceId,
      observation: { ...observed, targetId: "target_replaced" },
      planHash,
      reviewBinding: binding,
      planProjection: [{
        stepId: "open_home", capabilityId: "open_link", effectClass: "navigation", targetRole: "home_link",
        verificationCode: "destination_visible", requiresApproval: false, dependsOn: [], condition: null,
        purposeCodes: ["navigate"], preconditionCodes: ["observed_target"], postconditionCodes: ["destination_visible"]
      }]
    }), /exact plan and observation binding/u);
    assert.equal(calls, 0);
    assert.equal(eventStore.getEvents(episode.episodeId).filter(event => event.eventType === "decision.input_captured").length, 0);
  } finally { eventStore.close(); }
});
