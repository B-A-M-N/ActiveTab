import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "../telemetry/decisionEvents.js";
import { isSha256Digest, normalizeObservedRole, normalizeObservedTag } from "../telemetry/privacy.js";
import { isPinnedJevModel, JEV_MODEL_ID } from "./jevClient.js";
import { hasReviewIntent, selectVisualAssessmentRoute } from "./callPolicy.js";
import { isBoundVisualEvidence, visualEvidenceProjection } from "../navigation/visualEvidence.js";
import { isValidWorkflowReviewBinding, WORKFLOW_REVIEW_POLICY_VERSION } from "../navigation/workflowReviewBinding.js";
import {
  INTENT_ALIGNMENT_QUESTION, TARGET_CLARITY_QUESTION, EVIDENCE_SUPPORT_QUESTION, OUTCOME_ANOMALY_QUESTION,
  WORKFLOW_PLAN_QUESTIONS, VISUAL_PAGE_QUESTIONS, VISUAL_OBSTRUCTION_QUESTIONS, VISUAL_OUTCOME_QUESTIONS,
  VISUAL_TARGET_GROUNDING_QUESTIONS, RUBRIC_VERSION, VISUAL_RUBRIC_VERSION, VISUAL_GROUNDING_RUBRIC_VERSION
} from "./rubrics.js";

const REVIEW_THRESHOLD = 0.8;
const STRUCTURAL_CODE_CHARACTERS = new Set("abcdefghijklmnopqrstuvwxyz0123456789_:-");

function structuralCode(value, fallback = "unknown", maxLength = 96) {
  if (typeof value !== "string") return fallback;
  const code = value.trim().toLowerCase();
  if (code.length === 0 || code.length > maxLength) return fallback;
  const first = code.charCodeAt(0);
  if (!((first >= 97 && first <= 122) || (first >= 48 && first <= 57))) return fallback;
  for (const character of code) if (!STRUCTURAL_CODE_CHARACTERS.has(character)) return fallback;
  return code;
}

function structuralCandidate(candidate) {
  return {
    candidate_ref: String(candidate?.identity ?? "candidate_unknown").slice(0, 96),
    role: normalizeObservedRole(candidate?.role ?? candidate?.tag),
    tag: normalizeObservedTag(candidate?.tag),
    visible: candidate?.visible === true,
    disabled: candidate?.disabled === true
  };
}

function inputFingerprint(value) {
  // Salt each call so event fingerprints cannot be used to guess small,
  // sensitive evidence vocabularies from the local database alone.
  return createHash("sha256").update(randomBytes(32)).update(canonicalJson(value)).digest("hex");
}

function rubricFingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function projectQuestions(questions) {
  return Object.entries(questions).map(([id, question]) => ({
    id,
    type: question.type,
    instructions: question.instructions,
    ...(question.criteria !== undefined ? { criteria: question.criteria } : {})
  }));
}

function visualSnapshot(observation) {
  const candidates = Array.isArray(observation?.candidates) ? observation.candidates : [];
  const candidateCount = Math.min(10_000, Math.max(candidates.length, Number.isInteger(observation?.candidateCount) ? observation.candidateCount : 0));
  const visibleCandidates = candidates.filter(candidate => candidate?.visible === true).length;
  const dialogCount = candidates.filter(candidate => candidate?.visible === true
    && ["dialog", "alertdialog"].includes(normalizeObservedRole(candidate?.role))).length;
  const readyState = ["loading", "interactive", "complete"].includes(observation?.page?.readyState)
    ? observation.page.readyState : "unknown";
  return {
    document_generation: Number.isSafeInteger(observation?.documentGeneration) ? observation.documentGeneration : 0,
    candidate_count: candidateCount,
    visible_candidate_count: Math.min(candidateCount, visibleCandidates),
    dialog_count: Math.min(candidateCount, dialogCount),
    ready_state: readyState
  };
}

function jevFailureCode(error) {
  return ["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted"].includes(error?.kind) ? error.kind : "unknown";
}

function recordJevFailure(eventStore, { episodeId, runId, stepId, decisionId, observationId, questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds = [], error }) {
  const failureCode = jevFailureCode(error);
  for (const [rubricId, question] of Object.entries(questions)) {
    eventStore.append({
      episodeId, runId, stepId, decisionId, observationId,
      eventType: "decision.failed", trainingEligibility: "pending",
      payload: { provider: "openrouter", model: "typesafe/jev-1.14", rubricId, rubricVersion: RUBRIC_VERSION, rubricHash, questionType: question.type, failureCode, inputFingerprint: requestFingerprint, inputEventIds }
    });
  }
}

function recordDecisionContext(eventStore, { episodeId, runId, stepId, decisionId, observation, operation, operationClass, targetRole, expectedOutcomeClass }) {
  const events = eventStore.getEvents(episodeId);
  let observationEvent = events.find(event => event.eventType === "observation.captured" && event.observationId === observation.evidenceId);
  if (!observationEvent) {
    const candidates = observation.candidates ?? [];
    const candidateRoles = [...new Set(candidates.map(candidate => normalizeObservedRole(candidate.role ?? candidate.tag)))].slice(0, 64);
    observationEvent = eventStore.append({
      episodeId, runId, stepId, observationId: observation.evidenceId,
      eventType: "observation.captured", trainingEligibility: "pending",
      payload: {
        surfaceClass: "browser_surface",
        candidateCount: Math.min(candidates.length, 10_000),
        visibleCount: Math.min(candidates.filter(candidate => candidate.visible === true).length, 10_000),
        candidateRoles,
        evidenceRefs: [observation.evidenceId]
      }
    });
  }
  const intentEvent = eventStore.append({
    episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
    eventType: "intent.proposed", trainingEligibility: "pending",
    payload: {
      operation: structuralCode(operation),
      operationClass: operationClass ?? "unknown",
      targetRole: structuralCode(targetRole),
      expectedOutcomeClass: structuralCode(expectedOutcomeClass, "operation_complete")
    }
  });
  return [observationEvent.eventId, intentEvent.eventId];
}

function mapProbability(answer, label) {
  return answer?.type === "choice" && Number.isFinite(answer.probabilities?.[label]) ? answer.probabilities[label] : 0;
}

function recordProviderRouteIfMissing(eventStore, {
  episodeId, runId, stepId, decisionId, observationId, provider, route, reasonCode, visualEvidenceUsed = false
}) {
  const hasProviderRoute = eventStore.getEvents(episodeId).some(event => event.eventType === "inference.route_selected"
    && event.decisionId === decisionId
    && Array.isArray(event.payload.providers)
    && event.payload.providers.includes(provider));
  if (hasProviderRoute) return null;
  return eventStore.append({
    episodeId, runId, stepId, decisionId, observationId,
    eventType: "inference.route_selected", trainingEligibility: "pending",
    payload: {
      route,
      reasonCode,
      providers: [provider],
      visualEvidenceUsed,
      inputModality: visualEvidenceUsed ? "text_plus_visual" : "text_only"
    }
  });
}

export class DecisionCoordinator {
  constructor({ client, eventStore, thresholds = {} } = {}) {
    if (!client || typeof client.decide !== "function") throw new Error("DecisionCoordinator requires the core Jev decision client.");
    if (!eventStore) throw new Error("DecisionCoordinator requires the durable decision event store.");
    this.client = client;
    this.eventStore = eventStore;
    this.thresholds = { ...thresholds, intentAlignment: thresholds.intentAlignment ?? REVIEW_THRESHOLD, targetClarity: thresholds.targetClarity ?? REVIEW_THRESHOLD, evidenceSupport: thresholds.evidenceSupport ?? REVIEW_THRESHOLD };
  }

  recordReviewSkipped({ episodeId, runId, stepId, decisionId = randomUUID(), observation, operation, operationClass = "unknown", targetRole = "unknown", expectedOutcomeClass = "operation_complete", reasonCode = "policy_boundary_not_triggered" } = {}) {
    if (!episodeId || !runId || !stepId || !observation?.evidenceId) throw new Error("Recording a skipped Jev review requires stable episode, run, step, and observation identities.");
    const inputEventIds = recordDecisionContext(this.eventStore, { episodeId, runId, stepId, decisionId, observation, operation, operationClass, targetRole, expectedOutcomeClass });
    const event = this.eventStore.append({
      episodeId,
      runId,
      stepId,
      decisionId,
      observationId: observation.evidenceId,
      parentEventId: inputEventIds.at(-1),
      eventType: "decision.skipped",
      trainingEligibility: "pending",
      payload: { reasonCode, inputEventIds }
    });
    return { decisionId, inputEventIds, eventId: event.eventId };
  }

  async reviewBeforeAction({ episodeId, runId, stepId, decisionId = randomUUID(), observation, operation, operationClass = "unknown", targetRole = "unknown", purposeCode = null, expectedOutcomeClass = "operation_complete", candidate, semanticAnnotation = null, semanticEventIds = [], inputEventIds = null, recordContext = true, signal } = {}) {
    if (!episodeId || !runId || !stepId || !observation?.evidenceId) throw new Error("Jev pre-action review requires episode, run, step, and fresh observation identities.");
    const candidateImage = this.client.allowImages === true ? observation.visualEvidence ?? null : null;
    const imageEvidence = isBoundVisualEvidence(observation, candidateImage) ? candidateImage : null;
    const reviewIntentAvailable = hasReviewIntent({ targetRole, purposeCode });
    if (!imageEvidence || !reviewIntentAvailable) {
      const skipped = this.recordReviewSkipped({
        episodeId, runId, stepId, decisionId, observation, operation, operationClass, targetRole,
        expectedOutcomeClass, reasonCode: "review_insufficient_evidence"
      });
      return {
        decisionId,
        status: "insufficient_evidence",
        disposition: "insufficient_evidence",
        evidenceStatus: "insufficient_evidence",
        reasonCode: "review_insufficient_evidence",
        skipEventId: skipped.eventId,
        authorizesOperation: false
      };
    }
    let actualInputEventIds = inputEventIds ?? (recordContext ? recordDecisionContext(this.eventStore, { episodeId, runId, stepId, decisionId, observation, operation, operationClass, targetRole, expectedOutcomeClass }) : []);
    if (Array.isArray(semanticEventIds) && semanticEventIds.length) {
      actualInputEventIds = [...new Set([...actualInputEventIds, ...semanticEventIds])];
    }
    const target = structuralCandidate(candidate);
    const state = {
      operation_code: structuralCode(operation),
      operation_class: String(operationClass),
      requested_target_role: structuralCode(targetRole),
      ...(hasReviewIntent({ purposeCode }) ? { task_purpose_code: structuralCode(purposeCode) } : {}),
      proposed_control: target,
      page_surface: "observed_browser_surface",
      alternative_count: Math.max(0, Math.min(100, (observation.candidates?.length ?? 0) - 1)),
      ...(semanticAnnotation ? { semantic_annotation: {
        role: String(semanticAnnotation.semanticRole ?? "unknown"),
        result_code: String(semanticAnnotation.resultCode ?? "unknown"),
        confidence: Number.isFinite(semanticAnnotation.confidence) ? semanticAnnotation.confidence : 0
      } } : {})
    };
    const questions = { intent_alignment: INTENT_ALIGNMENT_QUESTION, target_clarity: TARGET_CLARITY_QUESTION };
    const rubricHash = rubricFingerprint(questions);
    const visualProjection = imageEvidence ? visualEvidenceProjection(imageEvidence) : null;
    const requestFingerprint = inputFingerprint({ state, questions, visualEvidence: visualProjection });
    const inputEvent = this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
      ...(actualInputEventIds.length ? { parentEventId: actualInputEventIds.at(-1) } : {}),
      eventType: "decision.input_captured", trainingEligibility: "pending",
      payload: {
        inputKind: "pre_action_review",
        inputProjection: { state, questions: projectQuestions(questions), ...(visualProjection ? { visualEvidence: visualProjection } : {}) },
        rubricIds: Object.keys(questions),
        rubricVersion: RUBRIC_VERSION,
        rubricHash,
        inputFingerprint: requestFingerprint,
        inputModality: visualProjection ? "text_plus_visual" : "text_only"
      }
    });
    actualInputEventIds = [...actualInputEventIds, inputEvent.eventId];
    let response;
    try {
      recordProviderRouteIfMissing(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        provider: "jev", route: "jev_only", reasonCode: "direct_decision_review",
        visualEvidenceUsed: Boolean(visualProjection)
      });
      response = await this.client.decide({ reviewKind: "pre_action_review", state, questions, ...(imageEvidence ? { imageEvidence } : {}), signal });
    } catch (error) {
      recordJevFailure(this.eventStore, { episodeId, runId, stepId, decisionId, observationId: observation.evidenceId, questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: actualInputEventIds, error });
      const failureCode = jevFailureCode(error);
      throw Object.assign(new Error(`Jev review failed (${failureCode}).`), { kind: failureCode });
    }
    if (!isPinnedJevModel(response.model)) {
      const error = Object.assign(new Error("Jev returned a model other than the pinned 1.14 model."), { kind: "schema" });
      recordJevFailure(this.eventStore, { episodeId, runId, stepId, decisionId, observationId: observation.evidenceId, questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: actualInputEventIds, error });
      throw error;
    }
    const alignmentProbability = response.answers.intent_alignment?.probabilityYes ?? 0;
    const clarityProbability = mapProbability(response.answers.target_clarity, "clear");
    const supported = alignmentProbability >= this.thresholds.intentAlignment && clarityProbability >= this.thresholds.targetClarity;
    const reviewDisposition = supported ? "supported" : "needs_agent_review";
    const created = [];
    for (const [rubricId, answer] of Object.entries(response.answers)) {
      created.push(this.eventStore.append({
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        eventType: "decision.predicted", trainingEligibility: "pending",
        payload: {
          provider: "openrouter", model: response.model, modelSnapshot: response.modelSnapshot ?? response.model, rubricId, rubricVersion: RUBRIC_VERSION, rubricHash,
          questionType: answer.type, answer,
          reviewDisposition,
          inputFingerprint: requestFingerprint,
          inputEventIds: actualInputEventIds,
          ...(response.usage ? { usage: response.usage } : {})
        }
      }));
    }
    return {
      decisionId,
      reviewer: { provider: "openrouter", model: response.model, rubricVersion: RUBRIC_VERSION },
      answers: response.answers,
      eventIds: created.map(event => event.eventId),
      disposition: supported ? "supported" : "needs_agent_review",
      authorizesOperation: false
    };
  }

  async reviewOutcome({ episodeId, runId, stepId, decisionId = randomUUID(), observationId, expectedOutcomeClass, browserOutcomeClass, backendOutcomeClass = "unavailable", inputEventIds = [], signal } = {}) {
    if (!episodeId || !runId || !stepId || !observationId) throw new Error("Jev outcome review requires stable episode and evidence identities.");
    const state = {
        expected_outcome: String(expectedOutcomeClass ?? "unknown"),
        browser_outcome: String(browserOutcomeClass ?? "unknown"),
        backend_outcome: String(backendOutcomeClass ?? "unavailable")
      };
    const questions = { evidence_support: EVIDENCE_SUPPORT_QUESTION, outcome_anomaly: OUTCOME_ANOMALY_QUESTION };
    const rubricHash = rubricFingerprint(questions);
    const requestFingerprint = inputFingerprint({ state, questions });
    const inputEvent = this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId,
      ...(inputEventIds.length ? { parentEventId: inputEventIds.at(-1) } : {}),
      eventType: "decision.input_captured", trainingEligibility: "pending",
      payload: {
        inputKind: "outcome_review",
        inputProjection: { state, questions: projectQuestions(questions) },
        rubricIds: Object.keys(questions),
        rubricVersion: RUBRIC_VERSION,
        rubricHash,
        inputFingerprint: requestFingerprint,
        inputModality: "text_only"
      }
    });
    const outcomeInputEventIds = [...inputEventIds, inputEvent.eventId];
    let response;
    try {
      recordProviderRouteIfMissing(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId,
        provider: "jev", route: "jev_only", reasonCode: "outcome_review_requested"
      });
      response = await this.client.decide({ reviewKind: "outcome_review", state, questions, signal });
    } catch (error) {
      recordJevFailure(this.eventStore, { episodeId, runId, stepId, decisionId, observationId, questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: outcomeInputEventIds, error });
      const failureCode = jevFailureCode(error);
      throw Object.assign(new Error(`Jev review failed (${failureCode}).`), { kind: failureCode });
    }
    if (!isPinnedJevModel(response.model)) {
      const error = Object.assign(new Error("Jev returned a model other than the pinned 1.14 model."), { kind: "schema" });
      recordJevFailure(this.eventStore, { episodeId, runId, stepId, decisionId, observationId, questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: outcomeInputEventIds, error });
      throw error;
    }
    const events = [];
    for (const [rubricId, answer] of Object.entries(response.answers)) {
      events.push(this.eventStore.append({
        episodeId, runId, stepId, decisionId, observationId,
        parentEventId: inputEvent.eventId,
        eventType: "decision.predicted", trainingEligibility: "pending",
        payload: { provider: "openrouter", model: response.model, modelSnapshot: response.modelSnapshot ?? response.model, rubricId, rubricVersion: RUBRIC_VERSION, rubricHash, questionType: answer.type, answer, inputFingerprint: requestFingerprint, inputEventIds: outcomeInputEventIds, ...(response.usage ? { usage: response.usage } : {}) }
      }));
    }
    return { decisionId, reviewer: { provider: "openrouter", model: response.model, rubricVersion: RUBRIC_VERSION }, answers: response.answers, inputEventIds: outcomeInputEventIds, eventIds: events.map(event => event.eventId), authorizesOperation: false };
  }

  async reviewVisualAssessment({
    episodeId, runId, stepId, decisionId = randomUUID(), task, observation, beforeObservation = null,
    expectedOutcomeClass = "unknown", targetRoleCode = null, imageEvidence = null, inputEventIds = [], signal
  } = {}) {
    if (!episodeId || !runId || !stepId || !observation?.evidenceId || !observation?.targetId) {
      throw new Error("Jev visual assessment requires stable run identities and a fresh browser observation.");
    }
    const questions = task === "page_classification" ? VISUAL_PAGE_QUESTIONS
      : task === "obstruction_detection" ? VISUAL_OBSTRUCTION_QUESTIONS
        : task === "outcome_assessment" ? VISUAL_OUTCOME_QUESTIONS
          : task === "target_grounding" ? VISUAL_TARGET_GROUNDING_QUESTIONS : null;
    if (!questions) throw new Error("Jev visual assessment task is unsupported.");
    const normalizedTargetRoleCode = task === "target_grounding" ? structuralCode(targetRoleCode, "", 96) : null;
    if (task === "target_grounding" && !normalizedTargetRoleCode) throw new Error("Jev target grounding requires a bounded structural target-role code.");
    if (task === "outcome_assessment" && (!beforeObservation?.evidenceId || beforeObservation.targetId !== observation.targetId)) {
      return { decisionId, status: "unavailable", failureCode: "stale_evidence", authorizesOperation: false };
    }
    const state = {
      task_code: task,
      current: visualSnapshot(observation),
      ...(task === "target_grounding" ? { target_role_code: normalizedTargetRoleCode } : {}),
      ...(task === "outcome_assessment" ? {
        before: visualSnapshot(beforeObservation),
        expected_outcome_code: structuralCode(expectedOutcomeClass)
      } : {})
    };
    const contextEventIds = recordDecisionContext(this.eventStore, {
      episodeId, runId, stepId, decisionId, observation,
      operation: task === "target_grounding" ? "visual_target_grounding" : "visual_assessment",
      operationClass: "read",
      targetRole: task === "target_grounding" ? "visual_target" : "browser_page",
      expectedOutcomeClass: task
    });
    const suppliedImage = imageEvidence ?? observation.visualEvidence ?? null;
    const imageIsBound = this.client.allowImages === true && isBoundVisualEvidence(observation, suppliedImage);
    const boundImage = imageIsBound ? suppliedImage : null;
    const route = selectVisualAssessmentRoute({ imagePermission: this.client.allowImages === true, visualEvidenceBound: Boolean(boundImage), task });
    this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
      eventType: "inference.route_selected", trainingEligibility: "pending",
      payload: { ...route }
    });
    const visualProjection = boundImage ? visualEvidenceProjection(boundImage) : null;
    const rubricVersion = task === "target_grounding" ? VISUAL_GROUNDING_RUBRIC_VERSION : VISUAL_RUBRIC_VERSION;
    const rubricHash = rubricFingerprint({ version: rubricVersion, questions });
    const requestFingerprint = inputFingerprint({ state, questions, visualEvidence: visualProjection });
    const inputEvent = this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
      ...(contextEventIds.length ? { parentEventId: contextEventIds.at(-1) } : {}),
      eventType: "decision.input_captured", trainingEligibility: "pending",
      payload: {
        inputKind: "visual_assessment_review",
        inputProjection: { state, questions: projectQuestions(questions), ...(visualProjection ? { visualEvidence: visualProjection } : {}) },
        rubricIds: Object.keys(questions),
        rubricVersion,
        rubricHash,
        inputFingerprint: requestFingerprint,
        inputModality: visualProjection ? "text_plus_visual" : "text_only"
      }
    });
    const actualInputEventIds = [...contextEventIds, inputEvent.eventId, ...inputEventIds];
    if (!this.client.allowImages || !boundImage) {
      const reasonCode = !this.client.allowImages ? "image_permission_denied" : suppliedImage ? "visual_evidence_stale_or_invalid" : "visual_evidence_unavailable";
      this.eventStore.append({
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        parentEventId: inputEvent.eventId,
        eventType: "decision.skipped", trainingEligibility: "pending",
        payload: { reasonCode, inputEventIds: actualInputEventIds }
      });
      return { decisionId, status: "skipped", failureCode: reasonCode, inputEventIds: actualInputEventIds, authorizesOperation: false };
    }
    let response;
    try {
      response = await this.client.decide({
        reviewKind: "visual_assessment_review", state, questions, imageEvidence: boundImage, signal
      });
    } catch (error) {
      recordJevFailure(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: actualInputEventIds, error
      });
      return { decisionId, status: "unavailable", failureCode: jevFailureCode(error), inputEventIds: actualInputEventIds, authorizesOperation: false };
    }
    if (!isPinnedJevModel(response.model)) {
      const error = Object.assign(new Error("Jev returned a model other than the pinned 1.14 model."), { kind: "schema" });
      recordJevFailure(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        questions, rubricHash, inputFingerprint: requestFingerprint, inputEventIds: actualInputEventIds, error
      });
      return { decisionId, status: "unavailable", failureCode: "schema", inputEventIds: actualInputEventIds, authorizesOperation: false };
    }
    const events = [];
    for (const [rubricId, answer] of Object.entries(response.answers)) {
      events.push(this.eventStore.append({
        episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
        parentEventId: inputEvent.eventId,
        eventType: "decision.predicted", trainingEligibility: "pending",
        payload: {
          provider: "openrouter", model: response.model, modelSnapshot: response.modelSnapshot ?? response.model,
          rubricId, rubricVersion, rubricHash, questionType: answer.type, answer,
          reviewDisposition: "advisory_only", inputFingerprint: requestFingerprint,
          inputEventIds: actualInputEventIds, ...(response.usage ? { usage: response.usage } : {})
        }
      }));
    }
    return {
      decisionId,
      observationId: observation.evidenceId,
      status: "reviewed",
      task,
      reviewer: { provider: "openrouter", model: response.model, rubricVersion },
      answers: response.answers,
      inputEventIds: actualInputEventIds,
      eventIds: events.map(event => event.eventId),
      advisoryOnly: true,
      authorizesOperation: false
    };
  }

  async reviewWorkflowPlan({ episodeId, runId, stepId, decisionId = randomUUID(), observationId, observation = null, planHash, reviewBinding, parentEventId = null, planProjection, imageEvidence = null, signal } = {}) {
    if (!episodeId || !runId || !stepId || !observationId || !Array.isArray(planProjection)
      || planProjection.length < 1 || planProjection.length > 24 || !isSha256Digest(planHash)
      || !isValidWorkflowReviewBinding(reviewBinding)
      || reviewBinding.planHash !== planHash.toLowerCase()
      || reviewBinding.observationId !== observationId
      || !observation || observation.evidenceId !== observationId
      || observation.targetId !== reviewBinding.targetId
      || observation.documentGeneration !== reviewBinding.documentGeneration) {
      throw new Error("Jev workflow review requires stable run identities, an exact plan and observation binding, and a bounded plan projection.");
    }
    const state = {
      plan_version: 1,
      task_outcome_code: reviewBinding.taskOutcomeCode,
      review_binding_hash: reviewBinding.bindingHash,
      step_count: planProjection.length,
      steps: planProjection.map(step => ({
        step_id: step.stepId,
        capability_id: step.capabilityId,
        effect_class: step.effectClass,
        target_role: step.targetRole,
        verification_code: step.verificationCode,
        requires_approval: step.requiresApproval,
        depends_on: step.dependsOn,
        condition: step.condition ? { step_id: step.condition.stepId, status: step.condition.status } : null,
        purpose_codes: step.purposeCodes,
        precondition_codes: step.preconditionCodes,
        postcondition_codes: step.postconditionCodes
      }))
    };
    const questions = WORKFLOW_PLAN_QUESTIONS;
    const rubricHash = rubricFingerprint(questions);
    const boundImageEvidence = this.client.allowImages === true
      && observation?.evidenceId === observationId
      && isBoundVisualEvidence(observation, imageEvidence)
      ? imageEvidence : null;
    const visualProjection = boundImageEvidence ? visualEvidenceProjection(boundImageEvidence) : null;
    const requestFingerprint = inputFingerprint({ state, questions, visualEvidence: visualProjection });
    const inputEvent = this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId,
      ...(parentEventId ? { parentEventId } : {}),
      eventType: "decision.input_captured",
      trainingEligibility: "pending",
      payload: {
        inputKind: "workflow_plan_review",
        inputProjection: { state, questions: projectQuestions(questions), ...(visualProjection ? { visualEvidence: visualProjection } : {}) },
        rubricIds: Object.keys(questions),
        rubricVersion: RUBRIC_VERSION,
        rubricHash,
        inputFingerprint: requestFingerprint,
        inputModality: visualProjection ? "text_plus_visual" : "text_only",
        planHash,
        taskContractHash: reviewBinding.taskContractHash,
        capabilityCatalogHash: reviewBinding.capabilityCatalogHash,
        bindingHash: reviewBinding.bindingHash,
        targetId: reviewBinding.targetId,
        documentGeneration: reviewBinding.documentGeneration,
        reviewPolicyVersion: WORKFLOW_REVIEW_POLICY_VERSION
      }
    });
    const inputEventIds = [inputEvent.eventId];
    let response;
    try {
      recordProviderRouteIfMissing(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId,
        provider: "jev", route: "jev_only", reasonCode: "workflow_plan_review_requested",
        visualEvidenceUsed: Boolean(visualProjection)
      });
      response = await this.client.decide({ reviewKind: "workflow_plan_review", state, questions, ...(visualProjection ? { imageEvidence: boundImageEvidence } : {}), signal });
    } catch (error) {
      recordJevFailure(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId, questions, rubricHash,
        inputFingerprint: requestFingerprint, inputEventIds, error
      });
      return { decisionId, status: "unavailable", failureCode: jevFailureCode(error), authorizesOperation: false };
    }
    if (!isPinnedJevModel(response.model)) {
      const error = Object.assign(new Error("Jev returned a model other than the pinned 1.14 model."), { kind: "schema" });
      recordJevFailure(this.eventStore, {
        episodeId, runId, stepId, decisionId, observationId, questions, rubricHash,
        inputFingerprint: requestFingerprint, inputEventIds, error
      });
      return { decisionId, status: "unavailable", failureCode: "schema", authorizesOperation: false };
    }
    const threshold = this.thresholds.workflowPlan ?? REVIEW_THRESHOLD;
    const supported = Object.keys(questions).every(id => Number.isFinite(response.answers[id]?.probabilityYes)
      && response.answers[id].probabilityYes >= threshold);
    const reviewDisposition = supported ? "supported" : "needs_agent_review";
    const events = [];
    for (const [rubricId, answer] of Object.entries(response.answers)) {
      events.push(this.eventStore.append({
        episodeId, runId, stepId, decisionId, observationId,
        parentEventId: inputEvent.eventId,
        eventType: "decision.predicted",
        trainingEligibility: "pending",
          payload: {
          provider: "openrouter", model: response.model, modelSnapshot: response.modelSnapshot ?? response.model, rubricId, rubricVersion: RUBRIC_VERSION,
          rubricHash, questionType: answer.type, answer, inputFingerprint: requestFingerprint,
          reviewDisposition,
          inputEventIds,
          ...(response.usage ? { usage: response.usage } : {})
        }
      }));
    }
    return {
      decisionId,
      status: "reviewed",
      disposition: supported ? "supported" : "needs_agent_review",
      reviewOutcome: supported ? "supported" : "needs_review",
      bindingStatus: "bound",
      planHash: planHash.toLowerCase(),
      observationId,
      reviewBindingHash: reviewBinding.bindingHash,
      taskContractHash: reviewBinding.taskContractHash,
      capabilityCatalogHash: reviewBinding.capabilityCatalogHash,
      targetId: reviewBinding.targetId,
      documentGeneration: reviewBinding.documentGeneration,
      reviewPolicyVersion: WORKFLOW_REVIEW_POLICY_VERSION,
      reviewer: { provider: "openrouter", model: response.model, rubricVersion: RUBRIC_VERSION },
      answers: response.answers,
      inputEventIds,
      eventIds: events.map(event => event.eventId),
      authorizesOperation: false
    };
  }

  async annotateRoles({ semanticAnalyzer, requestedRoles, intentHints = [], ...review } = {}) {
    if (!semanticAnalyzer || typeof semanticAnalyzer.analyzePage !== "function") throw new Error("A semantic page analyzer is required for role annotation.");
    if (!review.observation?.evidenceId || !review.episodeId || !review.runId || !review.stepId) throw new Error("Semantic role annotation requires stable episode, run, step, and observation identities.");
    const decisionId = review.decisionId ?? randomUUID();
    const contextEventIds = recordDecisionContext(this.eventStore, { ...review, decisionId });
    let semantic = null;
    let semanticFailureCode = null;
    try {
      semantic = await semanticAnalyzer.analyzePage({
        observation: review.observation,
        requestedRoles,
        intentHints,
        inputEventIds: contextEventIds,
        episodeId: review.episodeId,
        runId: review.runId,
        stepId: review.stepId,
        decisionId,
        signal: review.signal,
        ...(review.includePageLabels === undefined ? {} : { includePageLabels: review.includePageLabels }),
        useVisualEvidence: review.useVisualEvidence === true
      });
    } catch (error) {
      semanticFailureCode = jevFailureCode(error);
      if (!error?.kind) {
        for (const semanticRole of requestedRoles) {
          this.eventStore.append({
            episodeId: review.episodeId,
            runId: review.runId,
            stepId: review.stepId,
            decisionId,
            observationId: review.observation.evidenceId,
            eventType: "semantic.failed",
            trainingEligibility: "pending",
            payload: {
              analyzerProvider: semanticAnalyzer.providerId ?? "freeinference_production",
              analyzerModel: semanticAnalyzer.model ?? "glm-5.3-flash",
              annotationKind: "control_mapping",
              rubricId: `control_mapping_${semanticRole}`,
              failureCode: semanticFailureCode
            }
          });
        }
      }
    }
    const semanticEventIds = this.eventStore.getEvents(review.episodeId)
      .filter(event => event.decisionId === decisionId && event.eventType.startsWith("semantic."))
      .map(event => event.eventId);
    return { decisionId, semantic, semanticFailureCode, contextEventIds, eventIds: [...new Set([...(semantic?.eventIds ?? []), ...semanticEventIds])] };
  }

  async mapAndReviewBeforeAction({ semanticAnalyzer, requestedRoles, intentHints = [], ...review } = {}) {
    if (!review.observation?.evidenceId || !review.episodeId || !review.runId || !review.stepId) throw new Error("Combined semantic and Jev review requires stable episode, run, step, and observation identities.");
    const decisionId = review.decisionId ?? randomUUID();
    const annotated = await this.annotateRoles({ semanticAnalyzer, requestedRoles, intentHints, ...review, decisionId });
    const { semantic, semanticFailureCode, contextEventIds } = annotated;
    const semanticAnnotation = semantic?.annotations.find(annotation => annotation.semanticRole === review.targetRole)
      ?? semantic?.annotations[0]
      ?? null;
    // Link Jev's captured projection to the exact semantic input and output
    // events that preceded it, alongside the shared observation and intent.
    const jevInputEventIds = [...contextEventIds, ...annotated.eventIds];
    let jev;
    let reviewFailureCode = null;
    try {
      jev = await this.reviewBeforeAction({ ...review, decisionId, semanticAnnotation, inputEventIds: jevInputEventIds, recordContext: false });
    } catch (error) {
      if (!error?.kind) throw error;
      reviewFailureCode = jevFailureCode(error);
    }
    return { decisionId, semantic, semanticFailureCode, ...(jev ? { jev } : {}), ...(reviewFailureCode ? { jevFailureCode: reviewFailureCode } : {}), authorizesOperation: false };
  }

  recordSemanticUnavailable({ episodeId, runId, stepId, decisionId = randomUUID(), observation, requestedRoles, operation, operationClass = "unknown", targetRole = "unknown", expectedOutcomeClass = "operation_complete", analyzerProvider = "freeinference_production", analyzerModel = "glm-5.3-flash", rubricVersion = "1", failureCode = "configuration" } = {}) {
    if (!episodeId || !runId || !stepId || !observation?.evidenceId || !Array.isArray(requestedRoles) || requestedRoles.length === 0) {
      throw new Error("Recording unavailable semantic analysis requires run, decision, observation, and requested-role identities.");
    }
    if (!["configuration", "privacy", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "unknown"].includes(failureCode)) {
      throw new Error("Semantic failure code is unsupported.");
    }
    const inputEventIds = recordDecisionContext(this.eventStore, { episodeId, runId, stepId, decisionId, observation, operation, operationClass, targetRole, expectedOutcomeClass });
    const events = requestedRoles.map(semanticRole => this.eventStore.append({
      episodeId, runId, stepId, decisionId, observationId: observation.evidenceId,
      eventType: "semantic.failed", trainingEligibility: "pending",
      payload: {
        analyzerProvider,
        analyzerModel,
        annotationKind: "control_mapping",
        rubricId: `control_mapping_${semanticRole}`,
        rubricVersion,
        rubricHash: rubricFingerprint({ annotationKind: "control_mapping", semanticRole, rubricVersion }),
        failureCode,
        inputEventIds
      }
    }));
    return { decisionId, contextEventIds: inputEventIds, inputEventIds: [...inputEventIds, ...events.map(event => event.eventId)], eventIds: events.map(event => event.eventId) };
  }
}
