import { sanitizeUrl } from "./urlPrivacy.js";

/** Read-only freshness checks against the session's canonical target and generation. */
export class CandidateValidator {
  constructor(session, { assertTargetAttached } = {}) {
    this.session = session;
    this.assertTargetAttached = assertTargetAttached;
  }

  async validateObservedCandidate(candidate, { action, expectedUrl } = {}) {
    const session = this.session;
    this.assertTargetAttached();
    if (!candidate || candidate.targetId !== session.target.id
      || candidate.documentGeneration !== session.documentGeneration
      || !Number.isInteger(candidate.backendNodeId)) return { status: "stale", reasonCode: "candidate_binding_mismatch" };
    const frame = candidate.frameTargetId ? session.frameSessions.get(candidate.frameTargetId) : null;
    if (candidate.frameTargetId && (frame?.status !== "ready" || frame.targetId !== candidate.frameTargetId)) {
      return { status: "stale", reasonCode: "candidate_frame_unavailable" };
    }
    const client = frame?.client ?? session.client;
    try {
      const described = await client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
      const node = described.node;
      if (!node?.backendNodeId || node.backendNodeId !== candidate.backendNodeId
        || String(node.nodeName ?? "").toLowerCase() !== String(candidate.tag ?? "").toLowerCase()) {
        return { status: "stale", reasonCode: "candidate_node_identity_changed" };
      }
      const attributes = Object.fromEntries((node.attributes ?? []).reduce((pairs, value, index, values) => {
        if (index % 2 === 0) pairs.push([value, values[index + 1] ?? ""]);
        return pairs;
      }, []));
      if (candidate.type != null && String(attributes.type ?? "").toLowerCase() !== String(candidate.type).toLowerCase()) {
        return { status: "stale", reasonCode: "candidate_type_changed" };
      }
      if (candidate.href) {
        let currentHref;
        try { currentHref = new URL(attributes.href ?? "", expectedUrl ?? session.target.url).href; }
        catch { return { status: "stale", reasonCode: "candidate_href_invalid" }; }
        let observedHref;
        try { observedHref = new URL(candidate.href, expectedUrl ?? session.target.url).href; }
        catch { return { status: "stale", reasonCode: "candidate_href_invalid" }; }
        if (sanitizeUrl(currentHref) !== sanitizeUrl(observedHref)) return { status: "stale", reasonCode: "candidate_href_changed" };
      }
      const resolved = await client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
      const objectId = resolved.object?.objectId;
      if (!objectId) return { status: "stale", reasonCode: "candidate_resolution_unavailable" };
      let current;
      try {
        const checked = await client.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(expected){const r=this.getBoundingClientRect(),s=getComputedStyle(this),label=(this.getAttribute('aria-label')||this.title||Array.from(this.labels??[]).map(l=>l.innerText||l.textContent||'').join(' ')||this.innerText||this.textContent||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();const x=r.left+r.width/2,y=r.top+r.height/2;let top=document.elementFromPoint(x,y);for(let depth=0;top&&top.shadowRoot&&depth<8;depth++){const inner=top.shadowRoot.elementFromPoint(x,y);if(!inner||inner===top)break;top=inner}return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',disabled:this.disabled===true||this.getAttribute('aria-disabled')==='true',readOnly:this.readOnly===true,label,labelMatches:!expected||!label||label.toLocaleLowerCase()===expected.toLocaleLowerCase(),occluded:!!top&&top!==this&&!this.contains(top)}}",
          arguments: [{ value: candidate.name ?? "" }], returnByValue: true, awaitPromise: false
        });
        current = checked.result?.value;
      } finally { await client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
      if (!current?.connected || !current.visible || current.disabled
        || (["fill", "type"].includes(action) && current.readOnly)
        || !current.labelMatches || (["click", "toggle"].includes(action) && current.occluded)) {
        return { status: "stale", reasonCode: "candidate_interaction_state_changed" };
      }
      const routeResult = await session.client.send("Runtime.evaluate", {
        expression: "location.href", returnByValue: true, awaitPromise: false, userGesture: false
      });
      const url = routeResult.result?.value;
      if (typeof expectedUrl === "string" && url !== expectedUrl) return { status: "stale", reasonCode: "page_route_changed" };
      return { status: "valid", targetId: session.target.id, frameTargetId: candidate.frameTargetId ?? null,
        documentGeneration: session.documentGeneration, backendNodeId: candidate.backendNodeId, url, attributes };
    } catch {
      return { status: "unavailable", reasonCode: "candidate_validation_unavailable" };
    }
  }
}
