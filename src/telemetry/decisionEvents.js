import { randomUUID } from "node:crypto";
import { normalizeJevInputProjection, normalizeSemanticInputProjection, normalizeWorkflowPlanProjection } from "./decisionEventProjections.js";
import { ENUMS, normalizeAnswer, requireExactKeys, safeCode, safeModelId, validateEnum } from "./decisionEventValidation.js";
import { isSha256Digest, normalizeObservedRole, requireSafeEvidenceRefs } from "./privacy.js";

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
