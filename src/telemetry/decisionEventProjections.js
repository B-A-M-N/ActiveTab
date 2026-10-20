import { isSha256Digest, normalizeObservedRole, normalizeObservedTag } from "./privacy.js";
import { requireExactKeys, safeCode, validateEnum } from "./decisionEventValidation.js";

export function normalizeWorkflowPlanProjection(value) {
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

export function normalizeJevInputProjection(value, inputKind) {
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

export function normalizeSemanticInputProjection(value) {
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
