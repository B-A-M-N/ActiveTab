import { isLowercaseCode } from "../telemetry/privacy.js";

function code(value, label, maxLength = 96) {
  if (!isLowercaseCode(value, { maxLength })) throw new Error(`Application intelligence ${label} must be a bounded lowercase code.`);
  return value;
}

function compileTaskIntent(value) {
  const allowed = ["purposeCode", "outcomeCode", "targetRoles", "constraints"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error("Workflow synthesis requires a typed task intent; free-form goals are not sent to remote models.");
  }
  if (!Object.hasOwn(value, "purposeCode") || !Object.hasOwn(value, "outcomeCode")) {
    throw new Error("Workflow task intent requires purposeCode and outcomeCode.");
  }
  const targetRoles = value.targetRoles ?? [];
  const constraints = value.constraints ?? [];
  if (!Array.isArray(targetRoles) || targetRoles.length > 24 || !Array.isArray(constraints) || constraints.length > 24) {
    throw new Error("Workflow task intent exceeds its bounded role or constraint list.");
  }
  return Object.freeze({
    purposeCode: code(value.purposeCode, "purpose code", 64),
    outcomeCode: code(value.outcomeCode, "outcome code", 64),
    targetRoles: Object.freeze([...new Set(targetRoles.map(role => code(role, "target role", 64)))]),
    constraints: Object.freeze([...new Set(constraints.map(item => code(item, "constraint", 64)))])
  });
}

function compileScope(scope) {
  const allowed = ["applicationId", "environmentClass", "principalId"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)
    || Object.keys(scope).some(key => !allowed.includes(key))) {
    throw new Error("Application intelligence scope contains unsupported fields.");
  }
  const environmentClass = String(scope.environmentClass ?? "unknown");
  if (!["local", "staging", "production", "unknown"].includes(environmentClass)) throw new Error("Application intelligence environment class is unsupported.");
  return {
    applicationId: code(scope.applicationId ?? "unknown", "application id"),
    environmentClass,
    principalId: code(scope.principalId ?? "unknown", "principal id")
  };
}

function compileInputRefs(inputRefs) {
  if (!Array.isArray(inputRefs) || inputRefs.length > 32) throw new Error("Application intelligence input references exceed their bound.");
  return [...new Set(inputRefs.map(value => code(value, "input reference", 64)))];
}

function compileRepair(repair) {
  if (repair == null) return null;
  const allowed = ["failedStepId", "failureCode", "completedStepIds", "completedCapabilityIds"];
  if (!repair || typeof repair !== "object" || Array.isArray(repair)
    || Object.keys(repair).some(key => !allowed.includes(key))) throw new Error("Workflow repair context contains unsupported fields.");
  const list = (value, label) => {
    if (!Array.isArray(value) || value.length > 24) throw new Error(`Workflow repair ${label} exceeds its bound.`);
    return [...new Set(value.map(item => code(item, label, 96)))];
  };
  return {
    failedStepId: code(repair.failedStepId, "failed step id", 64),
    failureCode: code(repair.failureCode, "repair failure code", 64),
    completedStepIds: list(repair.completedStepIds ?? [], "completed step id"),
    completedCapabilityIds: list(repair.completedCapabilityIds ?? [], "completed capability id")
  };
}

export class ApplicationIntelligenceCompiler {
  compile({ taskIntent, observation, trustedCapabilities, qualifiedKnowledge, inputRefs = [], repairContext = null, scope = {}, maxSteps = 24 } = {}) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)
      || Object.keys(observation).some(key => !["observationId", "pageOrigin", "title", "headings", "candidates"].includes(key))) {
      throw new Error("Application intelligence requires a minimized typed observation projection.");
    }
    if (!Array.isArray(trustedCapabilities) || trustedCapabilities.length < 1 || trustedCapabilities.length > 64) {
      throw new Error("Application intelligence requires a bounded trusted capability catalog.");
    }
    if (!Array.isArray(qualifiedKnowledge) || qualifiedKnowledge.length > 24) throw new Error("Qualified application intelligence exceeds its bound.");
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 24) throw new Error("Application intelligence step limit is invalid.");
    compileScope(scope);
    return Object.freeze({
      planVersion: 1,
      task: Object.freeze({ ...compileTaskIntent(taskIntent), inputRefs: Object.freeze(compileInputRefs(inputRefs)) }),
      observation,
      trustedCapabilities,
      qualifiedKnowledge,
      ...(repairContext ? { repair: compileRepair(repairContext) } : {}),
      limits: Object.freeze({ maxSteps, maxBrowserActions: Math.min(40, maxSteps * 2), unknownEffect: "suspend" })
    });
  }
}
