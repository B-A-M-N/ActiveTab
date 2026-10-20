import { isLowercaseCode } from "../telemetry/privacy.js";

export const WORKFLOW_PLAN_VERSION = 1;
export const WORKFLOW_PLAN_STEP_STATUSES = Object.freeze(["passed", "failed", "blocked", "uncertain", "skipped"]);
export const WORKFLOW_PLAN_MISSING_POLICIES = Object.freeze(["stop", "reobserve", "repair"]);

const INPUT_VALUE_ACTIONS = new Set(["fill", "select", "toggle"]);
const MISSING_POLICIES = new Set(WORKFLOW_PLAN_MISSING_POLICIES);
const STEP_STATUSES = new Set(WORKFLOW_PLAN_STEP_STATUSES);

export function isWorkflowInputValueAction(action) {
  return INPUT_VALUE_ACTIONS.has(action);
}

function requiredCode(value, label, maxLength = 96) {
  if (!isLowercaseCode(value, { maxLength })) throw new Error(`Workflow ${label} must be a bounded lowercase code.`);
  return value;
}

/** Deterministic, provider-independent validation of a synthesized workflow plan. */
export function validateWorkflowPlan(plan, { observationBindings, capabilities, inputRefs, taskIntent, requiredCapabilityIds = new Set(), maxSteps }) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)
    || Object.keys(plan).some(key => !["version", "steps"].includes(key))
    || plan.version !== WORKFLOW_PLAN_VERSION || !Array.isArray(plan.steps)
    || plan.steps.length < 1 || plan.steps.length > maxSteps) {
    throw new Error("Synthesized workflow is outside the versioned step bound.");
  }
  const steps = [];
  const ids = new Set();
  const extractionCapabilities = new Set();
  const capabilityMap = capabilities.byId;
  for (const step of plan.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).some(key => !["id", "capabilityId", "targetRole", "targetRef", "inputRef", "dependsOn", "when", "verifyCode", "onMissing"].includes(key))) {
      throw new Error("Synthesized workflow step contains unsupported fields.");
    }
    const id = requiredCode(step.id, "step id", 64);
    const capabilityId = requiredCode(step.capabilityId, "capability id");
    const targetRole = requiredCode(step.targetRole, "target role", 64);
    const targetRef = step.targetRef === undefined ? null : requiredCode(step.targetRef, "target reference", 128);
    if (ids.has(id)) throw new Error("Synthesized workflow step IDs must be unique.");
    ids.add(id);
    const capability = capabilityMap.get(capabilityId);
    const binding = targetRef ? observationBindings.get(targetRef) : null;
    const extractionStep = capability?.action === "extract";
    const allowedPurposeCodes = new Set([taskIntent?.purposeCode, ...(taskIntent?.permittedPurposeCodes ?? [])].filter(Boolean));
    if (capability && !capability.purposeCodes.some(code => allowedPurposeCodes.has(code))) {
      throw new Error("Workflow capability purpose is outside the trusted task intent contract.");
    }
    if (requiredCapabilityIds.has(capabilityId) && step.when !== undefined) {
      throw new Error("A caller-required workflow capability cannot be placed behind a conditional skip.");
    }
    if (extractionStep && extractionCapabilities.has(capabilityId)) {
      throw new Error("A registered extraction capability may appear only once in a synthesized workflow.");
    }
    if (extractionStep) extractionCapabilities.add(capabilityId);
    if (!capability || targetRole !== capability.targetRole || (targetRef && !binding)
      || (extractionStep && (targetRef !== null || step.inputRef !== undefined))
      || (!extractionStep && !targetRef && typeof capability.resolveTarget !== "function")) {
      throw new Error("Synthesized workflow referenced an unregistered capability, target role, or unobserved target.");
    }
    if (binding && (binding.kind === "scroll" ? capability.action !== "scroll" : capability.action === "scroll" || extractionStep)) {
      throw new Error("Synthesized workflow target kind does not match the registered capability.");
    }
    if (binding?.kind === "candidate"
      && !capability.observedRoles.includes(binding.signature.role)
      && !capability.observedTags.includes(binding.signature.tag)) {
      throw new Error("Synthesized workflow target does not match the trusted capability's observed role or tag contract.");
    }
    if (binding?.kind === "scroll" && capability.action !== "scroll") throw new Error("Synthesized workflow scroll target does not match the trusted capability.");
    const inputRef = step.inputRef === undefined ? null : requiredCode(step.inputRef, "input reference", 64);
    if (inputRef && !inputRefs.has(inputRef)) throw new Error("Synthesized workflow referenced an unavailable caller input.");
    if (INPUT_VALUE_ACTIONS.has(capability.action) !== Boolean(inputRef)) {
      throw new Error("Value-bearing workflow steps require exactly one caller-provided input reference.");
    }
    if (capability.requiredInputRef && inputRef !== capability.requiredInputRef) {
      throw new Error("Workflow capability requires its exact trusted caller input reference.");
    }
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > maxSteps) throw new Error("Workflow dependencies must be an explicit bounded array.");
    const dependsOn = [...new Set(step.dependsOn.map(value => requiredCode(value, "dependency id", 64)))];
    if (dependsOn.length !== step.dependsOn.length || dependsOn.includes(id)) throw new Error("Workflow dependencies must be unique and cannot be self-referential.");
    const when = step.when === undefined ? null : { ...step.when };
    if (when !== null) {
      if (!when || typeof when !== "object" || Array.isArray(when)
        || Object.keys(when).some(key => !["stepId", "status"].includes(key))
        || !Object.hasOwn(when, "stepId") || !Object.hasOwn(when, "status")) {
        throw new Error("Workflow condition must use one typed prior-step status.");
      }
      const conditionStepId = requiredCode(when.stepId, "condition step id", 64);
      if (!STEP_STATUSES.has(when.status) || !dependsOn.includes(conditionStepId)) throw new Error("Workflow condition must reference a depended-on step and a supported status.");
      when.stepId = conditionStepId;
    }
    const verifyCode = requiredCode(step.verifyCode, "verification code", 64);
    if (!capability.verificationCodes.includes(verifyCode)) throw new Error("Workflow requested a verification code outside its trusted capability contract.");
    const onMissing = String(step.onMissing ?? "");
    if (!MISSING_POLICIES.has(onMissing)) throw new Error("Workflow onMissing behavior is unsupported.");
    steps.push(Object.freeze({ id, capabilityId, targetRole, targetRef, inputRef, dependsOn: Object.freeze(dependsOn), when: when ? Object.freeze({ ...when }) : null, verifyCode, onMissing }));
  }
  for (const capabilityId of requiredCapabilityIds) {
    if (!capabilityMap.has(capabilityId) || !steps.some(step => step.capabilityId === capabilityId)) {
      throw new Error("Synthesized workflow omitted a caller-required registered capability.");
    }
  }
  for (const step of steps) {
    if (step.dependsOn.some(dependency => !ids.has(dependency))) throw new Error("Workflow dependency references an unknown step.");
  }
  const remaining = new Map(steps.map(step => [step.id, step.dependsOn.length]));
  const queue = steps.filter(step => step.dependsOn.length === 0).map(step => step.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const step of steps) if (step.dependsOn.includes(id)) {
      const next = remaining.get(step.id) - 1;
      remaining.set(step.id, next);
      if (next === 0) queue.push(step.id);
    }
  }
  if (visited !== steps.length) throw new Error("Synthesized workflow contains a dependency cycle.");
  const stepById = new Map(steps.map(step => [step.id, step]));
  const hasUnconditionalAncestry = step => {
    // A passed branch on an explicit dependency is required for that successful path.
    // Failure and other status branches cannot witness the requested outcome for every successful execution.
    if (step.when && (step.when.status !== "passed" || !step.dependsOn.includes(step.when.stepId))) return false;
    return step.dependsOn.every(id => hasUnconditionalAncestry(stepById.get(id)));
  };
  const outcomeWitnesses = steps.filter(step => capabilities.byId.get(step.capabilityId)?.postconditionCodes.includes(taskIntent?.outcomeCode));
  if (!outcomeWitnesses.some(hasUnconditionalAncestry)) {
    throw new Error("Workflow has no unconditional trusted postcondition witness for the requested outcome.");
  }
  return Object.freeze({ version: WORKFLOW_PLAN_VERSION, steps: Object.freeze(steps) });
}
