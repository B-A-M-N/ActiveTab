function unchangedAfterFailedClick(attempt) {
  return attempt?.action === "click" && Boolean(attempt.error) &&
    (attempt.sameTargetRemained === true || attempt.observationUnavailable === true ||
      /^[a-f0-9]{64}$/.test(attempt.beforeStateFingerprint ?? "") && attempt.beforeStateFingerprint === attempt.afterStateFingerprint);
}

export function createNavigationRunContext({ taskState, observation, limits, executionBinding }) {
  if (!taskState || !Array.isArray(taskState.attempts)) {
    throw new TypeError("Navigation run context requires a task state with attempts.");
  }
  if (!observation || typeof observation !== "object") {
    throw new TypeError("Navigation run context requires the current observation.");
  }

  const attempts = taskState.attempts;
  const failedClicks = attempts.filter(attempt => attempt.action === "click" && attempt.error);
  const failedTargets = attempts.filter(attempt => attempt.error && attempt.action !== "scroll");
  const candidateIdentities = new Set(failedTargets
    .map(attempt => attempt.targetIdentity)
    .filter(value => typeof value === "string" && value));
  const targetSignatures = failedClicks
    .filter(attempt => attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt))
    .map(attempt => attempt.targetSignature)
    .filter(Boolean);
  const scrollIdentities = new Set(attempts
    .filter(attempt => attempt.action === "scroll" && attempt.error && attempt.scrollProgressObserved !== true)
    .map(attempt => attempt.targetIdentity)
    .filter(value => typeof value === "string" && value));

  if (taskState.scrollRecoveryBlocked === true) {
    for (const target of observation.scrollTargets ?? []) scrollIdentities.add(target.identity);
  }

  const context = {
    taskState,
    latestObservation: observation,
    executionBinding: Object.freeze({ ...executionBinding }),
    journalIdentity: taskState.taskId ?? null,
    limits: Object.freeze({ ...limits }),
    counters: {
      actions: attempts.length,
      recoveries: taskState.recoveryCount ?? 0,
      scrolls: attempts.filter(attempt => attempt.action === "scroll").length
    },
    exclusions: {
      candidateIdentities,
      targetSignatures,
      scrollIdentities
    },
    scrollConvergenceStates: new Map(),
    pendingAttempt: null,
    setLatestObservation(nextObservation) {
      this.latestObservation = nextObservation;
      return nextObservation;
    },
    excludeFailedAttempt(attempt) {
      if (!attempt?.error) return;
      if (attempt.action !== "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity) {
        candidateIdentities.add(attempt.targetIdentity);
      }
      if (attempt.action === "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity && attempt.scrollProgressObserved !== true) {
        scrollIdentities.add(attempt.targetIdentity);
      }
      if (attempt.action === "click" && (attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt)) && attempt.targetSignature) {
        targetSignatures.push(attempt.targetSignature);
      }
    }
  };

  return context;
}
