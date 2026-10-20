import { randomUUID } from "node:crypto";
import { goalExpectation } from "./planner.js";
import { reobserveFromRetainedLookup } from "./retainedLookupFallback.js";
import { selectAutomaticNavigationRoute } from "../decisions/callPolicy.js";
import { createPlanningOptions } from "./planningCycle.js";
import { isBoundVisualEvidence } from "./visualEvidence.js";

/** Resolve one deterministic, workflow, semantic, or visual planning cycle. */
export async function coordinateProviderPlan({
  goal,
  planner,
  configuredPlanner,
  plannerMode,
  workflowModeActive,
  explicitReadWorkflowRequest,
  resumeState,
  effectiveWorkflowIntent,
  deterministicPlanner,
  secondaryPlannerAvailable,
  decisionRuntime,
  decisionEpisodeId,
  decisionRunId,
  decisionStepId,
  session,
  state,
  excludedIdentities,
  excludedScrollIdentities,
  scrollActionsUsed,
  scrollConvergenceStates,
  maxScrolls,
  signal,
  inputBindings,
  searchPhrase,
  getLatestObservation,
  setLatestObservation,
  filterPlanning,
  captureVisualObservation,
  classifyAmbiguousPage,
  groundAmbiguousTarget
}) {
  let {
    planningObservation,
    candidateExpansionAttempted,
    plan,
    modelPlannerDecisionId,
    routedVisualReview,
    visualHandoffSuggested
  } = state;

  try {
    const planningOptions = createPlanningOptions({
      excludedIdentities,
      excludedScrollIdentities,
      maxScrolls,
      scrollActionsUsed,
      scrollConvergenceStates,
      signal,
      inputBindings
    });
    if (workflowModeActive || plannerMode !== "auto") {
      if (plannerMode === "model" && planner?.plannerRole) {
        const visualEvidenceUsed = planner.requiresScreenshot === true
          && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence);
        modelPlannerDecisionId = randomUUID();
        decisionRuntime?.recordInferenceRoute?.({
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          stepId: decisionStepId(),
          decisionId: modelPlannerDecisionId,
          observationId: planningObservation.evidenceId,
          route: "semantic_only",
          reasonCode: "explicit_model_planner",
          providers: ["secondary"],
          visualEvidenceUsed
        });
      }
      plan = await planner.plan(goal, planningObservation, planningOptions);
    } else if (explicitReadWorkflowRequest && resumeState) {
      const decisionId = randomUUID();
      decisionRuntime?.recordInferenceRoute?.({
        episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
        decisionId, observationId: planningObservation.evidenceId,
        route: "abstain", reasonCode: "read_output_not_retained_for_resume",
        providers: ["deterministic"], visualEvidenceUsed: false
      });
      plan = {
        status: "ambiguous",
        candidates: [],
        reason: "Read-only extraction output is not retained in task continuation state; start a new task to rebuild it from fresh evidence. No browser action was selected."
      };
    } else {
      let localPlan = await deterministicPlanner.plan(goal, planningObservation, planningOptions);
      if (localPlan.status === "ambiguous" && !candidateExpansionAttempted
        && getLatestObservation().candidateCoverage?.pageCoverage === "partial") {
        const expectedTargets = goalExpectation(goal).targetTokens;
        const fallback = await reobserveFromRetainedLookup({
          session,
          goal,
          observation: getLatestObservation(),
          targetTokens: expectedTargets
        });
        if (fallback.lookupTelemetry && decisionRuntime?.recordTargetLookup && decisionEpisodeId) {
          try {
            decisionRuntime.recordTargetLookup({
              episodeId: decisionEpisodeId,
              runId: decisionRunId,
              stepId: decisionStepId(),
              decisionId: randomUUID(),
              observationId: getLatestObservation().evidenceId,
              ...fallback.lookupTelemetry
            });
          } catch { /* lookup telemetry never changes target admission */ }
        }
        candidateExpansionAttempted = fallback.status !== "not_needed";
        if (fallback.status === "refreshed") {
          setLatestObservation(fallback.observation);
          planningObservation = filterPlanning(getLatestObservation());
          localPlan = await deterministicPlanner.plan(goal, planningObservation, planningOptions);
        }
      }
      if (searchPhrase) {
        const routeDecisionId = randomUUID();
        decisionRuntime?.recordInferenceRoute?.({
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          stepId: decisionStepId(),
          decisionId: routeDecisionId,
          observationId: planningObservation.evidenceId,
          route: "deterministic",
          reasonCode: "caller_bound_search_primitive",
          providers: ["deterministic"],
          visualEvidenceUsed: false
        });
        plan = localPlan;
      } else {
        const rawTargetRoleCode = goalExpectation(goal).targetTokens.slice(0, 10).join("_");
        const targetRoleCode = /^[a-z0-9][a-z0-9_]{0,95}$/u.test(rawTargetRoleCode) ? rawTargetRoleCode : "";
        const visualAssessmentAvailable = decisionRuntime?.jevClient?.allowImages === true
          && typeof decisionRuntime?.visualDecisionService?.classifyPage === "function";
        const visualGroundingAvailable = decisionRuntime?.jevClient?.allowImages === true
          && typeof decisionRuntime?.visualDecisionService?.groundTarget === "function"
          && targetRoleCode.length > 0;
        const route = selectAutomaticNavigationRoute({
          goal,
          deterministicPlan: localPlan,
          intentShape: effectiveWorkflowIntent?.cardinality ?? "unknown",
          semanticAvailable: secondaryPlannerAvailable,
          visualAssessmentAvailable,
          visualGroundingAvailable
        });
        const routeDecisionId = randomUUID();
        if (route.route === "deterministic" || route.route === "abstain") {
          decisionRuntime?.recordInferenceRoute?.({
            episodeId: decisionEpisodeId,
            runId: decisionRunId,
            stepId: decisionStepId(),
            decisionId: routeDecisionId,
            observationId: planningObservation.evidenceId,
            route: route.route,
            reasonCode: route.reasonCode,
            providers: route.providers,
            visualEvidenceUsed: route.visualEvidenceUsed
          });
        }
        if (route.route === "deterministic") {
          plan = localPlan;
        } else if (route.route === "abstain") {
          plan = {
            status: "ambiguous",
            candidates: localPlan.candidates ?? [],
            expected: localPlan.expected,
            reason: "The task has no trusted atomicity contract and no configured secondary planner is available; no browser action was selected."
          };
        } else if (route.route === "jev_only") {
          routedVisualReview = route.reasonCode === "ambiguous_visual_target_grounding"
            ? await groundAmbiguousTarget(planningObservation, localPlan, targetRoleCode)
            : await classifyAmbiguousPage(planningObservation);
          if (routedVisualReview?.observation?.evidenceId) {
            setLatestObservation(routedVisualReview.observation);
            planningObservation = filterPlanning(getLatestObservation());
            if (routedVisualReview.imageEvidence) {
              planningObservation.visualEvidence = routedVisualReview.imageEvidence;
              planningObservation.screenshotBase64 = routedVisualReview.imageEvidence.screenshotBase64;
            }
            localPlan = await deterministicPlanner.plan(goal, planningObservation, planningOptions);
          }
          if (routedVisualReview?.candidate && routedVisualReview.grounding?.status === "grounded") {
            plan = {
              status: "planned",
              action: { type: "click", target: routedVisualReview.candidate },
              expected: localPlan.expected,
              confidence: Math.min(0.95, routedVisualReview.grounding.scores.boxConfidence, routedVisualReview.grounding.scores.presenceProbability),
              reasoning: "Jev visually grounded one candidate already selected by deterministic matching; the exact identity was freshly re-resolved before policy admission."
            };
          }
          const pageAnswer = routedVisualReview?.assessment?.answers?.page_state;
          visualHandoffSuggested = ["login", "challenge"].includes(pageAnswer?.choice)
            && (pageAnswer.probabilities?.[pageAnswer.choice] ?? 0) >= 0.8;
          if (plan?.status === "planned") {
            // The advisory grounding selected only among current observed
            // candidates. The common action policy and executor still gate it.
          } else if (visualHandoffSuggested || !secondaryPlannerAvailable) {
            plan = {
              ...localPlan,
              status: "ambiguous",
              reason: visualHandoffSuggested
                ? "Visual assessment recommends a manual handoff for the apparent authentication or challenge state; no action was dispatched."
                : localPlan.reason
            };
          } else {
            const escalationId = randomUUID();
            decisionRuntime?.recordInferenceRoute?.({
              episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
              decisionId: escalationId, observationId: planningObservation.evidenceId,
              route: "semantic_only", reasonCode: "visual_state_did_not_resolve_navigation",
              providers: ["secondary"], visualEvidenceUsed: configuredPlanner.requiresScreenshot === true && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
            });
            if (configuredPlanner.requiresScreenshot === true && !isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)) {
              const captured = await captureVisualObservation(planningObservation);
              setLatestObservation(captured.observation);
              planningObservation = filterPlanning(getLatestObservation());
              if (captured.imageEvidence) {
                planningObservation.visualEvidence = captured.imageEvidence;
                planningObservation.screenshotBase64 = captured.imageEvidence.screenshotBase64;
              }
            }
            modelPlannerDecisionId = escalationId;
            plan = await planner.plan(goal, planningObservation, planningOptions);
          }
        } else {
          if (configuredPlanner.requiresScreenshot === true) {
            const captured = await captureVisualObservation(planningObservation);
            setLatestObservation(captured.observation);
            planningObservation = filterPlanning(getLatestObservation());
            if (captured.imageEvidence) {
              planningObservation.visualEvidence = captured.imageEvidence;
              planningObservation.screenshotBase64 = captured.imageEvidence.screenshotBase64;
            }
          }
          decisionRuntime?.recordInferenceRoute?.({
            episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
            decisionId: routeDecisionId, observationId: planningObservation.evidenceId,
            route: route.route, reasonCode: route.reasonCode, providers: route.providers,
            visualEvidenceUsed: configuredPlanner.requiresScreenshot === true
              && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
          });
          modelPlannerDecisionId = routeDecisionId;
          plan = await planner.plan(goal, planningObservation, planningOptions);
        }
      }
    }
  } catch (error) {
    Object.assign(state, { planningObservation, candidateExpansionAttempted, plan, modelPlannerDecisionId, routedVisualReview, visualHandoffSuggested });
    throw error;
  }

  Object.assign(state, { planningObservation, candidateExpansionAttempted, plan, modelPlannerDecisionId, routedVisualReview, visualHandoffSuggested });
  return state;
}
