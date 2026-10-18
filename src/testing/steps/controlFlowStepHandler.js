import { evaluateAssertion } from "../assertions.js";
import { isWaitingRunStatus, RUN_STATUS, STEP_STATUS, validateWorkflow } from "../schema.js";
import { STEP_STATUS_EXTENDED } from "../receipts.js";
import { deriveWorkflowRunStatus } from "../execution/workflowScheduler.js";

/** Handles in-memory workflow control flow without browser or API authority. */
export class ControlFlowStepHandler {
  constructor({ maxSteps, signal = null, collector = null, correlator = null, observe, executeWorkflowSteps, getWorkflow } = {}) {
    this.maxSteps = maxSteps;
    this.signal = signal;
    this.collector = collector;
    this.correlator = correlator;
    this.observe = observe ?? (async () => null);
    this.executeWorkflowSteps = executeWorkflowSteps;
    this.getWorkflow = getWorkflow ?? (() => null);
  }

  resolveWorkflowValue(value, context, stepStatuses = context?.stepStatuses) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value).length === 1 && typeof value.variable === "string") {
        return context?.variables?.get(value.variable);
      }
      if (Object.keys(value).length === 1 && typeof value.stepStatus === "string") {
        return stepStatuses?.get(value.stepStatus);
      }
    }
    return value;
  }

  executeSetVariable(step, receipt, startedAt, context, stepStatuses) {
    const resolved = this.resolveWorkflowValue(step.value, context, stepStatuses);
    if (resolved === undefined || !(resolved === null || ["string", "number", "boolean"].includes(typeof resolved))) {
      const reason = "Variable assignment source is unavailable or is not a scalar value.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    if (!context?.variables) {
      const reason = "No scoped workflow variable context is available.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    context.variables.set(step.name, resolved);
    const reason = "Scoped workflow variable assigned in memory.";
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt });
    return { status: STEP_STATUS.PASS, reason };
  }

  async executeRepeat(step, receipt, startedAt, parentContext) {
    const context = parentContext ?? { variables: new Map(), workflowStack: new Set(), depth: 0 };
    for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
      if (this.signal?.aborted) {
        const reason = "Run was canceled before the next bounded loop iteration.";
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.CANCELED, reason, startedAt });
        return { status: STEP_STATUS.CANCELED, reason };
      }
      const iterationContext = {
        variables: new Map(context.variables),
        workflowStack: new Set(context.workflowStack),
        depth: context.depth + 1,
        stepStatuses: new Map(),
        completedStatuses: context.completedStatuses,
        budget: context.budget
      };
      const result = await this.executeWorkflowSteps(
        { id: `${step.id}-body`, name: "bounded repeat body", steps: step.body },
        receipt,
        iterationContext,
        { stepIdPrefix: `${step.id}/iteration-${iteration}` }
      );
      if (result.suspension) {
        return {
          status: STEP_STATUS_EXTENDED.SUSPENDED,
          externalState: result.suspension.externalState,
          reason: `Bounded loop suspended at '${result.suspension.stepId}'.`
        };
      }
      const bodyStatuses = [...result.stepStatuses.values()];
      const failedBodyStatus = bodyStatuses.find(status => status !== STEP_STATUS.PASS);
      if (failedBodyStatus) {
        const reason = `Bounded loop body ended with ${failedBodyStatus}; no further iteration was dispatched.`;
        return { status: failedBodyStatus, reason };
      }
      const until = evaluateAssertion(step.until, {
        observation: await this.observe(),
        collector: this.collector,
        correlator: this.correlator
      });
      if (until.status === STEP_STATUS.PASS) {
        const reason = `Loop condition verified after ${iteration} bounded iteration${iteration === 1 ? "" : "s"}.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: STEP_STATUS.PASS, reason };
      }
      if (until.status === STEP_STATUS.UNCERTAIN) {
        const reason = `Loop condition could not be verified after iteration ${iteration}; execution stopped without another retry.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: STEP_STATUS.UNCERTAIN, reason };
      }
      if (until.status === STEP_STATUS.BLOCKED || until.status === STEP_STATUS.CANCELED) {
        const reason = until.status === STEP_STATUS.CANCELED
          ? "The bounded loop was canceled after its current iteration."
          : "The bounded loop condition is blocked; no further iteration was dispatched.";
        receipt.recordStep({ stepId: step.id, type: step.type, status: until.status, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: until.status, reason };
      }
    }
    const reason = `Loop condition remained false after the declared maximum of ${step.maxIterations} iterations.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
    return { status: STEP_STATUS.FAIL, reason };
  }

  async executeSubworkflow(step, receipt, startedAt, parentContext) {
    const workflow = this.getWorkflow(step.workflowRef);
    if (!workflow) {
      const reason = `Trusted workflow registry has no subworkflow '${step.workflowRef}'.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const parent = parentContext ?? { variables: new Map(), workflowStack: new Set(), depth: 0 };
    if (parent.depth >= 8 || parent.workflowStack.has(workflow.id)) {
      const reason = "Subworkflow nesting exceeded its depth limit or formed a recursive reference.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const validation = validateWorkflow(workflow, { maxSteps: this.maxSteps });
    if (!validation.valid) {
      const reason = "Registered subworkflow failed schema validation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const inputs = step.inputs ?? {};
    const allowedInputs = new Set(workflow.inputNames ?? []);
    if (Object.keys(inputs).some(name => !allowedInputs.has(name))
      || [...allowedInputs].some(name => !Object.hasOwn(inputs, name) && !Object.hasOwn(workflow.inputs ?? {}, name))) {
      const reason = "Subworkflow inputs do not satisfy the registered workflow interface.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const variables = new Map(Object.entries(workflow.inputs ?? {}));
    for (const [name, value] of Object.entries(inputs)) {
      const resolved = this.resolveWorkflowValue(value, parent);
      if (resolved === undefined || !(resolved === null || ["string", "number", "boolean"].includes(typeof resolved))) {
        const reason = `Subworkflow input '${name}' could not be resolved to a scalar.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
        return { status: STEP_STATUS.BLOCKED, reason };
      }
      variables.set(name, resolved);
    }
    const workflowStack = new Set(parent.workflowStack);
    workflowStack.add(workflow.id);
    const childContext = { variables, workflowStack, depth: parent.depth + 1, stepStatuses: new Map(), completedStatuses: parent.completedStatuses, budget: parent.budget };
    const childResult = await this.executeWorkflowSteps(workflow, receipt, childContext, { stepIdPrefix: step.id });
    if (isWaitingRunStatus(receipt.status)) {
      const reason = `Registered subworkflow '${step.workflowRef}' suspended at its child step.`;
      return {
        status: STEP_STATUS_EXTENDED.SUSPENDED,
        externalState: childResult.suspension?.externalState ?? "waiting_for_human_decision",
        reason
      };
    }
    const childStatus = deriveWorkflowRunStatus(workflow, childResult.stepStatuses);
    if (childStatus === RUN_STATUS.PASSED) {
      for (const [from, to] of Object.entries(step.outputs ?? {})) {
        if (!variables.has(from)) {
          const reason = "Registered subworkflow output was not defined in its private scope.";
          receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
          return { status: STEP_STATUS.UNCERTAIN, reason };
        }
        parent.variables.set(to, variables.get(from));
      }
      const reason = `Registered subworkflow '${step.workflowRef}' completed its declared steps.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt });
      return { status: STEP_STATUS.PASS, reason };
    }
    const status = childStatus === RUN_STATUS.UNCERTAIN ? STEP_STATUS.UNCERTAIN
      : childStatus === RUN_STATUS.BLOCKED ? STEP_STATUS.BLOCKED
        : childStatus === RUN_STATUS.CANCELED ? STEP_STATUS.CANCELED : STEP_STATUS.FAIL;
    const reason = `Registered subworkflow '${step.workflowRef}' ended ${status}.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt });
    return { status, reason };
  }
}
