const OUTCOMES = new Set(["verified_success", "agent_error", "site_access_error", "environment_error", "evaluator_error", "needs_human", "inconclusive"]);

export function aggregateLiveSiteResults(results) {
  if (!Array.isArray(results) || results.length > 10_000) throw new Error("Live-site result aggregation requires a bounded array.");
  const counts = Object.fromEntries([...OUTCOMES].map(status => [status, 0]));
  const bySite = {};
  for (const result of results) {
    if (result?.schemaVersion !== 1 || typeof result.siteId !== "string" || !OUTCOMES.has(result.outcomeStatus)) {
      throw new Error("Live-site result aggregation encountered an invalid receipt.");
    }
    counts[result.outcomeStatus]++;
    bySite[result.siteId] ??= Object.fromEntries([...OUTCOMES].map(status => [status, 0]));
    bySite[result.siteId][result.outcomeStatus]++;
  }
  const total = results.length;
  const agentEligible = counts.verified_success + counts.agent_error;
  return Object.freeze({
    schemaVersion: 1,
    total,
    counts: Object.freeze(counts),
    bySite: Object.freeze(Object.fromEntries(Object.entries(bySite).map(([siteId, siteCounts]) => [siteId, Object.freeze(siteCounts)]))),
    completionRate: total ? counts.verified_success / total : null,
    agentSuccessRate: agentEligible ? counts.verified_success / agentEligible : null,
    agentEligible,
    coverageLimitations: counts.site_access_error + counts.environment_error + counts.evaluator_error + counts.needs_human + counts.inconclusive
  });
}
