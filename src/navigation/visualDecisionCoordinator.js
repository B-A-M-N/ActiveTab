import { randomUUID } from "node:crypto";
import { bindVisualEvidence } from "./visualEvidence.js";
import { filterPlanningObservation } from "./planningCycle.js";
import { groundVisualTarget, revalidateVisualGrounding } from "./visualGrounder.js";

/** Compose read-only page assessment and advisory target grounding for one run. */
export function createVisualDecisionCoordinator({
  decisionRuntime,
  session,
  getSession = null,
  deterministicPlanner,
  goal,
  episodeId,
  runId,
  decisionStepId,
  signal,
  excludedIdentities = new Set(),
  excludedTargetSignatures = new Set(),
  excludedScrollIdentities = new Set(),
  searchPhrase = null,
  getLatestObservation = () => null
} = {}) {
  const currentSession = () => typeof getSession === "function" ? getSession() ?? session : session;
  const sessionMatchesObservation = (activeSession, observation) => activeSession?.attached === true
    && activeSession?.target?.id === observation?.targetId
    && activeSession?.documentGeneration === observation?.documentGeneration;
  const captureVisualObservation = async observation => {
    const activeSession = currentSession();
    if (!sessionMatchesObservation(activeSession, observation)) return { observation: null, imageEvidence: null, session: activeSession };
    let visualObservation = observation;
    let imageEvidence = visualObservation?.visualEvidence ?? null;
    if (!imageEvidence) {
      try {
        visualObservation = await activeSession.observe({ profile: "visual", prepareForJev: true, selectionGoal: goal });
        if (currentSession() !== activeSession || !sessionMatchesObservation(activeSession, visualObservation)) {
          return { observation: visualObservation, imageEvidence: null, session: activeSession };
        }
        const retained = activeSession.observer?.getEvidence?.(visualObservation.evidenceId, {
          facets: ["page"], includeScreenshot: true
        });
        imageEvidence = bindVisualEvidence(visualObservation, retained);
      } catch {
        imageEvidence = null;
      }
    }
    return { observation: visualObservation, imageEvidence, session: activeSession };
  };

  const classifyAmbiguousPage = async observation => {
    const service = decisionRuntime?.visualDecisionService;
    if (!service || typeof service.classifyPage !== "function") return null;
    const decisionId = randomUUID();
    if (decisionRuntime?.jevClient?.allowImages !== true) {
      decisionRuntime.recordInferenceRoute?.({
        episodeId, runId, stepId: decisionStepId(), decisionId,
        observationId: observation?.evidenceId, route: "deterministic", reasonCode: "image_permission_denied",
        providers: ["deterministic"], visualEvidenceUsed: false
      });
      decisionRuntime.recordReviewSkipped({
        episodeId, runId, stepId: decisionStepId(), decisionId,
        observation, operation: "visual_assessment", operationClass: "read", targetRole: "browser_page",
        expectedOutcomeClass: "page_classification", reasonCode: "image_permission_denied"
      });
      return { assessment: { status: "skipped", failureCode: "image_permission_denied", authorizesOperation: false }, observation, imageEvidence: null };
    }
    const captured = await captureVisualObservation(observation);
    if (!captured.imageEvidence) {
      decisionRuntime.recordInferenceRoute?.({
        episodeId, runId, stepId: decisionStepId(), decisionId,
        observationId: captured.observation?.evidenceId, route: "deterministic", reasonCode: "visual_evidence_unavailable",
        providers: ["deterministic"], visualEvidenceUsed: false
      });
      decisionRuntime.recordReviewSkipped({
        episodeId, runId, stepId: decisionStepId(), decisionId,
        observation: captured.observation ?? observation, operation: "visual_assessment", operationClass: "read",
        targetRole: "browser_page", expectedOutcomeClass: "page_classification", reasonCode: "visual_evidence_unavailable"
      });
      return { assessment: { status: "skipped", failureCode: "visual_evidence_unavailable", authorizesOperation: false }, ...captured };
    }
    if (currentSession() !== captured.session || !sessionMatchesObservation(captured.session, captured.observation)) {
      return { assessment: { status: "skipped", failureCode: "session_replaced_during_capture", authorizesOperation: false }, ...captured };
    }
    const assessment = await service.classifyPage({ ...captured.observation, visualEvidence: captured.imageEvidence }, {
      episodeId,
      runId,
      stepId: decisionStepId(),
      decisionId,
      imageEvidence: captured.imageEvidence,
      signal
    });
    return { assessment, ...captured };
  };

  const groundAmbiguousTarget = async (observation, deterministicPlan, targetRoleCode) => {
    const service = decisionRuntime?.visualDecisionService;
    if (!service || typeof service.groundTarget !== "function") return null;
    const allowedCandidateIds = (deterministicPlan?.candidates ?? []).map(candidate => candidate.identity);
    if (allowedCandidateIds.length < 2 || !targetRoleCode) return null;
    const decisionId = randomUUID();
    const stepId = decisionStepId();
    const captured = await captureVisualObservation(observation);
    if (!captured.imageEvidence) {
      decisionRuntime?.recordInferenceRoute?.({
        episodeId, runId, stepId, decisionId,
        observationId: captured.observation?.evidenceId ?? observation.evidenceId,
        route: "deterministic", reasonCode: "visual_evidence_unavailable",
        providers: ["deterministic"], visualEvidenceUsed: false
      });
      decisionRuntime?.recordReviewSkipped?.({
        episodeId, runId, stepId, decisionId,
        observation: captured.observation ?? observation,
        operation: "visual_target_grounding", operationClass: "read", targetRole: "visual_target",
        expectedOutcomeClass: "target_grounding", reasonCode: "visual_evidence_unavailable"
      });
      return { assessment: { status: "skipped", failureCode: "visual_evidence_unavailable", authorizesOperation: false }, grounding: null, ...captured };
    }
    const assessment = await service.groundTarget({ ...captured.observation, visualEvidence: captured.imageEvidence }, {
      episodeId,
      runId,
      stepId,
      decisionId,
      targetRoleCode,
      allowedCandidateIds,
      imageEvidence: captured.imageEvidence,
      signal
    });
    if (currentSession() !== captured.session || !sessionMatchesObservation(captured.session, captured.observation)) {
      return { assessment: { status: "skipped", failureCode: "session_replaced_during_grounding", authorizesOperation: false }, grounding: null, ...captured };
    }
    let finalAssessment = assessment;
    let candidateDiscoveryIdentity = null;
    let finalVisualImageEvidence = captured.imageEvidence;
    if (assessment?.status === "reviewed"
      && assessment.grounding?.status === "unavailable"
      && assessment.grounding?.reasonCode === "candidate_projection_incomplete"
      && typeof captured.session?.probeVisualCandidateAtPoint === "function") {
      const box = assessment.grounding.sourceBox;
      const x = Number.isFinite(box?.left) && Number.isFinite(box?.right) ? Math.round((box.left + box.right) / 2) : null;
      const y = Number.isFinite(box?.top) && Number.isFinite(box?.bottom) ? Math.round((box.top + box.bottom) / 2) : null;
      if (x !== null && y !== null) {
        const hitStartedAt = performance.now();
        const hit = await captured.session.probeVisualCandidateAtPoint(captured.observation.evidenceId, { x, y }).catch(() => ({
          status: "unavailable", reasonCode: "hit_probe_failed",
          elapsedMs: Math.max(0, Math.round(performance.now() - hitStartedAt)), actionAuthorized: false
        }));
        try {
          decisionRuntime?.recordTargetLookup?.({
            episodeId,
            runId,
            stepId,
            decisionId,
            observationId: captured.observation.evidenceId,
            lookupMode: hit.lookupMode ?? "cdp_dom_location",
            lookupStatus: ["candidate", "unavailable", "stale", "invalid", "expired"].includes(hit.status) ? hit.status : "unavailable",
            targetId: captured.observation.targetId,
            documentGeneration: captured.observation.documentGeneration,
            frameScope: hit.frameTargetId ? "out_of_process" : "root",
            frameTargetId: hit.frameTargetId ?? hit.candidateHint?.frameTargetId ?? null,
            frameId: hit.frameId ?? hit.candidateHint?.frameId ?? null,
            returnedCount: hit.status === "candidate" ? 1 : 0,
            visitedNodeCount: hit.visitedNodeCount ?? 0,
            stopReason: hit.reasonCode ?? "hit_probe_unavailable",
            elapsedMs: hit.elapsedMs ?? 0,
            nextActionDisposition: "deferred"
          });
        } catch { /* lookup telemetry never changes target admission */ }
        const hint = hit?.candidateHint;
        if (hit?.status === "candidate" && hint?.targetId === captured.observation.targetId
          && hint?.documentGeneration === captured.observation.documentGeneration
          && typeof hint.identity === "string") {
          const promotedObservation = await captured.session.observe({
            profile: "visual",
            prepareForJev: true,
            selectionGoal: goal,
            candidateLimit: 384,
            priorityCandidateIdentities: [hint.identity]
          }).catch(() => null);
          const promotedCandidate = currentSession() === captured.session && (promotedObservation?.candidates ?? []).find(candidate => candidate.identity === hint.identity
            && candidate.targetId === hint.targetId
            && candidate.documentGeneration === hint.documentGeneration
            && candidate.frameTargetId === hint.frameTargetId);
          if (promotedCandidate) {
            const promotedRetained = captured.session.observer?.getEvidence?.(promotedObservation.evidenceId, {
              facets: ["page"], includeScreenshot: true
            });
            const promotedImageEvidence = bindVisualEvidence(promotedObservation, promotedRetained);
            const refreshedPlan = await deterministicPlanner.plan(goal, filterPlanningObservation(promotedObservation, {
              excludedIdentities,
              excludedTargetSignatures,
              excludedScrollIdentities,
              searchPhrase,
              searchObservation: getLatestObservation()
            })).catch(() => null);
            const refreshedTargets = refreshedPlan?.status === "planned" ? [refreshedPlan.action?.target]
              : refreshedPlan?.candidates ?? [];
            const targetStillMatchesIntent = refreshedTargets.some(candidate => candidate?.identity === hint.identity);
            if (promotedImageEvidence && targetStillMatchesIntent) {
              const reprojection = groundVisualTarget({
                observation: promotedObservation,
                imageEvidence: promotedImageEvidence,
                answers: assessment.answers,
                allowedCandidateIds: refreshedTargets.map(candidate => candidate.identity).filter(Boolean)
              });
              if (reprojection.status === "grounded" && reprojection.candidate.identity === hint.identity) {
                finalAssessment = { ...assessment, grounding: reprojection, candidateDiscoveryMode: "bounded_cdp_location_probe" };
                candidateDiscoveryIdentity = hint.identity;
              }
            }
          }
        }
      }
    }
    // Reobserve after inference before offering any grounded identity to the
    // engine's ordinary policy and authorized-execution path.
    if (currentSession() !== captured.session) return { assessment: finalAssessment, grounding: null, ...captured };
    const freshObservation = await captured.session.observe({
      selectionGoal: goal,
      ...(candidateDiscoveryIdentity ? {
        profile: "visual",
        prepareForJev: true,
        candidateLimit: 384,
        priorityCandidateIdentities: [candidateDiscoveryIdentity]
      } : {})
    });
    if (candidateDiscoveryIdentity) {
      const retained = captured.session.observer?.getEvidence?.(freshObservation.evidenceId, { facets: ["page"], includeScreenshot: true });
      finalVisualImageEvidence = bindVisualEvidence(freshObservation, retained);
    }
    const candidate = finalAssessment?.status === "reviewed" && finalAssessment.grounding?.status === "grounded"
      ? revalidateVisualGrounding(finalAssessment.grounding, freshObservation)
      : null;
    if (!candidate) return {
      assessment: finalAssessment?.status === "reviewed" && finalAssessment.grounding?.status === "grounded" ? {
        ...finalAssessment,
        grounding: {
          status: "unavailable",
          reasonCode: "stale_after_inference",
          advisoryOnly: true,
          authorizesOperation: false
        }
      } : assessment,
      grounding: null,
      imageEvidence: finalVisualImageEvidence,
      observation: freshObservation
    };
    decisionRuntime?.recordTargetResolution?.({
      episodeId,
      runId,
      stepId,
      decisionId,
      observationId: freshObservation.evidenceId,
      resolver: candidateDiscoveryIdentity ? "cdp_hit_test_then_jev_box_candidate_intersection" : "jev_box_candidate_intersection",
      roleMappings: [{ role: targetRoleCode, candidateRef: candidate.identity }],
      reasonCode: candidateDiscoveryIdentity ? "bounded_location_candidate_rederived_and_box_matched" : "advisory_box_matched_fresh_candidate",
      evidenceRefs: [captured.observation.evidenceId, freshObservation.evidenceId],
      inputEventIds: assessment.inputEventIds ?? []
    });
    return {
      assessment: finalAssessment,
      grounding: finalAssessment.grounding,
      candidate,
      imageEvidence: finalVisualImageEvidence,
      observation: freshObservation
    };
  };

  return { captureVisualObservation, classifyAmbiguousPage, groundAmbiguousTarget };
}
