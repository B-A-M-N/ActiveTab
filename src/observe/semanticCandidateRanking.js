const TASK_SELECTION_STOPWORDS = new Set(["the", "and", "for", "from", "into", "with", "that", "this", "then", "open", "click", "find", "get", "show", "please", "page", "site", "browser", "use", "complete", "workflow", "task", "section", "sections", "step", "steps", "next", "all", "every"]);

function taskSelectionTerms(value) {
  if (typeof value !== "string") return [];
  const terms = new Set((value.slice(0, 2_048).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(term => !TASK_SELECTION_STOPWORDS.has(term)));
  if (terms.has("first")) terms.add("one");
  if (terms.has("second")) terms.add("two");
  if (terms.has("third")) terms.add("three");
  if (terms.has("fourth")) terms.add("four");
  return [...terms].slice(0, 48);
}

function candidateTaskMatch(candidate, terms) {
  if (!terms.length) return 0;
  const text = [candidate?.name, candidate?.contextName, candidate?.recordContext, candidate?.role, candidate?.tag, candidate?.type]
    .filter(value => typeof value === "string").join(" ").normalize("NFKC").toLowerCase();
  const words = new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return terms.reduce((count, term) => count + Number(words.has(term)), 0);
}

function candidateContextKeys(candidate) {
  return [candidate?.contextName, candidate?.recordContext]
    .filter(value => typeof value === "string")
    .map(value => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase())
    .filter(Boolean);
}

/** Rank observed controls locally without sending the selection goal to any model. */
export function rankInteractionCandidates(candidates, selectionGoal, { maxCandidates = 200, priorityCandidateIdentities = [] } = {}) {
  if (!Array.isArray(candidates) || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 1_000
    || !Array.isArray(priorityCandidateIdentities) || priorityCandidateIdentities.length > 10_000
    || priorityCandidateIdentities.some(identity => typeof identity !== "string" || identity.length > 256)) {
    throw new Error("Candidate ranking requires an array and a bounded positive limit.");
  }
  const terms = taskSelectionTerms(selectionGoal);
  const matches = new Map(candidates.map(candidate => [candidate, candidateTaskMatch(candidate, terms)]));
  const priority = new Set(priorityCandidateIdentities);
  const relevant = candidates.filter(candidate => matches.get(candidate) > 0);
  const relevantRegions = new Set(relevant.flatMap(candidateContextKeys));
  const scoped = terms.length && relevant.length
    ? candidates.filter(candidate => matches.get(candidate) > 0
      || candidateContextKeys(candidate).some(context => relevantRegions.has(context)))
    : candidates;
  const scopedSet = new Set(scoped);
  const ranked = [...candidates].sort((a, b) => Number(priority.has(b?.identity)) - Number(priority.has(a?.identity))
    || Number(scopedSet.has(b)) - Number(scopedSet.has(a))
    || matches.get(b) - matches.get(a)
    || Number(b?.visible === true) - Number(a?.visible === true));
  const selected = ranked.slice(0, maxCandidates);
  const returnedScopeCandidateCount = selected.filter(candidate => scopedSet.has(candidate)).length;
  const hasTaskScope = terms.length > 0 && relevant.length > 0;
  return Object.freeze({
    candidates: Object.freeze(selected),
    pageCandidateCount: candidates.length,
    taskRelevantCandidateCount: relevant.length,
    scopeCandidateCount: hasTaskScope ? scoped.length : candidates.length,
    returnedScopeCandidateCount,
    scopeCandidateIdentities: Object.freeze(scoped.map(candidate => candidate?.identity).filter(value => typeof value === "string")),
    selectionScope: hasTaskScope ? "task_relevant_region" : "page",
    pageCoverage: candidates.length <= selected.length ? "complete" : "partial",
    scopeCoverage: (hasTaskScope ? scoped.length : candidates.length) <= returnedScopeCandidateCount ? "complete" : "incomplete",
    truncated: candidates.length > selected.length
  });
}
