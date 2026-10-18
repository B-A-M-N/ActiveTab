import { createHash } from "node:crypto";
import { goalExpectation } from "./planner.js";
import { normalizeOrigin } from "../environments/model.js";

function pageLabelEntries(observation) {
  const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const entries = [];
  const title = normalize(observation.page?.title);
  if (title) entries.push({ source: "title", text: title });
  for (const heading of observation.headings ?? []) {
    const text = normalize(heading.text);
    if (text) entries.push({ source: `heading:${heading.level ?? ""}:${heading.frameId ?? ""}`, text });
  }
  return entries;
}

function pageLabelHash(entry) {
  return createHash("sha256").update(JSON.stringify([entry.source, entry.text])).digest("hex");
}

function labelTerms(value) {
  return new Set(String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Stores only hashes of initial page labels, not their raw text. */
export function pageLabelHashes(observation) {
  return [...new Set(pageLabelEntries(observation).map(pageLabelHash))].sort();
}

/**
 * Evaluates whether fresh navigation evidence satisfies the goal's visible
 * destination expectation. Application-level effects require their own oracle.
 */
export function hasVerifiedOutcome(observation, goal, initialPageLabelHashes, environment = null) {
  const expected = goalExpectation(goal);
  if (!expected.targetTokens.length) return false;
  const labels = pageLabelEntries(observation);
  const baselineLabels = new Set(initialPageLabelHashes ?? []);
  const changedLabels = labels.filter(label => !baselineLabels.has(pageLabelHash(label)));
  const changedLabelsMatch = changedLabels.some(label => {
    const observedTerms = labelTerms(label.text);
    return expected.targetTokens.every(token => observedTerms.has(token));
  });
  let pathTerms = new Set();
  try { pathTerms = labelTerms(new URL(observation.page.url).pathname); } catch { /* non-URL page */ }
  const pathMatches = expected.targetTokens.every(token => pathTerms.has(token));
  if (expected.searchQuery) {
    const resultsState = changedLabels.some(label => /\b(?:search results?|results? for|no results)\b/i.test(label.text));
    return resultsState;
  }
  // A matching label on the starting page is not proof that navigation happened. A matching route
  // is sufficient when already there; an SPA can instead prove the goal through a changed title/heading.
  if (!(pathMatches || changedLabelsMatch)) return false;
  // Environment guard: a goal whose label tokens happen to match on an
  // unrelated origin is NOT a verified outcome. When an environment binding
  // is supplied, the goal must be satisfied on one of its authorized origins
  // (or already be there). This prevents a blind navigation step from
  // "succeeding" after wandering onto an unauthorized site.
  if (environment?.authorizedOrigins?.length) {
    const observed = normalizeOrigin(observation.page.url);
    if (observed && !environment.authorizedOrigins.includes(observed)) return false;
  }
  return true;
}
