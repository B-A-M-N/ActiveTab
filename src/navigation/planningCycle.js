import { matchesTargetSignature } from "../state/workflows.js";
import { isSearchFieldCandidate } from "./search.js";

function toSet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
}

/** Apply the run's existing exclusions to one observed planning snapshot. */
export function filterPlanningObservation(observation, {
  excludedIdentities = new Set(),
  excludedTargetSignatures = [],
  excludedScrollIdentities = new Set(),
  searchPhrase = null,
  searchObservation = observation
} = {}) {
  if (!observation || typeof observation !== "object") return observation;
  const excludedIdentitySet = toSet(excludedIdentities);
  const excludedScrollIdentitySet = toSet(excludedScrollIdentities);
  const signatures = Array.isArray(excludedTargetSignatures) ? excludedTargetSignatures : [];

  return {
    ...observation,
    candidates: (observation.candidates ?? []).filter(candidate =>
      (!excludedIdentitySet.has(candidate.identity)
        || (searchPhrase && isSearchFieldCandidate(candidate, searchObservation)))
      && !signatures.some(signature => matchesTargetSignature(candidate, signature))
    ),
    scrollTargets: (observation.scrollTargets ?? []).filter(target =>
      !excludedScrollIdentitySet.has(target.identity)
    )
  };
}

/** Build only planner inputs; this function never changes run state or dispatches. */
export function createPlanningOptions({
  excludedIdentities,
  excludedScrollIdentities,
  maxScrolls,
  scrollActionsUsed,
  scrollConvergenceStates,
  signal,
  inputBindings
} = {}) {
  const previousScrollStates = [...(scrollConvergenceStates?.entries?.() ?? [])].map(([identity, data]) => ({
    identity,
    matchingCandidateCount: data.matchingCandidateCount,
    scrollActionsUsed: data.scrollActionsUsed
  }));
  return {
    excludedIdentities: [...(excludedIdentities ?? [])],
    excludedScrollIdentities: [...(excludedScrollIdentities ?? [])],
    maxScrolls,
    scrollActionsUsed,
    previousScrollStates,
    signal,
    inputBindings
  };
}
