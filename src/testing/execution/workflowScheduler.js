import { deriveRunStatus } from "../receipts.js";
import { RUN_STATUS, STEP_STATUS, validateWorkflow } from "../schema.js";

function conditionsFor(when) {
  if (Array.isArray(when?.all)) return { mode: "all", conditions: when.all };
  if (Array.isArray(when?.any)) return { mode: "any", conditions: when.any };
  return { mode: "all", conditions: [when] };
}

function conditionMatches(when, stepStatuses) {
  const { mode, conditions } = conditionsFor(when);
  const matches = conditions.map(condition => condition.statuses.includes(stepStatuses.get(condition.stepId)));
  return mode === "any" ? matches.some(Boolean) : matches.every(Boolean);
}

function conditionReferencesStatus(when, stepId, status) {
  const { conditions } = conditionsFor(when);
  return conditions.some(condition => condition.stepId === stepId && condition.statuses.includes(status));
}

/** Decide whether a graph step is eligible to run; this never authorizes effects. */
export function evaluateWorkflowStepAdmission({ workflow, step, stepStatuses, failedStepIds }) {
  if (workflow.execution === "dag") {
    const dependencyStatuses = new Map((step.dependsOn ?? []).map(id => [id, stepStatuses.get(id)]));
    if (step.compensates) {
      const sourceStatus = stepStatuses.get(step.compensates.stepId);
      if (sourceStatus === STEP_STATUS.UNCERTAIN) {
        return {
          action: "block",
          reason: "Compensation is suspended because the source effect is uncertain and its resource state must be reconciled first."
        };
      }
      if (!step.compensates.statuses.includes(sourceStatus)) {
        return { action: "skip", reason: "Compensation condition did not match the source operation outcome." };
      }
    }
    if (step.when && !conditionMatches(step.when, stepStatuses)) {
      return { action: "skip", reason: "Skipped because its declared workflow status condition was not met." };
    }
    const unresolvedDependencies = [...dependencyStatuses]
      .filter(([, status]) => status !== STEP_STATUS.PASS);
    if (unresolvedDependencies.length > 0) {
      const conditionCoversAll = unresolvedDependencies.every(([id, status]) =>
        (step.when && conditionReferencesStatus(step.when, id, status))
        || (step.compensates?.stepId === id && step.compensates.statuses.includes(status)));
      const uncertainDependency = unresolvedDependencies.some(([, status]) => status === STEP_STATUS.UNCERTAIN);
      const reconciliationStep = ["assert", "wait_for", "diagnostic_snapshot", "api_call"].includes(step.type);
      if (!conditionCoversAll || (uncertainDependency && !reconciliationStep)) {
        const reason = uncertainDependency
          ? "Blocked because a dependency has an unresolved effect; reconcile it before another effectful step."
          : `Blocked because dependency outcomes are not all PASS (${unresolvedDependencies.map(([id, status]) => `${id}:${status}`).join(", ")}).`;
        return { action: "block", reason };
      }
    }
  }
  if (workflow.execution !== "dag" && failedStepIds.size > 0 && !step.recoveryBranch) {
    return {
      action: "block",
      reason: `Skipped because a prerequisite step failed (${[...failedStepIds].join(", ")}).`
    };
  }
  return { action: "execute" };
}

export function deriveWorkflowRunStatus(workflow, stepStatuses) {
  if (workflow.execution !== "dag") {
    return deriveRunStatus([...stepStatuses.values()].map(status => ({ status })));
  }
  const dependedOn = new Set((workflow.steps ?? []).flatMap(step => step.dependsOn ?? []));
  const terminalStatuses = (workflow.steps ?? [])
    .filter(step => !dependedOn.has(step.id))
    .map(step => stepStatuses.get(step.id));
  if (!terminalStatuses.length || terminalStatuses.some(status => status === undefined)) return RUN_STATUS.BLOCKED;
  const allStatuses = [...stepStatuses.values()];
  if (allStatuses.includes(STEP_STATUS.UNCERTAIN)) return RUN_STATUS.UNCERTAIN;
  if (allStatuses.includes(STEP_STATUS.CANCELED)) return RUN_STATUS.CANCELED;
  if (terminalStatuses.includes(STEP_STATUS.FAIL)) return RUN_STATUS.FAILED;
  if (terminalStatuses.includes(STEP_STATUS.BLOCKED)) return RUN_STATUS.BLOCKED;
  if (terminalStatuses.some(status => status === STEP_STATUS.PASS)
    && terminalStatuses.every(status => status === STEP_STATUS.PASS || status === STEP_STATUS.SKIPPED)) return RUN_STATUS.PASSED;
  return RUN_STATUS.BLOCKED;
}

export function validateSubworkflowReferences({ workflow, activeWorkflowIds, depth = 0, maxDepth = 8, maxSteps, getWorkflow }) {
  const errors = [];
  if (depth > maxDepth) return [`Subworkflow nesting exceeds the maximum depth of ${maxDepth}.`];
  for (const step of workflow.steps ?? []) {
    if (step?.type !== "subworkflow") continue;
    const child = getWorkflow(step.workflowRef);
    if (!child) {
      errors.push(`No trusted registered subworkflow '${step.workflowRef}' exists.`);
      continue;
    }
    if (activeWorkflowIds.has(child.id)) {
      errors.push(`Subworkflow reference '${step.workflowRef}' forms a recursive workflow cycle.`);
      continue;
    }
    const validation = validateWorkflow(child, { maxSteps });
    if (!validation.valid) {
      errors.push(`Registered subworkflow '${step.workflowRef}' is invalid.`);
      continue;
    }
    const requiredInputs = new Set(child.inputNames ?? []);
    const providedInputs = new Set(Object.keys(step.inputs ?? {}));
    if ([...providedInputs].some(name => !requiredInputs.has(name))
      || [...requiredInputs].some(name => !providedInputs.has(name) && !Object.hasOwn(child.inputs ?? {}, name))) {
      errors.push(`Subworkflow '${step.workflowRef}' inputs do not match its registered interface.`);
    }
    const nextStack = new Set(activeWorkflowIds);
    nextStack.add(child.id);
    errors.push(...validateSubworkflowReferences({
      workflow: child,
      activeWorkflowIds: nextStack,
      depth: depth + 1,
      maxDepth,
      maxSteps,
      getWorkflow
    }));
  }
  return errors;
}

export function estimateWorkflowExecutionCost({ workflow, activeWorkflowIds = new Set(), maxSteps, getWorkflow }) {
  if (activeWorkflowIds.has(workflow.id)) return maxSteps + 1;
  const nextActive = new Set(activeWorkflowIds);
  nextActive.add(workflow.id);
  let cost = 0;
  for (const step of workflow.steps ?? []) {
    cost++;
    if (step?.type === "repeat") cost += (step.body?.length ?? 0) * (step.maxIterations ?? 0);
    if (step?.type === "subworkflow") {
      const child = getWorkflow(step.workflowRef);
      if (child) cost += estimateWorkflowExecutionCost({ workflow: child, activeWorkflowIds: nextActive, maxSteps, getWorkflow });
    }
    if (cost > maxSteps) return cost;
  }
  return cost;
}
