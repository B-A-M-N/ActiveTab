export const DISPATCH_DISPOSITION = Object.freeze({
  REFUSED_PRE_DISPATCH: "refused_pre_dispatch",
  DISPATCHED_UNVERIFIED: "dispatched_unverified",
  PARTIALLY_DISPATCHED_UNCERTAIN: "partially_dispatched_uncertain",
  UNCERTAIN: "uncertain"
});

const DISPATCH_STATUS_BY_DISPOSITION = Object.freeze({
  [DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH]: "refused",
  [DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED]: "dispatched",
  [DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN]: "uncertain",
  [DISPATCH_DISPOSITION.UNCERTAIN]: "uncertain"
});

const dispatchDispositions = new Set(Object.values(DISPATCH_DISPOSITION));
const DISPATCH_REASON_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;

function safeReasonCode(value) {
  return typeof value === "string" && DISPATCH_REASON_CODE_PATTERN.test(value) ? value : null;
}

export function isDispatchDisposition(value) {
  return dispatchDispositions.has(value);
}

export function dispatchStatusForDisposition(value) {
  return DISPATCH_STATUS_BY_DISPOSITION[value] ?? "uncertain";
}

export function dispatchDispositionForStatus(value) {
  if (value === "refused") return DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH;
  if (value === "dispatched") return DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED;
  return DISPATCH_DISPOSITION.UNCERTAIN;
}

export function normalizeDispatchOutcome(outcome, { error, reasonCode } = {}) {
  const dispatchDisposition = isDispatchDisposition(outcome?.dispatchDisposition)
    ? outcome.dispatchDisposition
    : DISPATCH_DISPOSITION.UNCERTAIN;
  const browserEffectPossible = dispatchDisposition !== DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH;
  const normalizedError = error ?? outcome?.error ?? (
    dispatchDisposition === DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED
      ? undefined
      : new Error(outcome?.reason ?? "The browser operation did not produce a verified dispatch disposition.")
  );

  return {
    ...(outcome && typeof outcome === "object" ? outcome : {}),
    dispatchDisposition,
    dispatchStatus: dispatchStatusForDisposition(dispatchDisposition),
    browserEffectPossible,
    retryWithoutReconciliation: !browserEffectPossible,
    reasonCode: safeReasonCode(reasonCode ?? outcome?.reasonCode ?? outcome?.category),
    ...(normalizedError ? { error: normalizedError } : {})
  };
}
