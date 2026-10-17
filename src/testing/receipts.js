/**
 * Test receipts — structured per-step and final-run receipts with evidence
 * references. Receipts do not contain raw goals, form values, or sensitive data.
 */

import { STEP_STATUS, RUN_STATUS } from "./schema.js";

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
    this.limitations = [];
  }

  recordStep({ stepId, type, status, reason, evidenceIds = [], startedAt, finishedAt, details = null }) {
    if (!Object.values(STEP_STATUS).includes(status)) {
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

  addLimitation(text) {
    this.limitations.push(String(text));
    return this;
  }

  finish(status) {
    if (!Object.values(RUN_STATUS).includes(status)) throw new Error(`Unknown run status '${status}'.`);
    if (status !== RUN_STATUS.RUNNING) this.finishedAt = new Date().toISOString();
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
      limitations: [...this.limitations]
    };
  }
}

/**
 * Derive final run status from step statuses.
 * CANCELED takes precedence, then FAILED/BLOCKED, then PASSED.
 */
export function deriveRunStatus(steps) {
  const statuses = steps.map(step => step.status);
  if (statuses.includes(STEP_STATUS.CANCELED)) return RUN_STATUS.CANCELED;
  if (statuses.includes(STEP_STATUS.FAIL)) return RUN_STATUS.FAILED;
  if (statuses.includes(STEP_STATUS.BLOCKED)) return RUN_STATUS.BLOCKED;
  if (statuses.includes(STEP_STATUS.UNCERTAIN)) return RUN_STATUS.FAILED;
  if (statuses.every(status => status === STEP_STATUS.PASS)) return RUN_STATUS.PASSED;
  return RUN_STATUS.FAILED;
}
