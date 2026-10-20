import { mapPointFromParentToFrame } from "../observe/frameCoordinates.js";

export async function runVisualCandidateProbe(session, evidenceId, { x, y, timeoutMs, active }) {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const remainingTimeoutMs = () => Math.floor(deadline - performance.now());
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
    const commandTimeoutMs = remainingTimeoutMs();
    if (commandTimeoutMs < 1) {
      return { status: "unavailable", reasonCode: "hit_test_deadline", evidenceId, actionAuthorized: false };
    }
    const result = await session.client.send("Runtime.evaluate", {
      expression: "({width:innerWidth,height:innerHeight,deviceScaleFactor:window.devicePixelRatio||1,scrollX,scrollY})",
      returnByValue: true,
      awaitPromise: false
    }, { timeoutMs: commandTimeoutMs, signal: active.controller.signal });
    viewport = result.result?.value;
  } catch (error) {
    if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
    return {
      status: "unavailable",
      reasonCode: error?.callerDeadlineExceeded === true ? "hit_test_deadline" : "viewport_recheck_failed",
      evidenceId,
      actionAuthorized: false
    };
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
  const hitTestTimeoutMs = remainingTimeoutMs();
  if (hitTestTimeoutMs < 1) {
    return { status: "unavailable", reasonCode: "hit_test_deadline", evidenceId, actionAuthorized: false };
  }
  try {
    hit = await session.client.send("DOM.getNodeForLocation", {
      x: Math.round(x + context.viewportScroll.x),
      y: Math.round(y + context.viewportScroll.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false
    }, { timeoutMs: hitTestTimeoutMs, signal: active.controller.signal });
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
  let currentFrameTargetId = null;
  let currentPoint = { x, y };
  let currentScroll = context.viewportScroll;
  let currentHit = hit;
  let resolution;
  let frameDepth = 0;
  let visitedNodeCount = 0;
  const stateIsCurrent = () => !isSuperseded()
    && session.targetLifecycle === "attached"
    && session.target.id === context.targetId
    && session.documentGeneration === context.documentGeneration
    && session.activity.totalDomMutations === context.domMutationCount;
  const unavailable = reasonCode => ({
    status: "unavailable",
    reasonCode,
    evidenceId,
    targetId: context.targetId,
    documentGeneration: context.documentGeneration,
    frameTargetId: currentFrameTargetId,
    frameDepth,
    visitedNodeCount,
    actionAuthorized: false
  });

  while (true) {
    if (!stateIsCurrent()) return staleResult(active.invalidatedBy ?? "page_changed_during_hit_test");
    resolution = session.observer.resolveCandidateForHitNode(evidenceId, {
      backendNodeId: currentHit.backendNodeId,
      frameId: currentHit.frameId,
      frameTargetId: currentFrameTargetId,
      x: currentPoint.x + currentScroll.x,
      y: currentPoint.y + currentScroll.y
    });
    visitedNodeCount += resolution.visitedNodeCount ?? 0;
    if (resolution.status === "candidate") break;
    if (resolution.status !== "frame_owner") {
      return {
        ...resolution,
        evidenceId,
        targetId: context.targetId,
        documentGeneration: context.documentGeneration,
        frameTargetId: currentFrameTargetId,
        frameId: currentHit.frameId ?? null,
        point: { x, y },
        hitBackendNodeId: Number.isInteger(currentHit.backendNodeId) ? currentHit.backendNodeId : null,
        visitedNodeCount,
        frameDepth,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        lookupMode: "cdp_dom_hit_test_chain",
        actionAuthorized: false
      };
    }
    if (frameDepth >= 8) return unavailable("frame_depth_exceeded");
    const owner = resolution.frameOwnerHint;
    const geometry = owner?.geometry;
    const frame = typeof owner?.targetId === "string" ? session.frameSessions?.get(owner.targetId) : null;
    const parentFrame = owner?.parentTargetId ? session.frameSessions?.get(owner.parentTargetId) : null;
    const expectedParentSessionId = parentFrame?.sessionId ?? session.sessionId ?? null;
    if (!frame || frame.status !== "ready" || frame.targetId !== owner.targetId
      || frame.frameId !== owner.frameId || frame.parentSessionId !== expectedParentSessionId
      || frame.domObservationAvailable !== true
      || geometry?.status !== "available" || geometry.frameTargetId !== frame.targetId
      || geometry.frameId !== frame.frameId || geometry.parentTargetId !== owner.parentTargetId
      || geometry.parentFrameId !== owner.parentFrameId) return unavailable("frame_unavailable");

    const childPoint = mapPointFromParentToFrame(currentPoint, geometry);
    if (!childPoint) return unavailable("frame_hit_point_outside_viewport");
    const viewportTimeoutMs = remainingTimeoutMs();
    if (viewportTimeoutMs < 1) return unavailable("hit_test_deadline");
    let childViewport;
    try {
      const result = await frame.client.send("Runtime.evaluate", {
        expression: "({width:innerWidth,height:innerHeight,deviceScaleFactor:window.devicePixelRatio||1,scrollX,scrollY})",
        returnByValue: true,
        awaitPromise: false
      }, { timeoutMs: viewportTimeoutMs, signal: active.controller.signal });
      childViewport = result.result?.value;
    } catch (error) {
      if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
      return unavailable(error?.callerDeadlineExceeded === true ? "hit_test_deadline" : "frame_viewport_recheck_failed");
    }
    if (!stateIsCurrent()) return staleResult(active.invalidatedBy ?? "page_changed_during_hit_test");
    if (childViewport?.width !== geometry.viewport.width || childViewport?.height !== geometry.viewport.height
      || childViewport?.deviceScaleFactor !== context.deviceScaleFactor
      || !Number.isFinite(childViewport.scrollX) || !Number.isFinite(childViewport.scrollY)) {
      return unavailable("frame_viewport_or_scale_changed");
    }

    const childHitTimeoutMs = remainingTimeoutMs();
    if (childHitTimeoutMs < 1) return unavailable("hit_test_deadline");
    try {
      currentHit = await frame.client.send("DOM.getNodeForLocation", {
        x: Math.round(childPoint.x + childViewport.scrollX),
        y: Math.round(childPoint.y + childViewport.scrollY),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: false
      }, { timeoutMs: childHitTimeoutMs, signal: active.controller.signal });
    } catch (error) {
      if (isSuperseded()) return staleResult(active.invalidatedBy ?? "superseded_by_new_observation");
      if (session.targetLifecycle !== "attached") return staleResult("target_detached");
      return unavailable(error?.callerDeadlineExceeded === true ? "hit_test_deadline" : "cdp_frame_hit_test_failed");
    }
    if (!stateIsCurrent()) return staleResult(active.invalidatedBy ?? "page_changed_during_hit_test");
    currentFrameTargetId = frame.targetId;
    currentPoint = childPoint;
    currentScroll = { x: childViewport.scrollX, y: childViewport.scrollY };
    frameDepth++;
  }
  return {
    ...resolution,
    evidenceId,
    targetId: context.targetId,
    documentGeneration: context.documentGeneration,
    frameId: currentHit.frameId ?? resolution.candidateHint?.frameId ?? null,
    frameTargetId: resolution.candidateHint?.frameTargetId ?? currentFrameTargetId,
    point: { x, y },
    hitBackendNodeId: Number.isInteger(currentHit.backendNodeId) ? currentHit.backendNodeId : null,
    visitedNodeCount,
    frameDepth,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    lookupMode: "cdp_dom_hit_test_chain",
    actionAuthorized: false
  };
}
