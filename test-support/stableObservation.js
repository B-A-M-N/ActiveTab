const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForActivityQuiet(session, {
  quietMs = 300,
  timeoutMs = 10_000,
  pollMs = 25,
  includePendingRequests = false,
  label = "browser fixture"
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = null;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const activity = session.activity.snapshot();
    const pendingRequests = includePendingRequests
      ? activity.networkRequests.filter(request => request.finishedAt === null).length
      : null;
    const signature = `${activity.totalLifecycleEvents}:${activity.totalDomMutations}:${activity.totalRequests}:${pendingRequests ?? "ignored"}`;
    if (signature !== previousSignature) {
      previousSignature = signature;
      quietSince = Date.now();
    }
    if ((pendingRequests === null || pendingRequests === 0) && Date.now() - quietSince >= quietMs) return;
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${label} did not reach a quiet lifecycle, DOM, and request state within ${timeoutMs} ms.`);
}

export async function observeStable(session, options, readiness = {}) {
  const {
    timeoutMs = 10_000,
    quietMs = 300,
    pollMs = 25,
    includePendingRequests = false,
    label = "browser fixture"
  } = readiness;
  const deadline = Date.now() + timeoutMs;
  let observation;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await waitForActivityQuiet(session, {
      timeoutMs: remaining,
      quietMs,
      pollMs,
      includePendingRequests,
      label
    });
    observation = await session.observe(options);
    if (observation.captureCoherence?.status === "stable" && observation.historical !== true) return observation;
  }
  throw new Error(`${label} did not produce a stable current observation within ${timeoutMs} ms: ${JSON.stringify(observation?.captureCoherence)}`);
}
