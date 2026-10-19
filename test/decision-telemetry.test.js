import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { buildEpisode } from "../src/telemetry/episodeBuilder.js";
import { buildTrainingDataset } from "../src/telemetry/datasetExporter.js";
import { TrainingLabeler } from "../src/telemetry/labeler.js";
import { evaluateDecisionExamples } from "../src/telemetry/evaluator.js";
import { SemanticPageAnalyzer } from "../src/navigation/semanticAnalyzer.js";
import { DecisionCoordinator } from "../src/decisions/decisionCoordinator.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";

const visualFixtureBase64 = readFileSync(new URL("../docs/assets/first-run.jpg", import.meta.url)).toString("base64");

function createStore(options = {}) {
  return new DecisionEventStore({
    databasePath: ":memory:",
    authenticateTrainingApprover: async ({ request }) => ({
      authenticated: true,
      principalId: "local_reviewer_1",
      approvalDigest: request.approvalDigest
    }),
    ...options
  });
}

function fixture(store, { applicationId = "fixture_app", runId = `run_${applicationId}` } = {}) {
  const episode = store.startEpisode({ runId, workflowId: "smoke_workflow", applicationId, environmentClass: "local", executionMode: "agent_directed", policyVersion: "policy_v1" });
  const decisionId = `decision_${applicationId}`;
  const intentEvent = store.append({
    episodeId: episode.episodeId, runId, eventType: "intent.proposed", stepId: "submit_task",
    payload: { operation: "submit", operationClass: "test_owned_mutation", targetRole: "submit_button", parameterNames: ["task_prompt", "model_id"], expectedOutcomeClass: "job_created" }
  });
  const observationEvent = store.append({
    episodeId: episode.episodeId, runId, stepId: "submit_task", observationId: `obs_${applicationId}`,
    eventType: "observation.captured", payload: { surfaceClass: "task_composer", candidateCount: 4, visibleCount: 4, candidateRoles: ["button", "combobox", "textbox"], evidenceRefs: [`ev_${applicationId}`] }
  });
  const inputEvent = store.append({
    episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId, observationId: `obs_${applicationId}`,
    eventType: "decision.input_captured",
    payload: {
      inputKind: "pre_action_review",
      inputProjection: {
        state: {
          operation_code: "submit",
          operation_class: "test_owned_mutation",
          requested_target_role: "submit_button",
          proposed_control: { candidate_ref: "candidate_submit", role: "button", tag: "button", visible: true, disabled: false },
          page_surface: "observed_browser_surface",
          alternative_count: 3
        },
        questions: [{ id: "intent_alignment", type: "noul" }]
      },
      rubricIds: ["intent_alignment"],
      inputFingerprint: "a".repeat(64)
    }
  });
  store.append({
    episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId, observationId: `obs_${applicationId}`,
    eventType: "decision.predicted", payload: { provider: "openrouter", model: "typesafe/jev-1.14", rubricId: "intent_alignment", rubricVersion: "2", rubricHash: "a".repeat(64), questionType: "noul", answer: { type: "noul", probabilityYes: 0.92 }, inputEventIds: [intentEvent.eventId, observationEvent.eventId, inputEvent.eventId] }
  });
  store.append({
    episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId,
    eventType: "policy.adjudicated", payload: { disposition: "allow", reasonCode: "scoped_test_operation", policyVersion: "policy_v1" }
  });
  store.append({
    episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId,
    eventType: "verification.completed", payload: { status: "verified_pass", oracleType: "correlated_backend", reasonCode: "exact_run_match", verifiedCode: "yes", evidenceRefs: [`backend_${applicationId}`] }
  });
  const labeler = new TrainingLabeler({ store });
  const proposed = labeler.propose({ episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId, rubricId: "intent_alignment", labelCode: "yes", sourceClass: "correlated_backend", evidenceRefs: [`backend_${applicationId}`] });
  return { ...episode, decisionId, labelEventId: proposed.eventId, labeler };
}

test("decision event log is private, ordered, append-only, and hash-verifiable", async () => {
  const root = mkdtempSync(join(tmpdir(), "active-tab-telemetry-"));
  const path = join(root, "private", "events.sqlite");
  const store = createStore({ databasePath: path });
  try {
    const item = fixture(store);
    const approvals = await Promise.allSettled([
      item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId }),
      item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId })
    ]);
    assert.equal(approvals.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(approvals.filter(result => result.status === "rejected").length, 1);
    const events = store.getEvents(item.episodeId);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    assert.equal(store.verifyEpisodeChain(item.episodeId).ok, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => store.db.prepare("UPDATE decision_events SET payload_json = '{}' WHERE episode_id = ?").run(item.episodeId), /append-only/);
    assert.throws(() => store.db.prepare("DELETE FROM decision_events WHERE episode_id = ?").run(item.episodeId), /append-only/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("training labels require same-decision verified evidence and the private approval boundary", async () => {
  const store = createStore();
  try {
    const item = fixture(store);
    const unrelatedEvidence = item.labeler.propose({
      episodeId: item.episodeId, runId: item.runId, stepId: "submit_task", decisionId: item.decisionId,
      rubricId: "intent_alignment", labelCode: "yes", sourceClass: "correlated_backend", evidenceRefs: ["invented_backend_ref"]
    });
    await assert.rejects(
      item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: unrelatedEvidence.eventId }),
      error => error.message.includes("independently verified evidence")
    );
    const unsupportedCode = item.labeler.propose({
      episodeId: item.episodeId, runId: item.runId, stepId: "submit_task", decisionId: item.decisionId,
      rubricId: "intent_alignment", labelCode: "no", sourceClass: "correlated_backend", evidenceRefs: ["backend_fixture_app"]
    });
    await assert.rejects(
      item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: unsupportedCode.eventId }),
      error => error.message.includes("independently verified evidence")
    );
    assert.throws(() => store.append({
      episodeId: item.episodeId, runId: item.runId, stepId: "submit_task", decisionId: item.decisionId,
      eventType: "label.approved", trainingEligibility: "eligible",
      payload: {
        labelEventId: item.labelEventId, rubricId: "intent_alignment", labelCode: "yes",
        sourceClass: "correlated_backend", evidenceRefs: ["backend_fixture_app"], reviewerId: "local_reviewer_1", approvalDigest: "a".repeat(64)
      }
    }), error => error.message.includes("authenticated approval boundary"));
    assert.equal(buildTrainingDataset(store, { split: { kind: "workflow", holdout: ["smoke_workflow"] } }).eligibleExampleCount, 0);
  } finally { store.close(); }
});

test("reviewer approval is bound to the exact label proposal", async () => {
  const store = createStore({
    authenticateTrainingApprover: async ({ request }) => ({
      authenticated: true,
      principalId: "local_reviewer_1",
      approvalDigest: "0".repeat(64)
    })
  });
  try {
    const item = fixture(store);
    await assert.rejects(
      item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId }),
      error => error.message.includes("exact label proposal")
    );
    assert.equal(store.getEvents(item.episodeId).some(event => event.eventType === "label.approved"), false);
  } finally { store.close(); }
});

test("verification events can retain a typed code for later independent labeling", () => {
  const store = createStore();
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: { async decide() { throw new Error("No decision request is expected."); } }, semanticAnalyzer: null });
  try {
    const episode = runtime.startEpisode({ runId: "run_verified_code", workflowId: "verification_fixture", applicationId: "fixture_app" });
    const event = runtime.recordVerification({
      episodeId: episode.episodeId, runId: episode.runId, stepId: "assert_outcome", decisionId: "decision_verified_code",
      status: "verified_pass", oracleType: "correlated_backend", reasonCode: "exact_fixture_run", verifiedCode: "task_succeeded",
      evidenceRefs: ["backend_run_fixture"]
    });
    assert.equal(event.payload.verifiedCode, "task_succeeded");
  } finally { runtime.close(); }
});

test("telemetry rejects unstructured content by schema shape, without scanning text", () => {
  const store = createStore();
  try {
    const item = store.startEpisode({ workflowId: "wf", applicationId: "fixture_app" });
    assert.throws(() => store.append({
      episodeId: item.episodeId, runId: item.runId, eventType: "intent.proposed",
      payload: { operation: "fill", operationClass: "read", targetRole: "textbox", expectedOutcomeClass: "saved", prompt: "raw prompt" }
    }), error => error.message.includes("not allowed"));
    assert.throws(() => store.append({
      episodeId: item.episodeId, runId: item.runId, eventType: "intent.proposed",
      payload: { operation: "fill", operationClass: "read", targetRole: "Submit a form with private details", expectedOutcomeClass: "saved" }
    }), error => error.message.includes("bounded structural code"));
    assert.throws(() => store.append({
      episodeId: item.episodeId, runId: item.runId, decisionId: "decision_shape", eventType: "decision.predicted",
      payload: {
        provider: "openrouter", model: "typesafe/jev-1.14", rubricId: "intent_alignment", rubricVersion: "2",
        questionType: "noul", answer: { type: "noul", probabilityYes: 0.5, pageText: "untrusted page data" }
      }
    }), error => error.message.includes("unsupported fields"));
    assert.throws(() => store.append({
      episodeId: item.episodeId, runId: item.runId, decisionId: "decision_usage_bounds", eventType: "decision.predicted",
      payload: {
        provider: "openrouter", model: "typesafe/jev-1.14", rubricId: "intent_alignment", rubricVersion: "2",
        questionType: "noul", answer: { type: "noul", probabilityYes: 0.5 },
        usage: { inputTokens: 5, cachedInputTokens: 6 }
      }
    }), /Cached input tokens cannot exceed total input tokens/);
  } finally { store.close(); }
});

test("episode reconstruction excludes future outcomes from Jev input and only exports approved independent labels", async () => {
  const store = createStore();
  try {
    const train = fixture(store, { applicationId: "fixture_app" });
    const holdout = fixture(store, { applicationId: "fixture_cloud_agent" });
    for (const item of [train, holdout]) await item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId });
    const reconstructed = buildEpisode(store, holdout.episodeId);
    const decision = reconstructed.decisions[0];
    assert.equal(decision.inputEventIds.length, 3);
    assert.equal(decision.model.rubricHash.length, 64);
    assert.ok([...decision.model.rubricHash].every(character => "0123456789abcdef".includes(character)));
    assert.equal(decision.inputEvents.some(event => event.eventType === "decision.predicted"), false);
    assert.equal(decision.outcomeEvents.some(event => event.eventType === "verification.completed"), true);
    assert.equal(decision.trainingEligible, true);
    const dataset = buildTrainingDataset(store, { split: { kind: "application", holdout: ["fixture_cloud_agent"] } });
    assert.equal(dataset.eligibleExampleCount, 2);
    assert.deepEqual(dataset.examples.map(example => example.split).sort(), ["evaluation", "train"]);
    assert.equal(JSON.stringify(dataset).includes("raw prompt"), false);
    const metrics = evaluateDecisionExamples(dataset.examples, { positiveLabel: "yes", approvalThreshold: 0.8 });
    assert.equal(metrics.exampleCount, 2);
    assert.equal(metrics.falseApprovalRate, 0);
    assert.ok(Math.abs(metrics.brierScore - (0.08 ** 2)) < 1e-12);
  } finally { store.close(); }
});

test("Jev and coding-agent predictions cannot self-label training data", async () => {
  const store = createStore();
  try {
    const item = fixture(store);
    const proposed = item.labeler.propose({ episodeId: item.episodeId, runId: item.runId, stepId: "submit_task", decisionId: item.decisionId, rubricId: "intent_alignment", labelCode: "yes", sourceClass: "jev_self", evidenceRefs: ["jev_answer"] });
    await assert.rejects(item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: proposed.eventId }), error => error.message.includes("independently verified evidence"));
    const before = store.getEvents(item.episodeId).length;
    assert.equal(buildTrainingDataset(store, { split: { kind: "workflow", holdout: ["smoke_workflow"] } }).eligibleExampleCount, 0);
    assert.equal(store.getEvents(item.episodeId).length, before);
  } finally { store.close(); }
});

test("semantic annotations and Jev predictions remain distinct but share the same evidence timeline", () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_dual", workflowId: "walkthrough", applicationId: "fixture_app", environmentClass: "local" });
    store.append({ episodeId: episode.episodeId, runId: episode.runId, eventType: "observation.captured", observationId: "obs_1", payload: { surfaceClass: "task_composer", candidateCount: 3, visibleCount: 3, candidateRoles: ["button", "textbox"], evidenceRefs: ["ev_1"] } });
    store.append({ episodeId: episode.episodeId, runId: episode.runId, stepId: "submit", decisionId: "decision_semantic", observationId: "obs_1", eventType: "semantic.annotated", payload: { analyzerProvider: "local", analyzerModel: "semantic_v1", annotationKind: "control_mapping", rubricId: "control_mapping", semanticRole: "task_prompt", candidateRef: "candidate_2", resultCode: "mapped", confidence: 0.91, evidenceRefs: ["ev_1"] } });
    store.append({ episodeId: episode.episodeId, runId: episode.runId, stepId: "submit", decisionId: "decision_jev", observationId: "obs_1", eventType: "decision.predicted", payload: { provider: "openrouter", model: "typesafe_jev_1_14", rubricId: "intent_alignment", rubricVersion: "2", questionType: "noul", answer: { type: "noul", probabilityYes: 0.88 }, usage: { inputTokens: 112, outputTokens: 8, cost: 0.00001 } } });
    const rebuilt = buildEpisode(store, episode.episodeId);
    assert.deepEqual(rebuilt.decisions.map(item => item.sourceType), ["semantic", "decision"]);
    assert.deepEqual(rebuilt.decisions[0].prediction, { type: "semantic", semanticRole: "task_prompt", candidateRef: "candidate_2", resultCode: "mapped", confidence: 0.91, uncertaintyCode: null });
    assert.equal(rebuilt.decisions[1].prediction.probabilityYes, 0.88);
    assert.equal(rebuilt.decisions[0].inputLineageComplete, false);
    assert.equal(rebuilt.decisions[1].inputLineageComplete, false);
    assert.deepEqual(rebuilt.decisions[0].inputEventIds, []);
  } finally { store.close(); }
});

test("Jev outcome review records its exact pre-prediction input projection and links both predictions", async () => {
  const store = createStore();
  try {
    // Outcome records here are constructed from test data, even though their
    // modeled environment class is staging.
    const episode = store.startEpisode({ runId: "run_outcome_review", workflowId: "cloud_agent_task", applicationId: "fixture_cloud_agent", environmentClass: "staging" });
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: {
        async decide({ state }) {
          assert.deepEqual(state, {
            expected_outcome: "status_expected_succeeded",
            browser_outcome: "run_id_observed",
            backend_outcome: "succeeded"
          });
          return {
            model: "typesafe/jev-1.14",
            answers: {
              evidence_support: { type: "noul", probabilityYes: 0.99 },
              outcome_anomaly: {
                type: "choice", choice: "none",
                probabilities: { none: 0.96, ui_backend_mismatch: 0.01, operation_failed: 0.01, evidence_missing: 0.01, unexpected_state: 0.01 }
              }
            },
            usage: { inputTokens: 90, outputTokens: 12 }
          };
        }
      }
    });
    const observedEvent = store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "submit_task",
      decisionId: "decision_outcome",
      observationId: "browser_after_submit",
      eventType: "execution.observed",
      payload: { outcomeClass: "run_id_observed", changed: true, evidenceRefs: ["browser_run_id"] }
    });
    const verificationEvent = store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "submit_task",
      decisionId: "decision_outcome",
      observationId: "browser_run_id",
      eventType: "verification.completed",
      payload: { status: "verified_pass", oracleType: "correlated_backend", reasonCode: "exact_match", evidenceRefs: ["browser_run_id", "backend_run"] }
    });
    const review = await coordinator.reviewOutcome({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "submit_task",
      decisionId: "decision_outcome",
      observationId: "browser_observation",
      expectedOutcomeClass: "status_expected_succeeded",
      browserOutcomeClass: "run_id_observed",
      backendOutcomeClass: "succeeded",
      inputEventIds: [observedEvent.eventId, verificationEvent.eventId]
    });
    const events = store.getEvents(episode.episodeId);
    const input = events.find(event => event.eventType === "decision.input_captured");
    const predictions = events.filter(event => event.eventType === "decision.predicted");
    const jevRoutes = events.filter(event => event.eventType === "inference.route_selected" && event.payload.providers.includes("jev"));
    assert.equal(input.payload.inputKind, "outcome_review");
    assert.equal(input.payload.inputProjection.state.backend_outcome, "succeeded");
    assert.equal(predictions.length, 2);
    assert.equal(jevRoutes.length, 1);
    assert.equal(jevRoutes[0].payload.inputModality, "text_only");
    assert.ok(predictions.every(event => event.payload.inputEventIds.includes(input.eventId)));
    assert.ok(predictions.every(event => event.payload.inputEventIds.includes(observedEvent.eventId)));
    assert.ok(predictions.every(event => event.payload.inputEventIds.includes(verificationEvent.eventId)));
    assert.ok(predictions.every(event => event.parentEventId === input.eventId));
    const rebuilt = buildEpisode(store, episode.episodeId);
    assert.ok(rebuilt.decisions.every(decision => decision.inputLineageComplete));
    assert.ok(rebuilt.events.some(event => event.eventType === "execution.observed"));
    assert.equal(review.authorizesOperation, false);
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("review skips remain explicit in the ordered episode timeline", () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_skip_review", workflowId: "typed_task", applicationId: "fixture_app", environmentClass: "staging" });
    const coordinator = new DecisionCoordinator({ eventStore: store, client: { async decide() { throw new Error("Jev must not be called for a skipped review."); } } });
    const observation = { evidenceId: "obs_skip_review", candidates: [] };
    const skipped = coordinator.recordReviewSkipped({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "fill_prompt",
      decisionId: "decision_skip_review",
      observation,
      operation: "fill",
      operationClass: "unknown",
      targetRole: "task_prompt",
      reasonCode: "policy_boundary_not_triggered"
    });
    const rebuilt = buildEpisode(store, episode.episodeId);
    const event = rebuilt.events.find(item => item.eventType === "decision.skipped");
    assert.equal(event.eventId, skipped.eventId);
    assert.equal(event.payload.reasonCode, "policy_boundary_not_triggered");
    assert.equal(event.payload.inputEventIds.length, 2);
  } finally { store.close(); }
});

test("trusted target resolution is appended as a validated evidence-linked event", () => {
  const store = createStore();
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevClient: { async decide() { throw new Error("No review is requested by this target-resolution test."); } },
    semanticAnalyzer: null
  });
  try {
    const episode = runtime.startEpisode({ runId: "run_target_resolution", workflowId: "cloud_agent_task", applicationId: "fi_agents", environmentClass: "staging" });
    const event = runtime.recordTargetResolution({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_control_mapping",
      decisionId: "decision_mapping",
      observationId: "observation_mapping",
      resolver: "deterministic_structural",
      roleMappings: [
        { role: "model_selector", candidateRef: "candidate_model" },
        { role: "task_prompt", candidateRef: "candidate_prompt" },
        { role: "submit_task", candidateRef: "candidate_submit" }
      ],
      reasonCode: "unique_observed_form_structure",
      evidenceRefs: ["observation_mapping"]
    });
    const rebuilt = buildEpisode(store, episode.episodeId);
    assert.equal(rebuilt.events.at(-1).eventId, event.eventId);
    assert.equal(rebuilt.events.at(-1).eventType, "target.resolved");
    assert.deepEqual(rebuilt.events.at(-1).payload.roleMappings.map(item => item.role), ["model_selector", "submit_task", "task_prompt"]);
    assert.equal(rebuilt.integrity.ok, true);
  } finally { runtime.close(); }
});

test("target lookup telemetry records bounded binding and disposition without page content", () => {
  const store = createStore();
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevClient: { async decide() { throw new Error("No model review is requested by target lookup telemetry."); } },
    semanticAnalyzer: null
  });
  try {
    const episode = runtime.startEpisode({ runId: "run_target_lookup", workflowId: "lookup_test", applicationId: "fixture_app", environmentClass: "local" });
    const event = runtime.recordTargetLookup({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_lookup",
      decisionId: "decision_lookup",
      observationId: "observation_lookup",
      lookupMode: "cdp_dom_location",
      lookupStatus: "candidate",
      targetId: "authorized_target_1",
      documentGeneration: 8,
      frameScope: "root",
      frameTargetId: null,
      frameId: "root_frame_1",
      returnedCount: 1,
      visitedNodeCount: 3,
      stopReason: "candidate_found_at_hit_location",
      elapsedMs: 12,
      nextActionDisposition: "deferred"
    });
    const stored = store.getEvents(episode.episodeId).at(-1);
    assert.equal(stored.eventType, "target.lookup");
    assert.equal(stored.schemaVersion, 3);
    assert.equal(stored.observationId, "observation_lookup");
    assert.equal(stored.payload.frameScope, "root");
    assert.equal(stored.payload.frameTargetId, null);
    assert.equal(stored.payload.visitedNodeCount, 3);
    assert.equal(stored.payload.nextActionDisposition, "deferred");
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
    assert.throws(() => store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_lookup",
      decisionId: "decision_lookup_leak",
      observationId: "observation_lookup",
      eventType: "target.lookup",
      payload: { ...event.payload, pageText: "must not be retained" }
    }), /not allowed/);
  } finally { runtime.close(); }
});

test("semantic GLM annotations and Jev review are automatically recorded against one decision and observation", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_dual_models", workflowId: "semantic_review", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_dual_models",
      targetId: "target_dual_models",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      visualEvidence: {
        evidenceId: "obs_dual_models",
        targetId: "target_dual_models",
        documentGeneration: 1,
        viewport: { width: 780, height: 437 },
        screenshotBase64: visualFixtureBase64
      },
      candidates: [{ identity: "candidate_prompt", tag: "textarea", role: "textbox", name: "Task prompt", contextName: "Cloud Agent", visible: true, disabled: false }]
    };
    let modelInput;
    const semanticAnalyzer = new SemanticPageAnalyzer({
      eventStore: store,
      includePageLabels: true,
      provider: {
        model: "GLM5.3-flash",
        async decide(messages) {
          modelInput = JSON.parse(messages[1].content);
          return {
            decision: { observationId: observation.evidenceId, annotations: [{ semanticRole: "task_prompt", candidateRef: "candidate_prompt", resultCode: "mapped", confidence: 0.96 }] },
            usage: { prompt_tokens: 120, completion_tokens: 14, prompt_tokens_details: { cached_tokens: 18 } }
          };
        }
      }
    });
    const jev = new DecisionCoordinator({
      eventStore: store,
      client: {
        allowImages: true,
        async decide({ state }) {
          assert.equal(state.semantic_annotation.role, "task_prompt");
          assert.equal(state.task_purpose_code, "create_agent_job");
          assert.equal("label" in state.proposed_control, false);
          return {
            model: "typesafe/jev-1.14",
            answers: {
              intent_alignment: { type: "noul", probabilityYes: 0.91 },
              target_clarity: { type: "choice", choice: "clear", probabilities: { clear: 0.9, ambiguous: 0.08, insufficient: 0.02 } }
            },
            usage: { inputTokens: 200, outputTokens: 20 }
          };
        }
      }
    });
    const result = await jev.mapAndReviewBeforeAction({
      semanticAnalyzer, episodeId: episode.episodeId, runId: episode.runId, stepId: "submit_task",
      observation, requestedRoles: ["task_prompt"], operation: "fill", operationClass: "test_owned_mutation",
      targetRole: "task_prompt", purposeCode: "create_agent_job", candidate: observation.candidates[0]
    });
    assert.equal(result.authorizesOperation, false);
    assert.equal(result.semantic.model, "glm-5.3-flash");
    assert.equal(result.jev.reviewer.model, "typesafe/jev-1.14");
    assert.equal(modelInput.candidates[0].label, "Task prompt");
    const events = store.getEvents(episode.episodeId).filter(event => ["semantic.annotated", "decision.predicted"].includes(event.eventType));
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.decisionId === result.decisionId && event.observationId === observation.evidenceId));
    assert.equal(events[0].payload.analyzerProvider, "freeinference_production");
    assert.equal(events[0].payload.analyzerModel, "glm-5.3-flash");
    assert.equal(events[0].payload.usage.inputTokens, 120);
    assert.equal(events[0].payload.usage.cachedInputTokens, 18);
    assert.ok(events.every(event => /^[a-f0-9]{64}$/.test(event.payload.inputFingerprint)));
    assert.equal(JSON.stringify(events).includes("Task prompt"), false);
  } finally { store.close(); }
});

test("semantic and Jev failures are recorded by failure class without response or error text", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_model_failure", workflowId: "failure_review", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_model_failure",
      targetId: "target_model_failure",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      visualEvidence: {
        evidenceId: "obs_model_failure",
        targetId: "target_model_failure",
        documentGeneration: 1,
        viewport: { width: 780, height: 437 },
        screenshotBase64: visualFixtureBase64
      },
      candidates: [{ identity: "candidate_input", tag: "textarea", role: "textbox", name: "Task prompt", visible: true, disabled: false }]
    };
    const semanticAnalyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async decide() { throw Object.assign(new Error("secret response body"), { kind: "transport" }); } }
    });
    let jevCalls = 0;
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: { allowImages: true, async decide() {
        jevCalls++;
        return {
          model: "typesafe/jev-1.14",
          answers: {
            intent_alignment: { type: "noul", probabilityYes: 0.8 },
            target_clarity: { type: "choice", choice: "clear", probabilities: { clear: 0.8, ambiguous: 0.1, insufficient: 0.1 } }
          }
        };
      } }
    });
    const combined = await coordinator.mapAndReviewBeforeAction({
      semanticAnalyzer, episodeId: episode.episodeId, runId: episode.runId, stepId: "failure_step",
      observation, requestedRoles: ["task_prompt"], operation: "fill", operationClass: "test_owned_mutation", targetRole: "task_prompt", purposeCode: "create_agent_job"
    });
    assert.equal(combined.semanticFailureCode, "transport");
    assert.equal(jevCalls, 1, "Jev still reviews after a semantic provider failure");
    const unavailableJev = new DecisionCoordinator({
      eventStore: store,
      client: { allowImages: true, async decide() { throw new Error("private endpoint detail"); } }
    });
    await assert.rejects(unavailableJev.reviewBeforeAction({
      episodeId: episode.episodeId, runId: episode.runId, stepId: "failure_step",
      observation, operation: "click", operationClass: "unknown", targetRole: "submit_button", purposeCode: "submit_report", candidate: { identity: "candidate_submit", role: "button", visible: true }
    }), /Jev review failed \(unknown\)/);
    const events = store.getEvents(episode.episodeId);
    const failures = events.filter(event => ["semantic.failed", "decision.failed"].includes(event.eventType));
    assert.equal(failures.length, 3);
    assert.ok(failures.every(event => event.payload.failureCode !== ""));
    assert.equal(JSON.stringify(failures).includes("secret response body"), false);
    assert.equal(JSON.stringify(failures).includes("private endpoint detail"), false);
  } finally { store.close(); }
});

test("semantic requests omit accessible page labels unless that feature is explicitly enabled", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_label_opt_in", workflowId: "label_privacy", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_label_opt_in",
      candidates: [{ identity: "candidate_1", tag: "button", role: "button", name: "Private account label", contextName: "Private page heading", visible: true }]
    };
    let request;
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async decide(messages) {
        request = JSON.parse(messages[1].content);
        return { decision: { observationId: observation.evidenceId, annotations: [{ semanticRole: "submit_button", candidateRef: "candidate_1", resultCode: "mapped", confidence: 0.8 }] } };
      } }
    });
    await analyzer.analyzePage({
      observation, requestedRoles: ["submit_button"], episodeId: episode.episodeId, runId: episode.runId,
      stepId: "label_step", decisionId: "label_decision", includePageLabels: true
    });
    assert.equal(request.candidates[0].label, "");
    assert.equal(request.candidates[0].context, "");
    assert.equal(JSON.stringify(store.getEvents(episode.episodeId)).includes("Private account label"), false);
    const route = store.getEvents(episode.episodeId).find(event => event.eventType === "inference.route_selected");
    assert.equal(route.payload.providers.includes("secondary"), true);
    assert.equal(route.payload.inputModality, "text_only");
  } finally { store.close(); }
});

test("secondary semantic inference receives the observation-bound semantic page context while telemetry retains no page values", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_semantic_page_context", workflowId: "semantic_page_context", applicationId: "public_catalog", environmentClass: "unknown" });
    const observation = {
      evidenceId: "obs_semantic_page_context",
      targetId: "target_semantic_page_context",
      documentGeneration: 3,
      candidates: [{
        identity: "candidate_details",
        tag: "a",
        role: "link",
        name: "View product details",
        contextName: "RTX A4000",
        visible: true,
        disabled: false
      }],
      semanticPage: {
        schemaVersion: 3,
        evidence: { observationId: "obs_semantic_page_context", targetId: "target_semantic_page_context", documentGeneration: 3 },
        page: { pageType: { value: "repeated_content", status: "inferred" } },
        regions: [{ ref: "region_main", kind: "main", label: { value: "Products", status: "observed" } }],
        collections: [{
          ref: "collection_product",
          kind: "microdata_product",
          visibleCount: 2,
          fields: [
            { name: "name", semanticRole: "name", semanticRoleStatus: "observed", label: { value: "name", status: "observed" }, status: "observed" },
            { name: "price", semanticRole: "price", semanticRoleStatus: "observed", label: { value: "price", status: "observed" }, status: "observed" }
          ],
          items: [{
            ref: "record_rtx",
            ordinal: 1,
            fields: [
              { name: "name", semanticRole: "name", semanticRoleStatus: "observed", label: { value: "name", status: "observed" }, value: "RTX A4000", status: "observed" },
              { name: "price", semanticRole: "price", semanticRoleStatus: "observed", label: { value: "price", status: "observed" }, value: "$450", status: "observed" }
            ],
            controlRefs: ["candidate_details"]
          }]
        }],
        controls: [{
          targetRef: "candidate_details",
          regionRef: "region_main",
          collectionRef: "collection_product",
          recordRef: "record_rtx",
          interaction: { mechanic: "follow_link", readiness: "visible_enabled" }
        }]
      }
    };
    const modelRequests = [];
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      includePageLabels: true,
      provider: { async decide(messages) {
        const input = JSON.parse(messages[1].content);
        modelRequests.push(input);
        return { decision: { observationId: observation.evidenceId, annotations: [{
          semanticRole: "product_details_link", candidateRef: "candidate_details", resultCode: "mapped", confidence: 0.91
        }] } };
      } }
    });
    const base = {
      observation,
      requestedRoles: ["product_details_link"],
      intentHints: ["product", "details"],
      episodeId: episode.episodeId,
      runId: episode.runId
    };
    await analyzer.analyzePage({ ...base, stepId: "labels_withheld", decisionId: "labels_withheld", includePageLabels: false });
    const withheld = modelRequests[0].candidates[0].semanticContext;
    assert.equal(withheld.collectionKind, "microdata_product");
    assert.equal(withheld.recordFields.find(field => field.semanticRole === "price").value, "");
    assert.equal(withheld.effect, "unknown");

    await analyzer.analyzePage({ ...base, stepId: "labels_allowed", decisionId: "labels_allowed", includePageLabels: true });
    const disclosed = modelRequests[1].candidates[0].semanticContext;
    assert.equal(disclosed.recordFields.find(field => field.semanticRole === "name").value, "RTX A4000");
    assert.equal(disclosed.recordFields.find(field => field.semanticRole === "price").value, "$450");

    const inputs = store.getEvents(episode.episodeId).filter(event => event.eventType === "semantic.input_captured");
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every(event => !JSON.stringify(event.payload.inputProjection).includes("RTX A4000")));
    assert.ok(inputs.every(event => !JSON.stringify(event.payload.inputProjection).includes("$450")));
    assert.equal(inputs[1].payload.inputProjection.candidates[0].semanticContext.recordFields[0].value, "");
  } finally { store.close(); }
});

test("semantic response schema is scoped to requested roles and a single answer per role", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_role_scoped_schema", workflowId: "semantic_schema", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_role_scoped_schema",
      candidates: [{ identity: "candidate_primary", tag: "button", role: "button", visible: true, disabled: false }]
    };
    let request;
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async requestStructured(value) {
        request = value;
        return { result: { observationId: observation.evidenceId, annotations: [{ semanticRole: "primary_action", candidateRef: "candidate_primary", resultCode: "mapped", confidence: 0.9 }] } };
      } }
    });

    const result = await analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "schema_step",
      decisionId: "schema_decision"
    });

    assert.equal(result.annotations[0].resultCode, "mapped");
    assert.equal(request.schema.properties.annotations.maxItems, 1);
    assert.deepEqual(request.schema.properties.annotations.items.properties.semanticRole.enum, ["primary_action"]);
    assert.match(request.instructions, /at most one annotation per requested semantic role/u);
  } finally { store.close(); }
});

test("semantic mapping rejects candidate-by-candidate duplicate role output", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_duplicate_role_output", workflowId: "semantic_schema", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_duplicate_role_output",
      candidates: [
        { identity: "candidate_first", tag: "button", role: "button", visible: true, disabled: false },
        { identity: "candidate_second", tag: "a", role: "link", visible: true, disabled: false }
      ]
    };
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async requestStructured() {
        return { result: { observationId: observation.evidenceId, annotations: [
          { semanticRole: "primary_action", candidateRef: "candidate_first", resultCode: "mapped", confidence: 0.9 },
          { semanticRole: "primary_action", candidateRef: "candidate_second", resultCode: "mapped", confidence: 0.8 }
        ] }, clientRequestId: "53c2113c-ca2e-4868-9950-0191b15bba15", providerLatencyMs: 21 };
      } }
    });

    await assert.rejects(analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "duplicate_step",
      decisionId: "duplicate_decision"
    }), error => error.kind === "schema");
    const failure = store.getEvents(episode.episodeId).find(event => event.eventType === "semantic.failed");
    assert.equal(failure.payload.failureCode, "schema");
    assert.equal(failure.payload.clientRequestId, "53c2113c-ca2e-4868-9950-0191b15bba15");
    assert.equal(failure.payload.providerLatencyMs, 21);
  } finally { store.close(); }
});

test("semantic provider failures retain bounded proxy correlation without error text", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_semantic_proxy_failure", workflowId: "semantic_failure", applicationId: "public_site", environmentClass: "production" });
    const observation = {
      evidenceId: "obs_semantic_proxy_failure",
      targetId: "target_semantic_proxy_failure",
      documentGeneration: 1,
      candidates: [{ identity: "candidate_primary", tag: "button", role: "button", visible: true, disabled: false }]
    };
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async requestStructured() {
        throw Object.assign(new Error("private gateway response body and bearer token"), {
          kind: "transport",
          clientRequestId: "53c2113c-ca2e-4868-9950-0191b15bba15",
          providerLatencyMs: 25_001,
          transportCode: "upstream_server_error",
          httpStatus: 503
        });
      } }
    });

    await assert.rejects(analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "semantic_proxy_failure",
      decisionId: "semantic_proxy_failure_decision"
    }), error => error.kind === "transport"
      && error.clientRequestId === "53c2113c-ca2e-4868-9950-0191b15bba15"
      && error.httpStatus === 503);

    const failure = store.getEvents(episode.episodeId).find(event => event.eventType === "semantic.failed");
    assert.equal(failure.payload.failureCode, "transport");
    assert.equal(failure.payload.clientRequestId, "53c2113c-ca2e-4868-9950-0191b15bba15");
    assert.equal(failure.payload.providerLatencyMs, 25_001);
    assert.equal(failure.payload.transportCode, "upstream_server_error");
    assert.equal(failure.payload.httpStatus, 503);
    assert.equal(JSON.stringify(failure).includes("private gateway response body"), false);
    assert.equal(JSON.stringify(failure).includes("bearer token"), false);
  } finally { store.close(); }
});

test("semantic size failures keep their typed failure code", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_semantic_size_failure", workflowId: "semantic_failure", applicationId: "public_site", environmentClass: "production" });
    const observation = {
      evidenceId: "obs_semantic_size_failure",
      candidates: [{ identity: "candidate_primary", tag: "button", role: "button", visible: true, disabled: false }]
    };
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async requestStructured() {
        throw Object.assign(new Error("bounded error text must not be recorded"), { kind: "size" });
      } }
    });

    await assert.rejects(analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "semantic_size_failure",
      decisionId: "semantic_size_failure_decision"
    }), error => error.kind === "size");

    const failure = store.getEvents(episode.episodeId).find(event => event.eventType === "semantic.failed");
    assert.equal(failure.payload.failureCode, "size");
    assert.equal(JSON.stringify(failure).includes("bounded error text"), false);
  } finally { store.close(); }
});

test("semantic mapping abstains when structurally identical candidates lack authorized distinguishing evidence", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_semantic_insufficient", workflowId: "semantic_insufficient", applicationId: "fixture_app", environmentClass: "local" });
    let calls = 0;
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async decide() { calls++; throw new Error("insufficient evidence must be resolved locally"); } }
    });
    const observation = {
      evidenceId: "obs_semantic_insufficient",
      candidates: [
        { identity: "first", tag: "button", role: "button", name: "Save profile", visible: true, disabled: false },
        { identity: "second", tag: "button", role: "button", name: "Save changes", visible: true, disabled: false }
      ]
    };
    const result = await analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "semantic_insufficient",
      decisionId: "semantic_insufficient_decision"
    });
    assert.equal(calls, 0);
    assert.equal(result.status, "skipped");
    assert.equal(result.reasonCode, "insufficient_distinguishing_evidence");
    assert.equal(result.annotations[0].resultCode, "ambiguous");
    const input = store.getEvents(episode.episodeId).find(event => event.eventType === "semantic.input_captured");
    assert.equal(input.payload.inputProjection.candidateCoverage.disposition, "complete");
    assert.equal(input.payload.inputProjection.candidates.every(candidate => candidate.label === ""), true);
    assert.equal(JSON.stringify(input).includes("Save profile"), false);
    assert.ok(store.getEvents(episode.episodeId).some(event => event.eventType === "decision.skipped" && event.payload.reasonCode === "insufficient_distinguishing_evidence"));
  } finally { store.close(); }
});

test("semantic image inference receives only a screenshot bound to the exact observation", async () => {
  const store = createStore();
  try {
    const episode = store.startEpisode({ runId: "run_semantic_image", workflowId: "semantic_image", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_semantic_image",
      targetId: "target_semantic_image",
      documentGeneration: 2,
      viewport: { width: 800, height: 600 },
      visualEvidence: {
        evidenceId: "obs_semantic_image",
        targetId: "target_semantic_image",
        documentGeneration: 2,
        viewport: { width: 800, height: 600 },
        screenshotBase64: visualFixtureBase64
      },
      candidates: [{ identity: "candidate_primary", tag: "button", role: "button", visible: true, disabled: false }]
    };
    let request;
    const analyzer = new SemanticPageAnalyzer({
      eventStore: store,
      allowScreenshots: true,
      provider: {
        model: "GLM5.3-flash",
        capabilities: { imageInput: true },
        async requestStructured(input) {
          request = input;
          return { result: { observationId: observation.evidenceId, annotations: [{ semanticRole: "primary_action", candidateRef: "candidate_primary", resultCode: "mapped", confidence: 0.9 }] } };
        }
      }
    });
    const result = await analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "visual_semantic",
      decisionId: "visual_semantic_decision",
      useVisualEvidence: true
    });
    assert.equal(analyzer.allowScreenshots, true);
    assert.equal(analyzer.requiresScreenshot, false);
    assert.equal(request.imageEvidence, observation.visualEvidence);
    assert.equal(result.annotations[0].candidateRef, "candidate_primary");
    const inputEvent = store.getEvents(episode.episodeId).find(event => event.eventType === "semantic.input_captured");
    const routeEvent = store.getEvents(episode.episodeId).find(event => event.eventType === "inference.route_selected" && event.decisionId === "visual_semantic_decision");
    const visualProjection = inputEvent.payload.inputProjection.visualEvidence;
    assert.equal(routeEvent.payload.inputModality, "text_plus_visual");
    assert.equal(visualProjection.transform.version, "jev_image_preparation_v1");
    assert.equal(visualProjection.transform.sourceWidth, observation.viewport.width);
    assert.equal(visualProjection.transform.imageWidth, 780);
    assert.equal(visualProjection.transform.crop.x, 0);
    assert.equal(JSON.stringify(inputEvent).includes(visualFixtureBase64), false);
    await analyzer.analyzePage({
      observation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "structural_semantic",
      decisionId: "structural_semantic_decision"
    });
    assert.equal(request.imageEvidence, undefined, "screenshot capability does not force images into structural semantic requests");
    const structuralInput = store.getEvents(episode.episodeId).find(event => event.decisionId === "structural_semantic_decision" && event.eventType === "semantic.input_captured");
    const structuralRoute = store.getEvents(episode.episodeId).find(event => event.eventType === "inference.route_selected" && event.decisionId === "structural_semantic_decision");
    assert.equal(Object.hasOwn(structuralInput.payload.inputProjection, "visualEvidence"), false);
    assert.equal(structuralRoute.payload.inputModality, "text_only");
    const changedObservation = { ...observation, evidenceId: "obs_replaced" };
    await assert.rejects(analyzer.analyzePage({
      observation: changedObservation,
      requestedRoles: ["primary_action"],
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "visual_semantic_changed",
      decisionId: "visual_semantic_changed_decision",
      useVisualEvidence: true
    }), error => error.kind === "privacy");
  } finally { store.close(); }
});
