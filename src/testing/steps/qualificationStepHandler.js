import { createHash } from "node:crypto";
import { STEP_STATUS } from "../schema.js";

/** Invokes ActiveTab qualification and records an advisory workflow receipt. */
export class QualificationStepHandler {
  constructor({ qualificationService = null, getEpisodeId, principalId = null, signal = null } = {}) {
    this.qualificationService = qualificationService;
    this.getEpisodeId = getEpisodeId ?? (() => null);
    this.principalId = principalId;
    this.signal = signal;
  }

  async execute(step, receipt, startedAt, context, telemetryStepId = null) {
    const unavailable = reasonCode => ({ status: "unavailable", qualificationId: null, reasonCode, evidenceRefs: [] });
    let result;
    const episodeId = this.getEpisodeId();
    if (!this.qualificationService || !episodeId) {
      result = unavailable("qualification_service_unavailable");
    } else {
      try {
        result = await this.qualificationService.qualify({
          runId: receipt.runId,
          episodeId,
          stepId: telemetryStepId,
          scenarioId: step.scenarioId,
          providerId: step.providerId,
          trigger: step.trigger,
          principalId: this.principalId ?? "unknown",
          strategyFingerprint: context?.workflowHash ?? createHash("sha256").update(step.id).digest("hex"),
          sourceEventIds: step.sourceEventIds ?? [],
          evidenceRefs: step.evidenceRefs ?? [],
          signal: this.signal
        });
      } catch {
        result = unavailable("qualification_invocation_unavailable");
      }
    }
    const qualificationStatus = result?.status ?? "unavailable";
    const required = step.required === true;
    const stepStatus = required && qualificationStatus !== "qualified" ? STEP_STATUS.FAIL : STEP_STATUS.PASS;
    const reason = qualificationStatus === "qualified" && result?.qualification?.level === "resolver"
      ? "Resolver strategy passed synthetic DOM variants; no independent application outcome was tested."
      : qualificationStatus === "qualified" ? `Candidate strategy qualified at the ${result?.qualification?.level ?? "unknown"} level against an independent fixture outcome.`
      : qualificationStatus === "not_qualified" ? "Candidate strategy did not satisfy the independent fixture oracle."
        : qualificationStatus === "inconclusive" ? "Fixture qualification was inconclusive; actual task execution remains governed by its own policy and evidence."
          : "Fixture qualification was unavailable; actual task execution remains governed by its own policy and evidence.";
    const details = {
      qualificationStatus,
      required,
      ...(typeof result?.qualificationId === "string" ? { qualificationId: result.qualificationId } : {}),
      ...(typeof result?.reasonCode === "string" ? { reasonCode: result.reasonCode } : {}),
      ...(result?.qualification ? {
        qualificationLevel: result.qualification.level,
        providerIdentity: result.qualification.providerIdentity,
        scenarioSeed: result.qualification.scenarioSeed,
        sourceRevision: result.qualification.sourceRevision,
        oracleReference: result.qualification.oracleReference,
        independentApplicationOutcome: result.qualification.independentApplicationOutcome,
        cleanupResult: result.cleanupResult
      } : {}),
      evidenceRefs: (result?.evidenceRefs ?? []).filter(ref => typeof ref === "string").slice(0, 32)
    };
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status: stepStatus,
      reason,
      evidenceIds: details.evidenceRefs,
      startedAt,
      details
    });
    return { status: stepStatus, reason, qualificationStatus };
  }
}
