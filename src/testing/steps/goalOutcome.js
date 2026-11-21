import { STEP_STATUS } from "../schema.js";

/** Project engine outcomes into workflow receipts without erasing dispatch uncertainty. */
export function projectGoalOutcome(goal, result = {}) {
  const succeeded = result.status === "succeeded";
  const definitelyNotDispatched = result.uncertain === false
    || result.dispatchDisposition === "refused_pre_dispatch";
  const status = succeeded ? STEP_STATUS.PASS
    : result.status === "canceled" && definitelyNotDispatched ? STEP_STATUS.CANCELED
      : STEP_STATUS.UNCERTAIN;
  const reason = succeeded
    ? `Goal resolved: ${goal}`
    : result.status === "canceled" && !definitelyNotDispatched
      ? "Goal step was canceled after dispatch may have started; its effect is UNCERTAIN and must be reconciled."
      : result.status === "canceled"
        ? "Goal step was canceled before dispatch; no browser input was sent."
        : `Goal step ended '${String(result.status ?? "unknown").slice(0, 64)}'; the expected application-level effect was not verified, so this is UNCERTAIN rather than PASS.`;

  return {
    status,
    reason,
    evidenceIds: [result.evidenceId ?? ""].filter(Boolean),
    details: {
      goal,
      engineStatus: result.status ?? "unknown",
      dispatchDisposition: result.dispatchDisposition ?? null,
      uncertain: status === STEP_STATUS.UNCERTAIN,
      attempts: result.attempts,
      recoveries: result.recoveries
    }
  };
}
