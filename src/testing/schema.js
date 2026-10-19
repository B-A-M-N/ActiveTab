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
  "postcondition", "cleanup", "goal", "qualify", "set_variable", "repeat", "subworkflow",
  "discover_tables", "extract_records", "collect_records", "emit_output"
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
  PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED", SKIPPED: "SKIPPED",
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
  PASSED: "PASSED", FAILED: "FAILED", BLOCKED: "BLOCKED", UNCERTAIN: "UNCERTAIN", CANCELED: "CANCELED",
  EXPIRED: "EXPIRED"
});

export const TERMINAL_RUN_STATUSES = Object.freeze([
  RUN_STATUS.PASSED, RUN_STATUS.FAILED, RUN_STATUS.BLOCKED, RUN_STATUS.UNCERTAIN,
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
export function validateWorkflow(workflow, { maxSteps = 128, requireFinalizedOutputs = true } = {}) {
  const errors = [];
  if (!workflow || typeof workflow !== "object") return { valid: false, errors: ["Workflow must be an object."] };
  if (typeof workflow.id !== "string" || !workflow.id) errors.push("Workflow requires an id.");
  if (typeof workflow.name !== "string" || !workflow.name) errors.push("Workflow requires a name.");
  if (workflow.inputNames !== undefined && (!Array.isArray(workflow.inputNames)
    || workflow.inputNames.length > 64
    || workflow.inputNames.some(name => !isScopedName(name))
    || new Set(workflow.inputNames).size !== workflow.inputNames.length)) {
    errors.push("workflow.inputNames must contain unique bounded variable names.");
  }
  if (workflow.inputs !== undefined && (!isScalarRecord(workflow.inputs) || Object.keys(workflow.inputs).length > 64)) {
    errors.push("workflow.inputs must be a bounded object of scalar values.");
  }
  if (!Array.isArray(workflow.steps)) { errors.push("Workflow requires a steps array."); return { valid: false, errors }; }
  if (workflow.steps.length === 0) errors.push("Workflow requires at least one step.");
  if (workflow.steps.length > maxSteps) {
    errors.push(`Workflow has ${workflow.steps.length} steps, which exceeds the maximum of ${maxSteps}.`);
  }

  const stepIds = new Set();
  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    if (typeof step?.id !== "string" || !step.id) continue;
    if (stepIds.has(step.id)) errors.push(`steps[${index}].id '${step.id}' is duplicated.`);
    stepIds.add(step.id);
  }

  if (workflow.execution !== undefined && workflow.execution !== "linear" && workflow.execution !== "dag") {
    errors.push("workflow.execution must be 'linear' or 'dag'.");
  }
  const dagMode = workflow.execution === "dag";
  if (!dagMode && workflow.steps.some(step => step && (step.dependsOn !== undefined || step.when !== undefined))) {
    errors.push("dependsOn and when require workflow.execution = 'dag'.");
  }
  if (!dagMode && workflow.steps.some(step => step?.compensates !== undefined)) {
    errors.push("compensates requires workflow.execution = 'dag'.");
  }
  const byId = new Map(workflow.steps.filter(step => step && typeof step.id === "string").map(step => [step.id, step]));
  if (dagMode) {
    for (let index = 0; index < workflow.steps.length; index++) {
      const step = workflow.steps[index];
      if (!step || typeof step !== "object") continue;
      if (!Array.isArray(step.dependsOn)) {
        errors.push(`steps[${index}].dependsOn is required for DAG workflows (use [] for a root).`);
      } else {
        const seen = new Set();
        for (const dependencyId of step.dependsOn) {
          if (typeof dependencyId !== "string" || !byId.has(dependencyId)) errors.push(`steps[${index}].dependsOn references unknown step '${String(dependencyId)}'.`);
          if (dependencyId === step.id) errors.push(`steps[${index}] cannot depend on itself.`);
          if (seen.has(dependencyId)) errors.push(`steps[${index}].dependsOn contains duplicate '${dependencyId}'.`);
          seen.add(dependencyId);
        }
      }
      if (step.when !== undefined) {
        const conditions = Array.isArray(step.when?.all) ? step.when.all
          : Array.isArray(step.when?.any) ? step.when.any
            : [step.when];
        if (conditions.length === 0) errors.push(`steps[${index}].when must include at least one status condition.`);
        for (const condition of conditions) {
          if (!condition || typeof condition.stepId !== "string" || !Array.isArray(condition.statuses) || condition.statuses.length === 0) {
            errors.push(`steps[${index}].when conditions require stepId and a non-empty statuses array.`);
            continue;
          }
          if (!step.dependsOn?.includes(condition.stepId)) errors.push(`steps[${index}].when must reference a directly depended-on step '${condition.stepId}'.`);
          if (condition.statuses.some(status => !Object.values(STEP_STATUS).includes(status))) {
            errors.push(`steps[${index}].when contains an unsupported status.`);
          }
        }
        if (step.when?.all && step.when?.any) errors.push(`steps[${index}].when may use all or any, not both.`);
      }
      if (step.compensates !== undefined) {
        const compensation = step.compensates;
        if (!compensation || typeof compensation.stepId !== "string" || !Array.isArray(compensation.statuses) || compensation.statuses.length === 0) {
          errors.push(`steps[${index}].compensates requires stepId and explicit source statuses.`);
        } else {
          if (!step.dependsOn?.includes(compensation.stepId)) errors.push(`steps[${index}].compensates must reference a directly depended-on step.`);
          if (compensation.statuses.some(status => ![STEP_STATUS.PASS, STEP_STATUS.FAIL, STEP_STATUS.BLOCKED].includes(status))) {
            errors.push(`steps[${index}].compensates cannot run for uncertain, skipped, or canceled operations.`);
          }
        }
      }
    }
    const indegree = new Map(workflow.steps.filter(step => step && typeof step.id === "string").map(step => [step.id, step.dependsOn?.length ?? 0]));
    const dependents = new Map([...indegree.keys()].map(id => [id, []]));
    for (const step of workflow.steps) {
      if (!step || typeof step.id !== "string" || !Array.isArray(step.dependsOn)) continue;
      for (const dependencyId of step.dependsOn) dependents.get(dependencyId)?.push(step.id);
    }
    const queue = workflow.steps.filter(step => step && typeof step.id === "string" && (indegree.get(step.id) ?? 0) === 0).map(step => step.id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited++;
      for (const dependentId of dependents.get(id) ?? []) {
        const next = indegree.get(dependentId) - 1;
        indegree.set(dependentId, next);
        if (next === 0) queue.push(dependentId);
      }
    }
    if (visited !== indegree.size) errors.push("DAG workflow contains a dependency cycle.");
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
      if (step.action && Object.hasOwn(step.action, "value") && !isWorkflowValue(step.action.value)) {
        errors.push(`${prefix}.action.value must be a scalar or an explicit scoped variable/step-status reference.`);
      }
      if (step.action?.type === "upload" && (typeof step.action.uploadGrantId !== "string" || !step.action.uploadGrantId
        || Object.hasOwn(step.action, "filePaths"))) {
        errors.push(`${prefix}.action.uploadGrantId is required and raw filePaths are not accepted.`);
      }
      if (step.action?.type !== "upload" && Object.hasOwn(step.action ?? {}, "uploadGrantId")) {
        errors.push(`${prefix}.action.uploadGrantId is valid only for upload steps.`);
      }
    }
    if (step.type === "assert" && !step.assertion) errors.push(`${prefix}.assertion is required for assert steps.`);
    if (step.type === "wait_for" && !step.condition) errors.push(`${prefix}.condition is required for wait_for steps.`);
    if (step.type === "api_call" && !step.operation) errors.push(`${prefix}.operation is required for api_call steps.`);
    if (step.type === "api_call" && step.operation && !step.operation.operationId) errors.push(`${prefix}.operation.operationId is required for api_call steps.`);
    if (step.type === "extract_records" || step.type === "collect_records" || step.type === "emit_output") {
      if (!isScopedName(step.capabilityId)) errors.push(`${prefix}.capabilityId must be a bounded registered capability identifier.`);
      if (step.capabilityVersion !== undefined && (!Number.isInteger(step.capabilityVersion) || step.capabilityVersion < 1 || step.capabilityVersion > 1000)) errors.push(`${prefix}.capabilityVersion must be from 1 to 1000.`);
      if (!isScopedName(step.outputName)) errors.push(`${prefix}.outputName must be a bounded output identifier.`);
    }
    if (step.type === "qualify") {
      if (typeof step.scenarioId !== "string" || !step.scenarioId.trim() || step.scenarioId.length > 96) errors.push(`${prefix}.scenarioId must be a bounded scenario identifier.`);
      if (typeof step.providerId !== "string" || !step.providerId.trim() || step.providerId.length > 96) errors.push(`${prefix}.providerId must be a bounded provider identifier.`);
      if (!new Set(["ambiguous_target", "observed_failure", "workflow_reuse", "ui_drift", "uncertain_operation"]).has(step.trigger)) errors.push(`${prefix}.trigger is unsupported for qualification.`);
      if (step.required !== undefined && typeof step.required !== "boolean") errors.push(`${prefix}.required must be a boolean.`);
      if (step.sourceEventIds !== undefined && (!Array.isArray(step.sourceEventIds) || step.sourceEventIds.length > 32 || step.sourceEventIds.some(id => typeof id !== "string" || !id))) errors.push(`${prefix}.sourceEventIds must be a bounded list of event identifiers.`);
      if (step.evidenceRefs !== undefined && (!Array.isArray(step.evidenceRefs) || step.evidenceRefs.length > 32 || step.evidenceRefs.some(ref => typeof ref !== "string" || !ref))) errors.push(`${prefix}.evidenceRefs must be a bounded list of evidence references.`);
    }
    if (step.type === "cleanup" && step.action && (!step.verify || typeof step.verify.type !== "string")) {
      errors.push(`${prefix}.verify requires an independent assertion for any effectful cleanup action.`);
    }
    if (step.type === "set_variable") {
      if (!isScopedName(step.name)) errors.push(`${prefix}.name must be a bounded variable name.`);
      if (!isWorkflowValue(step.value)) errors.push(`${prefix}.value must be a scalar or an explicit variable/step-status reference.`);
    }
    if (step.type === "repeat") {
      if (!Number.isInteger(step.maxIterations) || step.maxIterations < 1 || step.maxIterations > 10) errors.push(`${prefix}.maxIterations must be from 1 to 10.`);
      if (!Array.isArray(step.body) || step.body.length === 0) errors.push(`${prefix}.body requires at least one bounded workflow step.`);
      if (!step.until || typeof step.until !== "object" || typeof step.until.type !== "string") errors.push(`${prefix}.until requires a typed verification assertion.`);
      for (const child of step.body ?? []) {
        if (["repeat", "subworkflow"].includes(child?.type)) errors.push(`${prefix}.body cannot nest repeat or subworkflow controls in schema version 1.`);
      }
      if (Array.isArray(step.body)) {
        const nested = validateWorkflow({ id: `${step.id ?? "repeat"}-body`, name: "bounded repeat body", steps: step.body }, { maxSteps: 32, requireFinalizedOutputs: false });
        errors.push(...nested.errors.map(error => `${prefix}.body: ${error}`));
      }
    }
    if (step.type === "subworkflow") {
      if (typeof step.workflowRef !== "string" || !step.workflowRef) errors.push(`${prefix}.workflowRef is required.`);
      if (step.inputs !== undefined && !isWorkflowInputMap(step.inputs)) errors.push(`${prefix}.inputs must be a bounded scalar/reference mapping.`);
      if (step.outputs !== undefined && (!isScopedNameRecord(step.outputs))) errors.push(`${prefix}.outputs must map child variable names to scoped parent variable names.`);
    }
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
  if (requireFinalizedOutputs) {
    const producers = [];
    const visit = (steps, owner = null) => {
      for (const step of steps ?? []) {
        const ownerStepId = owner ?? step?.id;
        if (step?.type === "extract_records" || step?.type === "collect_records") producers.push({ step, ownerStepId });
        if (step?.type === "repeat") visit(step.body, ownerStepId);
      }
    };
    visit(workflow.steps);
    const outputs = new Map();
    for (const item of producers) {
      const entries = outputs.get(item.step.outputName) ?? [];
      entries.push(item);
      outputs.set(item.step.outputName, entries);
    }
    const emitters = new Map();
    for (const step of workflow.steps) {
      if (step?.type !== "emit_output") continue;
      const entries = emitters.get(step.outputName) ?? [];
      entries.push(step);
      emitters.set(step.outputName, entries);
    }
    for (const [outputName, entries] of outputs) {
      const matching = emitters.get(outputName) ?? [];
      if (matching.length !== 1) errors.push(`Output '${outputName}' must have exactly one top-level emit_output step.`);
      else {
        const emitter = matching[0];
        for (const { step: producer, ownerStepId } of entries) {
          if (producer.capabilityId !== emitter.capabilityId) errors.push(`Output '${outputName}' cannot combine different registered capabilities.`);
          if (dagMode && !emitter.dependsOn?.includes(ownerStepId)) errors.push(`emit_output '${emitter.id}' must depend on extraction step '${ownerStepId}'.`);
          if (!dagMode && workflow.steps.findIndex(item => item.id === emitter.id) <= workflow.steps.findIndex(item => item.id === ownerStepId)) {
            errors.push(`emit_output '${emitter.id}' must follow extraction step '${ownerStepId}'.`);
          }
        }
      }
    }
    for (const outputName of emitters.keys()) if (!outputs.has(outputName)) errors.push(`emit_output references '${outputName}' without an extract_records step.`);
  }
  const expandedStepCount = workflow.steps.reduce((count, step) => count + 1
    + (step?.type === "repeat" && Number.isInteger(step.maxIterations) && Array.isArray(step.body) ? step.maxIterations * step.body.length : 0), 0);
  if (expandedStepCount > maxSteps) errors.push(`Expanded workflow exceeds the maximum execution budget of ${maxSteps} steps.`);
  const order = dagMode ? topologicalStepOrder(workflow.steps) : workflow.steps;
  return { valid: errors.length === 0, errors, order };
}

function isScopedName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) return false;
  let previousSeparator = true;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const alphaNumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (alphaNumeric) previousSeparator = false;
    else if (character === "_" || character === "-" || character === ".") {
      if (previousSeparator) return false;
      previousSeparator = true;
    } else return false;
  }
  return !previousSeparator;
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isScalarRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => isScopedName(key) && isScalar(item));
}

function isWorkflowValue(value) {
  if (isScalar(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length === 1 && isScopedName(value.variable)) return true;
  return Object.keys(value).length === 1 && typeof value.stepStatus === "string" && value.stepStatus.length > 0;
}

function isWorkflowInputMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).length <= 64
    && Object.entries(value).every(([key, item]) => isScopedName(key) && isWorkflowValue(item));
}

function isScopedNameRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).length <= 64
    && Object.entries(value).every(([from, to]) => isScopedName(from) && isScopedName(to));
}

/** Stable topological ordering: independent nodes keep author order. */
export function topologicalStepOrder(steps) {
  const byId = new Map(steps.filter(step => step && typeof step.id === "string").map(step => [step.id, step]));
  const sourceIndex = new Map(steps.map((step, index) => [step?.id, index]));
  const indegree = new Map([...byId].map(([id, step]) => [id, step.dependsOn?.length ?? 0]));
  const dependents = new Map([...byId.keys()].map(id => [id, []]));
  for (const [id, step] of byId) {
    for (const dependencyId of step.dependsOn ?? []) dependents.get(dependencyId)?.push(id);
  }
  const ready = [...byId.keys()].filter(id => indegree.get(id) === 0)
    .sort((left, right) => sourceIndex.get(left) - sourceIndex.get(right));
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependentId of dependents.get(id) ?? []) {
      const next = indegree.get(dependentId) - 1;
      indegree.set(dependentId, next);
      if (next === 0) {
        ready.push(dependentId);
        ready.sort((left, right) => sourceIndex.get(left) - sourceIndex.get(right));
      }
    }
  }
  return ordered;
}
