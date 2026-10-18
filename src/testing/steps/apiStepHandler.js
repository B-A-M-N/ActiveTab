import { STEP_STATUS } from "../schema.js";

function classifyDiagnosticResult(snapshot) {
  const statuses = [snapshot?.data?.result?.status, snapshot?.data?.status, snapshot?.status]
    .filter(status => typeof status === "string");
  const refusal = statuses.find(status => ["refused", "denied"].includes(status));
  if (refusal) return { status: STEP_STATUS.BLOCKED, effectStatus: refusal, resultStatus: refusal };
  const failure = statuses.find(status => ["error", "failed"].includes(status));
  if (failure) return { status: STEP_STATUS.FAIL, effectStatus: failure, resultStatus: failure };
  const uncertain = statuses.find(status => ["uncertain", "unavailable", "unknown"].includes(status));
  if (uncertain) return { status: STEP_STATUS.UNCERTAIN, effectStatus: uncertain, resultStatus: uncertain };
  const unexpected = statuses.find(status => !["ok", "available", "empty"].includes(status));
  if (unexpected) return { status: STEP_STATUS.UNCERTAIN, effectStatus: "unrecognized_status", resultStatus: unexpected };
  const resultStatus = statuses[0] ?? null;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.data || typeof snapshot.data !== "object") {
    return { status: STEP_STATUS.UNCERTAIN, effectStatus: "missing_snapshot_data", resultStatus };
  }
  return { status: STEP_STATUS.PASS, effectStatus: resultStatus ?? "collected", resultStatus };
}

/** Dispatches registered typed application diagnostics through their adapters. */
export class ApiStepHandler {
  constructor({ collector = null } = {}) {
    this.collector = collector;
  }

  async execute(step, receipt, startedAt) {
    if (!this.collector) {
      const reason = "No diagnostic collector configured for API operations.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const operation = step.operation;
    if (typeof operation?.operationId !== "string" || !operation.operationId) {
      const reason = "API operation requires a typed operationId.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const sourceId = operation.sourceId;
    if (typeof sourceId !== "string" || !this.collector.hasSource(sourceId)) {
      const reason = `Diagnostic source '${sourceId}' for operation '${operation.operationId}' is not registered.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const declaredOp = operation.type ?? "read";
    try {
      const snapshot = await this.collector.collect(sourceId, declaredOp, { operationId: operation.operationId, ...operation.options });
      const classified = classifyDiagnosticResult(snapshot);
      const status = classified.status;
      const reason = status === STEP_STATUS.PASS
        ? `Diagnostic snapshot collected from source '${sourceId}'; this does not verify an application outcome.`
        : status === STEP_STATUS.BLOCKED
          ? `Diagnostic operation '${operation.operationId}' was refused by source '${sourceId}'.`
          : status === STEP_STATUS.FAIL
            ? `Diagnostic operation '${operation.operationId}' returned an error from source '${sourceId}'.`
            : `Diagnostic operation '${operation.operationId}' returned an unavailable or unrecognized result; outcome remains uncertain.`;
      receipt.recordStep({
        stepId: step.id, type: step.type, status, reason, startedAt,
        evidenceIds: [snapshot?.evidenceId ?? snapshot?.sourceId ?? ""].filter(Boolean),
        details: {
          operationId: operation.operationId,
          sourceId,
          dispatchStatus: "dispatched",
          effectStatus: classified.effectStatus,
          verificationStatus: "not_verified",
          ...(classified.resultStatus ? { resultStatus: classified.resultStatus } : {})
        }
      });
      return { status, reason, snapshot };
    } catch (error) {
      const reason = `API operation failed: ${String(error.message ?? error).slice(0, 300)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
  }
}
