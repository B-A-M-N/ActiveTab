import { createHash } from "node:crypto";
import { isSafeTelemetryCode, isSha256Digest } from "../telemetry/privacy.js";

export const WORKFLOW_REVIEW_POLICY_VERSION = "workflow_plan_review_v1";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createWorkflowReviewBinding({
  planHash,
  taskContractHash,
  capabilityCatalogHash,
  taskOutcomeCode,
  observationId,
  targetId,
  documentGeneration
} = {}) {
  if (![planHash, taskContractHash, capabilityCatalogHash].every(isSha256Digest)
    || !isSafeTelemetryCode(observationId, { maxLength: 128 })
    || !isSafeTelemetryCode(targetId, { maxLength: 128 })
    || !isSafeTelemetryCode(taskOutcomeCode, { maxLength: 96 })
    || !Number.isSafeInteger(documentGeneration) || documentGeneration < 0) {
    throw new Error("Workflow review binding requires exact hashes, observation, target, and document generation.");
  }
  const material = {
    schemaVersion: 1,
    planHash: planHash.toLowerCase(),
    taskContractHash: taskContractHash.toLowerCase(),
    capabilityCatalogHash: capabilityCatalogHash.toLowerCase(),
    taskOutcomeCode,
    observationId,
    targetId,
    documentGeneration,
    reviewPolicyVersion: WORKFLOW_REVIEW_POLICY_VERSION
  };
  return Object.freeze({ ...material, bindingHash: digest(material) });
}

export function isValidWorkflowReviewBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["schemaVersion", "planHash", "taskContractHash", "capabilityCatalogHash", "taskOutcomeCode", "observationId", "targetId", "documentGeneration", "reviewPolicyVersion", "bindingHash"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.schemaVersion !== 1 || value.reviewPolicyVersion !== WORKFLOW_REVIEW_POLICY_VERSION
    || !isSha256Digest(value.bindingHash)) return false;
  try {
    const { bindingHash, ...material } = value;
    return createWorkflowReviewBinding(material).bindingHash === bindingHash.toLowerCase();
  } catch {
    return false;
  }
}
