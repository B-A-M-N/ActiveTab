const MAX_TARGET_TOKENS = 12;

/**
 * Use a retained match only to trigger an ordinary fresh observation. A
 * fallback is usable only when that observation independently re-derives
 * one of the same candidate identities.
 */
export async function reobserveFromRetainedLookup({ session, goal, observation, targetTokens } = {}) {
  if (!session || !observation || observation.candidateCoverage?.pageCoverage !== "partial") {
    return { status: "not_needed", reasonCode: "candidate_coverage_complete" };
  }
  const targetId = session.target?.id;
  const documentGeneration = session.documentGeneration;
  if (!targetId || observation.targetId !== targetId || observation.documentGeneration !== documentGeneration) {
    return { status: "stale", reasonCode: "initial_observation_binding_mismatch" };
  }
  if (!Array.isArray(targetTokens) || targetTokens.length < 1 || targetTokens.length > MAX_TARGET_TOKENS
    || targetTokens.some(token => typeof token !== "string" || !token.trim() || token.length > 64)) {
    return { status: "unavailable", reasonCode: "target_terms_unavailable" };
  }
  const lookup = session.observer?.lookupRetainedCandidates;
  if (typeof lookup !== "function") return { status: "unavailable", reasonCode: "retained_lookup_unavailable" };

  let advisory;
  const lookupStartedAt = performance.now();
  try {
    advisory = await lookup.call(session.observer, observation.evidenceId, {
      targetTokens,
      maxNodes: 500,
      maxResults: 20,
      timeoutMs: 1_500
    });
  } catch {
    return { status: "unavailable", reasonCode: "retained_lookup_failed", lookupTelemetry: {
      lookupMode: "retained_snapshot", lookupStatus: "unavailable", targetId,
      documentGeneration, frameScope: "page", frameTargetId: null, frameId: null,
      returnedCount: 0, visitedNodeCount: 0, stopReason: "lookup_failed",
      elapsedMs: Math.max(0, Math.round(performance.now() - lookupStartedAt)),
      nextActionDisposition: "deferred"
    } };
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - lookupStartedAt));
  const matches = Array.isArray(advisory?.matches) ? advisory.matches : [];
  const frameTargetIds = [...new Set(matches.map(match => match?.frameTargetId ?? null))];
  const frameIds = [...new Set(matches.map(match => match?.frameId).filter(value => typeof value === "string"))];
  const lookupTelemetry = {
    lookupMode: "retained_snapshot",
    lookupStatus: ["unique", "not_found", "ambiguous", "incomplete", "stale", "unavailable", "invalid", "expired"].includes(advisory?.status)
      ? advisory.status : "unavailable",
    targetId,
    documentGeneration,
    frameScope: "page",
    frameTargetId: frameTargetIds.length === 1 ? frameTargetIds[0] : null,
    frameId: frameIds.length === 1 ? frameIds[0] : null,
    returnedCount: Number.isInteger(advisory?.matchCount) ? advisory.matchCount : matches.length,
    visitedNodeCount: Number.isInteger(advisory?.visitedNodeCount) ? advisory.visitedNodeCount : 0,
    stopReason: typeof advisory?.stopReason === "string" ? advisory.stopReason : "snapshot_unavailable",
    elapsedMs,
    nextActionDisposition: "deferred"
  };
  if (advisory?.evidenceId !== observation.evidenceId || advisory?.targetId !== targetId
    || advisory?.documentGeneration !== documentGeneration) {
    return { status: "stale", reasonCode: "retained_lookup_binding_mismatch", lookupTelemetry: { ...lookupTelemetry, lookupStatus: "stale", stopReason: "binding_mismatch" } };
  }
  const suggestedIdentities = new Set(matches.map(match => match?.identity).filter(value => typeof value === "string"));
  if (!suggestedIdentities.size) return {
    status: "no_hint",
    reasonCode: advisory?.stopReason ?? "no_retained_match",
    visitedNodeCount: advisory?.visitedNodeCount ?? 0,
    lookupTelemetry
  };

  let refreshed;
  try {
    refreshed = await session.observe({ profile: "interaction", selectionGoal: goal, candidateLimit: 384 });
  } catch {
    return { status: "unavailable", reasonCode: "fresh_observation_failed", lookupTelemetry: { ...lookupTelemetry, stopReason: "fresh_observation_failed" } };
  }
  if (typeof refreshed?.evidenceId !== "string" || refreshed.evidenceId === observation.evidenceId
    || refreshed?.targetId !== targetId || refreshed?.documentGeneration !== documentGeneration
    || session.target?.id !== targetId || session.documentGeneration !== documentGeneration) {
    return { status: "stale", reasonCode: "fresh_observation_binding_mismatch", lookupTelemetry: { ...lookupTelemetry, lookupStatus: "stale", stopReason: "fresh_observation_binding_mismatch" } };
  }
  const identityRederived = (refreshed.candidates ?? []).some(candidate => suggestedIdentities.has(candidate.identity)
    && candidate.targetId === targetId && candidate.documentGeneration === documentGeneration);
  if (!identityRederived) return {
    status: "no_hint",
    reasonCode: "retained_match_not_rederived",
    visitedNodeCount: advisory?.visitedNodeCount ?? 0,
    lookupTelemetry: { ...lookupTelemetry, stopReason: "retained_match_not_rederived" }
  };
  return {
    status: "refreshed",
    observation: refreshed,
    reasonCode: "retained_match_rederived",
    visitedNodeCount: advisory?.visitedNodeCount ?? 0,
    stopReason: advisory?.stopReason ?? "snapshot_unavailable",
    lookupTelemetry: { ...lookupTelemetry, lookupStatus: "refreshed", stopReason: "retained_match_rederived" }
  };
}
