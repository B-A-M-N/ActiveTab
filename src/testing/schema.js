/**
 * Declarative test workflow schema and validation.
 *
 * A test workflow is a bounded sequence of steps with explicit preconditions,
 * expected outcomes, and cleanup. The runner coordinates execution; the
 * NavigationEngine performs browser actions.
 */

export const STEP_TYPES = Object.freeze([
  "setup", "navigate", "interact", "api_call", "wait_for", "assert",
  "diagnostic_snapshot", "controlled_failure", "retry_verification",
  "postcondition", "cleanup", "goal"
]);

/** Human-intervention declaration for goal steps (P0-4). */
export const INTERVENTION_TYPES = Object.freeze([
  "tab_authorization", "authentication", "mfa", "human_approval",
  "external_authorization", "human_decision"
]);

export const INTERACTION_TYPES = Object.freeze([
  "click", "fill", "select", "toggle", "upload"
]);

export const EFFECT_CLASSIFICATION = Object.freeze({
  READ_ONLY: "read_only",
  MUTATING: "mutating",
  DESTRUCTIVE: "destructive"
});

export const STEP_STATUS = Object.freeze({
  PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED",
  UNCERTAIN: "UNCERTAIN", CANCELED: "CANCELED"
});

export const RUN_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  // Resumable waiting states (P0-3): NOT terminal failures.
  WAITING_FOR_TAB_AUTHORIZATION: "WAITING_FOR_TAB_AUTHORIZATION",
  WAITING_FOR_AUTHENTICATION: "WAITING_FOR_AUTHENTICATION",
  WAITING_FOR_MFA: "WAITING_FOR_MFA",
  WAITING_FOR_HUMAN_APPROVAL: "WAITING_FOR_HUMAN_APPROVAL",
  WAITING_FOR_EXTERNAL_AUTHORIZATION: "WAITING_FOR_EXTERNAL_AUTHORIZATION",
  WAITING_FOR_HUMAN_DECISION: "WAITING_FOR_HUMAN_DECISION",
  RESUME_VALIDATION: "RESUME_VALIDATION",
  RECONCILING: "RECONCILING",
  // Terminal states.
  PASSED: "PASSED", FAILED: "FAILED", BLOCKED: "BLOCKED", CANCELED: "CANCELED",
  EXPIRED: "EXPIRED"
});

export const TERMINAL_RUN_STATUSES = Object.freeze([
  RUN_STATUS.PASSED, RUN_STATUS.FAILED, RUN_STATUS.BLOCKED,
  RUN_STATUS.CANCELED, RUN_STATUS.EXPIRED
]);

export const WAITING_RUN_STATUSES = Object.freeze([
  RUN_STATUS.WAITING_FOR_TAB_AUTHORIZATION, RUN_STATUS.WAITING_FOR_AUTHENTICATION,
  RUN_STATUS.WAITING_FOR_MFA, RUN_STATUS.WAITING_FOR_HUMAN_APPROVAL,
  RUN_STATUS.WAITING_FOR_EXTERNAL_AUTHORIZATION, RUN_STATUS.WAITING_FOR_HUMAN_DECISION
]);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isWaitingRunStatus(status) {
  return WAITING_RUN_STATUSES.includes(status);
}

/**
 * Validate a test workflow object.
 * Returns { valid: true, errors: [] } or { valid: false, errors: string[] }.
 */
export function validateWorkflow(workflow, { maxSteps = 128 } = {}) {
  const errors = [];
  if (!workflow || typeof workflow !== "object") return { valid: false, errors: ["Workflow must be an object."] };
  if (typeof workflow.id !== "string" || !workflow.id) errors.push("Workflow requires an id.");
  if (typeof workflow.name !== "string" || !workflow.name) errors.push("Workflow requires a name.");
  if (!Array.isArray(workflow.steps)) { errors.push("Workflow requires a steps array."); return { valid: false, errors }; }
  if (workflow.steps.length === 0) errors.push("Workflow requires at least one step.");
  if (workflow.steps.length > maxSteps) {
    errors.push(`Workflow has ${workflow.steps.length} steps, which exceeds the maximum of ${maxSteps}.`);
  }

  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const prefix = `steps[${index}]`;
    if (!step || typeof step !== "object") { errors.push(`${prefix} must be an object.`); continue; }
    if (typeof step.id !== "string" || !step.id) errors.push(`${prefix}.id is required.`);
    if (!STEP_TYPES.includes(step.type)) errors.push(`${prefix}.type '${step.type}' is not a recognized step type.`);
    if (step.type === "navigate" && typeof step.url !== "string") errors.push(`${prefix}.url is required for navigate steps.`);
    if (step.type === "interact") {
      if (!step.action) errors.push(`${prefix}.action is required for interact steps.`);
      else if (typeof step.action.type !== "string" || !INTERACTION_TYPES.includes(step.action.type)) {
        errors.push(`${prefix}.action.type must be one of: ${INTERACTION_TYPES.join(", ")}.`);
      }
    }
    if (step.type === "assert" && !step.assertion) errors.push(`${prefix}.assertion is required for assert steps.`);
    if (step.type === "wait_for" && !step.condition) errors.push(`${prefix}.condition is required for wait_for steps.`);
    if (step.type === "api_call" && !step.operation) errors.push(`${prefix}.operation is required for api_call steps.`);
    if (step.type === "api_call" && step.operation && !step.operation.operationId) errors.push(`${prefix}.operation.operationId is required for api_call steps.`);
    if (step.type === "controlled_failure") {
      if (!step.failure) errors.push(`${prefix}.failure is required for controlled_failure steps.`);
      else if (!step.failure.mechanism) errors.push(`${prefix}.failure.mechanism is required for controlled_failure steps.`);
    }
    if (step.type === "setup" && Array.isArray(step.preconditions) && step.preconditions.length === 0) {
      errors.push(`${prefix}.preconditions must not be empty for setup steps.`);
    }
    if (step.type === "goal") {
      if (typeof step.goal !== "string" || !step.goal.trim()) {
        errors.push(`${prefix}.goal is required for goal steps.`);
      }
      if (step.intervention !== undefined) {
        const intervention = step.intervention;
        if (!intervention || typeof intervention !== "object") {
          errors.push(`${prefix}.intervention must be an object.`);
        } else {
          if (!INTERVENTION_TYPES.includes(intervention.type)) {
            errors.push(`${prefix}.intervention.type must be one of: ${INTERVENTION_TYPES.join(", ")}.`);
          }
          if (typeof intervention.condition?.type !== "string" || !intervention.condition.type) {
            errors.push(`${prefix}.intervention.condition.type is required (the verified resume predicate).`);
          }
          if (typeof intervention.requiredAction !== "string" || !intervention.requiredAction) {
            errors.push(`${prefix}.intervention.requiredAction is required.`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
