/**
 * Test receipts — structured per-step and final-run receipts with evidence
 * references. Receipts do not contain raw goals, form values, or sensitive data.
 */

import { STEP_STATUS, RUN_STATUS, isWaitingRunStatus } from "./schema.js";

/** SUSPENDED: the step is paused at a durable human intervention (P0-3). */
export const STEP_SUSPENDED = "SUSPENDED";

export class TestReceipt {
  constructor({ runId, workflowId, workflowName }) {
    this.runId = String(runId);
    this.workflowId = String(workflowId);
    this.workflowName = String(workflowName);
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.status = RUN_STATUS.RUNNING;
    this.steps = [];
    this.cleanup = [];
    this.interventions = [];
    this.limitations = [];
  }

  static fromObject(value) {
    if (!value || typeof value !== "object" || typeof value.runId !== "string"
      || typeof value.workflowId !== "string" || !Array.isArray(value.steps)
      || !Array.isArray(value.interventions) || !Object.values(RUN_STATUS).includes(value.status)) {
      throw new Error("Cannot restore an invalid durable test receipt.");
    }
    const receipt = new TestReceipt({ runId: value.runId, workflowId: value.workflowId, workflowName: value.workflowName ?? value.workflowId });
    receipt.startedAt = typeof value.startedAt === "string" ? value.startedAt : receipt.startedAt;
    receipt.finishedAt = typeof value.finishedAt === "string" ? value.finishedAt : null;
    receipt.status = value.status;
    receipt.steps = value.steps.map(step => {
      if (!step || typeof step.stepId !== "string" || typeof step.type !== "string"
        || ![...Object.values(STEP_STATUS), STEP_SUSPENDED].includes(step.status)) {
        throw new Error("Cannot restore a durable receipt with an invalid step.");
      }
      return {
        stepId: step.stepId,
        type: step.type,
        status: step.status,
        reason: String(step.reason ?? "Restored from durable run state."),
        evidenceIds: Array.isArray(step.evidenceIds) ? step.evidenceIds.filter(id => typeof id === "string").slice(0, 20) : [],
        startedAt: typeof step.startedAt === "string" ? step.startedAt : receipt.startedAt,
        finishedAt: typeof step.finishedAt === "string" ? step.finishedAt : receipt.startedAt
      };
    });
    receipt.interventions = value.interventions.map(item => {
      if (!item || typeof item.stepId !== "string" || typeof item.interventionId !== "string") {
        throw new Error("Cannot restore a durable receipt with an invalid intervention reference.");
      }
      return {
        stepId: item.stepId,
        interventionId: item.interventionId,
        type: String(item.type ?? "human_decision"),
        state: String(item.state ?? "waiting_for_human"),
        reason: String(item.reason ?? "Restored from durable run state."),
        ...(typeof item.externalState === "string" ? { externalState: item.externalState } : {}),
        ...(typeof item.resumedAt === "string" ? { resumedAt: item.resumedAt } : {})
      };
    });
    receipt.cleanup = (Array.isArray(value.cleanup) ? value.cleanup : []).map(item => {
      if (!item || typeof item.stepId !== "string" || typeof item.status !== "string") {
        throw new Error("Cannot restore a durable receipt with an invalid cleanup obligation.");
      }
      return {
        stepId: item.stepId,
        status: item.status,
        reason: String(item.reason ?? "Restored cleanup obligation."),
        recordedAt: typeof item.recordedAt === "string" ? item.recordedAt : receipt.startedAt
      };
    });
    return receipt;
  }

  recordStep({ stepId, type, status, reason, evidenceIds = [], startedAt, finishedAt, details = null }) {
    if (!Object.values(STEP_STATUS).includes(status) && status !== STEP_SUSPENDED) {
      throw new Error(`Unknown step status '${status}' for step '${stepId}'.`);
    }
    this.steps.push({
      stepId, type, status, reason,
      evidenceIds: [...evidenceIds],
      startedAt: startedAt ?? new Date().toISOString(),
      finishedAt: finishedAt ?? new Date().toISOString(),
      ...(details ? { details } : {})
    });
    return this;
  }

  recordCleanup({ stepId, status, reason }) {
    const existingPending = this.cleanup.findLast(item => item.stepId === stepId && item.status === "pending");
    const entry = { stepId, status, reason: String(reason ?? "").slice(0, 500), recordedAt: new Date().toISOString() };
    if (existingPending) Object.assign(existingPending, entry);
    else this.cleanup.push(entry);
    return this;
  }

  /** Record a durable human intervention; keeps run/step identity. */
  recordIntervention({ stepId, interventionId, type, state, reason, externalState }) {
    this.interventions.push({
      stepId, interventionId, type, state, reason,
      ...(externalState ? { externalState } : {}),
      recordedAt: new Date().toISOString()
    });
    return this;
  }

  /** Reconcile the suspended step with its verified continuation result. */
  replaceSuspendedStep(stepId) {
    const suspendedIndex = this.steps.findIndex(step => step.stepId === stepId && step.status === STEP_SUSPENDED);
    if (suspendedIndex < 0) return false;
    const suspended = this.steps[suspendedIndex];
    const resumedIndex = this.steps.findLastIndex(step => step.stepId === stepId);
    if (resumedIndex <= suspendedIndex) return false;
    const resumed = this.steps[resumedIndex];
    this.steps[suspendedIndex] = { ...resumed, startedAt: suspended.startedAt };
    this.steps.splice(resumedIndex, 1);
    return true;
  }

  /** Complete a suspended step when its exact resume predicate proves its postcondition. */
  completeSuspendedStep(stepId, { reason, evidenceId = null } = {}) {
    const step = this.steps.findLast(item => item.stepId === stepId && item.status === STEP_SUSPENDED);
    if (!step) return false;
    step.status = STEP_STATUS.PASS;
    step.reason = String(reason ?? "The suspended step's completion predicate was verified.");
    step.finishedAt = new Date().toISOString();
    step.evidenceIds = evidenceId ? [evidenceId] : [];
    delete step.details;
    return true;
  }

  /** Reconcile a dispatched step only after independent evidence arrives. */
  reconcileStep(stepId, { status, reason, evidenceIds = [], details = null } = {}) {
    if (![STEP_STATUS.PASS, STEP_STATUS.FAIL, STEP_STATUS.UNCERTAIN].includes(status)) {
      throw new Error("An uncertain step can only reconcile to PASS, FAIL, or UNCERTAIN.");
    }
    const step = this.steps.findLast(item => item.stepId === stepId && item.status === STEP_STATUS.UNCERTAIN);
    if (!step) return false;
    step.status = status;
    step.reason = String(reason ?? "Uncertain step reconciled from independent evidence.");
    step.finishedAt = new Date().toISOString();
    step.evidenceIds = [...new Set(evidenceIds.filter(id => typeof id === "string"))].slice(0, 20);
    if (details && typeof details === "object" && !Array.isArray(details)) step.details = details;
    this.finish(deriveRunStatus(this.steps));
    return true;
  }

  addLimitation(text) {
    this.limitations.push(String(text));
    return this;
  }

  finish(status) {
    if (!Object.values(RUN_STATUS).includes(status)) throw new Error(`Unknown run status '${status}'.`);
    // Waiting states are suspensions, not completions: the run can resume.
    if (status !== RUN_STATUS.RUNNING && !isWaitingRunStatus(status)) this.finishedAt = new Date().toISOString();
    this.status = status;
    return this;
  }

  toObject() {
    return {
      runId: this.runId,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      status: this.status,
      steps: [...this.steps],
      cleanup: [...this.cleanup],
      interventions: [...this.interventions],
      limitations: [...this.limitations]
    };
  }
}

/** Rebuild the bounded receipt shell needed to resume from durable checkpoints. */
export function receiptFromRunState(runState, intervention = null) {
  if (!runState || typeof runState.runId !== "string" || !Array.isArray(runState.completedSteps)) {
    throw new Error("Cannot restore a receipt from invalid durable run state.");
  }
  const workflowId = runState.executionContract?.workflowId ?? runState.workflowId;
  const receipt = new TestReceipt({
    runId: runState.runId,
    workflowId,
    workflowName: runState.workflowName ?? workflowId
  });
  receipt.startedAt = typeof runState.createdAt === "string" ? runState.createdAt : receipt.startedAt;
  for (const checkpoint of runState.completedSteps) {
    if (!checkpoint || typeof checkpoint.stepId !== "string" || typeof checkpoint.status !== "string") continue;
    if (![...Object.values(STEP_STATUS), STEP_SUSPENDED].includes(checkpoint.status)) continue;
    receipt.recordStep({
      stepId: checkpoint.stepId,
      type: checkpoint.type ?? "checkpoint",
      status: checkpoint.status,
      reason: "Restored from a durable workflow checkpoint.",
      evidenceIds: checkpoint.evidenceIds ?? []
    });
  }
  if (intervention) {
    if (intervention.runId !== runState.runId || intervention.intervention_id !== runState.pendingInterventionId) {
      throw new Error("Durable intervention does not belong to the run's pending intervention binding.");
    }
    receipt.recordIntervention({
      stepId: intervention.stepId,
      interventionId: intervention.intervention_id,
      type: intervention.type,
      state: intervention.state,
      reason: "Restored from the durable intervention record.",
      externalState: intervention.externalState
    });
  }
  const normalizedStatus = String(runState.status ?? "running").toUpperCase();
  receipt.status = Object.values(RUN_STATUS).includes(normalizedStatus) ? normalizedStatus : RUN_STATUS.RUNNING;
  if (isWaitingRunStatus(receipt.status)) receipt.finishedAt = null;
  return receipt;
}

/**
 * Derive final run status from step statuses.
 * A suspended run (any SUSPENDED step) stays in a resumable waiting state.
 * Uncertain effects remain distinct from definitive failure and cancellation.
 */
export const STEP_STATUS_EXTENDED = Object.freeze({ ...STEP_STATUS, SUSPENDED: STEP_SUSPENDED });

export function deriveRunStatus(steps) {
  const statuses = steps.map(step => step.status);
  if (statuses.includes(STEP_STATUS.UNCERTAIN)) return RUN_STATUS.UNCERTAIN;
  if (statuses.includes(STEP_STATUS.CANCELED)) return RUN_STATUS.CANCELED;
  if (statuses.includes(STEP_STATUS_EXTENDED.SUSPENDED)) return RUN_STATUS.WAITING_FOR_HUMAN_DECISION;
  if (statuses.includes(STEP_STATUS.FAIL)) return RUN_STATUS.FAILED;
  if (statuses.includes(STEP_STATUS.BLOCKED)) return RUN_STATUS.BLOCKED;
  if (statuses.some(status => status === STEP_STATUS.PASS)
    && statuses.every(status => status === STEP_STATUS.PASS || status === STEP_STATUS.SKIPPED)) return RUN_STATUS.PASSED;
  return RUN_STATUS.FAILED;
}
