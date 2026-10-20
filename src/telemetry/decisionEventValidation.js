import { isSafeModelId, requireSafeTelemetryCode } from "./privacy.js";

export const ENUMS = {
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
  lookupMode: new Set(["retained_snapshot", "cdp_dom_location", "cdp_dom_hit_test_chain"]),
  lookupStatus: new Set(["unique", "not_found", "ambiguous", "incomplete", "candidate", "unavailable", "stale", "invalid", "expired", "no_hint", "refreshed"]),
  frameScope: new Set(["root", "page", "out_of_process", "unknown"]),
  nextActionDisposition: new Set(["deferred", "permitted", "refused"])
};

export function safeCode(value, field, maxLength) {
  return requireSafeTelemetryCode(value, field, { maxLength });
}

export function safeModelId(value, field) {
  if (!isSafeModelId(value)) throw new Error(`Telemetry field '${field}' must be a bounded model identifier.`);
  return value;
}

export function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

export function normalizeConfidence(value) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Telemetry confidence must be in [0, 1].");
  return value;
}

export function validateEnum(value, field) {
  const values = ENUMS[field];
  if (values && !values.has(value)) throw new Error(`Telemetry field '${field}' has an unsupported value.`);
  return value;
}

export function normalizeAnswer(value, questionType) {
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
