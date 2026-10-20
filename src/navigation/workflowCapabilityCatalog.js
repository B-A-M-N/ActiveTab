import { isLowercaseCode } from "../telemetry/privacy.js";
import { isWorkflowInputValueAction } from "./workflowPlanValidator.js";

const ACTIONS = new Set(["click", "fill", "select", "toggle", "scroll", "extract"]);
const EFFECT_CLASSES = new Set(["read", "navigation", "test_owned_mutation", "shared_mutation", "security_change", "unknown"]);
const MUTATING_EFFECTS = new Set(["test_owned_mutation", "shared_mutation", "security_change"]);
const CAPABILITY_INTENT_BINDINGS = new Set(["generic_navigation", "caller_required"]);

function requiredCode(value, label, maxLength = 96) {
  if (!isLowercaseCode(value, { maxLength })) throw new Error(`Workflow ${label} must be a bounded lowercase code.`);
  return value;
}

/** Compile trusted capabilities into a local normalized catalog and model-safe projection. */
export function compileWorkflowCapabilityCatalog(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 64) {
    throw new Error("Workflow synthesis requires a bounded trusted capability catalog.");
  }
  const byId = new Map();
  const projection = capabilities.map(capability => {
    if (!capability || typeof capability !== "object") throw new Error("Trusted workflow capability is invalid.");
    const id = requiredCode(capability.id, "capability id");
    const action = String(capability.action ?? "");
    const effectClass = String(capability.effectClass ?? "unknown");
    const intentBinding = capability.intentBinding ?? "caller_required";
    const targetRole = requiredCode(capability.targetRole, "target role", 64);
    const verificationCodes = capability.verificationCodes;
    const purposeCodes = capability.purposeCodes ?? [];
    const preconditionCodes = capability.preconditionCodes ?? [];
    const postconditionCodes = capability.postconditionCodes ?? [];
    const observedRoles = capability.observedRoles ?? [];
    const observedTags = capability.observedTags ?? [];
    const resolveTarget = capability.resolveTarget;
    const validateTarget = capability.validateTarget;
    const requiredInputRef = capability.requiredInputRef == null ? null : requiredCode(capability.requiredInputRef, "required input reference", 64);
    const isExtraction = action === "extract";
    const outputSchema = capability.outputSchema;
    const outputCompleteness = capability.outputCompleteness ?? "complete";
    if (!ACTIONS.has(action) || !EFFECT_CLASSES.has(effectClass) || !CAPABILITY_INTENT_BINDINGS.has(intentBinding)
      || (intentBinding === "generic_navigation" && (action !== "click" || effectClass !== "navigation"))
      || (requiredInputRef !== null && !isWorkflowInputValueAction(action))
      || !Array.isArray(verificationCodes)
      || verificationCodes.length < 1 || verificationCodes.length > 16
      || !Array.isArray(purposeCodes) || purposeCodes.length < 1 || purposeCodes.length > 24
      || !Array.isArray(preconditionCodes) || preconditionCodes.length > 24
      || !Array.isArray(postconditionCodes) || postconditionCodes.length < 1 || postconditionCodes.length > 24
      || !Array.isArray(observedRoles) || observedRoles.length > 8
      || !Array.isArray(observedTags) || observedTags.length > 8
      || (isExtraction && (effectClass !== "read" || observedRoles.length !== 0 || observedTags.length !== 0
        || resolveTarget !== undefined || typeof capability.execute !== "function"
        || !Array.isArray(outputSchema) || outputSchema.length < 1 || outputSchema.length > 32
        || !["complete", "observed_partial"].includes(outputCompleteness)
        || (outputCompleteness === "observed_partial"
          && !postconditionCodes.includes("observed_records_returned"))))
      || (!isExtraction && action !== "scroll" && observedRoles.length + observedTags.length === 0 && typeof resolveTarget !== "function")
      || (resolveTarget !== undefined && typeof resolveTarget !== "function")
      || (validateTarget !== undefined && typeof validateTarget !== "function")) {
      throw new Error(`Trusted workflow capability '${id}' has an invalid action, effect, or verification contract.`);
    }
    const operationId = capability.operationId == null ? null : requiredCode(capability.operationId, "operation id");
    if ((MUTATING_EFFECTS.has(effectClass) || capability.requiresApproval === true) && !operationId) {
      throw new Error(`Mutating workflow capability '${id}' requires a trusted operation id.`);
    }
    if (byId.has(id)) throw new Error(`Trusted workflow capability '${id}' is duplicated.`);
    const normalized = Object.freeze({
      id,
      action,
      effectClass,
      intentBinding,
      targetRole,
      observedRoles: Object.freeze(observedRoles.map(role => requiredCode(role, "observed role", 48))),
      observedTags: Object.freeze(observedTags.map(tag => requiredCode(tag, "observed tag", 32))),
      operationId,
      requiredInputRef,
      requiresApproval: capability.requiresApproval === true,
      verificationCodes: Object.freeze(verificationCodes.map(code => requiredCode(code, "verification code", 64))),
      purposeCodes: Object.freeze(purposeCodes.map(code => requiredCode(code, "purpose code", 64))),
      preconditionCodes: Object.freeze(preconditionCodes.map(code => requiredCode(code, "precondition code", 64))),
      postconditionCodes: Object.freeze(postconditionCodes.map(code => requiredCode(code, "postcondition code", 64))),
      verify: capability.verify,
      resolveTarget,
      validateTarget,
      ...(isExtraction ? {
        execute: capability.execute,
        outputCompleteness,
        outputSchema: Object.freeze(outputSchema.map(field => {
          if (!field || typeof field !== "object" || Array.isArray(field)
            || !isLowercaseCode(field.name, { maxLength: 64 })
            || !["string", "integer", "number", "boolean"].includes(field.type)
            || typeof field.required !== "boolean") {
            throw new Error(`Trusted extraction workflow capability '${id}' has an invalid output schema.`);
          }
          return Object.freeze({ name: field.name, type: field.type, required: field.required });
        }))
      } : {})
    });
    byId.set(id, normalized);
    return {
      id,
      action,
      effectClass,
      intentBinding,
      targetRole,
      observedRoles: normalized.observedRoles,
      observedTags: normalized.observedTags,
      dynamicResolution: typeof normalized.resolveTarget === "function",
      requiresApproval: normalized.requiresApproval,
      verificationCodes: normalized.verificationCodes,
      purposeCodes: normalized.purposeCodes,
      ...(normalized.requiredInputRef ? { requiredInputRef: normalized.requiredInputRef } : {}),
      preconditionCodes: normalized.preconditionCodes,
      postconditionCodes: normalized.postconditionCodes,
      ...(isExtraction ? { outputSchema: normalized.outputSchema } : {}),
      ...(isExtraction ? { outputCompleteness: normalized.outputCompleteness } : {})
    };
  });
  return { byId, projection };
}
