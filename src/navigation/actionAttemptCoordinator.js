import {
  DISPATCH_DISPOSITION,
  dispatchDispositionForStatus,
  normalizeDispatchOutcome
} from "../runtime/dispatchDisposition.js";

/** Coordinates durable attempts around an injected engine callback; it has no direct browser or authorization capability. */
export class ActionAttemptCoordinator {
  constructor({ taskState, runContext, updateJournal, reserveOperation, onDispatch } = {}) {
    if (!taskState || !Array.isArray(taskState.attempts)) {
      throw new TypeError("Action attempt coordination requires task state with an attempts list.");
    }
    if (!runContext?.counters || typeof updateJournal !== "function") {
      throw new TypeError("Action attempt coordination requires run counters and a journal updater.");
    }
    if (typeof reserveOperation !== "function" || typeof onDispatch !== "function") {
      throw new TypeError("Action attempt coordination requires operation reservation and dispatch recorders.");
    }
    this.taskState = taskState;
    this.runContext = runContext;
    this.updateJournal = updateJournal;
    this.reserveOperation = reserveOperation;
    this.onDispatch = onDispatch;
  }

  async begin(attempt) {
    this.runContext.pendingAttempt = attempt;
    this.taskState.pendingAction = attempt;
    await this.updateJournal();
  }

  async coordinateDispatch(attempt, actionType, executeAuthorizedAction) {
    if (typeof actionType !== "string" || !actionType || typeof executeAuthorizedAction !== "function") {
      throw new TypeError("Action dispatch coordination requires an action type and an injected authorized-action callback.");
    }

    await this.begin(attempt);
    let outcome;
    try {
      await this.reserveOperation(attempt, actionType);
    } catch (error) {
      outcome = normalizeDispatchOutcome({
        dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
        reasonCode: "operation_reservation_failed"
      }, { error, reasonCode: "operation_reservation_failed" });
    }

    if (!outcome) {
      // The callback belongs to NavigationEngine and must use its authorized
      // executor. An exception without a typed pre-dispatch refusal is
      // conservatively uncertain because the coordinator cannot prove that no
      // browser command was sent.
      try {
        outcome = await executeAuthorizedAction();
      } catch (error) {
        const aborted = error?.name === "AbortError" || error?.code === 20;
        outcome = normalizeDispatchOutcome({
          cancelled: aborted,
          dispatchDisposition: DISPATCH_DISPOSITION.UNCERTAIN,
          reasonCode: "dispatch_callback_exception"
        }, { error, reasonCode: "dispatch_callback_exception" });
      }
    }

    outcome = normalizeDispatchOutcome(outcome);
    const { dispatchDisposition, dispatchStatus } = outcome;
    attempt.dispatchDisposition = dispatchDisposition;
    attempt.dispatchStatus = dispatchStatus;
    attempt.browserEffectPossible = outcome.browserEffectPossible;
    attempt.retryWithoutReconciliation = outcome.retryWithoutReconciliation;
    attempt.dispatchReasonCode = outcome.reasonCode;
    if (dispatchDisposition === DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN
      || dispatchDisposition === DISPATCH_DISPOSITION.UNCERTAIN) {
      attempt.uncertainOutcome = true;
    }
    if (dispatchDisposition === DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED
      || dispatchDisposition === DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN) {
      attempt.dispatched = true;
    }
    if (outcome.error) {
      attempt.error = {
        name: outcome.error.name ?? "Error",
        message: String(outcome.error.message ?? outcome.error).slice(0, 400)
      };
    }
    if (outcome.observation?.evidenceId) attempt.dispatchObservationId = outcome.observation.evidenceId;
    await this.recordDispatch(attempt, actionType, dispatchStatus, dispatchDisposition);
    return { ...outcome };
  }

  async recordDispatch(attempt, actionType, dispatchStatus, dispatchDisposition = null) {
    attempt.dispatchStatus = dispatchStatus;
    attempt.dispatchDisposition = dispatchDisposition ?? dispatchDispositionForStatus(dispatchStatus);
    try {
      await this.onDispatch(attempt, actionType, dispatchStatus, attempt.dispatchDisposition ?? null);
    } catch {
      attempt.telemetryIncomplete = true;
    }
    await this.updateJournal();
  }

  finish(attempt) {
    delete this.taskState.pendingAction;
    this.taskState.attempts.push(attempt);
    this.runContext.counters.actions = this.taskState.attempts.length;
    this.runContext.pendingAttempt = null;
  }
}
