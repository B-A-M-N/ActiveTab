/**
 * Test assertions — evaluate expected conditions against observations
 * and diagnostic evidence. A mandatory assertion that cannot be evaluated
 * returns UNCERTAIN, never PASS.
 */

import { STEP_STATUS } from "./schema.js";

/**
 * Evaluate an assertion against available evidence.
 * @param {object} assertion - { type, ...params }
 * @param {object} context - { observation, collector, correlator, runId }
 * @returns {{ status, reason, evidenceIds }}
 */
export function evaluateAssertion(assertion, context) {
  if (!assertion || typeof assertion !== "object") {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Assertion is missing or invalid.", evidenceIds: [] };
  }
  switch (assertion.type) {
    case "page_title_contains": return pageTitleContains(assertion, context);
    case "candidate_name_contains": return candidateNameContains(assertion, context);
    case "url_matches": return urlMatches(assertion, context);
    case "element_visible": return elementVisible(assertion, context);
    case "network_request_seen": return networkRequestSeen(assertion, context);
    case "diagnostic_source_available": return diagnosticSourceAvailable(assertion, context);
    default: return { status: STEP_STATUS.UNCERTAIN, reason: `Unknown assertion type '${assertion.type}'.`, evidenceIds: [] };
  }
}

function candidateNameContains(assertion, context) {
  const observation = context.observation;
  const expected = String(assertion.value ?? "").trim().toLocaleLowerCase();
  if (!observation || !expected) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Candidate-name assertion requires fresh observation and a non-empty value.", evidenceIds: [] };
  }
  const found = (observation.candidates ?? []).some(candidate =>
    candidate.visible !== false && String(candidate.name ?? "").toLocaleLowerCase().includes(expected)
  );
  const evidenceIds = observation.evidenceId ? [observation.evidenceId] : [];
  return found
    ? { status: STEP_STATUS.PASS, reason: `A visible control name contains '${assertion.value}'.`, evidenceIds }
    : { status: STEP_STATUS.FAIL, reason: `No visible control name contains '${assertion.value}'.`, evidenceIds };
}

function pageTitleContains(assertion, context) {
  const title = context.observation?.page?.title;
  const evidenceId = context.observation?.evidenceId;
  if (typeof title !== "string") {
    return { status: STEP_STATUS.UNCERTAIN, reason: "No page title in current observation.", evidenceIds: [] };
  }
  if (!title.toLowerCase().includes(String(assertion.value).toLowerCase())) {
    return { status: STEP_STATUS.FAIL, reason: `Page title '${title}' does not contain '${assertion.value}'.`, evidenceIds: evidenceId ? [evidenceId] : [] };
  }
  return { status: STEP_STATUS.PASS, reason: `Page title contains '${assertion.value}'.`, evidenceIds: evidenceId ? [evidenceId] : [] };
}

function urlMatches(assertion, context) {
  const url = context.observation?.page?.url;
  const evidenceId = context.observation?.evidenceId;
  if (typeof url !== "string" || !url) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "No page URL in current observation.", evidenceIds: [] };
  }
  if (typeof assertion.pattern !== "string") {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Assertion requires a pattern.", evidenceIds: [] };
  }
  let regex;
  try { regex = new RegExp(assertion.pattern); } catch {
    return { status: STEP_STATUS.UNCERTAIN, reason: `Invalid regex pattern '${assertion.pattern}'.`, evidenceIds: [] };
  }
  if (!regex.test(url)) {
    return { status: STEP_STATUS.FAIL, reason: `URL '${url}' does not match '${assertion.pattern}'.`, evidenceIds: evidenceId ? [evidenceId] : [] };
  }
  return { status: STEP_STATUS.PASS, reason: `URL matches '${assertion.pattern}'.`, evidenceIds: evidenceId ? [evidenceId] : [] };
}

function elementVisible(assertion, context) {
  const observation = context.observation;
  if (!observation) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "No observation available.", evidenceIds: [] };
  }
  const selector = assertion.selector;
  if (typeof selector !== "string" || !selector) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Assertion requires a selector.", evidenceIds: [] };
  }
  // Use the native ActiveTab observation contract (candidates, not interactables).
  const candidates = observation.candidates ?? [];
  const found = candidates.some(candidate =>
    candidate.selector === selector ||
    candidate.tagName?.toLowerCase() === selector.toLowerCase() ||
    candidate.id === selector ||
    candidate.name === selector ||
    candidate.role === selector ||
    candidate.tag === selector ||
    (candidate.classes ?? []).some(cls => selector.includes(cls))
  );
  if (!found) {
    return { status: STEP_STATUS.FAIL, reason: `Element '${selector}' not found in current observation candidates.`, evidenceIds: observation.evidenceId ? [observation.evidenceId] : [] };
  }
  return { status: STEP_STATUS.PASS, reason: `Element '${selector}' is visible.`, evidenceIds: observation.evidenceId ? [observation.evidenceId] : [] };
}

function networkRequestSeen(assertion, context) {
  const collector = context.collector;
  if (!collector) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "No diagnostic collector available.", evidenceIds: [] };
  }
  const snapshots = collector.getSnapshots({ sourceId: assertion.sourceId ?? null });
  const pattern = assertion.urlPattern;
  if (typeof pattern !== "string") {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Assertion requires a urlPattern.", evidenceIds: [] };
  }
  let regex;
  try { regex = new RegExp(pattern); } catch {
    return { status: STEP_STATUS.UNCERTAIN, reason: `Invalid urlPattern '${pattern}'.`, evidenceIds: [] };
  }
  // Network assertions must match against the current run's snapshots, not stale data.
  // Snapshots that report status "empty" or "unavailable" never satisfy the assertion.
  for (const snapshot of snapshots) {
    const requests = snapshot.data?.requests ?? [];
    const found = requests.some(request => typeof request.url === "string" && regex.test(request.url));
    if (found) {
      return {
        status: STEP_STATUS.PASS,
        reason: `Network request matching '${pattern}' observed in snapshot from source '${snapshot.sourceId}'.`,
        evidenceIds: [snapshot.evidenceId ?? snapshot.sourceId].filter(Boolean)
      };
    }
  }
  return { status: STEP_STATUS.FAIL, reason: `No network request matching '${pattern}' found in collected diagnostics.`, evidenceIds: [] };
}

function diagnosticSourceAvailable(assertion, context) {
  const collector = context.collector;
  if (!collector) {
    return { status: STEP_STATUS.UNCERTAIN, reason: "No diagnostic collector available.", evidenceIds: [] };
  }
  const sourceId = assertion.sourceId;
  if (typeof sourceId !== "string") {
    return { status: STEP_STATUS.UNCERTAIN, reason: "Assertion requires a sourceId.", evidenceIds: [] };
  }
  if (!collector.hasSource(sourceId)) {
    return { status: STEP_STATUS.FAIL, reason: `Diagnostic source '${sourceId}' is not registered.`, evidenceIds: [] };
  }
  // Registration alone does not prove accessibility or usable evidence.
  // Return UNCERTAIN unless a fresh snapshot from this source is available
  // and reports status "available".
  const snapshots = collector.getSnapshots({ sourceId });
  const latest = snapshots.at(-1);
  if (!latest) {
    return { status: STEP_STATUS.UNCERTAIN, reason: `Diagnostic source '${sourceId}' is registered but no evidence has been collected.`, evidenceIds: [] };
  }
  if (latest.data?.status !== "available") {
    return { status: STEP_STATUS.UNCERTAIN, reason: `Diagnostic source '${sourceId}' last returned status '${latest.data?.status ?? "unknown"}'.`, evidenceIds: [latest.evidenceId ?? latest.sourceId].filter(Boolean) };
  }
  return { status: STEP_STATUS.PASS, reason: `Diagnostic source '${sourceId}' is registered and returned usable evidence.`, evidenceIds: [latest.evidenceId ?? latest.sourceId].filter(Boolean) };
}
