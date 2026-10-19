import { randomUUID } from "node:crypto";
import { isSafeModelId, isSha256Digest, normalizeObservedRole, normalizeObservedTag, requireSafeEvidenceRefs, requireSafeTelemetryCode } from "./privacy.js";

export const DECISION_EVENT_SCHEMA_VERSION = 3;
export const TRAINING_ELIGIBILITY = Object.freeze({ EXCLUDED: "excluded", PENDING: "pending", ELIGIBLE: "eligible" });

const EVENT_FIELDS = Object.freeze({
  "episode.started": ["workflowKind", "applicationId", "environmentClass", "executionMode", "policyVersion"],
  "intent.proposed": ["operation", "operationClass", "targetRole", "parameterNames", "expectedOutcomeClass"],
  "observation.captured": ["surfaceClass", "candidateCount", "visibleCount", "candidateRoles", "evidenceRefs", "observationFingerprint"],
  "semantic.input_captured": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricVersion", "rubricHash", "inputFingerprint", "inputModality", "inputProjection"],
  "semantic.annotated": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "rubricVersion", "rubricHash", "semanticRole", "candidateRef", "resultCode", "confidence", "uncertaintyCode", "inputFingerprint", "inputEventIds", "evidenceRefs", "usage"],
  "semantic.failed": ["analyzerProvider", "analyzerModel", "annotationKind", "rubricId", "rubricVersion", "rubricHash", "failureCode", "inputFingerprint", "inputEventIds", "clientRequestId", "providerLatencyMs", "transportCode", "httpStatus"],
  "target.resolved": ["resolver", "roleMappings", "reasonCode", "evidenceRefs", "inputEventIds"],
  "target.lookup": ["lookupMode", "lookupStatus", "targetId", "documentGeneration", "frameScope", "frameTargetId", "frameId", "returnedCount", "visitedNodeCount", "stopReason", "elapsedMs", "nextActionDisposition"],
  "decision.input_captured": ["inputKind", "inputProjection", "rubricIds", "rubricVersion", "rubricHash", "inputFingerprint", "inputModality", "planHash", "taskContractHash", "capabilityCatalogHash", "bindingHash", "targetId", "documentGeneration", "reviewPolicyVersion"],
  "decision.skipped": ["reasonCode", "inputEventIds"],
  "decision.predicted": ["provider", "model", "modelSnapshot", "rubricId", "rubricVersion", "rubricHash", "questionType", "answer", "reviewDisposition", "inputFingerprint", "inputEventIds", "usage"],
  "decision.failed": ["provider", "model", "rubricId", "rubricVersion", "rubricHash", "questionType", "failureCode", "inputFingerprint", "inputEventIds"],
  "planner.predicted": ["provider", "model", "inputFingerprint", "inputModality", "resultCode", "reasonCode", "actionType", "selectedCandidateFingerprint", "clientRequestId", "providerLatencyMs", "usage"],
  "planner.failed": ["provider", "model", "inputFingerprint", "inputModality", "failureCode", "clientRequestId", "providerLatencyMs"],
  "workflow.plan_synthesized": ["provider", "model", "planVersion", "planHash", "inputFingerprint", "stepCount", "planProjection", "usage", "inputModality"],
  "workflow.plan_failed": ["provider", "model", "planVersion", "inputFingerprint", "failureCode", "inputModality", "clientRequestId", "providerLatencyMs", "transportCode", "httpStatus"],
  "inference.route_selected": ["route", "reasonCode", "providers", "visualEvidenceUsed", "inputModality"],
  "model.capability_preflight": ["providerRole", "model", "capabilityStatus", "capabilitySource", "inputModalities", "outputModalities", "imageCapability"],
  "inference.attempted": ["taskCode", "attemptNumber", "maxAttempts"],
  "policy.adjudicated": ["disposition", "reasonCode", "policyVersion"],
  "execution.reserved": ["operation", "targetRole", "operationId"],
  "execution.dispatched": ["operation", "targetRole", "dispatchStatus", "operationId"],
  "execution.reconciliation_required": ["operation", "targetRole", "operationId", "dispatchStatus", "reasonCode", "observationErrorClass", "observationAttempts", "evidenceRefs"],
  "execution.observed": ["outcomeClass", "changed", "evidenceRefs"],
  "verification.completed": ["status", "oracleType", "reasonCode", "verifiedCode", "evidenceRefs"],
  "correction.recorded": ["correctionType", "sourceClass", "supersedesDecisionId", "correctedCode", "evidenceRefs"],
  "label.proposed": ["rubricId", "labelCode", "sourceClass", "evidenceRefs"],
  "label.approved": ["labelEventId", "rubricId", "labelCode", "sourceClass", "evidenceRefs", "reviewerId", "approvalDigest"],
  "qualification.started": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "sourceEventIds", "evidenceRefs"],
  "qualification.completed": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "qualificationStatus", "reasonCode", "fixtureSeed", "scenarioSeed", "applicationBuild", "qualificationLevel", "providerIdentity", "sourceRevision", "oracleReference", "independentApplicationOutcome", "cleanupResult", "evidenceRefs"],
  "episode.completed": ["status", "cleanupStatus"]
});

const ENUMS = {
  environmentClass: new Set(["local", "staging", "production", "unknown"]),
  executionMode: new Set(["agent_directed", "agent_assisted", "standalone", "unknown"]),
  operationClass: new Set(["read", "navigation", "test_owned_mutation", "shared_mutation", "security_change", "unknown"]),
  disposition: new Set(["allow", "deny", "suspend", "review"]),
  dispatchStatus: new Set(["dispatched", "refused", "failed", "uncertain"]),
  observationErrorClass: new Set(["timeout", "cdp_transport", "target_detached", "unknown"]),
  status: new Set(["passed", "failed", "blocked", "uncertain", "canceled", "suspended"]),
  cleanupStatus: new Set(["verified", "pending", "failed", "not_required", "unknown"]),
  questionType: new Set(["noul", "choice", "score", "box"]),
  sourceClass: new Set(["deterministic_assertion", "correlated_backend", "independent_human", "coding_agent", "secondary_model", "jev_self"]),
  correctionType: new Set(["target_mapping", "risk_classification", "outcome_label", "recovery", "other"]),
  verificationStatus: new Set(["verified_pass", "verified_fail", "uncertain", "not_run"]),
  qualificationStatus: new Set(["qualified", "not_qualified", "inconclusive", "unavailable"]),
  qualificationLevel: new Set(["resolver", "integration", "outcome", "live"]),
  cleanupResultStatus: new Set(["verified", "unverified", "not_applicable", "not_run"]),
  annotationKind: new Set(["page_classification", "control_mapping", "ambiguity_resolution", "change_analysis", "form_discovery"]),
  failureCode: new Set(["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted", "missing_intent", "unknown"]),
  transportCode: new Set(["connection_refused", "connection_reset", "dns_failure", "network_unreachable", "tls_failure", "fetch_failure", "request_timeout", "response_read_failure", "upstream_rate_limited", "upstream_server_error", "upstream_http_error"]),
  inputKind: new Set(["pre_action_review", "outcome_review", "workflow_plan_review", "visual_assessment_review"]),
  reviewDisposition: new Set(["supported", "needs_agent_review", "advisory_only"]),
  route: new Set(["deterministic", "jev_only", "semantic_only", "jev_then_semantic", "semantic_then_jev", "abstain"]),
  inputModality: new Set(["text_only", "text_plus_visual", "unknown"]),
  capabilityStatus: new Set(["available", "unknown", "unavailable"]),
  capabilitySource: new Set(["authenticated_catalog", "configured_fallback"]),
  lookupMode: new Set(["retained_snapshot", "cdp_dom_location"]),
  lookupStatus: new Set(["unique", "not_found", "ambiguous", "incomplete", "candidate", "unavailable", "stale", "invalid", "expired", "no_hint", "refreshed"]),
  frameScope: new Set(["root", "page", "unknown"]),
  nextActionDisposition: new Set(["deferred", "permitted", "refused"])
};

function normalizeWorkflowPlanProjection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) throw new Error("Workflow plan telemetry must contain a bounded non-empty step projection.");
  const ids = new Set();
  const normalized = value.map(step => {
    const fields = ["stepId", "capabilityId", "effectClass", "targetRole", "verificationCode", "requiresApproval", "dependsOn", "condition", "purposeCodes", "preconditionCodes", "postconditionCodes"];
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(step, key))) {
      throw new Error("Workflow plan telemetry step contains unsupported fields.");
    }
    const stepId = safeCode(step.stepId, "planProjection.stepId", 64);
    if (ids.has(stepId)) throw new Error("Workflow plan telemetry step IDs must be unique.");
    ids.add(stepId);
    if (typeof step.requiresApproval !== "boolean") throw new Error("Workflow plan approval requirement must be boolean.");
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > 24 || new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error("Workflow plan dependencies are outside their bound.");
    const normalizeCodes = (codes, label, required = false) => {
      if (!Array.isArray(codes) || codes.length > 24 || (required && codes.length < 1)) throw new Error(`Workflow plan ${label} are outside their bound.`);
      const normalized = codes.map(code => safeCode(code, `planProjection.${label}`, 64));
      if (new Set(normalized).size !== normalized.length) throw new Error(`Workflow plan ${label} must be unique.`);
      return normalized;
    };
    let condition = null;
    if (step.condition !== null) {
      requireExactKeys(step.condition, ["stepId", "status"], "Workflow plan condition");
      if (!["passed", "failed", "blocked", "uncertain", "skipped"].includes(step.condition.status)) throw new Error("Workflow plan condition status is unsupported.");
      condition = { stepId: safeCode(step.condition.stepId, "planProjection.condition.stepId", 64), status: step.condition.status };
    }
    return {
      stepId,
      capabilityId: safeCode(step.capabilityId, "planProjection.capabilityId", 96),
      effectClass: validateEnum(step.effectClass, "operationClass"),
      targetRole: safeCode(step.targetRole, "planProjection.targetRole", 64),
      verificationCode: safeCode(step.verificationCode, "planProjection.verificationCode", 64),
      requiresApproval: step.requiresApproval,
      dependsOn: step.dependsOn.map(value => safeCode(value, "planProjection.dependsOn", 64)),
      condition,
      purposeCodes: normalizeCodes(step.purposeCodes, "purposeCodes", true),
      preconditionCodes: normalizeCodes(step.preconditionCodes, "preconditionCodes"),
      postconditionCodes: normalizeCodes(step.postconditionCodes, "postconditionCodes", true)
    };
  });
  const prior = new Set();
  for (const step of normalized) {
    if (step.dependsOn.some(id => !prior.has(id))) throw new Error("Workflow plan dependencies must refer to earlier steps.");
    if (step.condition && !step.dependsOn.includes(step.condition.stepId)) throw new Error("Workflow plan conditions must depend on their source step.");
    prior.add(step.stepId);
  }
  return normalized;
}

function normalizeWorkflowReviewProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["state", "questions", "visualEvidence"].includes(key))) {
    throw new Error("Workflow review projection contains unsupported fields.");
  }
  const state = value.state;
  const fields = ["plan_version", "step_count", "task_outcome_code", "review_binding_hash", "steps"];
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Object.keys(state).length !== fields.length || Object.keys(state).some(key => !fields.includes(key))) {
    throw new Error("Workflow review state contains unsupported fields.");
  }
  if (state.plan_version !== 1 || !Number.isInteger(state.step_count) || state.step_count < 1 || state.step_count > 24
    || !isSha256Digest(state.review_binding_hash)
    || !Array.isArray(state.steps) || state.steps.length !== state.step_count) {
    throw new Error("Workflow review state is outside its supported bounds.");
  }
  const steps = state.steps.map(step => {
    const allowed = ["step_id", "capability_id", "effect_class", "target_role", "verification_code", "requires_approval", "depends_on", "condition", "purpose_codes", "precondition_codes", "postcondition_codes"];
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).length !== allowed.length || Object.keys(step).some(key => !allowed.includes(key))) {
      throw new Error("Workflow review step contains unsupported fields.");
    }
    if (typeof step.requires_approval !== "boolean") throw new Error("Workflow review approval requirement must be boolean.");
    if (!Array.isArray(step.depends_on) || step.depends_on.length > 24 || new Set(step.depends_on).size !== step.depends_on.length) throw new Error("Workflow review dependencies are outside their bound.");
    const normalizeCodes = (codes, label, required = false) => {
      if (!Array.isArray(codes) || codes.length > 24 || (required && codes.length < 1)) throw new Error(`Workflow review ${label} are outside their bound.`);
      const normalized = codes.map(code => safeCode(code, `inputProjection.${label}`, 64));
      if (new Set(normalized).size !== normalized.length) throw new Error(`Workflow review ${label} must be unique.`);
      return normalized;
    };
    let condition = null;
    if (step.condition !== null) {
      requireExactKeys(step.condition, ["step_id", "status"], "Workflow review condition");
      if (!["passed", "failed", "blocked", "uncertain", "skipped"].includes(step.condition.status)) throw new Error("Workflow review condition status is unsupported.");
      condition = { step_id: safeCode(step.condition.step_id, "inputProjection.condition.step_id", 64), status: step.condition.status };
    }
    return {
      step_id: safeCode(step.step_id, "inputProjection.step_id", 64),
      capability_id: safeCode(step.capability_id, "inputProjection.capability_id", 96),
      effect_class: validateEnum(step.effect_class, "operationClass"),
      target_role: safeCode(step.target_role, "inputProjection.target_role", 64),
      verification_code: safeCode(step.verification_code, "inputProjection.verification_code", 64),
      requires_approval: step.requires_approval,
      depends_on: step.depends_on.map(value => safeCode(value, "inputProjection.depends_on", 64)),
      condition,
      purpose_codes: normalizeCodes(step.purpose_codes, "purpose_codes", true),
      precondition_codes: normalizeCodes(step.precondition_codes, "precondition_codes"),
      postcondition_codes: normalizeCodes(step.postcondition_codes, "postcondition_codes", true)
    };
  });
  const prior = new Set();
  for (const step of steps) {
    if (step.depends_on.some(id => !prior.has(id))) throw new Error("Workflow review dependencies must refer to earlier steps.");
    if (step.condition && !step.depends_on.includes(step.condition.step_id)) throw new Error("Workflow review conditions must depend on their source step.");
    prior.add(step.step_id);
  }
  return {
    state: {
      plan_version: state.plan_version,
      task_outcome_code: safeCode(state.task_outcome_code, "inputProjection.task_outcome_code", 96),
      review_binding_hash: state.review_binding_hash.toLowerCase(),
      step_count: state.step_count,
      steps
    },
    questions: normalizeQuestionProjection(value.questions),
    ...(value.visualEvidence !== undefined ? { visualEvidence: normalizeVisualEvidenceProjection(value.visualEvidence) } : {})
  };
}

function normalizeJevInputProjection(value, inputKind) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["state", "questions", "visualEvidence"].includes(key))) {
    throw new Error("Jev input projection contains unsupported fields.");
  }
  if (inputKind === "outcome_review" && value.visualEvidence !== undefined) throw new Error("Visual evidence is not accepted for outcome-only Jev review.");
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
  if (inputKind === "visual_assessment_review") {
    const state = value.state;
    if (!state || typeof state !== "object" || Array.isArray(state)
      || Object.keys(state).some(key => !["task_code", "current", "before", "expected_outcome_code", "target_role_code"].includes(key))) {
      throw new Error("Jev visual assessment state contains unsupported fields.");
    }
    const taskCode = safeCode(state.task_code, "inputProjection.task_code", 64);
    if (!["page_classification", "obstruction_detection", "outcome_assessment", "target_grounding"].includes(taskCode)) throw new Error("Jev visual assessment task is unsupported.");
    const expectedStateKeys = taskCode === "outcome_assessment"
      ? ["task_code", "current", "before", "expected_outcome_code"]
      : taskCode === "target_grounding" ? ["task_code", "current", "target_role_code"]
        : ["task_code", "current"];
    if (Object.keys(state).length !== expectedStateKeys.length || expectedStateKeys.some(key => !Object.hasOwn(state, key))) {
      throw new Error("Jev visual assessment state does not match its task contract.");
    }
    const snapshot = (source, label) => {
      const fields = ["document_generation", "candidate_count", "visible_candidate_count", "dialog_count", "ready_state"];
      if (!source || typeof source !== "object" || Array.isArray(source)
        || Object.keys(source).length !== fields.length || Object.keys(source).some(key => !fields.includes(key))) {
        throw new Error(`Jev ${label} visual snapshot contains unsupported fields.`);
      }
      if (!Number.isSafeInteger(source.document_generation) || source.document_generation < 0
        || !Number.isInteger(source.candidate_count) || source.candidate_count < 0 || source.candidate_count > 10_000
        || !Number.isInteger(source.visible_candidate_count) || source.visible_candidate_count < 0 || source.visible_candidate_count > source.candidate_count
        || !Number.isInteger(source.dialog_count) || source.dialog_count < 0 || source.dialog_count > source.candidate_count
        || !["loading", "interactive", "complete", "unknown"].includes(source.ready_state)) {
        throw new Error(`Jev ${label} visual snapshot is outside its bounds.`);
      }
      return { ...source };
    };
    const normalizedState = { task_code: taskCode, current: snapshot(state.current, "current") };
    if (taskCode === "outcome_assessment") {
      if (!Object.hasOwn(state, "before") || !Object.hasOwn(state, "expected_outcome_code")) throw new Error("Visual outcome telemetry requires before-state and expected-outcome codes.");
      normalizedState.before = snapshot(state.before, "before");
      normalizedState.expected_outcome_code = safeCode(state.expected_outcome_code, "inputProjection.expected_outcome_code", 96);
    } else if (taskCode === "target_grounding") {
      normalizedState.target_role_code = safeCode(state.target_role_code, "inputProjection.target_role_code", 96);
    } else if (Object.hasOwn(state, "before") || Object.hasOwn(state, "expected_outcome_code")) {
      throw new Error("Page and obstruction telemetry cannot include outcome-only state.");
    }
    const questions = normalizeQuestionProjection(value.questions);
    return { state: normalizedState, questions, ...(value.visualEvidence !== undefined ? { visualEvidence: normalizeVisualEvidenceProjection(value.visualEvidence) } : {}) };
  }
  if (inputKind !== "pre_action_review") throw new Error("Jev input projection requires a supported review kind.");
  const stateFields = ["operation_code", "operation_class", "requested_target_role", "task_purpose_code", "proposed_control", "page_surface", "alternative_count", "semantic_annotation"];
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
    ...(Object.hasOwn(state, "task_purpose_code") ? { task_purpose_code: safeCode(state.task_purpose_code, "inputProjection.task_purpose_code", 96) } : {}),
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
  return {
    state: normalizedState,
    questions,
    ...(value.visualEvidence !== undefined ? { visualEvidence: normalizeVisualEvidenceProjection(value.visualEvidence) } : {})
  };
}

function normalizeVisualEvidenceProjection(value) {
  const fields = ["evidenceId", "targetId", "documentGeneration", "viewport", "transform", "imageSha256"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error("Jev visual evidence projection contains unsupported fields.");
  }
  if (!Number.isSafeInteger(value.documentGeneration) || value.documentGeneration < 0) {
    throw new Error("Jev visual evidence document generation is invalid.");
  }
  if (!value.viewport || typeof value.viewport !== "object" || Array.isArray(value.viewport)
    || Object.keys(value.viewport).length !== 2
    || !Number.isInteger(value.viewport.width) || value.viewport.width < 1 || value.viewport.width > 16_384
    || !Number.isInteger(value.viewport.height) || value.viewport.height < 1 || value.viewport.height > 16_384) {
    throw new Error("Jev visual evidence viewport is invalid.");
  }
  const transform = value.transform;
  const transformFields = ["version", "sourceWidth", "sourceHeight", "sourceDeviceScaleFactor", "sourcePixelWidth", "sourcePixelHeight", "imageWidth", "imageHeight", "scaleX", "scaleY", "crop"];
  if (!transform || typeof transform !== "object" || Array.isArray(transform)
    || Object.keys(transform).length !== transformFields.length || Object.keys(transform).some(key => !transformFields.includes(key))) {
    throw new Error("Jev visual transform is invalid.");
  }
  const crop = transform.crop;
  if (transform.version !== "jev_image_preparation_v1"
    || transform.sourceWidth !== value.viewport.width || transform.sourceHeight !== value.viewport.height
    || !Number.isFinite(transform.sourceDeviceScaleFactor) || transform.sourceDeviceScaleFactor <= 0 || transform.sourceDeviceScaleFactor > 8
    || transform.sourcePixelWidth !== Math.round(transform.sourceWidth * transform.sourceDeviceScaleFactor)
    || transform.sourcePixelHeight !== Math.round(transform.sourceHeight * transform.sourceDeviceScaleFactor)
    || !Number.isInteger(transform.imageWidth) || transform.imageWidth < 1 || transform.imageWidth > 16_384
    || !Number.isInteger(transform.imageHeight) || transform.imageHeight < 1 || transform.imageHeight > 16_384
    || !Number.isFinite(transform.scaleX) || transform.scaleX <= 0 || transform.scaleX > 16
    || !Number.isFinite(transform.scaleY) || transform.scaleY <= 0 || transform.scaleY > 16
    || Math.abs(transform.scaleX - transform.imageWidth / transform.sourceWidth) > 1e-6
    || Math.abs(transform.scaleY - transform.imageHeight / transform.sourceHeight) > 1e-6
    || !crop || typeof crop !== "object" || Array.isArray(crop)
    || Object.keys(crop).length !== 4 || Object.keys(crop).some(key => !["x", "y", "width", "height"].includes(key))
    || crop.x !== 0 || crop.y !== 0 || crop.width !== value.viewport.width || crop.height !== value.viewport.height) {
    throw new Error("Jev visual transform does not map the complete source viewport.");
  }
  if (!isSha256Digest(value.imageSha256)) throw new Error("Jev visual evidence image digest is invalid.");
  return {
    evidenceId: safeCode(value.evidenceId, "visualEvidence.evidenceId", 128),
    targetId: safeCode(value.targetId, "visualEvidence.targetId", 256),
    documentGeneration: value.documentGeneration,
    viewport: { width: value.viewport.width, height: value.viewport.height },
    transform: {
      version: transform.version,
      sourceWidth: transform.sourceWidth,
      sourceHeight: transform.sourceHeight,
      sourceDeviceScaleFactor: transform.sourceDeviceScaleFactor,
      sourcePixelWidth: transform.sourcePixelWidth,
      sourcePixelHeight: transform.sourcePixelHeight,
      imageWidth: transform.imageWidth,
      imageHeight: transform.imageHeight,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
    },
    imageSha256: value.imageSha256.toLowerCase()
  };
}

function normalizeQuestionProjection(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Jev input projection requires bounded question identifiers.");
  return value.map(question => {
    if (!question || typeof question !== "object" || Array.isArray(question) || Object.keys(question).some(key => !["id", "type", "instructions", "criteria"].includes(key))) throw new Error("Jev question projection contains unsupported fields.");
    const id = safeCode(question.id, "inputProjection.question.id", 64);
    const type = validateEnum(question.type, "questionType");
    if (question.instructions === undefined) return { id, type };
    if (typeof question.instructions !== "string" || question.instructions.length < 1 || question.instructions.length > 1000) throw new Error("Jev question instructions are outside their bound.");
    if (["noul", "box"].includes(type)) {
      requireExactKeys(question, ["id", "type", "instructions"], "Jev Noul/Box question projection");
      return { id, type, instructions: question.instructions };
    }
    if (type === "choice") {
      requireExactKeys(question, ["id", "type", "instructions", "criteria"], "Jev Choice question projection");
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 32) throw new Error("Jev Choice question projection requires bounded criteria.");
      const normalizedCriteria = {};
      for (const [key, description] of Object.entries(criteria)) {
        normalizedCriteria[safeCode(key, "inputProjection.question.criteria", 64)] = safeText(description, "inputProjection.question.criteria description", 500);
      }
      return { id, type, instructions: question.instructions, criteria: normalizedCriteria };
    }
    requireExactKeys(question, ["id", "type", "instructions", "criteria"], "Jev Score question projection");
    if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 32) throw new Error("Jev Score question projection requires bounded criteria.");
    return { id, type, instructions: question.instructions, criteria: question.criteria.map(item => safeText(item, "inputProjection.question.criteria", 500)) };
  });
}

function safeText(value, field, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) throw new Error(`Telemetry field '${field}' must be bounded text.`);
  return value;
}

function normalizeSemanticInputProjection(value) {
  const projectionFields = ["observationId", "requestedRoles", "intentHints", "pageLabelsIncluded", "candidateCoverage", "candidates", "visualEvidence"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !projectionFields.includes(key))) {
    throw new Error("Semantic input projection contains unsupported fields.");
  }
  if (typeof value.pageLabelsIncluded !== "boolean") throw new Error("Semantic input projection requires a page-label disclosure flag.");
  const coverage = value.candidateCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
    || Object.keys(coverage).length !== 3 || Object.keys(coverage).some(key => !["eligibleCandidateCount", "submittedCandidateCount", "disposition"].includes(key))
    || !Number.isInteger(coverage.eligibleCandidateCount) || coverage.eligibleCandidateCount < 0 || coverage.eligibleCandidateCount > 10_000
    || !Number.isInteger(coverage.submittedCandidateCount) || coverage.submittedCandidateCount < 0 || coverage.submittedCandidateCount > 256
    || coverage.submittedCandidateCount > coverage.eligibleCandidateCount
    || !["complete", "incomplete"].includes(coverage.disposition)) {
    throw new Error("Semantic input requires a bounded candidate coverage contract.");
  }
  const normalizeCodes = (items, field, maximum) => {
    if (!Array.isArray(items) || items.length < 1 || items.length > maximum) throw new Error(`Semantic input '${field}' is outside its bounds.`);
    return [...new Set(items.map(item => safeCode(item, field, 96)))];
  };
  if (!Array.isArray(value.candidates) || value.candidates.length > 256) throw new Error("Semantic input candidates exceed their bound.");
  if (coverage.submittedCandidateCount !== value.candidates.length
    || (coverage.disposition === "complete" && coverage.submittedCandidateCount !== coverage.eligibleCandidateCount)
    || (coverage.disposition === "incomplete" && coverage.submittedCandidateCount >= coverage.eligibleCandidateCount)) {
    throw new Error("Semantic candidate coverage does not match the submitted eligible set.");
  }
  const candidates = value.candidates.map(candidate => {
    const allowedFields = ["candidateRef", "role", "tag", "visible", "disabled", "label", "context", "semanticContext"];
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
      ...(!value.pageLabelsIncluded ? { label: "", context: "" } : {}),
      ...(candidate.semanticContext !== undefined
        ? { semanticContext: normalizeSemanticCandidateContext(candidate.semanticContext) } : {})
    };
  });
  return {
    observationId: safeCode(value.observationId, "inputProjection.observationId", 96),
    requestedRoles: normalizeCodes(value.requestedRoles, "requestedRoles", 32),
    intentHints: Array.isArray(value.intentHints) && value.intentHints.length === 0
      ? []
      : normalizeCodes(value.intentHints, "intentHints", 32),
    pageLabelsIncluded: value.pageLabelsIncluded,
    candidateCoverage: {
      eligibleCandidateCount: coverage.eligibleCandidateCount,
      submittedCandidateCount: coverage.submittedCandidateCount,
      disposition: coverage.disposition
    },
    candidates,
    ...(value.visualEvidence !== undefined ? { visualEvidence: normalizeVisualEvidenceProjection(value.visualEvidence) } : {})
  };
}

const SEMANTIC_CONTEXT_ROLES = new Set([
  "name", "price", "description", "sku", "rating", "date", "author", "category", "location", "count",
  "url", "image", "brand", "availability", "country", "population"
]);

function normalizeSemanticCandidateContext(value) {
  const fields = ["version", "pageType", "regionKind", "regionLabel", "collectionKind", "collectionFields", "recordOrdinal", "recordFields", "interactionMechanic", "interactionReadiness", "effect"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
    || fields.some(key => !Object.hasOwn(value, key)) || value.version !== 1
    || !["article", "tabular_data", "repeated_content", "form", "navigation", "unknown"].includes(value.pageType)
    || !(value.regionKind === null || typeof value.regionKind === "string" && /^[a-z][a-z0-9_-]{0,47}$/u.test(value.regionKind))
    || typeof value.regionLabel !== "string" || value.regionLabel.length > 120
    || !(value.collectionKind === null || typeof value.collectionKind === "string" && /^[a-z][a-z0-9_-]{0,47}$/u.test(value.collectionKind))
    || !(value.recordOrdinal === null || Number.isInteger(value.recordOrdinal) && value.recordOrdinal >= 1 && value.recordOrdinal <= 10_000)
    || !["follow_link", "enter_text", "choose_option", "toggle_control", "activate_control", "submit_form", "unknown"].includes(value.interactionMechanic)
    || !["visible_enabled", "disabled", "not_visible", "unknown"].includes(value.interactionReadiness)
    || value.effect !== "unknown") {
    throw new Error("Semantic candidate context is outside its bounded evidence contract.");
  }
  if (value.regionLabel !== "") throw new Error("Semantic candidate labels are never retained in decision telemetry.");
  const normalizeFields = (items, maximum) => {
    if (!Array.isArray(items) || items.length > maximum) throw new Error("Semantic candidate fields exceed their bound.");
    return items.map(field => {
      const allowed = ["name", "semanticRole", "semanticRoleStatus", "label", "value", "status"];
      if (!field || typeof field !== "object" || Array.isArray(field) || Object.keys(field).some(key => !allowed.includes(key))
        || allowed.some(key => !Object.hasOwn(field, key))
        || typeof field.name !== "string" || field.name.length > 120
        || !(field.semanticRole === null || SEMANTIC_CONTEXT_ROLES.has(field.semanticRole))
        || !["observed", "inferred", "unknown"].includes(field.semanticRoleStatus)
        || typeof field.label !== "string" || field.label.length > 120
        || typeof field.value !== "string" || field.value.length > 180
        || !["observed", "inferred", "unknown"].includes(field.status)) {
        throw new Error("Semantic candidate field is invalid.");
      }
      if (field.name !== "" || field.label !== "" || field.value !== "") {
        throw new Error("Semantic candidate field text is never retained in decision telemetry.");
      }
      return { ...field };
    });
  };
  if (!Array.isArray(value.collectionFields) || value.collectionFields.length > 12
    || !Array.isArray(value.recordFields) || value.recordFields.length > 8) {
    throw new Error("Semantic candidate context fields exceed their bound.");
  }
  return {
    version: value.version,
    pageType: value.pageType,
    regionKind: value.regionKind,
    regionLabel: value.regionLabel,
    collectionKind: value.collectionKind,
    collectionFields: normalizeFields(value.collectionFields, 12),
    recordOrdinal: value.recordOrdinal,
    recordFields: normalizeFields(value.recordFields, 8),
    interactionMechanic: value.interactionMechanic,
    interactionReadiness: value.interactionReadiness,
    effect: value.effect
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
    if (value.type !== "box" || !box || [box.top, box.bottom, box.left, box.right].some(n => !Number.isFinite(n) || n < 0 || n > 1)
      || !(box.left < box.right) || !(box.top < box.bottom)) throw new Error("Box telemetry answers require ordered normalized coordinates.");
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
    else if (field === "reviewDisposition") out[field] = validateEnum(value, field);
    else if (["candidateCount", "visibleCount", "stepCount", "attemptNumber", "maxAttempts", "observationAttempts", "returnedCount", "visitedNodeCount"].includes(field)) {
      if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`Telemetry field '${field}' must be a bounded non-negative integer.`);
      out[field] = value;
      if (["attemptNumber", "maxAttempts"].includes(field) && (value < 1 || value > 4)) throw new Error(`Telemetry field '${field}' must be between 1 and 4.`);
      if (field === "observationAttempts" && (value < 1 || value > 2)) throw new Error("Telemetry observationAttempts must be 1 or 2.");
    } else if (field === "documentGeneration") {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Telemetry documentGeneration must be a non-negative safe integer.");
      out[field] = value;
    } else if (field === "fixtureSeed") {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Telemetry fixtureSeed must be a non-negative safe integer.");
      out[field] = value;
    } else if (field === "scenarioSeed") {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Telemetry scenarioSeed must be a non-negative safe integer.");
      out[field] = value;
    } else if (field === "applicationBuild") {
      out[field] = safeCode(value, field, 128);
    } else if (field === "qualificationLevel") {
      out[field] = validateEnum(value, field);
    } else if (["providerIdentity", "oracleReference"].includes(field)) {
      out[field] = safeCode(value, field, 128);
    } else if (field === "sourceRevision") {
      out[field] = safeModelId(value, field);
    } else if (field === "independentApplicationOutcome") {
      if (typeof value !== "boolean") throw new Error("Telemetry independentApplicationOutcome must be boolean.");
      out[field] = value;
    } else if (field === "cleanupResult") {
      requireExactKeys(value, ["status", "reasonCode"], "Qualification cleanup result");
      out[field] = {
        status: validateEnum(value.status, "cleanupResultStatus"),
        ...(value.reasonCode !== undefined ? { reasonCode: safeCode(value.reasonCode, "cleanupResult.reasonCode", 96) } : {})
      };
    } else if (field === "planVersion") {
      if (value !== 1) throw new Error("Workflow plan telemetry supports only version 1.");
      out[field] = value;
    } else if (field === "changed") {
      if (typeof value !== "boolean") throw new Error("Telemetry field 'changed' must be boolean.");
      out[field] = value;
    } else if (field === "confidence") {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Telemetry confidence must be in [0, 1].");
      out[field] = value;
    } else if (["inputFingerprint", "planHash", "taskContractHash", "capabilityCatalogHash", "bindingHash"].includes(field)) {
      if (!isSha256Digest(value)) throw new Error(`Telemetry ${field} must be a SHA-256 digest.`);
      out[field] = value.toLowerCase();
    } else if (field === "reviewPolicyVersion") {
      out[field] = safeCode(value, field, 64);
    } else if (field === "targetId") {
      out[field] = safeCode(value, field, 128);
    } else if (field === "frameTargetId" || field === "frameId") {
      out[field] = value === null ? null : safeCode(value, field, 128);
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
    } else if (field === "providers") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 2
        || value.some(provider => !["deterministic", "secondary", "jev"].includes(provider))) {
        throw new Error("Inference route providers must be a bounded list of supported providers.");
      }
      out[field] = [...new Set(value)];
    } else if (field === "visualEvidenceUsed") {
      if (typeof value !== "boolean") throw new Error("Inference route visualEvidenceUsed must be boolean.");
      out[field] = value;
    } else if (field === "inputModality") {
      out[field] = validateEnum(value, field);
    } else if (field === "transportCode") {
      out[field] = validateEnum(value, field);
    } else if (field === "clientRequestId") {
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
        throw new Error("Telemetry clientRequestId must be a generated UUID.");
      }
      out[field] = value.toLowerCase();
    } else if (field === "providerLatencyMs") {
      if (!Number.isInteger(value) || value < 0 || value > 300_000) throw new Error("Telemetry providerLatencyMs must be a bounded non-negative integer.");
      out[field] = value;
    } else if (field === "elapsedMs") {
      if (!Number.isInteger(value) || value < 0 || value > 120_000) throw new Error("Telemetry elapsedMs must be a bounded non-negative integer.");
      out[field] = value;
    } else if (field === "httpStatus") {
      if (!Number.isInteger(value) || value < 100 || value > 599) throw new Error("Telemetry httpStatus must be a valid HTTP status code.");
      out[field] = value;
    } else if (field === "selectedCandidateFingerprint") {
      if (!isSha256Digest(value)) throw new Error("Planner candidate fingerprint must be a SHA-256 digest.");
      out[field] = value.toLowerCase();
    } else if (field === "capabilityStatus" || field === "capabilitySource") {
      out[field] = validateEnum(value, field);
    } else if (field === "providerRole") {
      out[field] = safeCode(value, field, 32);
    } else if (field === "inputModalities") {
      if (!Array.isArray(value) || value.length > 4 || value.some(item => !["text", "image", "audio", "video"].includes(item))) {
        throw new Error("Model capability modalities must be a bounded supported list.");
      }
      out[field] = [...new Set(value)].sort();
    } else if (field === "outputModalities") {
      if (!Array.isArray(value) || value.length > 4 || value.some(item => !["text", "image", "audio", "video"].includes(item))) {
        throw new Error("Model capability modalities must be a bounded supported list.");
      }
      out[field] = [...new Set(value)].sort();
    } else if (field === "imageCapability") {
      if (typeof value !== "boolean") throw new Error("Model image capability must be boolean.");
      out[field] = value;
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
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"]) {
        if (value[key] !== undefined) {
          if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 10_000_000) throw new Error(`Decision usage '${key}' must be a bounded non-negative integer.`);
          usage[key] = value[key];
        }
      }
      if (value.cost !== undefined) {
        if (!Number.isFinite(value.cost) || value.cost < 0 || value.cost > 1000) throw new Error("Decision usage cost must be bounded and non-negative.");
        usage.cost = value.cost;
      }
      for (const key of Object.keys(value)) if (!["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cost"].includes(key)) throw new Error(`Decision usage field '${key}' is not allowed.`);
      if (usage.cachedInputTokens !== undefined && usage.inputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) throw new Error("Cached input tokens cannot exceed total input tokens.");
      out[field] = usage;
    } else if (field === "candidateRoles" || field === "parameterNames") {
      if (!Array.isArray(value) || value.length > 64) throw new Error(`Telemetry field '${field}' must be a bounded array.`);
      out[field] = [...new Set(value.map(item => field === "candidateRoles" ? normalizeObservedRole(item) : safeCode(item, field, 64)))].sort();
    } else if (field === "rubricIds") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Telemetry rubricIds must be a bounded non-empty array.");
      out[field] = [...new Set(value.map(item => safeCode(item, field, 64)))].sort();
    } else if (field === "answer") out[field] = normalizeAnswer(value, payload.questionType);
    else if (field === "model" || field === "modelSnapshot" || field === "analyzerModel") out[field] = safeModelId(value, field);
    else if (field === "status" && eventType === "verification.completed") out[field] = validateEnum(value, "verificationStatus");
    else if (["annotationKind", "observationErrorClass", "lookupMode", "lookupStatus", "frameScope", "nextActionDisposition"].includes(field)) out[field] = validateEnum(value, field);
    else if (field === "workflowKind" || field === "applicationId" || field === "environmentClass" || field === "executionMode" || field === "operationClass" || field === "disposition" || field === "dispatchStatus" || field === "status" || field === "cleanupStatus" || field === "questionType" || field === "sourceClass" || field === "correctionType" || field === "failureCode" || field === "qualificationStatus" || field === "route") {
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
    "target.lookup": ["lookupMode", "lookupStatus", "targetId", "documentGeneration", "frameScope", "frameTargetId", "frameId", "returnedCount", "visitedNodeCount", "stopReason", "elapsedMs", "nextActionDisposition"],
    "decision.input_captured": ["inputKind", "inputProjection", "rubricIds", "inputFingerprint"],
    "decision.skipped": ["reasonCode", "inputEventIds"],
    "decision.predicted": ["provider", "model", "rubricId", "rubricVersion", "questionType", "answer"],
    "decision.failed": ["provider", "model", "rubricId", "rubricVersion", "questionType", "failureCode"],
    "planner.predicted": ["provider", "model", "inputFingerprint", "inputModality", "resultCode"],
    "planner.failed": ["provider", "model", "inputFingerprint", "inputModality", "failureCode"],
    "policy.adjudicated": ["disposition", "reasonCode", "policyVersion"],
    "execution.reserved": ["operation", "targetRole", "operationId"],
    "execution.dispatched": ["operation", "dispatchStatus", "operationId"],
    "execution.reconciliation_required": ["operation", "targetRole", "operationId", "dispatchStatus", "reasonCode", "observationErrorClass", "observationAttempts", "evidenceRefs"],
    "execution.observed": ["outcomeClass", "changed", "evidenceRefs"],
    "verification.completed": ["status", "oracleType", "reasonCode", "evidenceRefs"],
    "correction.recorded": ["correctionType", "sourceClass", "correctedCode"],
    "label.proposed": ["rubricId", "labelCode", "sourceClass", "evidenceRefs"],
    "label.approved": ["labelEventId", "rubricId", "labelCode", "sourceClass", "evidenceRefs", "reviewerId", "approvalDigest"],
    "qualification.started": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "sourceEventIds", "evidenceRefs"],
    "qualification.completed": ["qualificationId", "automationRunId", "scenarioId", "providerId", "trigger", "principalId", "strategyFingerprint", "qualificationStatus", "reasonCode", "evidenceRefs"],
    "workflow.plan_synthesized": ["provider", "model", "planVersion", "planHash", "inputFingerprint", "stepCount", "planProjection"],
    "workflow.plan_failed": ["provider", "model", "planVersion", "inputFingerprint", "failureCode"],
    "inference.route_selected": ["route", "reasonCode", "providers", "visualEvidenceUsed"],
    "inference.attempted": ["taskCode", "attemptNumber", "maxAttempts"],
    "model.capability_preflight": ["providerRole", "model", "capabilityStatus", "capabilitySource", "inputModalities", "outputModalities", "imageCapability"],
    "episode.completed": ["status", "cleanupStatus"]
  }[eventType];
  for (const field of required) if (out[field] === undefined) throw new Error(`Telemetry event '${eventType}' requires '${field}'.`);
  if (["semantic.input_captured", "decision.input_captured"].includes(eventType) && out.inputModality === undefined) {
    out.inputModality = out.inputProjection?.visualEvidence ? "text_plus_visual" : "text_only";
  }
  if (eventType === "decision.input_captured" && out.inputKind === "workflow_plan_review"
    && ["planHash", "taskContractHash", "capabilityCatalogHash", "bindingHash", "targetId", "documentGeneration", "reviewPolicyVersion"].some(field => out[field] === undefined)) {
    throw new Error("Workflow-plan review telemetry requires its complete exact review binding.");
  }
  if (eventType === "inference.route_selected" && out.inputModality === undefined) {
    out.inputModality = out.visualEvidenceUsed ? "text_plus_visual" : "text_only";
  }
  if (eventType === "qualification.completed" && ["qualified", "not_qualified"].includes(out.qualificationStatus)) {
    for (const field of ["qualificationLevel", "providerIdentity", "scenarioSeed", "sourceRevision", "oracleReference", "independentApplicationOutcome", "cleanupResult"]) {
      if (out[field] === undefined) throw new Error(`Telemetry qualification receipt requires '${field}'.`);
    }
  }
  if (eventType === "qualification.completed" && out.qualificationLevel === "resolver" && out.independentApplicationOutcome !== undefined && out.independentApplicationOutcome !== false) {
    throw new Error("Resolver qualification cannot claim an independent application outcome.");
  }
  if (eventType === "qualification.completed" && ["qualified", "not_qualified"].includes(out.qualificationStatus)
    && ["outcome", "live"].includes(out.qualificationLevel) && out.independentApplicationOutcome !== true) {
    throw new Error("Outcome and live qualification require an independent application outcome.");
  }
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
  if (["semantic.input_captured", "semantic.annotated", "semantic.failed", "target.resolved", "target.lookup", "decision.input_captured", "decision.skipped", "decision.predicted", "decision.failed", "planner.predicted", "planner.failed", "policy.adjudicated", "execution.reserved", "execution.dispatched", "execution.reconciliation_required", "execution.observed", "verification.completed", "correction.recorded", "label.proposed", "label.approved", "qualification.started", "qualification.completed", "workflow.plan_synthesized", "workflow.plan_failed", "inference.route_selected", "inference.attempted", "model.capability_preflight"].includes(eventType) && !input.decisionId) {
    throw new Error(`Telemetry event '${eventType}' requires a stable decisionId.`);
  }
  if (eventType === "target.lookup" && (!input.stepId || !input.observationId)) {
    throw new Error("Target lookup telemetry requires its step and source observation identities.");
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("Decision event timestamp must be valid ISO date text.");
  const payload = normalizePayload(eventType, input.payload);
  const capturedVisualEvidence = payload.inputProjection?.visualEvidence;
  if (capturedVisualEvidence && input.observationId !== capturedVisualEvidence.evidenceId) {
    throw new Error("Jev visual evidence must match the decision input's observation identity.");
  }
  if (eventType === "semantic.input_captured" && payload.inputProjection.observationId !== input.observationId) {
    throw new Error("Semantic input projection must match the decision input's observation identity.");
  }
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
    payload
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
