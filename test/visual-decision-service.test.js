import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_MODEL_ID, JevDecisionClient } from "../src/decisions/jevClient.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { buildEpisode } from "../src/telemetry/episodeBuilder.js";

const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

function observation(evidenceId, { generation = 1, targetId = "target_visual_fixture", withImage = true, candidates = [] } = {}) {
  return {
    evidenceId,
    targetId,
    documentGeneration: generation,
    viewport: { width: 780, height: 437 },
    page: { readyState: "complete", title: "Never persisted" },
    candidates,
    candidateCount: candidates.length,
    ...(withImage ? { visualEvidence: {
      evidenceId,
      targetId,
      documentGeneration: generation,
      viewport: { width: 780, height: 437 },
      screenshotBase64
    } } : {})
  };
}

function choiceAnswer(question, selected) {
  const probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 0.92 : 0.01]));
  return { type: "choice", choice: selected, probabilities, confidence: 0.92 };
}

function setup(fetchImpl, { allowImages = true } = {}) {
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore,
    semanticAnalyzer: null,
    jevClient: new JevDecisionClient({ apiKey: "visual-test-credential", allowImages, fetchImpl })
  });
  const episode = runtime.startEpisode({ runId: "run_visual_decisions", workflowId: "visual_decisions", applicationId: "fixture_app", environmentClass: "local" });
  return { runtime, eventStore, episode };
}

test("visual page classification sends one bound image and records typed advisory lineage", async () => {
  let request;
  const { runtime, eventStore, episode } = setup(async (_url, options) => {
    request = options;
    const body = JSON.parse(options.body);
    const questions = body.questions;
    return new Response(JSON.stringify({
      model: JEV_MODEL_ID,
      answers: {
        page_state: choiceAnswer(questions.page_state, "authenticated_app"),
        obstruction_present: { type: "noul", noul: 0.08 }
      }
    }), { status: 200 });
  });
  try {
    const page = observation("obs_visual_page", {
      candidates: [{ identity: "dialog_1", role: "dialog", visible: true }, { identity: "save_1", role: "button", visible: true }]
    });
    const result = await runtime.visualDecisionService.classifyPage(page, {
      episodeId: episode.episodeId, runId: episode.runId, stepId: "classify", decisionId: "decision_visual_page"
    });
    const requestBody = JSON.parse(request.body);
    assert.equal(result.status, "reviewed");
    assert.equal(result.authorizesOperation, false);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.answers.page_state.choice, "authenticated_app");
    assert.equal(request.headers["TypeSafe-Danger-Zone-Images"], "true");
    assert.equal(requestBody.state[1].type, "image_url");
    assert.equal(requestBody.state[1].image_url.url, `data:image/jpeg;base64,${screenshotBase64}`);
    const events = eventStore.getEvents(episode.episodeId);
    const input = events.find(event => event.eventType === "decision.input_captured");
    const predictions = events.filter(event => event.eventType === "decision.predicted");
    assert.equal(input.payload.inputKind, "visual_assessment_review");
    assert.equal(input.payload.rubricVersion, "1");
    assert.equal(input.payload.inputProjection.state.current.dialog_count, 1);
    assert.ok(input.payload.inputProjection.visualEvidence.imageSha256);
    assert.ok(input.payload.inputProjection.questions.every(question => question.instructions));
    assert.equal(JSON.stringify(events).includes(screenshotBase64), false);
    assert.ok(predictions.every(event => event.payload.reviewDisposition === "advisory_only"));
    assert.ok(predictions.every(event => event.payload.inputEventIds.includes(input.eventId)));
    assert.ok(buildEpisode(eventStore, episode.episodeId).decisions.every(decision => decision.inputLineageComplete));
    assert.equal(events.some(event => event.eventType === "verification.completed"), false);
    assert.equal(eventStore.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { runtime.close(); }
});

test("visual target grounding batches Noul and Box, then binds the box to one fresh candidate", async () => {
  let requestBody;
  const { runtime, eventStore, episode } = setup(async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: JEV_MODEL_ID,
      answers: {
        target_present: { type: "noul", noul: 0.96 },
        target_box: { type: "box", confidence: 0.93, box: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 } }
      }
    }), { status: 200 });
  });
  try {
    const page = observation("obs_visual_grounding", {
      generation: 3,
      candidates: [{
        identity: "save_candidate", targetId: "target_visual_fixture", documentGeneration: 3,
        backendNodeId: 17, frameTargetId: null, tag: "button", role: "button", name: "Save",
        visible: true, disabled: false,
        bounds: { x: 190, y: 90, width: 110, height: 55 }
      }]
    });
    const result = await runtime.visualDecisionService.groundTarget(page, {
      episodeId: episode.episodeId, runId: episode.runId, stepId: "ground_save", decisionId: "decision_visual_grounding",
      targetRoleCode: "save_button", allowedCandidateIds: ["save_candidate"], imageEvidence: page.visualEvidence
    });
    assert.equal(Object.keys(requestBody.questions).length, 2);
    assert.equal(requestBody.questions.target_present.type, "noul");
    assert.equal(requestBody.questions.target_box.type, "box");
    assert.equal(JSON.parse(requestBody.state[0]).browserState.target_role_code, "save_button");
    assert.equal(requestBody.state[1].type, "image_url");
    assert.equal(result.status, "reviewed");
    assert.equal(result.grounding.status, "grounded");
    assert.equal(result.grounding.candidate.identity, "save_candidate");
    assert.equal(result.authorizesOperation, false);
    const events = eventStore.getEvents(episode.episodeId);
    const input = events.find(event => event.payload.inputKind === "visual_assessment_review");
    const predictionTypes = events.filter(event => event.eventType === "decision.predicted").map(event => event.payload.questionType).sort();
    assert.equal(input.payload.rubricVersion, "1");
    assert.equal(input.payload.inputProjection.state.target_role_code, "save_button");
    assert.equal(input.payload.inputModality, "text_plus_visual");
    assert.deepEqual(predictionTypes, ["box", "noul"]);
    assert.equal(JSON.stringify(events).includes(screenshotBase64), false);
    assert.equal(eventStore.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { runtime.close(); }
});

test("visual outcome assessment is advisory and refuses cross-target before/after evidence", async () => {
  let requests = 0;
  const { runtime, eventStore, episode } = setup(async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: JEV_MODEL_ID,
      answers: { visual_outcome: choiceAnswer(body.questions.visual_outcome, "visible_success") }
    }), { status: 200 });
  });
  try {
    const before = observation("obs_visual_before", { generation: 1, withImage: false });
    const after = observation("obs_visual_after", { generation: 2 });
    const result = await runtime.visualDecisionService.assessVisualOutcome(before, after, {
      episodeId: episode.episodeId, runId: episode.runId, stepId: "outcome", decisionId: "decision_visual_outcome",
      expectedOutcomeClass: "success_banner_visible"
    });
    assert.equal(result.status, "reviewed");
    assert.equal(result.answers.visual_outcome.choice, "visible_success");
    assert.equal(result.authorizesOperation, false);
    assert.equal(requests, 1);
    assert.equal(eventStore.getEvents(episode.episodeId).some(event => event.eventType === "verification.completed"), false);

    const stale = await runtime.visualDecisionService.assessVisualOutcome(before, observation("obs_other_target", { targetId: "target_other" }), {
      episodeId: episode.episodeId, runId: episode.runId, stepId: "outcome_stale", decisionId: "decision_visual_stale"
    });
    assert.equal(stale.status, "unavailable");
    assert.equal(stale.failureCode, "stale_evidence");
    assert.equal(requests, 1);
  } finally { runtime.close(); }
});

test("visual decisions record permission and evidence skips without calling Jev", async () => {
  let requests = 0;
  const denied = setup(async () => { requests++; throw new Error("must not call Jev"); }, { allowImages: false });
  try {
    const result = await denied.runtime.visualDecisionService.detectObstructions(observation("obs_visual_denied"), {
      episodeId: denied.episode.episodeId, runId: denied.episode.runId, stepId: "obstructions", decisionId: "decision_visual_denied"
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.failureCode, "image_permission_denied");
    assert.equal(requests, 0);
    const skipped = denied.eventStore.getEvents(denied.episode.episodeId).find(event => event.eventType === "decision.skipped");
    assert.equal(skipped.payload.reasonCode, "image_permission_denied");
  } finally { denied.runtime.close(); }

  const enabled = setup(async () => { requests++; throw new Error("must not call Jev"); });
  try {
    const missing = await enabled.runtime.visualDecisionService.classifyPage(observation("obs_visual_missing", { withImage: false }), {
      episodeId: enabled.episode.episodeId, runId: enabled.episode.runId, stepId: "classify_missing", decisionId: "decision_visual_missing"
    });
    assert.equal(missing.failureCode, "visual_evidence_unavailable");
    assert.equal(requests, 0);
  } finally { enabled.runtime.close(); }
});
