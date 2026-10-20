/** Tracks a pending action durably; it has no browser dispatch capability. */
export class ActionAttemptCoordinator {
  constructor({ taskState, runContext, updateJournal } = {}) {
    if (!taskState || !Array.isArray(taskState.attempts)) {
      throw new TypeError("Action attempt coordination requires task state with an attempts list.");
    }
    if (!runContext?.counters || typeof updateJournal !== "function") {
      throw new TypeError("Action attempt coordination requires run counters and a journal updater.");
    }
    this.taskState = taskState;
    this.runContext = runContext;
    this.updateJournal = updateJournal;
  }

  async begin(attempt) {
    this.runContext.pendingAttempt = attempt;
    this.taskState.pendingAction = attempt;
    await this.updateJournal();
  }

  finish(attempt) {
    delete this.taskState.pendingAction;
    this.taskState.attempts.push(attempt);
    this.runContext.counters.actions = this.taskState.attempts.length;
    this.runContext.pendingAttempt = null;
  }
}
