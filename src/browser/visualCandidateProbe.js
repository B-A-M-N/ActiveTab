export async function runVisualCandidateProbe(session, evidenceId, { x, y, timeoutMs, active }) {
  const startedAt = performance.now();
  const staleResult = reasonCode => ({ status: "stale", reasonCode, evidenceId, actionAuthorized: false });
  const isSuperseded = () => active.invalidatedBy !== null
    || active.observationGeneration !== session.observationGeneration;
  if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
  const context = session.observer.getHitTestContext(evidenceId);
  if (context.status !== "available") return { ...context, actionAuthorized: false };
  if (context.targetId !== session.target.id || context.documentGeneration !== session.documentGeneration) {
    return { status: "stale", reasonCode: "stale_document", evidenceId, actionAuthorized: false };
  }
  if (x < 0 || y < 0 || x >= context.viewport.width || y >= context.viewport.height) {
    return { status: "invalid", reasonCode: "hit_test_point_outside_viewport", evidenceId, actionAuthorized: false };
  }

  let viewport;
  try {
    const result = await session.client.send("Runtime.evaluate", {
      expression: "({width:innerWidth,height:innerHeight,deviceScaleFactor:window.devicePixelRatio||1,scrollX,scrollY})",
      returnByValue: true,
      awaitPromise: false
    }, { signal: active.controller.signal });
    viewport = result.result?.value;
  } catch {
    if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
    return { status: "unavailable", reasonCode: "viewport_recheck_failed", evidenceId, actionAuthorized: false };
  }
  if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
  if (context.targetId !== session.target.id || context.documentGeneration !== session.documentGeneration
    || session.activity.totalDomMutations !== context.domMutationCount) {
    return { status: "stale", reasonCode: "page_changed_before_hit_test", evidenceId, actionAuthorized: false };
  }
  if (viewport?.width !== context.viewport.width || viewport?.height !== context.viewport.height
    || viewport?.deviceScaleFactor !== context.deviceScaleFactor) {
    return { status: "stale", reasonCode: "viewport_or_scale_changed", evidenceId, actionAuthorized: false };
  }
  if (viewport?.scrollX !== context.viewportScroll?.x || viewport?.scrollY !== context.viewportScroll?.y) {
    return { status: "stale", reasonCode: "page_scroll_changed", evidenceId, actionAuthorized: false };
  }

  let hit;
  try {
    hit = await session.client.send("DOM.getNodeForLocation", {
      x: Math.round(x + context.viewportScroll.x),
      y: Math.round(y + context.viewportScroll.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false
    }, { timeoutMs, signal: active.controller.signal });
  } catch (error) {
    if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
    if (session.targetLifecycle !== "attached") return staleResult("target_detached");
    return {
      status: "unavailable",
      reasonCode: error?.callerDeadlineExceeded === true ? "hit_test_deadline" : "cdp_hit_test_failed",
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      evidenceId,
      actionAuthorized: false
    };
  }

  if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
  if (session.targetLifecycle !== "attached") return staleResult("target_detached");
  if (context.targetId !== session.target.id || context.documentGeneration !== session.documentGeneration
    || session.activity.totalDomMutations !== context.domMutationCount) {
    return { status: "stale", reasonCode: "page_changed_during_hit_test", evidenceId, actionAuthorized: false };
  }
  const resolution = session.observer.resolveCandidateForHitNode(evidenceId, {
    backendNodeId: hit.backendNodeId,
    frameId: hit.frameId,
    x: x + context.viewportScroll.x,
    y: y + context.viewportScroll.y
  });
  return {
    ...resolution,
    evidenceId,
    targetId: context.targetId,
    documentGeneration: context.documentGeneration,
    frameId: hit.frameId ?? resolution.candidateHint?.frameId ?? null,
    point: { x, y },
    hitBackendNodeId: Number.isInteger(hit.backendNodeId) ? hit.backendNodeId : null,
    visitedNodeCount: resolution.visitedNodeCount ?? 0,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    lookupMode: "single_cdp_dom_hit_test",
    actionAuthorized: false
  };
}
