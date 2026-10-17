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
    this.cleanup.push({ stepId, status, reason, recordedAt: new Date().toISOString() });
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

/**
 * Derive final run status from step statuses.
 * A suspended run (any SUSPENDED step) stays in a resumable waiting state;
 * CANCELED takes precedence, then FAILED/BLOCKED, then PASSED.
 */
export const STEP_STATUS_EXTENDED = Object.freeze({ ...STEP_STATUS, SUSPENDED: STEP_SUSPENDED });

export function deriveRunStatus(steps) {
  const statuses = steps.map(step => step.status);
  if (statuses.includes(STEP_STATUS.CANCELED)) return RUN_STATUS.CANCELED;
  if (statuses.includes(STEP_STATUS_EXTENDED.SUSPENDED)) return RUN_STATUS.WAITING_FOR_HUMAN_DECISION;
  if (statuses.includes(STEP_STATUS.FAIL)) return RUN_STATUS.FAILED;
  if (statuses.includes(STEP_STATUS.BLOCKED)) return RUN_STATUS.BLOCKED;
  if (statuses.includes(STEP_STATUS.UNCERTAIN)) return RUN_STATUS.FAILED;
  if (statuses.every(status => status === STEP_STATUS.PASS)) return RUN_STATUS.PASSED;
  return RUN_STATUS.FAILED;
}
