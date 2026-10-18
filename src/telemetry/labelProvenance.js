import { createHash } from "node:crypto";
import { canonicalJson } from "./decisionEvents.js";

const INDEPENDENT_SOURCES = new Set(["deterministic_assertion", "correlated_backend", "independent_human"]);
const VERIFIED_STATUSES = new Set(["verified_pass", "verified_fail"]);

function sameIdentity(event, proposal) {
  return event.episodeId === proposal.episodeId
    && event.runId === proposal.runId
    && event.stepId === proposal.stepId
    && event.decisionId === proposal.decisionId;
}

function hasAllEvidence(sourceEvent, evidenceRefs) {
  const available = new Set(sourceEvent.payload.evidenceRefs ?? []);
  return evidenceRefs.length > 0 && evidenceRefs.every(reference => available.has(reference));
}

export function findPredictionForLabel(events, proposal) {
  return events.find(event => event.sequence < proposal.sequence
    && sameIdentity(event, proposal)
    && ((event.eventType === "decision.predicted" && event.payload.rubricId === proposal.payload.rubricId)
      || (event.eventType === "semantic.annotated" && event.payload.rubricId === proposal.payload.rubricId))) ?? null;
}

export function hasIndependentLabelEvidence(events, proposal, prediction = findPredictionForLabel(events, proposal)) {
  const { sourceClass, labelCode, evidenceRefs } = proposal.payload;
  if (!INDEPENDENT_SOURCES.has(sourceClass) || !prediction) return false;
  return events.some(event => {
    if (!sameIdentity(event, proposal) || event.sequence <= prediction.sequence || event.sequence >= proposal.sequence) return false;
    if (sourceClass === "correlated_backend" || sourceClass === "deterministic_assertion") {
      return event.eventType === "verification.completed"
        && VERIFIED_STATUSES.has(event.payload.status)
        && event.payload.oracleType === sourceClass
        && event.payload.verifiedCode === labelCode
        && hasAllEvidence(event, evidenceRefs);
    }
    return event.eventType === "correction.recorded"
      && event.payload.correctionType === "outcome_label"
      && event.payload.sourceClass === "independent_human"
      && event.payload.supersedesDecisionId === proposal.decisionId
      && event.payload.correctedCode === labelCode
      && hasAllEvidence(event, evidenceRefs);
  });
}

export function labelApprovalDigest(proposal) {
  const approvalScope = {
    schemaVersion: 1,
    episodeId: proposal.episodeId,
    runId: proposal.runId,
    stepId: proposal.stepId ?? null,
    decisionId: proposal.decisionId,
    labelEventId: proposal.eventId,
    rubricId: proposal.payload.rubricId,
    labelCode: proposal.payload.labelCode,
    sourceClass: proposal.payload.sourceClass,
    evidenceRefs: proposal.payload.evidenceRefs
  };
  return createHash("sha256").update(canonicalJson(approvalScope)).digest("hex");
}

export function isValidApprovedLabel(events, approval, prediction) {
  if (approval.eventType !== "label.approved"
    || approval.trainingEligibility !== "eligible"
    || !approval.parentEventId
    || approval.sequence <= prediction.sequence) return false;
  const proposal = events.find(event => event.eventId === approval.payload.labelEventId
    && event.eventType === "label.proposed");
  if (!proposal || approval.parentEventId !== proposal.eventId
    || proposal.sequence <= prediction.sequence
    || !sameIdentity(proposal, approval)
    || approval.runId !== proposal.runId
    || approval.stepId !== proposal.stepId
    || approval.decisionId !== proposal.decisionId
    || approval.payload.rubricId !== proposal.payload.rubricId
    || approval.payload.labelCode !== proposal.payload.labelCode
    || approval.payload.sourceClass !== proposal.payload.sourceClass
    || canonicalJson(approval.payload.evidenceRefs) !== canonicalJson(proposal.payload.evidenceRefs)
    || approval.payload.approvalDigest !== labelApprovalDigest(proposal)
    || !approval.payload.reviewerId) return false;
  return hasIndependentLabelEvidence(events, proposal, prediction);
}
