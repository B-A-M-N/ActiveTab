import { isBoundVisualEvidence } from "../navigation/visualEvidence.js";

const SENSITIVE_EFFECTS = new Set(["shared_mutation", "security_change"]);
const GENERIC_REVIEW_TARGETS = new Set(["unknown", "browser_control", "browser_target", "navigation_link", "button", "link", "control"]);

export function hasReviewIntent({ targetRole = null, purposeCode = null } = {}) {
  const valid = value => typeof value === "string" && /^[a-z0-9][a-z0-9_:-]{0,95}$/u.test(value);
  return valid(purposeCode)
    || (valid(targetRole) && !GENERIC_REVIEW_TARGETS.has(targetRole));
}

/** Route an already selected operation according to its trusted risk and evidence uncertainty. */
export function selectPreActionDecisionRoute({
  actionAdmitted = true,
  workflowReview = null,
  workflowReviewBound = false,
  reviewRequired = false,
  riskClass = "unknown",
  uncertaintyClass = "resolved",
  visualEvidenceAvailable = false,
  reviewIntentAvailable = false
} = {}) {
  if (!actionAdmitted) {
    return Object.freeze({ route: "deterministic", reasonCode: "action_policy_refused", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (workflowReviewBound === true && workflowReview?.status === "reviewed"
    && workflowReview?.reviewOutcome === "supported"
    && workflowReview?.disposition === "supported"
    && workflowReview?.bindingStatus === "bound"
    && workflowReview?.reviewPolicyVersion === "workflow_plan_review_v1"
    && typeof workflowReview?.planHash === "string"
    && typeof workflowReview?.observationId === "string"
    && typeof workflowReview?.reviewBindingHash === "string"
    && typeof workflowReview?.taskContractHash === "string"
    && typeof workflowReview?.capabilityCatalogHash === "string"
    && typeof workflowReview?.targetId === "string"
    && Number.isSafeInteger(workflowReview?.documentGeneration)) {
    return Object.freeze({ route: "deterministic", reasonCode: "covered_by_batched_workflow_review", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (reviewRequired || SENSITIVE_EFFECTS.has(riskClass)) {
    return visualEvidenceAvailable === true && reviewIntentAvailable === true
      ? Object.freeze({ route: "jev_only", reasonCode: "consequential_operation_review", providers: ["jev"], visualEvidenceUsed: true })
      : Object.freeze({ route: "deterministic", reasonCode: "review_insufficient_evidence", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (uncertaintyClass === "ambiguous" && visualEvidenceAvailable === true && reviewIntentAvailable === true) {
    return Object.freeze({ route: "jev_only", reasonCode: "visual_target_uncertainty", providers: ["jev"], visualEvidenceUsed: true });
  }
  if (uncertaintyClass === "ambiguous" || visualEvidenceAvailable === true && reviewIntentAvailable !== true) {
    return Object.freeze({ route: "deterministic", reasonCode: "review_insufficient_evidence", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  return Object.freeze({ route: "deterministic", reasonCode: "fresh_target_and_local_policy_sufficient", providers: ["deterministic"], visualEvidenceUsed: false });
}

export function selectVisualAssessmentRoute({ imagePermission = false, visualEvidenceBound = false, task = null } = {}) {
  if (!imagePermission) {
    return Object.freeze({ route: "deterministic", reasonCode: "image_permission_denied", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (!visualEvidenceBound) {
    return Object.freeze({ route: "deterministic", reasonCode: "visual_evidence_unavailable", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  return Object.freeze({
    route: "jev_only",
    reasonCode: task === "target_grounding" ? "ambiguous_visual_target_grounding" : "ambiguous_page_state_review",
    providers: ["jev"],
    visualEvidenceUsed: true
  });
}

const INTENT_CARDINALITIES = new Set(["atomic", "compound", "unknown"]);

function intentCardinality(value) {
  return INTENT_CARDINALITIES.has(value) ? value : "unknown";
}

/**
 * Route standalone navigation through deterministic evidence first. Jev is
 * useful for an unexplained page state; candidate ambiguity or a compound
 * task needs the semantic planner directly.
 */
export function selectAutomaticNavigationRoute({
  goal,
  deterministicPlan,
  intentShape = "unknown",
  semanticAvailable = false,
  visualAssessmentAvailable = false,
  visualGroundingAvailable = false
} = {}) {
  // Cardinality is a typed caller contract. Natural-language wording is not
  // sufficient evidence to let a local matcher treat a request as atomic.
  const cardinality = intentCardinality(intentShape);
  if (cardinality !== "atomic" && semanticAvailable) {
    return Object.freeze({
      route: "semantic_only",
      reasonCode: cardinality === "compound" ? "compound_navigation_requires_planning" : "intent_cardinality_unclassified",
      providers: ["secondary"],
      visualEvidenceUsed: false
    });
  }
  if (cardinality === "atomic" && deterministicPlan?.status === "planned" && deterministicPlan.action?.type === "scroll") {
    return Object.freeze({ route: "deterministic", reasonCode: "unique_fresh_scroll_region", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (deterministicPlan?.status === "planned" && Number.isFinite(deterministicPlan.confidence)
    && deterministicPlan.confidence >= 0.8 && cardinality === "atomic") {
    return Object.freeze({ route: "deterministic", reasonCode: "unique_fresh_candidate", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (cardinality === "atomic" && deterministicPlan?.status === "ambiguous" && deterministicPlan.candidates?.length > 1
    && visualGroundingAvailable) {
    return Object.freeze({ route: "jev_only", reasonCode: "ambiguous_visual_target_grounding", providers: ["jev"], visualEvidenceUsed: true });
  }
  if (cardinality === "atomic" && deterministicPlan?.status === "ambiguous" && !(deterministicPlan.candidates?.length)
    && visualAssessmentAvailable) {
    return Object.freeze({ route: "jev_only", reasonCode: "unclassified_page_state", providers: ["jev"], visualEvidenceUsed: true });
  }
  if (semanticAvailable) {
    return Object.freeze({ route: "semantic_only", reasonCode: "deterministic_resolution_insufficient", providers: ["secondary"], visualEvidenceUsed: false });
  }
  if (cardinality !== "atomic") {
    return Object.freeze({ route: "abstain", reasonCode: "intent_contract_unavailable", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  return Object.freeze({ route: "deterministic", reasonCode: "secondary_provider_unavailable", providers: ["deterministic"], visualEvidenceUsed: false });
}

/**
 * Pick the workflow planning path from fresh deterministic evidence first.
 * This is a call-cost policy only; executor admission and verification still
 * decide whether an operation may run and whether its outcome passed.
 */
export function selectWorkflowPlanningRoute({
  goal,
  deterministicPlan,
  deterministicReadAvailable = false,
  allowDeterministic = false,
  semanticAvailable = true,
  taskIntent = null,
  intentShape = taskIntent?.cardinality ?? "unknown",
  inputs = {},
  knowledge = []
} = {}) {
  if (deterministicReadAvailable === true) {
    return Object.freeze({ route: "deterministic", reasonCode: "single_bound_observed_read", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  const cardinality = intentCardinality(intentShape);
  const intentRequiresModel = Boolean(taskIntent?.requiredCapabilityIds?.length
    || taskIntent?.targetRoles?.length || taskIntent?.constraints?.length
    || cardinality !== "atomic");
  const directAction = deterministicPlan?.action;
  const safeDirectAction = directAction
    && ["click", "scroll"].includes(directAction.type)
    && directAction.target?.submitsForm !== true;
  const deterministicShortcutAvailable = allowDeterministic && deterministicPlan?.status === "planned"
    && Number.isFinite(deterministicPlan.confidence) && deterministicPlan.confidence >= 0.8
    && safeDirectAction && cardinality === "atomic" && !intentRequiresModel
    && !Object.keys(inputs ?? {}).length && !knowledge?.length;
  if (!semanticAvailable) {
    if (deterministicShortcutAvailable) {
      return Object.freeze({ route: "deterministic", reasonCode: "unique_fresh_candidate", providers: ["deterministic"], visualEvidenceUsed: false });
    }
    return Object.freeze({ route: "abstain", reasonCode: "workflow_synthesizer_unconfigured", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  if (deterministicShortcutAvailable) {
    return Object.freeze({ route: "deterministic", reasonCode: "unique_fresh_candidate", providers: ["deterministic"], visualEvidenceUsed: false });
  }
  return Object.freeze({ route: "semantic_only", reasonCode: intentRequiresModel ? "workflow_intent_requires_planning" : "deterministic_resolution_insufficient", providers: ["secondary"], visualEvidenceUsed: false });
}

/**
 * Jev adds a second opinion when the synthesized workflow is consequential,
 * genuinely multi-step, or can be checked against the same fresh screenshot.
 */
export function selectWorkflowReviewRoute({ result, observation, jevAvailable = false, jevImageAvailable = false } = {}) {
  const steps = result?.plan?.steps ?? [];
  const bindings = result?.bindings instanceof Map ? result.bindings : new Map();
  const capabilities = result?.capabilities?.byId;
  const consequential = steps.some(step => {
    const capability = capabilities?.get?.(step.capabilityId);
    const binding = step.targetRef ? bindings.get(step.targetRef) : null;
    const target = binding ? (observation?.candidates ?? []).find(candidate => candidate.identity === binding.identity) : null;
    return capability?.requiresApproval === true
      || SENSITIVE_EFFECTS.has(capability?.effectClass)
      || ["upload", "toggle"].includes(capability?.action)
      || target?.submitsForm === true;
  });
  const hasVisualEvidence = jevImageAvailable && isBoundVisualEvidence(observation, observation?.visualEvidence);
  const shouldReview = steps.length > 1 || consequential || hasVisualEvidence;
  if (!jevAvailable || !shouldReview) {
    return Object.freeze({
      route: "semantic_only",
      reasonCode: !jevAvailable ? "jev_unavailable" : "routine_plan_needs_no_second_review",
      providers: ["secondary"],
      visualEvidenceUsed: false,
      review: false
    });
  }
  return Object.freeze({
    route: "jev_only",
    reasonCode: consequential ? "consequential_plan_review" : hasVisualEvidence ? "visual_plan_review" : "multi_step_plan_review",
    providers: ["jev"],
    visualEvidenceUsed: hasVisualEvidence,
    review: true
  });
}
