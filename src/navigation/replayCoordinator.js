import {
  matchesScrollTargetSignature,
  matchesTargetSignature,
  observationStateFingerprint,
  routeFingerprint,
  scrollPositionFraction,
  scrollPositionMatches,
  visibleCandidatesFingerprint
} from "../state/workflows.js";

/** Makes stored-workflow replay decisions; browser effects remain with NavigationEngine. */
export class ReplayCoordinator {
  constructor({ workflowStore, goal, initialRouteFingerprint } = {}) {
    this.workflowStore = workflowStore;
    this.goal = goal;
    this.initialRouteFingerprint = initialRouteFingerprint;
  }

  async load({ observation, remainingActions, remainingScrolls } = {}) {
    const workflow = await this.workflowStore.find(this.goal, observation);
    if (!workflow) return { status: "miss", workflow: null };
    const scrollSteps = workflow.steps.filter(step => step.action === "scroll").length;
    if (workflow.steps.length > remainingActions || scrollSteps > remainingScrolls) {
      return { status: "budget-skipped", workflow: null };
    }
    return { status: "replaying", workflow };
  }

  resolveStep(step, observation) {
    if (routeFingerprint(observation?.page?.url) !== step.routeFingerprint) {
      return { status: "stale", reasonCode: "route_changed" };
    }
    if (step.action === "scroll") {
      const beforePositionFraction = observation.scrollTargets
        ?.filter(target => matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true)
        .map(scrollPositionFraction)
        .find(Number.isFinite);
      if (!scrollPositionMatches(beforePositionFraction, step.beforePositionFraction)
        || visibleCandidatesFingerprint(observation) !== step.beforeCandidatesFingerprint) {
        return { status: "stale", reasonCode: "scroll_precondition_changed" };
      }
      const matches = (observation.scrollTargets ?? []).filter(target =>
        matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true
      );
      if (matches.length !== 1) return { status: "stale", reasonCode: "scroll_target_not_unique" };
      return { status: "ready", target: matches[0], beforePositionFraction };
    }
    const matches = (observation.candidates ?? []).filter(candidate => matchesTargetSignature(candidate, step.target));
    if (matches.length !== 1) return { status: "stale", reasonCode: "click_target_not_unique" };
    return { status: "ready", target: matches[0] };
  }

  evaluateScrollStep(step, target, attempt, afterObservation) {
    const afterScrollMatches = (afterObservation.scrollTargets ?? [])
      .filter(item => matchesScrollTargetSignature(item, step.scrollTarget));
    const afterTarget = afterScrollMatches.length === 1 ? afterScrollMatches[0] : undefined;
    const afterPositionFraction = scrollPositionFraction(afterTarget);
    const afterCandidatesFingerprint = visibleCandidatesFingerprint(afterObservation);
    const moved = Boolean(afterTarget && afterTarget.scrollTop > Number(target.scrollTop ?? 0) + 2);
    const matchesTrace = !attempt.error && moved
      && afterCandidatesFingerprint === step.afterCandidatesFingerprint
      && scrollPositionMatches(afterPositionFraction, step.afterPositionFraction);
    return { matchesTrace, afterTarget, afterPositionFraction, afterCandidatesFingerprint, moved };
  }

  clickChanged(beforeStateFingerprint, afterObservation) {
    return observationStateFingerprint(afterObservation) !== beforeStateFingerprint;
  }

  invalidate() {
    return this.workflowStore.invalidate(this.goal, this.initialRouteFingerprint);
  }
}
