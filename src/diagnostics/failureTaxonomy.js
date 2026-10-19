/** Stable, content-free failure categories shared by investigations and traces. */

export const FAILURE_CLASSIFICATION = Object.freeze({
  NAVIGATION: "navigation",
  ASSERTION: "assertion",
  NETWORK: "network",
  AUTHORIZATION: "authorization",
  DIAGNOSTIC: "diagnostic",
  BROWSER_TRANSPORT: "browser_transport",
  TARGET_LEASE: "target_lease",
  STALE_OBSERVATION: "stale_observation",
  VISUAL_GROUNDING: "visual_grounding",
  SEMANTIC_PLAN: "semantic_plan",
  JEV_REVIEW: "jev_review",
  OPERATION_DISPATCH: "dispatch",
  UNCERTAIN_REMOTE_EFFECT: "uncertain_remote_effect",
  POSTCONDITION: "postcondition",
  EXTRACTION: "extraction",
  SCHEMA: "schema",
  ARTIFACT_PERSISTENCE: "artifact_persistence",
  FIXTURE_SETUP: "fixture_setup",
  ORACLE: "oracle",
  CLEANUP: "cleanup",
  MODEL_BUDGET: "model_budget",
  UNKNOWN: "unknown"
});

const REASON_CODE_CLASSIFICATION = new Map([
  ["browser_launch_failed", FAILURE_CLASSIFICATION.BROWSER_TRANSPORT],
  ["cdp_transport_failed", FAILURE_CLASSIFICATION.BROWSER_TRANSPORT],
  ["browser_connection_failed", FAILURE_CLASSIFICATION.BROWSER_TRANSPORT],
  ["target_lease_lost", FAILURE_CLASSIFICATION.TARGET_LEASE],
  ["target_lease_expired", FAILURE_CLASSIFICATION.TARGET_LEASE],
  ["target_lease_failed", FAILURE_CLASSIFICATION.TARGET_LEASE],
  ["stale_observation", FAILURE_CLASSIFICATION.STALE_OBSERVATION],
  ["observation_stale", FAILURE_CLASSIFICATION.STALE_OBSERVATION],
  ["visual_grounding_failed", FAILURE_CLASSIFICATION.VISUAL_GROUNDING],
  ["semantic_plan_invalid", FAILURE_CLASSIFICATION.SEMANTIC_PLAN],
  ["workflow_plan_invalid", FAILURE_CLASSIFICATION.SEMANTIC_PLAN],
  ["extraction_discovery_failed", FAILURE_CLASSIFICATION.EXTRACTION],
  ["extraction_incomplete", FAILURE_CLASSIFICATION.EXTRACTION],
  ["qualification_failed", FAILURE_CLASSIFICATION.FIXTURE_SETUP],
  ["fixture_setup_failed", FAILURE_CLASSIFICATION.FIXTURE_SETUP],
  ["workflow_failed", FAILURE_CLASSIFICATION.SEMANTIC_PLAN],
  ["oracle_mismatch", FAILURE_CLASSIFICATION.ORACLE],
  ["schema_mismatch", FAILURE_CLASSIFICATION.SCHEMA],
  ["artifact_persistence_failed", FAILURE_CLASSIFICATION.ARTIFACT_PERSISTENCE],
  ["authorization_denied", FAILURE_CLASSIFICATION.AUTHORIZATION],
  ["approval_required", FAILURE_CLASSIFICATION.AUTHORIZATION],
  ["operation_dispatch_failed", FAILURE_CLASSIFICATION.OPERATION_DISPATCH],
  ["remote_effect_uncertain", FAILURE_CLASSIFICATION.UNCERTAIN_REMOTE_EFFECT],
  ["postcondition_mismatch", FAILURE_CLASSIFICATION.POSTCONDITION],
  ["model_budget_exhausted", FAILURE_CLASSIFICATION.MODEL_BUDGET],
  ["cleanup_failed", FAILURE_CLASSIFICATION.CLEANUP],
  ["diagnostic_source_unavailable", FAILURE_CLASSIFICATION.DIAGNOSTIC]
]);

/** Exact stable codes take precedence over legacy human-readable reason text. */
export function classifyFailureReasonCode(reasonCode) {
  if (typeof reasonCode !== "string") return null;
  return REASON_CODE_CLASSIFICATION.get(reasonCode.trim().toLowerCase()) ?? null;
}

function normalizedCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,95}$/u.test(value)
    ? value.toLowerCase()
    : null;
}

function divergenceDetails(failureCode, category, phase, safeNextAction) {
  return { failureCode, category, phase, safeNextAction, automatedContinuationPermitted: false };
}

/** Return a causal finding only for a telemetry event that proves a contract failed. */
export function classifyCausalDivergence(event) {
  if (!event || typeof event !== "object") return null;
  const payload = event.payload ?? {};
  let details = null;

  if (event.eventType === "workflow.plan_failed") {
    const providerFailure = normalizedCode(payload.failureCode);
    if (providerFailure === "budget_exhausted") {
      details = divergenceDetails("model_budget_exhausted", FAILURE_CLASSIFICATION.MODEL_BUDGET, "planning",
        "Wait for or configure a new bounded inference budget, then synthesize a plan again. No browser effect was dispatched by this failed synthesis.");
    } else if (providerFailure === "schema") {
      details = divergenceDetails("semantic_plan_invalid", FAILURE_CLASSIFICATION.SEMANTIC_PLAN, "planning",
        "Inspect the structured-plan validation failure and correct the plan contract before starting a new authorized run.");
    } else {
      details = divergenceDetails("workflow_plan_failed", FAILURE_CLASSIFICATION.SEMANTIC_PLAN, "planning",
        "Inspect the bounded provider failure code and request fingerprint, then retry only within the configured inference budget.");
    }
  } else if (event.eventType === "policy.adjudicated" && payload.disposition !== "allow") {
    if (payload.disposition === "suspend") {
      details = divergenceDetails("approval_required", FAILURE_CLASSIFICATION.AUTHORIZATION, "authorization",
        "Complete the scoped human review and resume through the authorized run coordinator.");
    } else if (payload.disposition === "review") {
      details = divergenceDetails("policy_review_required", FAILURE_CLASSIFICATION.AUTHORIZATION, "authorization",
        "Resolve the pending policy review through the authorized run coordinator before dispatch.");
    } else {
      details = divergenceDetails("authorization_denied", FAILURE_CLASSIFICATION.AUTHORIZATION, "authorization",
        "Review the policy reason and required authority. Do not retry the denied operation without a new authorization decision.");
    }
  } else if (event.eventType === "execution.dispatched" && payload.dispatchStatus !== "dispatched") {
    if (payload.dispatchStatus === "uncertain") {
      details = divergenceDetails("remote_effect_uncertain", FAILURE_CLASSIFICATION.UNCERTAIN_REMOTE_EFFECT, "dispatch",
        "Reconcile this operation ID against durable run state and independent application evidence before considering any retry.");
    } else if (payload.dispatchStatus === "refused") {
      details = divergenceDetails("operation_refused", FAILURE_CLASSIFICATION.OPERATION_DISPATCH, "dispatch",
        "Inspect the refusal and policy evidence. Any new attempt must pass through the normal authorization and run-coordinator path.");
    } else {
      details = divergenceDetails("operation_dispatch_failed", FAILURE_CLASSIFICATION.OPERATION_DISPATCH, "dispatch",
        "Inspect the dispatch receipt and target binding. Use the normal run coordinator for any separately authorized attempt.");
    }
  } else if (event.eventType === "verification.completed" && payload.status !== "verified_pass") {
    if (payload.status === "verified_fail") {
      details = divergenceDetails("postcondition_mismatch", FAILURE_CLASSIFICATION.POSTCONDITION, "verification",
        "Compare the declared postcondition with its evidence and independent oracle, then reconcile the operation before any retry.");
    } else if (payload.status === "not_run") {
      details = divergenceDetails("verification_not_run", FAILURE_CLASSIFICATION.POSTCONDITION, "verification",
        "Collect fresh verification evidence through the current run; do not infer success from dispatch or UI activity.");
    } else {
      details = divergenceDetails("verification_uncertain", FAILURE_CLASSIFICATION.POSTCONDITION, "verification",
        "Reobserve and reconcile the operation through the run coordinator. Do not replay an unresolved effect.");
    }
  } else if (event.eventType === "episode.completed" && payload.status !== "passed") {
    if (payload.cleanupStatus === "failed") {
      details = divergenceDetails("cleanup_failed", FAILURE_CLASSIFICATION.CLEANUP, "cleanup",
        "Inspect the test-owned resource ledger and verify cleanup with the owning application oracle.");
    } else if (payload.status === "blocked") {
      details = divergenceDetails("run_blocked", FAILURE_CLASSIFICATION.UNKNOWN, "run",
        "Resolve the reported authorization or environment blocker, then resume only through the run coordinator.");
    } else if (payload.status === "uncertain") {
      details = divergenceDetails("run_uncertain", FAILURE_CLASSIFICATION.UNCERTAIN_REMOTE_EFFECT, "run",
        "Reconcile every unresolved operation and cleanup obligation before continuing.");
    } else if (payload.status === "canceled") {
      details = divergenceDetails("run_canceled", FAILURE_CLASSIFICATION.UNKNOWN, "run",
        "Inspect the cancellation checkpoint and outstanding obligations before starting a new run.");
    } else {
      details = divergenceDetails("run_failed", FAILURE_CLASSIFICATION.UNKNOWN, "run",
        "Inspect the earliest failed contract and its supporting evidence before deciding whether a new run is safe.");
    }
  }

  if (!details) return null;
  const reasonCode = normalizedCode(payload.reasonCode) ?? normalizedCode(payload.failureCode)
    ?? normalizedCode(payload.disposition) ?? normalizedCode(payload.dispatchStatus) ?? normalizedCode(payload.status) ?? "unclassified";
  return {
    eventId: typeof event.eventId === "string" ? event.eventId : null,
    sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null,
    eventType: event.eventType,
    phase: details.phase,
    category: details.category,
    failureCode: details.failureCode,
    reasonCode,
    stepId: typeof event.stepId === "string" ? event.stepId : null,
    decisionId: typeof event.decisionId === "string" ? event.decisionId : null,
    observationId: typeof event.observationId === "string" ? event.observationId : null,
    evidenceRefs: [...new Set([
      ...(typeof event.observationId === "string" ? [event.observationId] : []),
      ...(Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []),
      ...(Array.isArray(payload.inputEventIds) ? payload.inputEventIds : []),
      ...(Array.isArray(payload.sourceEventIds) ? payload.sourceEventIds : [])
    ].filter(value => typeof value === "string" && value.length <= 128))].slice(0, 64),
    safeNextAction: details.safeNextAction,
    automatedContinuationPermitted: details.automatedContinuationPermitted
  };
}
