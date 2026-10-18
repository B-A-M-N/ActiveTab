import { createHash, randomUUID } from "node:crypto";
import { adjudicatePreActionReview } from "../../decisions/adjudication.js";
import { isWaitingRunStatus, RUN_STATUS, STEP_STATUS } from "../schema.js";
import { INTERVENTION_STATE } from "../../runtime/interventions.js";

/**
 * Connects a declarative workflow run to decision telemetry and durable
 * operation receipts. It records decisions; it does not authorize effects.
 */
export class RunDecisionRecorder {
  constructor({ decisionRuntime = null, runStateStore = null, environment = null, session = null, signal = null, getTargetFencingToken = null } = {}) {
    this.decisionRuntime = decisionRuntime;
    this.runStateStore = runStateStore;
    this.environment = environment;
    this.session = session;
    this.signal = signal;
    this.getTargetFencingToken = getTargetFencingToken ?? (() => null);
    this.episodeId = null;
  }

  bindEpisode(episodeId) {
    this.episodeId = episodeId ?? null;
  }

  async ensureEpisode(receipt) {
    if (!this.decisionRuntime) return null;
    const environmentId = String(this.environment?.environmentId ?? "").toLowerCase();
    const environmentClass = this.environment?.environmentClass
      ?? (environmentId.includes("production") ? "production" : environmentId.includes("staging") ? "staging" : environmentId ? "local" : "unknown");
    const episode = this.decisionRuntime.startEpisode({
      ...(this.episodeId ? { episodeId: this.episodeId } : {}),
      runId: receipt.runId,
      workflowId: `workflow_${createHash("sha256").update(receipt.workflowId).digest("hex").slice(0, 16)}`,
      applicationId: this.environment?.applications?.[0]?.applicationId ?? "unknown",
      environmentClass,
      executionMode: "agent_directed",
      policyVersion: "active_policy_v1",
      workflowKind: "declarative_test"
    });
    this.episodeId = episode.episodeId;
    return episode;
  }

  completeEpisode(receipt) {
    if (!this.decisionRuntime || !this.episodeId) return;
    const status = receipt.status === RUN_STATUS.PASSED ? "passed"
      : receipt.status === RUN_STATUS.BLOCKED ? "blocked"
        : receipt.status === RUN_STATUS.UNCERTAIN ? "uncertain"
        : receipt.status === RUN_STATUS.CANCELED ? "canceled"
          : receipt.status === RUN_STATUS.WAITING_FOR_HUMAN_DECISION || isWaitingRunStatus(receipt.status) ? "suspended"
            : "failed";
    if (status === "suspended" || status === "uncertain") return;
    const cleanupStatus = receipt.cleanup.length === 0 ? "not_required"
      : receipt.cleanup.every(item => item.status === "PASS" || item.status === "verified") ? "verified"
        : receipt.cleanup.some(item => item.status === "FAIL" || item.status === "failed") ? "failed"
          : "unknown";
    this.decisionRuntime.completeEpisode({ episodeId: this.episodeId, runId: receipt.runId, status, cleanupStatus });
  }

  async createHooks({ receipt, action, candidate = null, decisionContext = null, telemetryStepId = null, runtimeStepId = null } = {}) {
    if (!this.decisionRuntime && !this.runStateStore) return null;
    if (this.decisionRuntime && !this.episodeId) await this.ensureEpisode(receipt);
    const decisionId = randomUUID();
    const stepId = telemetryStepId ?? "step_unknown";
    const stateStepId = runtimeStepId ?? stepId;
    const operationId = createHash("sha256").update(`${receipt.runId}\0${stateStepId}`).digest("hex").slice(0, 40);
    const operationClass = decisionContext?.operationClass ?? (action === "navigate" ? "navigation" : "unknown");
    const targetRole = decisionContext?.targetRole ?? (candidate ? "browser_target" : "navigation_destination");
    const reviewRequired = decisionContext?.reviewRequired ?? (
      action === "navigate" || action === "upload" || action === "toggle" || candidate?.submitsForm === true
      || (action === "click" && (candidate?.tag === "a" || candidate?.role === "link") && typeof candidate?.href === "string")
    );
    const runtime = this.decisionRuntime;
    const episodeId = this.episodeId;
    const signal = this.signal;
    const thisRecorder = this;
    let beforeEvidenceId = null;
    return {
      decisionId,
      operationId,
      stepId,
      async onAdmission({ observation } = {}) {
        if (!runtime) return { allowed: true, grantsAuthority: false, category: "deterministic_policy_only" };
        if (!observation?.evidenceId) throw new Error("The admitted operation has no fresh observation identity.");
        beforeEvidenceId = observation.evidenceId;
        let adjudication;
        if (reviewRequired) {
          const review = await runtime.reviewBeforeAction({
            episodeId,
            runId: receipt.runId,
            stepId,
            decisionId,
            observation,
            operation: action,
            operationClass,
            targetRole,
            expectedOutcomeClass: "browser_state_change",
            ...(candidate ? { candidate } : {}),
            ...(decisionContext?.semanticAnnotation ? { semanticAnnotation: decisionContext.semanticAnnotation } : {}),
            ...(decisionContext?.semanticEventIds?.length ? { semanticEventIds: decisionContext.semanticEventIds } : {}),
            signal
          });
          adjudication = adjudicatePreActionReview(review);
        } else {
          await runtime.recordReviewSkipped({
            episodeId,
            runId: receipt.runId,
            stepId,
            decisionId,
            observation,
            operation: action,
            operationClass,
            targetRole,
            expectedOutcomeClass: "browser_state_change",
            reasonCode: "policy_boundary_not_triggered"
          });
          adjudication = {
            allowed: true,
            grantsAuthority: false,
            category: "review_not_required",
            reason: null
          };
        }
        if (!adjudication.allowed) return adjudication;
        await runtime.recordPolicy({
          episodeId,
          runId: receipt.runId,
          stepId,
          decisionId,
          observationId: observation.evidenceId,
          disposition: "allow",
          reasonCode: reviewRequired ? "independent_review_admitted" : "review_not_required_by_boundary_policy"
        });
        return adjudication;
      },
      async onReserve({ observation } = {}) {
        const targetId = thisRecorder.session?.target?.id ?? null;
        const effectDigest = createHash("sha256").update(JSON.stringify({
          operationId,
          stepId: stateStepId,
          action,
          operationClass,
          environmentId: thisRecorder.environment?.environmentId ?? null,
          targetId,
          candidateIdentity: candidate?.identity ?? null,
          candidateKind: candidate?.kind ?? null,
          candidateTag: candidate?.tag ?? null
        })).digest("hex");
        if (thisRecorder.runStateStore) {
          await thisRecorder.runStateStore.reserveOperation(receipt.runId, {
            operationId,
            stepId: stateStepId,
            action,
            effectDigest,
            environmentId: thisRecorder.environment?.environmentId ?? null,
            targetId,
            targetFencingToken: thisRecorder.getTargetFencingToken() ?? null
          });
          await thisRecorder.runStateStore.update(receipt.runId, { status: "dispatching", currentStepId: stateStepId });
        }
        if (runtime) {
          await runtime.reserveExecution({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation?.evidenceId ?? beforeEvidenceId, operation: action, targetRole, operationId });
        }
        return { allowed: true };
      },
      async onDispatch({ dispatchStatus, observation } = {}) {
        const errors = [];
        if (runtime) {
          try { await runtime.recordDispatch({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: beforeEvidenceId, operation: action, targetRole, operationId, dispatchStatus }); }
          catch (error) { errors.push(error); }
        }
        if (thisRecorder.runStateStore) {
          try {
            await thisRecorder.runStateStore.recordOperationDispatch(receipt.runId, {
              operationId,
              status: dispatchStatus === "uncertain" ? "UNCERTAIN"
                : dispatchStatus === "refused" ? "REFUSED" : "DISPATCHED",
              receiptId: observation?.evidenceId ?? null
            });
          } catch (error) { errors.push(error); }
        }
        if (errors.length) throw errors[0];
      },
      async recordDenied(observation) {
        if (!runtime || !observation?.evidenceId) return;
        beforeEvidenceId = observation.evidenceId;
        await runtime.recordPolicy({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation.evidenceId, disposition: "deny", reasonCode: "authorized_executor_refused" });
      },
      async recordObserved(observation, changed, outcomeClass = "browser_state_observed") {
        if (!runtime || !observation?.evidenceId || !beforeEvidenceId) return;
        await runtime.recordObserved({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation.evidenceId, outcomeClass, changed, evidenceRefs: [beforeEvidenceId, observation.evidenceId] });
      },
      async recordVerification({ status, oracleType, reasonCode, verifiedCode, observation, evidenceIds = [] } = {}) {
        if (thisRecorder.runStateStore) {
          await thisRecorder.runStateStore.reconcileOperation(receipt.runId, {
            operationId,
            status: status === STEP_STATUS.PASS ? "VERIFIED"
              : status === STEP_STATUS.FAIL ? "FAILED" : "UNCERTAIN",
            evidenceIds,
            summary: reasonCode ?? status ?? "unresolved verification"
          });
        }
        if (runtime && typeof runtime.recordVerification === "function" && observation?.evidenceId) {
          await runtime.recordVerification({
            episodeId, runId: receipt.runId, stepId, decisionId,
            observationId: observation.evidenceId,
            status: status === STEP_STATUS.PASS ? "verified_pass"
              : status === STEP_STATUS.FAIL ? "verified_fail"
                : status === STEP_STATUS.CANCELED ? "not_run" : "uncertain",
            oracleType: oracleType ?? "unavailable",
            reasonCode: reasonCode ?? "verification_unresolved",
            ...(verifiedCode !== undefined ? { verifiedCode } : {}),
            evidenceRefs: [...new Set([beforeEvidenceId, ...evidenceIds].filter(Boolean))]
          });
        }
        return true;
      }
    };
  }
}
