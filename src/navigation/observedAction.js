import { authorizePlannedAction } from "./actionPolicy.js";
import { classifyHumanHandoff } from "./handoff.js";
import { randomUUID } from "node:crypto";
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import { adjudicatePreActionReview } from "../decisions/adjudication.js";

export async function clickObservedElement(session, { goal, evidenceId, backendNodeId, frameTargetId = null, decisionRuntime = null, environment = null, localFixture = false } = {}) {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 2_000) throw new Error("A non-empty caller goal of at most 2,000 characters is required.");
  if (typeof evidenceId !== "string" || !evidenceId) throw new Error("An evidence ID is required.");
  if (!Number.isInteger(backendNodeId) || backendNodeId < 0) throw new Error("A non-negative observed backend node ID is required.");

  const selectedEvidence = session.observer.getEvidence(evidenceId, {
    facets: ["selectedElement"],
    backendNodeId,
    frameTargetId
  });
  if (selectedEvidence.status !== "available") return { status: "evidence_expired", evidenceId };
  const selected = selectedEvidence.selectedElement;
  if (!selected || selected.status === "not_found") return { status: "target_not_found", evidenceId, backendNodeId, frameTargetId };

  const before = await session.observe({ includeScreenshot: false });
  const target = before.candidates.find(candidate => candidate.identity === selected.identity);
  if (!target) return { status: "stale_target", evidenceId: before.evidenceId, reason: "The selected candidate is no longer present in a fresh observation. Select a current target before acting." };

  const handoff = classifyHumanHandoff(before);
  if (handoff) return { status: "needs_human", category: handoff.category, reason: handoff.reason, evidenceId: before.evidenceId };
  const authorization = authorizePlannedAction(goal, target, "click");
  const runId = randomUUID();
  const stepId = "step_observed_click";
  const decisionId = randomUUID();
  const operationId = randomUUID();
  const episode = decisionRuntime?.startEpisode({
    runId,
    workflowId: "observed_element_action",
    applicationId: "unknown",
    environmentClass: "unknown",
    executionMode: "agent_directed",
    policyVersion: "active_policy_v1",
    workflowKind: "browser_workflow"
  });
  if (episode && !authorization.authorized) {
    await decisionRuntime.recordPolicy({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, disposition: "deny", reasonCode: authorization.category ?? "action_policy_refused" });
    decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: "blocked", cleanupStatus: "not_required" });
  }
  if (!authorization.authorized) return { status: "needs_human", category: authorization.category, reason: authorization.reason, evidenceId: before.evidenceId, targetIdentity: target.identity, ...(episode ? { decisionEpisodeId: episode.episodeId } : {}) };

  if (episode) {
    const reviewRequired = target.submitsForm === true
      || ((target.tag === "a" || target.role === "link") && typeof target.href === "string");
    const review = reviewRequired
      ? await decisionRuntime.reviewBeforeAction({
          episodeId: episode.episodeId,
          runId,
          stepId,
          decisionId,
          observation: before,
          operation: "click",
          operationClass: target.submitsForm === true ? "form_submission" : "navigation",
          targetRole: target.submitsForm === true ? "form_submit_control" : "navigation_link",
          expectedOutcomeClass: target.submitsForm === true ? "browser_state_change" : "destination_observed",
          candidate: target
        })
      : (decisionRuntime.recordReviewSkipped({
          episodeId: episode.episodeId,
          runId,
          stepId,
          decisionId,
          observation: before,
          operation: "click",
          operationClass: "browser_disclosure",
          targetRole: "observed_browser_target",
          expectedOutcomeClass: "browser_state_change",
          reasonCode: "policy_boundary_not_triggered"
        }), { decisionId, authorizesOperation: false });
    const adjudication = adjudicatePreActionReview(review);
    if (!adjudication.allowed) {
      await decisionRuntime.recordPolicy({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, disposition: "deny", reasonCode: "jev_review_required" });
      decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: "blocked", cleanupStatus: "not_required" });
      return { status: "needs_human", category: adjudication.category, reason: adjudication.reason, evidenceId: before.evidenceId, targetIdentity: target.identity, decisionEpisodeId: episode.episodeId };
    }
    await decisionRuntime.recordPolicy({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, disposition: "allow", reasonCode: "action_policy_admitted" });
    await decisionRuntime.reserveExecution({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, operation: "click", targetRole: "observed_browser_target", operationId });
  }

  let dispatch;
  try {
    dispatch = await executeAuthorizedAction({ session, environment, localFixture, goal, action: "click", candidate: target });
  } catch (error) {
    const afterFailure = await session.observe({ includeScreenshot: false });
    if (episode) {
      try {
        decisionRuntime.recordDispatch({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, operation: "click", targetRole: "observed_browser_target", operationId, dispatchStatus: "uncertain" });
        if (afterFailure?.evidenceId) decisionRuntime.recordObserved({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: afterFailure.evidenceId, outcomeClass: "click_failure_state_observed", changed: afterFailure.pageChangeFingerprint !== before.pageChangeFingerprint, evidenceRefs: [before.evidenceId, afterFailure.evidenceId] });
      } catch { /* preserve the uncertain browser result if telemetry storage fails */ }
      decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: "uncertain", cleanupStatus: "not_required" });
    }
    return {
      status: "action_failed",
      targetIdentity: target.identity,
      reason: String(error.message).slice(0, 500),
      beforeEvidenceId: before.evidenceId,
      observation: afterFailure,
      verificationRequired: true
    };
  }
  if (!dispatch.dispatched) {
    const afterRefusal = dispatch.authorized ? await session.observe({ includeScreenshot: false }).catch(() => null) : before;
    if (episode) {
      try {
        await decisionRuntime.recordDispatch({
          episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId,
          operation: "click", targetRole: "observed_browser_target", operationId,
          dispatchStatus: dispatch.authorized ? "uncertain" : "refused"
        });
        if (afterRefusal?.evidenceId) await decisionRuntime.recordObserved({
          episodeId: episode.episodeId, runId, stepId, decisionId, observationId: afterRefusal.evidenceId,
          outcomeClass: dispatch.authorized ? "click_uncertain_state_observed" : "click_refusal_state_observed",
          changed: afterRefusal.pageChangeFingerprint !== before.pageChangeFingerprint,
          evidenceRefs: [before.evidenceId, afterRefusal.evidenceId]
        });
      } catch { /* preserve the executor disposition if telemetry storage fails */ }
      decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: dispatch.authorized ? "uncertain" : "blocked", cleanupStatus: "not_required" });
    }
    return {
      status: dispatch.authorized ? "action_uncertain" : "needs_human",
      category: dispatch.category,
      reason: dispatch.reason,
      targetIdentity: target.identity,
      beforeEvidenceId: before.evidenceId,
      observation: afterRefusal,
      verificationRequired: true,
      ...(episode ? { decisionEpisodeId: episode.episodeId } : {})
    };
  }
  const after = await session.observe({ includeScreenshot: false });
  let telemetryError = false;
  if (episode) {
    try {
      await decisionRuntime.recordDispatch({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: before.evidenceId, operation: "click", targetRole: "observed_browser_target", operationId, dispatchStatus: "dispatched" });
      await decisionRuntime.recordObserved({ episodeId: episode.episodeId, runId, stepId, decisionId, observationId: after.evidenceId, outcomeClass: "click_state_observed", changed: after.pageChangeFingerprint !== before.pageChangeFingerprint, evidenceRefs: [before.evidenceId, after.evidenceId] });
      decisionRuntime.completeEpisode({ episodeId: episode.episodeId, runId, status: "uncertain", cleanupStatus: "not_required" });
    } catch { telemetryError = true; }
  }
  return {
    status: "action_dispatched",
    targetIdentity: target.identity,
    beforeEvidenceId: before.evidenceId,
    observation: after,
    verificationRequired: true,
    ...(telemetryError ? { telemetryError: true } : {}),
    ...(episode ? { decisionEpisodeId: episode.episodeId } : {})
  };
}
