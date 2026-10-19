const MAX_QUERY_TEXT_LENGTH = 160;
const MAX_ROLE_LENGTH = 64;
const MAX_SCOPE_REF_LENGTH = 256;
const MAX_FRAME_TARGET_LENGTH = 128;
const MAX_VISITED_NODES = 500;
const MAX_MATCHES = 20;
const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 2_000;

const normalize = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
const keyForNode = (frameTargetId, documentIndex, nodeIndex) => `${frameTargetId ?? "root"}:${documentIndex}:${nodeIndex}`;

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "query_invalid" };
  const allowed = new Set([
    "role", "accessibleName", "targetTokens", "exact", "scopeRef", "frameTargetId",
    "maxNodes", "maxResults", "timeoutMs"
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) return { error: "query_field_unsupported" };
  const role = input.role ?? null;
  const accessibleName = input.accessibleName ?? null;
  const exact = input.exact ?? true;
  const scopeRef = input.scopeRef ?? null;
  const frameTargetId = input.frameTargetId ?? null;
  const targetTokens = input.targetTokens ?? null;
  const maxNodes = input.maxNodes ?? MAX_VISITED_NODES;
  const maxResults = input.maxResults ?? MAX_MATCHES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (role !== null && (typeof role !== "string" || role.length < 1 || role.length > MAX_ROLE_LENGTH || !/^[a-z][a-z0-9_-]*$/u.test(role))) return { error: "query_role_invalid" };
  if (accessibleName !== null && (typeof accessibleName !== "string" || !accessibleName.trim() || accessibleName.length > MAX_QUERY_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(accessibleName))) return { error: "query_name_invalid" };
  if (targetTokens !== null && (!Array.isArray(targetTokens) || targetTokens.length < 1 || targetTokens.length > 12
    || targetTokens.some(token => typeof token !== "string" || !token.trim() || token.length > 64 || /[\u0000-\u001f\u007f]/u.test(token)))) return { error: "query_tokens_invalid" };
  if (!role && !accessibleName && !targetTokens) return { error: "query_target_required" };
  if (exact !== true && exact !== false) return { error: "query_exact_invalid" };
  if (exact === false && !role && !targetTokens) return { error: "substring_query_requires_role" };
  if (scopeRef !== null && (typeof scopeRef !== "string" || !scopeRef.trim() || scopeRef.length > MAX_SCOPE_REF_LENGTH || /[\u0000-\u001f\u007f]/u.test(scopeRef))) return { error: "query_scope_invalid" };
  if (frameTargetId !== null && (typeof frameTargetId !== "string" || !frameTargetId.trim() || frameTargetId.length > MAX_FRAME_TARGET_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(frameTargetId))) return { error: "query_frame_invalid" };
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_VISITED_NODES) return { error: "query_node_limit_invalid" };
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MATCHES) return { error: "query_result_limit_invalid" };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > MAX_TIMEOUT_MS) return { error: "query_timeout_invalid" };
  return { query: Object.freeze({ role, accessibleName, targetTokens, exact, scopeRef, frameTargetId, maxNodes, maxResults, timeoutMs }) };
}

function parseEvidenceRef(value) {
  if (typeof value !== "string" || value.length > MAX_SCOPE_REF_LENGTH) return null;
  const match = /^(root|[A-Za-z0-9_-]{1,128}):(\d{1,4}):(\d{1,10})$/u.exec(value);
  if (!match) return null;
  const documentIndex = Number(match[2]);
  const backendNodeId = Number(match[3]);
  if (!Number.isInteger(documentIndex) || !Number.isInteger(backendNodeId)) return null;
  return { frameTargetId: match[1] === "root" ? null : match[1], documentIndex, backendNodeId };
}

function resolveScope(evidence, indexes, query) {
  if (!query.scopeRef) return { status: "available", location: null };
  const page = evidence.semanticPage;
  if (!page || page.evidence?.observationId !== evidence.id) return { status: "unavailable", reasonCode: "scope_semantic_page_unavailable" };
  const scopes = [
    ...(page.regions ?? []).filter(item => item.ref === query.scopeRef),
    ...(page.forms ?? []).filter(item => item.ref === query.scopeRef)
  ];
  if (scopes.length !== 1) return { status: "invalid", reasonCode: scopes.length ? "scope_ref_ambiguous" : "scope_ref_not_observed" };
  const reference = parseEvidenceRef(scopes[0].evidenceRef);
  if (!reference) return { status: "unavailable", reasonCode: "scope_backend_identity_unavailable" };
  if (query.frameTargetId && query.frameTargetId !== reference.frameTargetId) return { status: "invalid", reasonCode: "scope_frame_mismatch" };
  const frameIndex = indexes.find(item => item.frameTargetId === reference.frameTargetId);
  const document = frameIndex?.documents?.find(item => item.documentIndex === reference.documentIndex);
  if (!frameIndex || !document || frameIndex.snapshot !== document.snapshot || !document.backendNodeIndexes?.has(reference.backendNodeId)) {
    return { status: "stale", reasonCode: "scope_evidence_mismatch" };
  }
  return {
    status: "available",
    location: {
      frameTargetId: reference.frameTargetId,
      documentIndex: reference.documentIndex,
      nodeIndex: document.backendNodeIndexes.get(reference.backendNodeId)
    }
  };
}

function candidateMatches(candidate, query) {
  if (!candidate) return false;
  if (query.role && String(candidate.role ?? "").toLowerCase() !== query.role) return false;
  const name = normalize(candidate.name);
  if (query.accessibleName) {
    const expected = normalize(query.accessibleName);
    if (query.exact ? name !== expected : !name.toLocaleLowerCase().includes(expected.toLocaleLowerCase())) return false;
  }
  if (query.targetTokens) {
    const candidateText = normalize(`${candidate.name ?? ""} ${candidate.contextName ?? ""}`).toLocaleLowerCase();
    const tokens = query.targetTokens.map(token => normalize(token).toLocaleLowerCase());
    const matched = tokens.filter(token => candidateText.split(/[^\p{L}\p{N}]+/u).includes(token)).length;
    if (matched === 0) return false;
  }
  return true;
}

function makeResult(evidence, query) {
  return {
    evidenceId: evidence?.id ?? null,
    targetId: evidence?.targetId ?? null,
    documentGeneration: evidence?.documentGeneration ?? null,
    query: query ? {
      role: query.role,
      accessibleName: query.accessibleName,
      targetTokens: query.targetTokens ? [...query.targetTokens] : null,
      exact: query.exact,
      scopeRef: query.scopeRef,
      frameTargetId: query.frameTargetId,
      maxNodes: query.maxNodes,
      maxResults: query.maxResults,
      timeoutMs: query.timeoutMs
    } : null,
    status: "incomplete",
    reasonCode: null,
    stopReason: "snapshot_unavailable",
    matches: [],
    matchCount: 0,
    omittedCount: null,
    visitedNodeCount: 0,
    truncated: true,
    coverage: "incomplete",
    actionAuthorized: false
  };
}

function finalStatus(result, { stopReason, knownMatchCount }) {
  result.stopReason = stopReason;
  result.reasonCode = stopReason === "complete" ? null : stopReason;
  result.matchCount = knownMatchCount;
  result.omittedCount = stopReason === "complete" ? 0 : null;
  result.truncated = stopReason !== "complete";
  result.coverage = stopReason === "complete" ? "complete" : "incomplete";
  result.status = stopReason !== "complete"
    ? "incomplete"
    : knownMatchCount === 0 ? "no_match" : knownMatchCount === 1 ? "unique" : "ambiguous";
  return result;
}

function pushChildren(stack, children, maxPending) {
  const room = Math.max(0, maxPending - stack.length);
  const count = Math.min(children?.length ?? 0, room);
  for (let index = count - 1; index >= 0; index--) stack.push(children[index]);
  return count < (children?.length ?? 0);
}

/**
 * Search only the exact retained snapshot indexes. Results are advisory
 * evidence references and never carry action authority.
 */
export function queryRetainedControls({ evidence, lookupIndex, session, input, now = Date.now } = {}) {
  const validated = validateInput(input);
  const query = validated.query ?? null;
  const result = makeResult(evidence, query);
  if (validated.error) {
    result.status = "invalid";
    result.reasonCode = validated.error;
    result.stopReason = validated.error;
    return result;
  }
  if (!session || !evidence || !session.attached || session.targetLifecycle !== "attached") {
    result.status = "unavailable";
    result.reasonCode = "authorized_session_unavailable";
    result.stopReason = "snapshot_unavailable";
    return result;
  }
  if (session.target?.id !== evidence.targetId || session.documentGeneration !== evidence.documentGeneration) {
    result.status = "stale";
    result.reasonCode = "stale_document";
    result.stopReason = "stale_document";
    return result;
  }
  const mutationCount = session.activity?.totalDomMutations;
  if (!Number.isInteger(mutationCount) || mutationCount !== evidence.activity?.totalDomMutations) {
    result.status = "stale";
    result.reasonCode = Number.isInteger(mutationCount) ? "dom_changed_since_observation" : "dom_freshness_unavailable";
    result.stopReason = result.reasonCode;
    return result;
  }
  if (!lookupIndex || !Array.isArray(lookupIndex.frames) || !lookupIndex.frames.length
    || !Array.isArray(lookupIndex.candidates) || lookupIndex.available !== true) {
    result.reasonCode = "snapshot_unavailable";
    return result;
  }

  const scope = resolveScope(evidence, lookupIndex.frames, query);
  if (scope.status !== "available") {
    result.status = scope.status;
    result.reasonCode = scope.reasonCode;
    result.stopReason = scope.reasonCode === "frame_session_unavailable" ? "frame_unavailable" : "snapshot_unavailable";
    return result;
  }
  if (query.frameTargetId && !lookupIndex.frames.some(frame => frame.frameTargetId === query.frameTargetId)) {
    result.reasonCode = "frame_unavailable";
    result.stopReason = "frame_unavailable";
    return result;
  }

  const candidateByNode = new Map(lookupIndex.candidates.map(candidate => [
    keyForNode(candidate.frameTargetId, candidate.documentIndex, candidate.nodeIndex), candidate
  ]));
  const indexes = lookupIndex.frames.filter(frame => !query.frameTargetId || frame.frameTargetId === query.frameTargetId);
  const deadline = now() + query.timeoutMs;
  const visited = new Set();
  let stopReason = "complete";
  let indexPosition = 0;
  let documentPosition = 0;
  let pendingOverflow = false;

  for (const frameIndex of indexes) {
    for (const document of frameIndex.documents ?? []) {
      if (!document || (scope.location && (scope.location.frameTargetId !== frameIndex.frameTargetId
        || scope.location.documentIndex !== document.documentIndex))) continue;
      if (document.snapshot !== frameIndex.snapshot || frameIndex.snapshot !== (frameIndex.frameTargetId
        ? evidence.outOfProcessFrames?.find(frame => frame.targetId === frameIndex.frameTargetId && frame.status === "available")?.domSnapshot
        : evidence.domSnapshot)) {
        stopReason = "snapshot_unavailable";
        break;
      }
      const nodeCount = document.sourceDocument?.nodes?.nodeName?.length ?? 0;
      if (!nodeCount) continue;
      const roots = scope.location
        ? [scope.location.nodeIndex]
        : [0];
      const stack = [...roots];
      const documentVisited = new Set();
      while (stack.length) {
        if (now() >= deadline) { stopReason = "deadline"; break; }
        if (result.visitedNodeCount >= query.maxNodes) { stopReason = "node_budget"; break; }
        const nodeIndex = stack.pop();
        if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeCount) continue;
        if (documentVisited.has(nodeIndex)) continue;
        documentVisited.add(nodeIndex);
        visited.add(keyForNode(frameIndex.frameTargetId, document.documentIndex, nodeIndex));
        result.visitedNodeCount++;
        const candidate = candidateByNode.get(keyForNode(frameIndex.frameTargetId, document.documentIndex, nodeIndex));
        if (candidateMatches(candidate, query)) {
          result.matches.push({
            identity: candidate.identity,
            targetId: evidence.targetId,
            documentGeneration: evidence.documentGeneration,
            evidenceId: evidence.id,
            backendNodeId: candidate.backendNodeId,
            frameTargetId: candidate.frameTargetId,
            frameId: candidate.frameId,
            documentIndex: candidate.documentIndex,
            role: candidate.role,
            name: candidate.name,
            tag: candidate.tag,
            visible: candidate.visible,
            disabled: candidate.disabled,
            contextName: candidate.contextName,
            identityEvidence: "retained_candidate_index",
            actionAuthorized: false
          });
          if (result.matches.length >= query.maxResults) { stopReason = "match_limit"; break; }
        }
        const children = document.children?.get(nodeIndex) ?? [];
        if (pushChildren(stack, children, query.maxNodes)) pendingOverflow = true;
        if (pendingOverflow && result.visitedNodeCount >= query.maxNodes) { stopReason = "node_budget"; break; }
      }
      documentPosition++;
      if (stopReason !== "complete") break;
      if (!scope.location && documentVisited.size < nodeCount && stack.length === 0) {
        stopReason = "snapshot_unavailable";
        break;
      }
    }
    indexPosition++;
    if (stopReason !== "complete") break;
  }

  if (stopReason === "complete" && lookupIndex.candidateCoverage !== "complete") stopReason = "candidate_index_limit";
  if (stopReason === "complete" && query.frameTargetId === null
    && evidence.outOfProcessFrames?.some(frame => frame.status !== "available")) stopReason = "frame_unavailable";
  if (stopReason === "complete" && evidence.semanticPage?.coverage?.closedShadowRoots !== "complete") stopReason = "closed_shadow_root";
  result.frameCountVisited = indexPosition;
  result.documentCountVisited = documentPosition;
  result.visitedSetSize = visited.size;
  return finalStatus(result, { stopReason, knownMatchCount: result.matches.length });
}
