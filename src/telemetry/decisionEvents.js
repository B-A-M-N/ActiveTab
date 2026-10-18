import { randomUUID } from "node:crypto";
import { isSafeModelId, isSha256Digest, normalizeObservedRole, normalizeObservedTag, requireSafeEvidenceRefs, requireSafeTelemetryCode } from "./privacy.js";

export const DECISION_EVENT_SCHEMA_VERSION = 1;
export const TRAINING_ELIGIBILITY = Object.freeze({ EXCLUDED: "excluded", PENDING: "pending", ELIGIBLE: "eligible" });

const EVENT_FIELDS = Object.freeze({
  "episode.started": ["workflowKind", "applicationId", "environmentClass", "executionMode", "policyVersion"],
  "intent.proposed": ["operation", "operationClass", "targetRole", "parameterNames", "expectedOutcomeClass"],
  "observation.captured": ["surfaceClass", "candidateCount", "visibleCount", "candidateRoles", "evidenceRefs", "observationFingerprint"],
  "semantic.input_captured": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricVersion", "rubricHash", "inputFingerprint", "inputProjection"],
  "semantic.annotated": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "rubricVersion", "rubricHash", "semanticRole", "candidateRef", "resultCode", "confidence", "uncertaintyCode", "inputFingerprint", "inputEventIds", "evidenceRefs", "usage"],
  "semantic.failed": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "rubricVersion", "rubricHash", "failureCode", "inputFingerprint", "inputEventIds"],
  "target.resolved": ["resolver", "roleMappings", "reasonCode", "evidenceRefs", "inputEventIds"],
  "decision.input_captured": ["inputKind", "inputProjection", "rubricIds", "rubricHash", "inputFingerprint"],
  "decision.skipped": ["reasonCode", "inputEventIds"],
  "decision.predicted": ["provider", "model", "rubricId", "rubricVersion", "rubricHash", "questionType", "answer", "inputFingerprint", "inputEventIds", "usage"],
  "decision.failed": ["provider", "model", "rubricId", "rubricVersion", "rubricHash", "questionType", "failureCode", "inputFingerprint", "inputEventIds"],
  "workflow.plan_synthesized": ["provider", "model", "planVersion", "planHash", "inputFingerprint", "stepCount", "planProjection", "usage"],
  "workflow.plan_failed": ["provider", "model", "planVersion", "inputFingerprint", "failureCode"],
  "inference.attempted": ["taskCode", "attemptNumber", "maxAttempts"],
  "policy.adjudicated": ["disposition", "reasonCode", "policyVersion"],
  "execution.reserved": ["operation", "targetRole", "operationId"],
  "execution.dispatched": ["operation", "targetRole", "dispatchStatus", "operationId"],
  "execution.observed": ["outcomeClass", "changed", "evidenceRefs"],
  "verification.completed": ["status", "oracleType", "reasonCode", "verifiedCode", "evidenceRefs"],
  "correction.recorded": ["correctionType", "sourceClass", "supersedesDecisionId", "correctedCode", "evidenceRefs"],
  "label.proposed": ["rubricId", "labelCode", "sourceClass", "evidenceRefs"],
  "label.approved": ["labelEventId", "rubricId", "labelCode", "sourceClass", "evidenceRefs", "reviewerId", "approvalDigest"],
  "qualification.started": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "sourceEventIds", "evidenceRefs"],
  "qualification.completed": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "qualificationStatus", "reasonCode", "evidenceRefs"],
  "episode.completed": ["status", "cleanupStatus"]
});

const ENUMS = {
  environmentClass: new Set(["local", "staging", "production", "unknown"]),
  executionMode: new Set(["agent_directed", "agent_assisted", "standalone", "unknown"]),
  operationClass: new Set(["read", "navigation", "test_owned_mutation", "shared_mutation", "security_change", "unknown"]),
  disposition: new Set(["allow", "deny", "suspend", "review"]),
  dispatchStatus: new Set(["dispatched", "refused", "failed", "uncertain"]),
  status: new Set(["passed", "failed", "blocked", "uncertain", "canceled", "suspended"]),
  cleanupStatus: new Set(["verified", "pending", "failed", "not_required", "unknown"]),
  questionType: new Set(["noul", "choice", "score", "box"]),
  sourceClass: new Set(["deterministic_assertion", "correlated_backend", "independent_human", "coding_agent", "secondary_model", "jev_self"]),
  correctionType: new Set(["target_mapping", "risk_classification", "outcome_label", "recovery", "other"]),
  verificationStatus: new Set(["verified_pass", "verified_fail", "uncertain", "not_run"]),
  qualificationStatus: new Set(["qualified", "not_qualified", "inconclusive", "unavailable"]),
  annotationKind: new Set(["page_classification", "control_mapping", "ambiguity_resolution", "change_analysis", "form_discovery"]),
  failureCode: new Set(["configuration", "privacy", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted", "missing_intent", "unknown"]),
  inputKind: new Set(["pre_action_review", "outcome_review", "workflow_plan_review"])
};

function normalizeWorkflowPlanProjection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) throw new Error("Workflow plan telemetry must contain a bounded non-empty step projection.");
  const ids = new Set();
  return value.map(step => {
    const fields = ["stepId", "capabilityId", "effectClass", "targetRole", "verificationCode", "requiresApproval"];
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(step, key))) {
      throw new Error("Workflow plan telemetry step contains unsupported fields.");
    }
    const stepId = safeCode(step.stepId, "planProjection.stepId", 64);
    if (ids.has(stepId)) throw new Error("Workflow plan telemetry step IDs must be unique.");
    ids.add(stepId);
    if (typeof step.requiresApproval !== "boolean") throw new Error("Workflow plan approval requirement must be boolean.");
    return {
      stepId,
      capabilityId: safeCode(step.capabilityId, "planProjection.capabilityId", 96),
      effectClass: validateEnum(step.effectClass, "operationClass"),
      targetRole: safeCode(step.targetRole, "planProjection.targetRole", 64),
      verificationCode: safeCode(step.verificationCode, "planProjection.verificationCode", 64),
      requiresApproval: step.requiresApproval
    };
  });
}

function normalizeWorkflowReviewProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["state", "questions"].includes(key))) {
    throw new Error("Workflow review projection must contain only state and question identifiers.");
  }
  const state = value.state;
  const fields = ["plan_version", "step_count", "steps"];
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Object.keys(state).length !== fields.length || Object.keys(state).some(key => !fields.includes(key))) {
    throw new Error("Workflow review state contains unsupported fields.");
  }
  if (state.plan_version !== 1 || !Number.isInteger(state.step_count) || state.step_count < 1 || state.step_count > 24
    || !Array.isArray(state.steps) || state.steps.length !== state.step_count) {
    throw new Error("Workflow review state is outside its supported bounds.");
  }
  const steps = state.steps.map(step => {
    const allowed = ["step_id", "capability_id", "effect_class", "target_role", "verification_code", "requires_approval"];
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).length !== allowed.length || Object.keys(step).some(key => !allowed.includes(key))) {
      throw new Error("Workflow review step contains unsupported fields.");
    }
    if (typeof step.requires_approval !== "boolean") throw new Error("Workflow review approval requirement must be boolean.");
    return {
      step_id: safeCode(step.step_id, "inputProjection.step_id", 64),
      capability_id: safeCode(step.capability_id, "inputProjection.capability_id", 96),
      effect_class: validateEnum(step.effect_class, "operationClass"),
      target_role: safeCode(step.target_role, "inputProjection.target_role", 64),
      verification_code: safeCode(step.verification_code, "inputProjection.verification_code", 64),
      requires_approval: step.requires_approval
    };
  });
  return { state: { plan_version: state.plan_version, step_count: state.step_count, steps }, questions: normalizeQuestionProjection(value.questions) };
}

function normalizeJevInputProjection(value, inputKind) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["state", "questions"].includes(key))) {
    throw new Error("Jev input projection must contain only state and question identifiers.");
  }
  const state = value.state;
  if (inputKind === "outcome_review") {
    const outcomeFields = ["expected_outcome", "browser_outcome", "backend_outcome"];
    if (!state || typeof state !== "object" || Array.isArray(state)
      || Object.keys(state).length !== outcomeFields.length
      || Object.keys(state).some(key => !outcomeFields.includes(key))) {
      throw new Error("Jev outcome input projection must contain exact expected, browser, and backend outcome codes.");
    }
    const questions = normalizeQuestionProjection(value.questions);
    return {
      state: Object.fromEntries(outcomeFields.map(field => [field, safeCode(state[field], `inputProjection.${field}`, 96)])),
      questions
    };
  }
  if (inputKind === "workflow_plan_review") return normalizeWorkflowReviewProjection(value);
  if (inputKind !== "pre_action_review") throw new Error("Jev input projection requires a supported review kind.");
  const stateFields = ["operation_code", "operation_class", "requested_target_role", "proposed_control", "page_surface", "alternative_count", "semantic_annotation"];
  if (!state || typeof state !== "object" || Array.isArray(state) || Object.keys(state).some(key => !stateFields.includes(key))) {
    throw new Error("Jev state projection contains unsupported fields.");
  }
  const control = state.proposed_control;
  const controlFields = ["candidate_ref", "role", "tag", "visible", "disabled"];
  if (!control || typeof control !== "object" || Array.isArray(control) || Object.keys(control).some(key => !controlFields.includes(key))) {
    throw new Error("Jev control projection contains unsupported fields.");
  }
  const normalizedState = {
    operation_code: safeCode(state.operation_code, "inputProjection.operation_code", 96),
    operation_class: validateEnum(state.operation_class, "operationClass"),
    requested_target_role: safeCode(state.requested_target_role, "inputProjection.requested_target_role", 96),
    proposed_control: {
      candidate_ref: safeCode(control.candidate_ref, "inputProjection.candidate_ref", 96),
      role: normalizeObservedRole(control.role),
      tag: normalizeObservedTag(control.tag),
      visible: control.visible === true,
      disabled: control.disabled === true
    },
    page_surface: safeCode(state.page_surface, "inputProjection.page_surface", 64),
    alternative_count: state.alternative_count
  };
  if (!Number.isInteger(state.alternative_count) || state.alternative_count < 0 || state.alternative_count > 100) {
    throw new Error("Jev alternative_count must be between 0 and 100.");
  }
  if (state.semantic_annotation !== undefined) {
    const annotation = state.semantic_annotation;
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation) || Object.keys(annotation).some(key => !["role", "result_code", "confidence"].includes(key))) {
      throw new Error("Jev semantic annotation projection contains unsupported fields.");
    }
    if (!Number.isFinite(annotation.confidence) || annotation.confidence < 0 || annotation.confidence > 1) throw new Error("Jev semantic confidence is invalid.");
    normalizedState.semantic_annotation = {
      role: safeCode(annotation.role, "inputProjection.semantic_annotation.role", 64),
      result_code: safeCode(annotation.result_code, "inputProjection.semantic_annotation.result_code", 32),
      confidence: annotation.confidence
    };
  }
  const questions = normalizeQuestionProjection(value.questions);
  return { state: normalizedState, questions };
}

function normalizeQuestionProjection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Jev input projection requires bounded question identifiers.");
  return value.map(question => {
    if (!question || typeof question !== "object" || Array.isArray(question) || Object.keys(question).some(key => !["id", "type"].includes(key))) throw new Error("Jev question projection contains unsupported fields.");
    return { id: safeCode(question.id, "inputProjection.question.id", 64), type: validateEnum(question.type, "questionType") };
  });
}

function normalizeSemanticInputProjection(value) {
  const projectionFields = ["observationId", "requestedRoles", "intentHints", "pageLabelsIncluded", "candidates"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !projectionFields.includes(key))) {
    throw new Error("Semantic input projection contains unsupported fields.");
  }
  if (typeof value.pageLabelsIncluded !== "boolean") throw new Error("Semantic input projection requires a page-label disclosure flag.");
  const normalizeCodes = (items, field, maximum) => {
    if (!Array.isArray(items) || items.length < 1 || items.length > maximum) throw new Error(`Semantic input '${field}' is outside its bounds.`);
    return [...new Set(items.map(item => safeCode(item, field, 96)))];
  };
  if (!Array.isArray(value.candidates) || value.candidates.length > 256) throw new Error("Semantic input candidates exceed their bound.");
  const candidates = value.candidates.map(candidate => {
    const allowedFields = ["candidateRef", "role", "tag", "visible", "disabled", "label", "context"];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).some(key => !allowedFields.includes(key))) {
      throw new Error("Semantic input candidate contains unsupported fields.");
    }
    const hasText = Object.hasOwn(candidate, "label") || Object.hasOwn(candidate, "context");
    if (value.pageLabelsIncluded ? hasText : (!hasText || candidate.label !== "" || candidate.context !== "")) {
      throw new Error("Semantic input candidate text does not match its disclosure flag.");
    }
    if (typeof candidate.visible !== "boolean" || typeof candidate.disabled !== "boolean") throw new Error("Semantic candidate state must be boolean.");
    return {
      candidateRef: safeCode(candidate.candidateRef, "inputProjection.candidateRef", 96),
      role: normalizeObservedRole(candidate.role),
      tag: normalizeObservedTag(candidate.tag),
      visible: candidate.visible,
      disabled: candidate.disabled,
      ...(!value.pageLabelsIncluded ? { label: "", context: "" } : {})
    };
  });
  return {
    observationId: safeCode(value.observationId, "inputProjection.observationId", 96),
    requestedRoles: normalizeCodes(value.requestedRoles, "requestedRoles", 32),
    intentHints: Array.isArray(value.intentHints) && value.intentHints.length === 0
      ? []
      : normalizeCodes(value.intentHints, "intentHints", 32),
    pageLabelsIncluded: value.pageLabelsIncluded,
    candidates
  };
}

function safeCode(value, field, maxLength) {
  return requireSafeTelemetryCode(value, field, { maxLength });
}

function safeModelId(value, field) {
  if (!isSafeModelId(value)) throw new Error(`Telemetry field '${field}' must be a bounded model identifier.`);
  return value;
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function normalizeConfidence(value) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Telemetry confidence must be in [0, 1].");
  return value;
}

function validateEnum(value, field) {
  const values = ENUMS[field];
  if (values && !values.has(value)) throw new Error(`Telemetry field '${field}' has an unsupported value.`);
  return value;
}

function normalizeAnswer(value, questionType) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telemetry prediction answer must be a typed object.");
  if (questionType === "noul") {
    requireExactKeys(value, ["type", "probabilityYes"], "Noul answer");
    if (value.type !== "noul" || !Number.isFinite(value.probabilityYes) || value.probabilityYes < 0 || value.probabilityYes > 1) {
      throw new Error("Noul telemetry answers require probabilityYes in [0, 1].");
    }
    return { type: "noul", probabilityYes: value.probabilityYes };
  }
  if (questionType === "choice") {
    requireExactKeys(value, ["type", "choice", "probabilities", "confidence"], "Choice answer");
    if (value.type !== "choice") throw new Error("Choice telemetry answers require the choice type.");
    const choice = safeCode(value.choice, "answer.choice", 64);
    if (!value.probabilities || typeof value.probabilities !== "object" || Array.isArray(value.probabilities)) throw new Error("Choice telemetry answers require named probabilities.");
    const entries = Object.entries(value.probabilities);
    if (entries.length < 2 || entries.length > 32) throw new Error("Choice telemetry answers require between 2 and 32 choices.");
    const probabilities = Object.fromEntries(entries.map(([key, probability]) => {
      safeCode(key, "answer.probabilities key", 64);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Choice probability must be in [0, 1].");
      return [key, probability];
    }).sort(([a], [b]) => a.localeCompare(b)));
    if (!Object.hasOwn(probabilities, choice)) throw new Error("Chosen answer must appear in its probability map.");
    const confidence = normalizeConfidence(value.confidence);
    return { type: "choice", choice, probabilities, ...(confidence !== undefined ? { confidence } : {}) };
  }
  if (questionType === "score") {
    requireExactKeys(value, ["type", "score", "probabilities", "confidence"], "Score answer");
    if (value.type !== "score" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) throw new Error("Score telemetry answers require a bounded score.");
    if (!value.probabilities || typeof value.probabilities !== "object" || Array.isArray(value.probabilities)) throw new Error("Score telemetry answers require their full probability distribution.");
    const entries = Object.entries(value.probabilities);
    if (entries.length < 2 || entries.length > 32) throw new Error("Score telemetry answers require between 2 and 32 probability values.");
    const probabilities = Object.fromEntries(entries.map(([key, probability]) => {
      const numericKey = key.length > 0 && key.length <= 2 && [...key].every(character => character >= "0" && character <= "9");
      if (!numericKey || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Score probability must be a bounded numeric level.");
      return [key, probability];
    }).sort(([a], [b]) => Number(a) - Number(b)));
    const confidence = normalizeConfidence(value.confidence);
    return { type: "score", score: value.score, probabilities, ...(confidence !== undefined ? { confidence } : {}) };
  }
  if (questionType === "box") {
    requireExactKeys(value, ["type", "box", "confidence"], "Box answer");
    const box = value.box;
    requireExactKeys(box, ["top", "bottom", "left", "right"], "Box coordinates");
    if (value.type !== "box" || !box || [box.top, box.bottom, box.left, box.right].some(n => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error("Box telemetry answers require normalized coordinates.");
    const confidence = normalizeConfidence(value.confidence);
    return { type: "box", box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, ...(confidence !== undefined ? { confidence } : {}) };
  }
  throw new Error("Unsupported typed decision answer.");
}

function normalizePayload(eventType, payload) {
  if (!EVENT_FIELDS[eventType]) throw new Error(`Unsupported decision event type '${eventType}'.`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Decision event payload must be an object.");
  const allowed = new Set(EVENT_FIELDS[eventType]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new Error(`Telemetry payload field '${key}' is not allowed for '${eventType}'.`);
  const out = {};
  for (const field of EVENT_FIELDS[eventType]) {
    const value = payload[field];
    if (value === undefined) continue;
    if (field === "evidenceRefs") out[field] = requireSafeEvidenceRefs(value);
    else if (field === "inputProjection") out[field] = eventType === "semantic.input_captured"
      ? normalizeSemanticInputProjection(value)
      : normalizeJevInputProjection(value, payload.inputKind);
    else if (field === "planProjection") out[field] = normalizeWorkflowPlanProjection(value);
    else if (field === "inputKind") out[field] = validateEnum(value, field);
    else if (["candidateCount", "visibleCount", "stepCount", "attemptNumber", "maxAttempts"].includes(field)) {
      if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`Telemetry field '${field}' must be a bounded non-negative integer.`);
      out[field] = value;
      if (["attemptNumber", "maxAttempts"].includes(field) && (value < 1 || value > 4)) throw new Error(`Telemetry field '${field}' must be between 1 and 4.`);
    } else if (field === "planVersion") {
      if (value !== 1) throw new Error("Workflow plan telemetry supports only version 1.");
      out[field] = value;
    } else if (field === "changed") {
      if (typeof value !== "boolean") throw new Error("Telemetry field 'changed' must be boolean.");
      out[field] = value;
    } else if (field === "confidence") {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Telemetry confidence must be in [0, 1].");
      out[field] = value;
    } else if (field === "inputFingerprint") {
      if (!isSha256Digest(value)) throw new Error("Telemetry inputFingerprint must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "planHash") {
      if (!isSha256Digest(value)) throw new Error("Workflow planHash must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "rubricHash") {
      if (!isSha256Digest(value)) throw new Error("Telemetry rubricHash must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "approvalDigest") {
      if (!isSha256Digest(value)) throw new Error("Telemetry approvalDigest must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "strategyFingerprint") {
      if (!isSha256Digest(value)) throw new Error("Telemetry strategyFingerprint must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "inputEventIds") {
      if (!Array.isArray(value) || value.length > 64) throw new Error("Telemetry inputEventIds must be a bounded event reference list.");
      out[field] = [...new Set(value.map(item => safeCode(item, field, 96)))];
    } else if (field === "sourceEventIds") {
      if (!Array.isArray(value) || value.length > 32) throw new Error("Telemetry sourceEventIds must be a bounded event reference list.");
      out[field] = [...new Set(value.map(item => safeCode(item, field, 96)))];
    } else if (field === "roleMappings") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Telemetry roleMappings must contain a bounded non-empty mapping.");
      const roles = new Set();
      const candidates = new Set();
      out[field] = value.map(mapping => {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)
          || Object.keys(mapping).some(key => !["role", "candidateRef"].includes(key))
          || !Object.hasOwn(mapping, "role") || !Object.hasOwn(mapping, "candidateRef")) {
          throw new Error("Telemetry role mapping must contain only role and candidateRef.");
        }
        const role = safeCode(mapping.role, "roleMappings.role", 64);
        const candidateRef = safeCode(mapping.candidateRef, "roleMappings.candidateRef", 256);
        if (roles.has(role) || candidates.has(candidateRef)) throw new Error("Telemetry role mapping must use unique roles and candidate references.");
        roles.add(role);
        candidates.add(candidateRef);
        return { role, candidateRef };
      }).sort((left, right) => left.role.localeCompare(right.role));
    } else if (field === "usage") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decision usage must be a bounded object.");
      const usage = {};
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"]) {
        if (value[key] !== undefined) {
          if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 10_000_000) throw new Error(`Decision usage '${key}' must be a bounded non-negative integer.`);
          usage[key] = value[key];
        }
      }
      if (value.cost !== undefined) {
        if (!Number.isFinite(value.cost) || value.cost < 0 || value.cost > 1000) throw new Error("Decision usage cost must be bounded and non-negative.");
        usage.cost = value.cost;
      }
      for (const key of Object.keys(value)) if (!["inputTokens", "outputTokens", "cachedInputTokens", "cost"].includes(key)) throw new Error(`Decision usage field '${key}' is not allowed.`);
      if (usage.cachedInputTokens !== undefined && usage.inputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) throw new Error("Cached input tokens cannot exceed total input tokens.");
      out[field] = usage;
    } else if (field === "candidateRoles" || field === "parameterNames") {
      if (!Array.isArray(value) || value.length > 64) throw new Error(`Telemetry field '${field}' must be a bounded array.`);
      out[field] = [...new Set(value.map(item => field === "candidateRoles" ? normalizeObservedRole(item) : safeCode(item, field, 64)))].sort();
    } else if (field === "rubricIds") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Telemetry rubricIds must be a bounded non-empty array.");
      out[field] = [...new Set(value.map(item => safeCode(item, field, 64)))].sort();
    } else if (field === "answer") out[field] = normalizeAnswer(value, payload.questionType);
    else if (field === "model" || field === "analyzerModel") out[field] = safeModelId(value, field);
    else if (field === "status" && eventType === "verification.completed") out[field] = validateEnum(value, "verificationStatus");
    else if (field === "annotationKind") out[field] = validateEnum(value, field);
    else if (field === "workflowKind" || field === "applicationId" || field === "environmentClass" || field === "executionMode" || field === "operationClass" || field === "disposition" || field === "dispatchStatus" || field === "status" || field === "cleanupStatus" || field === "questionType" || field === "sourceClass" || field === "correctionType" || field === "failureCode" || field === "qualificationStatus") {
      out[field] = validateEnum(value, field) ?? safeCode(value, field);
      if (!ENUMS[field]) out[field] = safeCode(value, field);
    } else {
      out[field] = safeCode(value, field, field === "policyVersion" || field === "observationFingerprint" ? 128 : 96);
    }
  }
  const required = {
    "episode.started": ["workflowKind", "applicationId", "environmentClass", "executionMode", "policyVersion"],
    "intent.proposed": ["operation", "operationClass", "targetRole", "expectedOutcomeClass"],
    "observation.captured": ["surfaceClass", "candidateCount", "visibleCount", "candidateRoles", "evidenceRefs"],
    "semantic.input_captured": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricVersion", "rubricHash", "inputFingerprint", "inputProjection"],
    "semantic.annotated": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "semanticRole", "resultCode", "confidence", "evidenceRefs"],
    "semantic.failed": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "failureCode"],
    "target.resolved": ["resolver", "roleMappings", "reasonCode", "evidenceRefs"],
    "decision.input_captured": ["inputKind", "inputProjection", "rubricIds", "inputFingerprint"],
    "decision.skipped": ["reasonCode", "inputEventIds"],
    "decision.predicted": ["provider", "model", "rubricId", "rubricVersion", "questionType", "answer"],
    "decision.failed": ["provider", "model", "rubricId", "rubricVersion", "questionType", "failureCode"],
    "policy.adjudicated": ["disposition", "reasonCode", "policyVersion"],
    "execution.reserved": ["operation", "targetRole", "operationId"],
    "execution.dispatched": ["operation", "dispatchStatus", "operationId"],
    "execution.observed": ["outcomeClass", "changed", "evidenceRefs"],
    "verification.completed": ["status", "oracleType", "reasonCode", "evidenceRefs"],
    "correction.recorded": ["correctionType", "sourceClass", "correctedCode"],
    "label.proposed": ["rubricId", "labelCode", "sourceClass", "evidenceRefs"],
    "label.approved": ["labelEventId", "rubricId", "labelCode", "sourceClass", "evidenceRefs", "reviewerId", "approvalDigest"],
    "qualification.started": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "sourceEventIds", "evidenceRefs"],
    "qualification.completed": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "qualificationStatus", "reasonCode", "evidenceRefs"],
    "workflow.plan_synthesized": ["provider", "model", "planVersion", "planHash", "inputFingerprint", "stepCount", "planProjection"],
    "workflow.plan_failed": ["provider", "model", "planVersion", "inputFingerprint", "failureCode"],
    "inference.attempted": ["taskCode", "attemptNumber", "maxAttempts"],
    "episode.completed": ["status", "cleanupStatus"]
  }[eventType];
  for (const field of required) if (out[field] === undefined) throw new Error(`Telemetry event '${eventType}' requires '${field}'.`);
  return out;
}

export function createDecisionEvent(input) {
  if (!input || typeof input !== "object") throw new Error("Decision event input is required.");
  const eventType = safeCode(input.eventType, "eventType", 64);
  const episodeId = safeCode(input.episodeId, "episodeId", 96);
  const runId = safeCode(input.runId, "runId", 96);
  const trainingEligibility = input.trainingEligibility ?? TRAINING_ELIGIBILITY.PENDING;
  if (!Object.values(TRAINING_ELIGIBILITY).includes(trainingEligibility)) throw new Error("Unsupported training eligibility.");
  if (trainingEligibility === TRAINING_ELIGIBILITY.ELIGIBLE && eventType !== "label.approved") throw new Error("Only independently approved labels may be training eligible.");
  if (["semantic.input_captured", "semantic.annotated", "semantic.failed", "target.resolved", "decision.input_captured", "decision.skipped", "decision.predicted", "decision.failed", "policy.adjudicated", "execution.reserved", "execution.dispatched", "execution.observed", "verification.completed", "correction.recorded", "label.proposed", "label.approved", "qualification.started", "qualification.completed", "workflow.plan_synthesized", "workflow.plan_failed", "inference.attempted"].includes(eventType) && !input.decisionId) {
    throw new Error(`Telemetry event '${eventType}' requires a stable decisionId.`);
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Decision event timestamp must be valid ISO date text.");
  return {
    schemaVersion: DECISION_EVENT_SCHEMA_VERSION,
    eventId: safeCode(input.eventId ?? randomUUID(), "eventId", 96),
    eventType,
    episodeId,
    runId,
    ...(input.stepId ? { stepId: safeCode(input.stepId, "stepId", 96) } : {}),
    ...(input.decisionId ? { decisionId: safeCode(input.decisionId, "decisionId", 96) } : {}),
    ...(input.observationId ? { observationId: safeCode(input.observationId, "observationId", 96) } : {}),
    ...(input.parentEventId ? { parentEventId: safeCode(input.parentEventId, "parentEventId", 96) } : {}),
    occurredAt,
    trainingEligibility,
    payload: normalizePayload(eventType, input.payload)
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
