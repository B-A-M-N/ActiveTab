import { authorizePlannedAction } from "./actionPolicy.js";
import { classifyHumanHandoff } from "./handoff.js";

export async function clickObservedElement(session, { goal, evidenceId, backendNodeId, frameTargetId = null } = {}) {
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
  if (!authorization.authorized) return { status: "needs_human", category: authorization.category, reason: authorization.reason, evidenceId: before.evidenceId, targetIdentity: target.identity };

  try {
    await session.click(target);
  } catch (error) {
    const afterFailure = await session.observe({ includeScreenshot: false });
    return {
      status: "action_failed",
      targetIdentity: target.identity,
      reason: String(error.message).slice(0, 500),
      beforeEvidenceId: before.evidenceId,
      observation: afterFailure,
      verificationRequired: true
    };
  }
  const after = await session.observe({ includeScreenshot: false });
  return {
    status: "action_dispatched",
    targetIdentity: target.identity,
    beforeEvidenceId: before.evidenceId,
    observation: after,
    verificationRequired: true
  };
}
