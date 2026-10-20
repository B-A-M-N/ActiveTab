/** Operation transitions committed through the RunStateStore mutation boundary. */
export class OperationLedger {
  #mutateRun;
  #safeIdentifier;
  #clone;

  constructor({ mutateRun, safeIdentifier, clone }) {
    if (typeof mutateRun !== "function" || typeof safeIdentifier !== "function" || typeof clone !== "function") {
      throw new Error("OperationLedger requires the RunStateStore mutation and validation callbacks.");
    }
    this.#mutateRun = mutateRun;
    this.#safeIdentifier = safeIdentifier;
    this.#clone = clone;
  }

  /** Persist a redacted reservation before dispatch. Input values are omitted. */
  async reserveOperation(runId, { operationId, stepId, action, effectDigest, environmentId = null, targetId = null, targetFencingToken = null } = {}) {
    for (const [value, label] of [[operationId, "operationId"], [action, "action"], [effectDigest, "effectDigest"]]) this.#safeIdentifier(String(value ?? ""), label);
    this.#safeIdentifier(String(stepId ?? ""), "stepId", { allowSlash: true });
    return await this.#mutateRun(runId, run => {
      if (environmentId !== null && environmentId !== run.environmentId) throw new Error("Operation reservation environment does not match its run binding.");
      if (targetId !== null && targetId !== run.target?.targetId) throw new Error("Operation reservation target does not match its run binding.");
      if (targetFencingToken !== null && targetFencingToken !== run.target?.fencingToken) throw new Error("Operation reservation uses a stale browser target fencing token.");
      const existing = run.pendingOperations.find(item => item.operationId === operationId)
        ?? run.uncertainOperations.find(item => item.operationId === operationId);
      if (existing) {
        if (existing.stepId !== stepId || existing.action !== action || existing.effectDigest !== effectDigest) throw new Error("Operation identity was reused with a different effect contract.");
        if (["DISPATCHED", "UNCERTAIN", "VERIFIED", "REFUSED"].includes(existing.status)) throw new Error(`Operation '${operationId}' already reached ${existing.status}; it cannot be dispatched again.`);
        return;
      }
      const duplicate = [...run.pendingOperations, ...run.uncertainOperations].find(item =>
        item.effectDigest === effectDigest && ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status)
      );
      if (duplicate) {
        throw new Error(`Equivalent effect is already ${duplicate.status} under operation '${duplicate.operationId}'; reconcile it before reserving another operation.`);
      }
      run.pendingOperations.push({
        operationId, stepId, action, effectDigest, status: "RESERVED",
        environmentId: run.environmentId, targetId: run.target?.targetId ?? null,
        targetFencingToken,
        reservedAt: new Date().toISOString()
      });
    });
  }

  async recordOperationDispatch(runId, { operationId, status, receiptId = null } = {}) {
    if (!operationId || !["DISPATCHED", "UNCERTAIN", "REFUSED"].includes(status)) throw new Error("Operation dispatch transition is invalid.");
    return await this.#mutateRun(runId, run => {
      const operationIndex = run.pendingOperations.findIndex(item => item.operationId === operationId);
      if (operationIndex < 0) throw new Error("No durable operation reservation exists for dispatch.");
      const operation = run.pendingOperations[operationIndex];
      if (operation.status !== "RESERVED") throw new Error(`Operation cannot transition from ${operation.status} to ${status}.`);
      operation.status = status;
      operation.dispatchedAt = status === "REFUSED" ? null : new Date().toISOString();
      operation.receiptId = typeof receiptId === "string" ? receiptId : null;
      if (status === "UNCERTAIN") run.uncertainOperations.push(this.#clone(operation));
    });
  }

  async reconcileOperation(runId, { operationId, status, evidenceIds = [], summary = "" } = {}) {
    if (!["OBSERVED", "VERIFIED", "FAILED", "UNCERTAIN"].includes(status)) throw new Error("Operation reconciliation status is invalid.");
    return await this.#mutateRun(runId, run => {
      const operation = run.uncertainOperations.find(item => item.operationId === operationId)
        ?? run.pendingOperations.find(item => item.operationId === operationId && ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status));
      if (!operation) throw new Error("No reserved or uncertain operation exists for reconciliation.");
      run.completedSteps ??= [];
      run.pendingOperations ??= [];
      operation.status = status;
      operation.evidenceIds = [...new Set(evidenceIds.filter(id => typeof id === "string"))].slice(0, 20);
      operation.summary = String(summary).slice(0, 500);
      operation.reconciledAt = new Date().toISOString();
      const checkpointStatus = status === "VERIFIED" ? "PASS"
        : status === "FAILED" ? "FAIL" : "UNCERTAIN";
      const checkpoint = run.completedSteps.find(item => item.stepId === operation.stepId);
      const checkpointRecord = {
        stepId: operation.stepId,
        type: "interact",
        status: checkpointStatus,
        evidenceIds: operation.evidenceIds,
        updatedAt: operation.reconciledAt
      };
      if (checkpoint) Object.assign(checkpoint, checkpointRecord);
      else run.completedSteps.push(checkpointRecord);
      if (status === "VERIFIED" || status === "FAILED") {
        const pending = run.pendingOperations.find(item => item.operationId === operationId);
        if (pending) { pending.status = status; pending.reconciledAt = operation.reconciledAt; }
        if (run.currentStepId === operation.stepId) run.currentStepId = null;
      }
      if (!run.pendingOperations.some(item => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status))) run.status = "resume_validation";
    });
  }
}
