/** Coordinate bounded API shutdown without inventing run outcomes. */
export function createShutdownCoordinator({
  stopAdmission,
  getTestRuns,
  ensureRunStateStore,
  runStateStore,
  lifecycle,
  server,
  closeOwnedResources,
  logger,
  timeoutMs = 10_000
} = {}) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(60_000, Math.floor(timeoutMs)))
    : 10_000;
  let stopPromise = null;

  async function cancelAfterPersistingIntent(run) {
    if (run.runState.settled) return;
    try {
      await ensureRunStateStore();
      while (!run.runState.settled) {
        const durable = await runStateStore.getFresh(run.runId);
        if (durable) {
          if (["passed", "failed", "blocked", "canceled", "expired"].includes(durable.status)) return;
          const requested = await runStateStore.requestCancellation(run.runId);
          if (requested?.cancellationRequested === true) run.controller.abort();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) {
      logger.warn("api.shutdown.cancellation.persist.failed", {
        run: run.runId,
        reason: String(error?.message ?? error).slice(0, 120)
      });
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopAdmission();
    stopPromise = (async () => {
      const runs = getTestRuns();
      const serverClosed = new Promise(resolve => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
      });
      const cancellationWork = Promise.allSettled(runs.map(cancelAfterPersistingIntent));
      const legacyWork = lifecycle.stopAll();
      const allWork = Promise.allSettled([
        cancellationWork,
        legacyWork,
        ...runs.map(run => run.settlement ?? run.runState.completion)
      ]);
      void allWork.then(() => closeOwnedResources()).catch(error => {
        logger.error("api.shutdown.resources.close.failed", { reason: String(error?.message ?? error).slice(0, 120) });
      });

      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), boundedTimeoutMs);
      });
      const settledInTime = await Promise.race([allWork.then(() => true), timeout]);
      clearTimeout(timer);
      if (settledInTime) await closeOwnedResources();
      else {
        logger.warn("api.shutdown.runs.unsettled", {
          count: runs.filter(run => !run.runState.settled).length,
          timeoutMs: boundedTimeoutMs
        });
        server.closeAllConnections?.();
      }
      await serverClosed;
    })();
    return stopPromise;
  }

  return Object.freeze({ stop });
}
