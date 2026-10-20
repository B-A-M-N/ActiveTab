/** Decide whether an incomplete task-scoped interaction snapshot merits one wider read. */
export function shouldExpandTaskScope(observation, {
  workflowModeActive = false,
  expansionAttempted = false
} = {}) {
  const coverage = observation?.candidateCoverage;
  return workflowModeActive
    && !expansionAttempted
    && observation?.observationProfile === "interaction"
    && coverage?.selectionScope === "task_relevant_region"
    && coverage.scopeCoverage === "incomplete"
    && Number.isInteger(coverage.scopeCandidateCount)
    && coverage.scopeCandidateCount > (coverage.returnedScopeCandidateCount ?? 0)
    && coverage.scopeCandidateCount <= 384;
}

/**
 * Perform the one bounded task-scope expansion and accept only a new observation
 * for the attached target. Observation failures intentionally retain old evidence.
 */
export async function expandTaskScopeObservation({
  session,
  observation,
  goal,
  acceptObservation = () => {},
  filterObservation = value => value
} = {}) {
  try {
    const expandedObservation = await session.observe({
      profile: "interaction",
      selectionGoal: goal,
      candidateLimit: 384
    });
    if (expandedObservation?.evidenceId === observation?.evidenceId
      || expandedObservation?.targetId !== session?.target?.id) {
      return { observation, expanded: false };
    }

    acceptObservation(expandedObservation);
    return {
      observation: expandedObservation,
      planningObservation: filterObservation(expandedObservation, expandedObservation),
      expanded: true
    };
  } catch {
    // Keep the caller's existing planning snapshot if observation or projection fails.
    return { observation, expanded: false };
  }
}
