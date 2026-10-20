import { jsonByteLength } from "./evidenceSizing.js";

const MAX_SCROLL_TARGETS_PER_FRAME = 8;

export function instrumentCaptureClient(client, metrics) {
  return {
    send(method, ...args) {
      metrics.cdpRoundTrips++;
      const startedAt = Date.now();
      if (method === "DOMSnapshot.captureSnapshot") metrics.domSnapshotCount++;
      return Promise.resolve().then(() => client.send(method, ...args)).finally(() => {
        const duration = Date.now() - startedAt;
        metrics.totalCdpRoundTripMs += duration;
        if (metrics.cdpRoundTripDurations.length < 2048) metrics.cdpRoundTripDurations.push(duration);
      });
    }
  };
}

function parentFrameIdFromTree(tree, childFrameId, parentId = null) {
  const node = tree?.frameTree ?? tree;
  if (!node?.frame?.id) return null;
  if (node.frame.id === childFrameId) return parentId;
  for (const child of node.childFrames ?? []) {
    const found = parentFrameIdFromTree(child, childFrameId, node.frame.id);
    if (found) return found;
  }
  return null;
}

async function captureFrameGeometry(session, frame, childFrameId, frameViewport, rootClient, metrics) {
  const parentFrame = [...(session.frameSessions?.values?.() ?? [])].find(item => item.sessionId === frame.parentSessionId);
  const isRootParent = frame.parentSessionId === session.sessionId;
  const parentClient = parentFrame?.client ?? (isRootParent ? rootClient : null);
  if (!parentClient) return { status: "unavailable", reason: "parent_frame_session_unavailable" };
  try {
    const client = instrumentCaptureClient(parentClient, metrics);
    let parentFrameId = frame.parentFrameId;
    if (!parentFrameId) {
      const parentTree = await client.send("Page.getFrameTree");
      parentFrameId = parentFrameIdFromTree(parentTree, childFrameId);
    }
    if (!parentFrameId) return { status: "unavailable", reason: "parent_frame_identity_unavailable" };
    const owner = await client.send("DOM.getFrameOwner", { frameId: childFrameId });
    if (!Number.isInteger(owner?.backendNodeId)) return { status: "unavailable", reason: "frame_owner_unavailable" };
    const box = await client.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
    const quad = box?.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) {
      return { status: "unavailable", reason: "frame_owner_geometry_unavailable" };
    }
    return {
      status: "available",
      frameTargetId: frame.targetId,
      frameId: frame.frameId,
      parentTargetId: parentFrame?.targetId ?? null,
      parentFrameId,
      viewport: { width: frameViewport.width, height: frameViewport.height },
      ownerContentQuad: quad
    };
  } catch {
    return { status: "unavailable", reason: "frame_geometry_capture_failed" };
  }
}

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? strings[index] ?? "" : "";
}

export async function captureScrollableTargets(client, { targetId, frameTargetId = null, frameId, generation, limit = MAX_SCROLL_TARGETS_PER_FRAME }) {
  let arrayObjectId;
  const elementObjectIds = [];
  const cappedLimit = Math.max(1, Math.min(MAX_SCROLL_TARGETS_PER_FRAME, limit));
  try {
    const evaluated = await client.send("Runtime.evaluate", {
      expression: `(()=>Array.from(document.querySelectorAll('*')).filter(element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return element!==document.scrollingElement&&/(auto|scroll|overlay)/.test(style.overflowY)&&element.scrollHeight>element.clientHeight+2&&rect.width>=80&&rect.height>=80&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0}).slice(0,${cappedLimit}))()`,
      returnByValue: false,
      awaitPromise: false
    });
    arrayObjectId = evaluated.result?.objectId;
    if (!arrayObjectId) return [];
    const properties = await client.send("Runtime.getProperties", { objectId: arrayObjectId, ownProperties: true, generatePreview: false });
    const elements = (properties.result ?? [])
      .filter(property => /^\d+$/.test(property.name) && typeof property.value?.objectId === "string")
      .slice(0, limit);
    elementObjectIds.push(...elements.map(property => property.value.objectId));
    return (await Promise.all(elements.map(async property => {
      const objectId = property.value.objectId;
      try {
        const [description, details] = await Promise.all([
          client.send("DOM.describeNode", { objectId, depth: 0, pierce: true }),
          client.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function(){const rect=this.getBoundingClientRect(),style=getComputedStyle(this),heading=this.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,[role=heading]');const maxScrollTop=Math.max(0,this.scrollHeight-this.clientHeight);return {tag:this.tagName.toLowerCase(),role:this.getAttribute('role')||'',name:(this.getAttribute('aria-label')||this.title||'').replace(/\\s+/g,' ').trim().slice(0,160),contextName:(heading?.innerText||heading?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),x:rect.x,y:rect.y,width:rect.width,height:rect.height,scrollTop:this.scrollTop,maxScrollTop,clientHeight:this.clientHeight,canScrollDown:maxScrollTop-this.scrollTop>2,canScrollUp:this.scrollTop>2,overflowY:style.overflowY}}",
            returnByValue: true,
            awaitPromise: false
          })
        ]);
        const node = description.node;
        const value = details.result?.value;
        if (!Number.isInteger(node?.backendNodeId) || !(value?.maxScrollTop > 0) || !value.width || !value.height) return null;
        const identity = `${targetId}:${frameTargetId ?? "root"}:${frameId}:${node.backendNodeId}:${generation}`;
        return {
          identity,
          targetId,
          frameTargetId,
          frameId,
          documentGeneration: generation,
          kind: "container",
          backendNodeId: node.backendNodeId,
          name: value.name || value.role || value.tag,
          contextName: value.contextName,
          role: value.role || value.tag,
          tag: value.tag,
          visible: true,
          bounds: { x: value.x, y: value.y, width: value.width, height: value.height },
          scrollTop: value.scrollTop,
          maxScrollTop: value.maxScrollTop,
          clientHeight: value.clientHeight,
          canScrollDown: value.canScrollDown,
          canScrollUp: value.canScrollUp
        };
      } catch { return null; }
    }))).filter(Boolean);
  } catch { return []; }
  finally {
    for (const objectId of elementObjectIds) await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    if (arrayObjectId) await client.send("Runtime.releaseObject", { objectId: arrayObjectId }).catch(() => {});
  }
}

export function viewportScrollTarget(targetId, frameId, generation, scrollState, frameTargetId = null) {
  if (!(scrollState?.maxScrollTop > 0)) return null;
  return {
    identity: `${targetId}:${frameTargetId ?? "root"}:${frameId}:viewport:${generation}`,
    targetId,
    frameTargetId,
    frameId,
    documentGeneration: generation,
    kind: "viewport",
    name: "Page",
    contextName: "",
    role: "document",
    tag: "body",
    visible: true,
    bounds: { x: 0, y: 0, width: scrollState.viewportWidth, height: scrollState.viewportHeight },
    scrollTop: scrollState.scrollTop,
    maxScrollTop: scrollState.maxScrollTop,
    clientHeight: scrollState.viewportHeight,
    canScrollDown: scrollState.canScrollDown,
    canScrollUp: scrollState.canScrollUp
  };
}

export async function captureOutOfProcessFrames(session, {
  rootClient,
  metrics,
  computedStyles,
  runtimeExpression,
  deriveInteraction,
  remainingFrameBytes
}) {
  const attachedFrames = await session.getOutOfProcessFrames?.({
    onCdpRoundTrip: durationMs => {
      metrics.cdpRoundTrips++;
      metrics.totalCdpRoundTripMs += durationMs;
    }
  }) ?? [];

  const captureFrame = async frame => {
    try {
      const frameClient = instrumentCaptureClient(frame.client, metrics);
      const [frameTreeResult, frameSnapshot, frameAx, frameRuntime] = await Promise.all([
        frameClient.send("Page.getFrameTree"),
        frameClient.send("DOMSnapshot.captureSnapshot", { computedStyles, includePaintOrder: true, includeDOMRects: true }),
        frameClient.send("Accessibility.getFullAXTree"),
        frameClient.send("Runtime.evaluate", { expression: runtimeExpression, returnByValue: true })
      ]);
      const childFrameId = frameTreeResult.frameTree?.frame?.id ?? frame.frameId;
      const page = JSON.parse(frameRuntime.result?.value ?? "{}");
      const frameScrollState = {
        scrollTop: Number(page.scrollTop ?? 0),
        maxScrollTop: Number(page.maxScrollTop ?? 0),
        viewportHeight: Number(page.viewportHeight ?? 0),
        viewportWidth: Number(page.viewportWidth ?? 0),
        canScrollDown: Number(page.maxScrollTop ?? 0) - Number(page.scrollTop ?? 0) > 2,
        canScrollUp: Number(page.scrollTop ?? 0) > 2
      };
      const frameGeometry = await captureFrameGeometry(session, frame, childFrameId, {
        width: frameScrollState.viewportWidth,
        height: frameScrollState.viewportHeight
      }, rootClient, metrics);
      delete page.scrollTop;
      delete page.maxScrollTop;
      delete page.viewportHeight;
      delete page.viewportWidth;
      const frameScrollTargets = deriveInteraction ? [
        viewportScrollTarget(session.target.id, childFrameId, session.documentGeneration, frameScrollState, frame.targetId),
        ...await captureScrollableTargets(frameClient, {
          targetId: session.target.id,
          frameTargetId: frame.targetId,
          frameId: childFrameId,
          generation: session.documentGeneration,
          limit: 4
        })
      ].filter(Boolean) : [];
      return {
        targetId: frame.targetId,
        frameId: childFrameId,
        parentFrameId: frame.parentFrameId,
        page,
        frameGeometry,
        domSnapshot: frameSnapshot,
        accessibilityTree: frameAx.nodes ?? [],
        scrollTargets: frameScrollTargets,
        domMutationObservationAvailable: frame.domObservationAvailable,
        networkObservationAvailable: frame.networkObservationAvailable,
        status: "available"
      };
    } catch (error) {
      return { targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "unavailable", errorName: error.name };
    }
  };

  const frameResults = [];
  for (const frame of attachedFrames) {
    if (remainingFrameBytes < 1) {
      frameResults.push({ targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "omitted", reason: "observation_budget" });
      continue;
    }
    const captured = await captureFrame(frame);
    if (captured.status === "available") {
      const frameBytes = jsonByteLength(captured);
      if (frameBytes > remainingFrameBytes) {
        frameResults.push({ targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "omitted", reason: "observation_budget" });
        continue;
      }
      remainingFrameBytes -= frameBytes;
    }
    frameResults.push(captured);
  }

  const frameSnapshots = frameResults.filter(frame => frame.status === "available");
  return { frameResults, frameSnapshots, remainingFrameBytes };
}
