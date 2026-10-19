import { createHash, randomUUID } from "node:crypto";
import { adjudicatePreActionReview } from "../../decisions/adjudication.js";
import { hasReviewIntent, selectPreActionDecisionRoute } from "../../decisions/callPolicy.js";
import { isBoundVisualEvidence } from "../../navigation/visualEvidence.js";
import { isWaitingRunStatus, RUN_STATUS, STEP_STATUS } from "../schema.js";
import { INTERVENTION_STATE } from "../../runtime/interventions.js";
import { resolveObservedApplication } from "../../environments/model.js";

function boundedText(value, limit = 512) {
  return typeof value === "string" ? value.trim().slice(0, limit) : null;
}

function stableUrl(value, { includeQuery = false } = {}) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${includeQuery ? url.search : ""}`;
  } catch { return boundedText(value, 2048); }
}

function stableSelector(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const selector = {};
  for (const key of ["role", "name", "tag", "type", "contextName", "text", "label"]) {
    if (typeof target[key] === "string") selector[key] = boundedText(target[key], 512);
  }
  if (typeof target.href === "string") selector.href = stableUrl(target.href);
  return Object.keys(selector).length ? selector : null;
}

function stableResource(candidate) {
  if (!candidate) return null;
  const attributes = candidate.attributes && typeof candidate.attributes === "object" ? candidate.attributes : {};
  const stableAttributes = {};
  for (const key of ["id", "name", "type", "data-testid", "aria-label"]) {
    if (typeof attributes[key] === "string") stableAttributes[key] = boundedText(attributes[key], 256);
  }
  return {
    role: boundedText(candidate.role, 128),
    tag: boundedText(candidate.tag, 64),
    kind: boundedText(candidate.kind, 64),
    name: boundedText(candidate.name, 512),
    contextName: boundedText(candidate.contextName, 512),
    type: boundedText(candidate.type, 64),
    href: stableUrl(candidate.href),
    page: stableUrl(candidate.documentUrl),
    formMethod: boundedText(candidate.formMethod, 16),
    formActionOrigin: boundedText(candidate.formActionOrigin, 512),
    attributes: stableAttributes
  };
}

function stableIntent(intent) {
  if (!intent || typeof intent !== "object") return null;
  return {
    goal: boundedText(intent.goal, 4096),
    target: stableSelector(intent.target),
    value: intent.value ?? null,
    uploadRequested: intent.uploadRequested === true,
    destination: stableUrl(intent.destination, { includeQuery: true }),
    expectedUrlPattern: boundedText(intent.expectedUrlPattern, 2048),
    postcondition: intent.postcondition ?? null,
    verifyValue: intent.verifyValue === true
  };
}

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
    const application = this.session?.target?.url && this.environment
      ? resolveObservedApplication(this.environment, this.session.target.url)
      : { status: "unmatched" };
    const environmentId = String(this.environment?.environmentId ?? "").toLowerCase();
    const environmentClass = this.environment?.environmentClass
      ?? (environmentId.includes("production") ? "production" : environmentId.includes("staging") ? "staging" : environmentId ? "local" : "unknown");
    const episode = this.decisionRuntime.startEpisode({
      ...(this.episodeId ? { episodeId: this.episodeId } : {}),
      runId: receipt.runId,
      workflowId: `workflow_${createHash("sha256").update(receipt.workflowId).digest("hex").slice(0, 16)}`,
      applicationId: application.status === "matched" ? application.applicationId : "unknown",
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

  async createHooks({ receipt, action, candidate = null, decisionContext = null, effectIntent = null, telemetryStepId = null, runtimeStepId = null } = {}) {
    if (!this.decisionRuntime && !this.runStateStore) return null;
    if (this.decisionRuntime && !this.episodeId) await this.ensureEpisode(receipt);
    const decisionId = randomUUID();
    const stepId = telemetryStepId ?? "step_unknown";
    const stateStepId = runtimeStepId ?? stepId;
    const operationId = createHash("sha256").update(`${receipt.runId}\0${stateStepId}`).digest("hex").slice(0, 40);
    const operationClass = decisionContext?.operationClass ?? (action === "navigate" ? "navigation" : "unknown");
    const targetRole = decisionContext?.targetRole ?? (candidate ? "browser_target" : "navigation_destination");
    const purposeCode = decisionContext?.purposeCode ?? null;
    const reviewRequired = decisionContext?.reviewRequired ?? (
      candidate?.submitsForm === true || ["shared_mutation", "security_change"].includes(operationClass)
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
        const matchingCandidates = (observation.candidates ?? []).filter(item =>
          item.identity !== candidate?.identity
          && item.visible === true
          && item.role === candidate?.role
          && String(item.name ?? "").trim().toLowerCase() === String(candidate?.name ?? "").trim().toLowerCase()
        );
        const route = selectPreActionDecisionRoute({
          actionAdmitted: true,
          reviewRequired,
          riskClass: operationClass,
          uncertaintyClass: matchingCandidates.length ? "ambiguous" : "resolved",
          visualEvidenceAvailable: runtime.jevClient?.allowImages === true && isBoundVisualEvidence(observation, observation.visualEvidence),
          reviewIntentAvailable: hasReviewIntent({ targetRole, purposeCode })
        });
        runtime.recordInferenceRoute({
          episodeId,
          runId: receipt.runId,
          stepId,
          decisionId,
          observationId: observation.evidenceId,
          route: route.route,
          reasonCode: route.reasonCode,
          providers: route.providers,
          visualEvidenceUsed: route.visualEvidenceUsed
        });
        let adjudication;
        if (route.route === "jev_only") {
          const review = await runtime.reviewBeforeAction({
            episodeId,
            runId: receipt.runId,
            stepId,
            decisionId,
            observation,
            operation: action,
            operationClass,
            targetRole,
            ...(purposeCode ? { purposeCode } : {}),
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
            reasonCode: route.reasonCode
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
        const effectDigest = thisRecorder.runStateStore
          ? await thisRecorder.runStateStore.fingerprintOperationEffect(receipt.runId, {
              schemaVersion: 1,
              action,
              environmentId: thisRecorder.environment?.environmentId ?? null,
              targetId,
              resource: stableResource(candidate),
              intent: stableIntent(effectIntent)
            })
          : null;
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
