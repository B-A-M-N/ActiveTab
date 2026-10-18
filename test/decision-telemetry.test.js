import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
    eventType: "verification.completed", payload: { status: "verified_pass", oracleType: "correlated_backend", reasonCode: "exact_run_match", evidenceRefs: [`backend_${applicationId}`] }
  });
  const labeler = new TrainingLabeler({ store, authenticateApprover: async reviewerId => reviewerId === "local_reviewer_1" });
  const proposed = labeler.propose({ episodeId: episode.episodeId, runId, stepId: "submit_task", decisionId, rubricId: "intent_alignment", labelCode: "yes", sourceClass: "correlated_backend", evidenceRefs: [`backend_${applicationId}`] });
  return { ...episode, decisionId, labelEventId: proposed.eventId, labeler };
}

test("decision event log is private, ordered, append-only, and hash-verifiable", async () => {
  const root = mkdtempSync(join(tmpdir(), "active-tab-telemetry-"));
  const path = join(root, "private", "events.sqlite");
  const store = new DecisionEventStore({ databasePath: path });
  try {
    const item = fixture(store);
    await item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId, reviewerId: "local_reviewer_1" });
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

test("telemetry rejects unstructured content by schema shape, without scanning text", () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const train = fixture(store, { applicationId: "fixture_app" });
    const holdout = fixture(store, { applicationId: "fixture_cloud_agent" });
    for (const item of [train, holdout]) await item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: item.labelEventId, reviewerId: "local_reviewer_1" });
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const item = fixture(store);
    const proposed = item.labeler.propose({ episodeId: item.episodeId, runId: item.runId, decisionId: item.decisionId, rubricId: "intent_alignment", labelCode: "yes", sourceClass: "jev_self", evidenceRefs: ["jev_answer"] });
    await assert.rejects(item.labeler.approve({ episodeId: item.episodeId, runId: item.runId, labelEventId: proposed.eventId, reviewerId: "local_reviewer_1" }), /cannot become training ground truth/);
    const before = store.getEvents(item.episodeId).length;
    assert.equal(buildTrainingDataset(store, { split: { kind: "workflow", holdout: ["smoke_workflow"] } }).eligibleExampleCount, 0);
    assert.equal(store.getEvents(item.episodeId).length, before);
  } finally { store.close(); }
});

test("semantic annotations and Jev predictions remain distinct but share the same evidence timeline", () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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
    assert.equal(input.payload.inputKind, "outcome_review");
    assert.equal(input.payload.inputProjection.state.backend_outcome, "succeeded");
    assert.equal(predictions.length, 2);
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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

test("semantic GLM annotations and Jev review are automatically recorded against one decision and observation", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_dual_models", workflowId: "semantic_review", applicationId: "fixture_app", environmentClass: "local" });
    const observation = {
      evidenceId: "obs_dual_models",
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
        async decide({ state }) {
          assert.equal(state.semantic_annotation.role, "task_prompt");
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
      targetRole: "task_prompt", candidate: observation.candidates[0]
    });
    assert.equal(result.authorizesOperation, false);
    assert.equal(result.semantic.model, "GLM5.3-flash");
    assert.equal(result.jev.reviewer.model, "typesafe/jev-1.14");
    assert.equal(modelInput.candidates[0].label, "Task prompt");
    const events = store.getEvents(episode.episodeId).filter(event => ["semantic.annotated", "decision.predicted"].includes(event.eventType));
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.decisionId === result.decisionId && event.observationId === observation.evidenceId));
    assert.equal(events[0].payload.analyzerProvider, "freeinference_production");
    assert.equal(events[0].payload.analyzerModel, "GLM5.3-flash");
    assert.equal(events[0].payload.usage.inputTokens, 120);
    assert.equal(events[0].payload.usage.cachedInputTokens, 18);
    assert.ok(events.every(event => /^[a-f0-9]{64}$/.test(event.payload.inputFingerprint)));
    assert.equal(JSON.stringify(events).includes("Task prompt"), false);
  } finally { store.close(); }
});

test("semantic and Jev failures are recorded by failure class without response or error text", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_model_failure", workflowId: "failure_review", applicationId: "fixture_app", environmentClass: "local" });
    const observation = { evidenceId: "obs_model_failure", candidates: [] };
    const semanticAnalyzer = new SemanticPageAnalyzer({
      eventStore: store,
      provider: { async decide() { throw Object.assign(new Error("secret response body"), { kind: "transport" }); } }
    });
    let jevCalls = 0;
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: { async decide() {
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
      observation, requestedRoles: ["task_prompt"], operation: "fill", operationClass: "test_owned_mutation", targetRole: "task_prompt"
    });
    assert.equal(combined.semanticFailureCode, "transport");
    assert.equal(jevCalls, 1, "Jev still reviews after a semantic provider failure");
    const unavailableJev = new DecisionCoordinator({
      eventStore: store,
      client: { async decide() { throw new Error("private endpoint detail"); } }
    });
    await assert.rejects(unavailableJev.reviewBeforeAction({
      episodeId: episode.episodeId, runId: episode.runId, stepId: "failure_step",
      observation, operation: "click", operationClass: "unknown", targetRole: "submit_button", candidate: { identity: "candidate_submit", role: "button", visible: true }
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
  const store = new DecisionEventStore({ databasePath: ":memory:" });
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
      stepId: "label_step", decisionId: "label_decision"
    });
    assert.equal(request.candidates[0].label, "");
    assert.equal(request.candidates[0].context, "");
    assert.equal(JSON.stringify(store.getEvents(episode.episodeId)).includes("Private account label"), false);
  } finally { store.close(); }
});
