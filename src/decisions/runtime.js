import { createHash, randomUUID } from "node:crypto";
import { DecisionEventStore } from "../telemetry/eventStore.js";
import { DecisionCoordinator } from "./decisionCoordinator.js";
import { hasReviewIntent, selectPreActionDecisionRoute } from "./callPolicy.js";
import { VisualDecisionService } from "./visualDecisionService.js";
import { defaultJevCredentialFile, JEV_MODEL_ID, JevDecisionClient, JevRequestError } from "./jevClient.js";
import { createConfiguredSemanticAnalyzer, DEFAULT_SEMANTIC_MODEL } from "../navigation/semanticAnalyzer.js";
import { DEFAULT_INFERENCE_ATTEMPT_BUDGET, InferenceAttemptBudget } from "./inferenceBudget.js";
import { isBoundVisualEvidence } from "../navigation/visualEvidence.js";

/**
 * One process-wide decision runtime shared by browser execution entrypoints.
 * Jev is always constructed as the pinned reviewer; semantic annotation uses
 * the configured OpenAI-compatible endpoint when one is available.
 */
export function createDecisionRuntime({
  eventStore = null,
  jevClient = null,
  semanticAnalyzer = undefined,
  databasePath,
  maxInferenceAttempts = DEFAULT_INFERENCE_ATTEMPT_BUDGET,
  authenticateTrainingApprover,
  jevOptions,
  semanticOptions
} = {}) {
  const store = eventStore ?? new DecisionEventStore({
    ...(databasePath ? { databasePath } : {}),
    ...(authenticateTrainingApprover ? { authenticateTrainingApprover } : {})
  });
  const inferenceBudget = new InferenceAttemptBudget({ eventStore: store, maxAttempts: maxInferenceAttempts });
  const budgetedFetch = (taskCode, fetchImpl = fetch) => inferenceBudget.wrapFetch(taskCode, fetchImpl);
  let client = jevClient;
  if (!client) {
    try {
      client = new JevDecisionClient({
        ...jevOptions,
        apiKeyFile: jevOptions?.apiKeyFile ?? defaultJevCredentialFile(),
        fetchImpl: budgetedFetch("jev_review", jevOptions?.fetchImpl ?? fetch)
      });
    }
    catch { client = { async decide() { throw new JevRequestError("configuration", "Jev reviewer configuration is unavailable."); } }; }
  }
  let analyzer = semanticAnalyzer;
  if (semanticAnalyzer === undefined) {
    try { analyzer = createConfiguredSemanticAnalyzer({ ...semanticOptions, eventStore: store, fetchImpl: budgetedFetch("semantic_inference", semanticOptions?.fetchImpl ?? fetch) }); }
    catch { analyzer = null; }
  }
  const semanticProviderId = analyzer?.providerId ?? semanticOptions?.providerId ?? process.env.ACTIVETAB_SEMANTIC_PROVIDER_ID ?? "freeinference_production";
  const semanticModel = analyzer?.model ?? semanticOptions?.model ?? process.env.ACTIVETAB_SEMANTIC_MODEL ?? DEFAULT_SEMANTIC_MODEL;
  // Image capability is availability, not a reason to capture pixels on every run.
  const requiresScreenshot = false;
  const coordinator = new DecisionCoordinator({ client, eventStore: store });
  const visualDecisionService = new VisualDecisionService({ coordinator });
  let closed = false;

  return Object.freeze({
    eventStore: store,
    jevClient: client,
    semanticAnalyzer: analyzer,
    requiresScreenshot,
    coordinator,
    visualDecisionService,
    withInferenceBudget({ runId }, callback) { return inferenceBudget.run({ runId }, callback); },
    budgetedFetch(taskCode, fetchImpl = fetch) { return budgetedFetch(taskCode, fetchImpl); },
    inferenceBudgetSnapshot(runId) { return inferenceBudget.snapshot(runId); },
    startEpisode({ episodeId, runId, workflowId, applicationId = "unknown", environmentClass = "unknown", executionMode = "agent_directed", policyVersion = "active_policy_v1", workflowKind = "browser_workflow" }) {
      const resumed = episodeId ? store.getEpisode(episodeId) : null;
      if (resumed?.run_id === runId) return { episodeId: resumed.episode_id, runId, resumed: true };
      const existing = store.getLatestEpisodeForRun(runId);
      if (existing) return { episodeId: existing.episode_id, runId, resumed: true };
      return { ...store.startEpisode({ runId, workflowId, applicationId, environmentClass, executionMode, policyVersion, workflowKind }), resumed: false };
    },
    completeEpisode({ episodeId, runId, status, cleanupStatus = "not_required" }) {
      const existing = store.getEpisode(episodeId);
      if (!existing || existing.run_id !== runId || existing.status !== "active") return null;
      return store.append({
        episodeId, runId,
        eventType: "episode.completed", trainingEligibility: "pending",
        payload: { status, cleanupStatus }
      });
    },
    async reviewBeforeAction(input) {
      const { semanticRoles, intentHints = [], ...review } = input;
      const decisionId = review.decisionId ?? randomUUID();
      let semanticUnavailable = null;
      let semantic = null;
      let semanticFailureCode = null;
      let semanticContextEventIds = [];
      let semanticEventIds = [];
      if (Array.isArray(semanticRoles) && semanticRoles.length && analyzer) {
        const visualEvidenceUsed = input.useVisualEvidence === true
          && analyzer.allowScreenshots === true
          && isBoundVisualEvidence(review.observation, review.observation?.visualEvidence);
        store.append({
          episodeId: review.episodeId, runId: review.runId, stepId: review.stepId,
          decisionId, observationId: review.observation?.evidenceId,
          eventType: "inference.route_selected", trainingEligibility: "pending",
          payload: { route: "semantic_only", reasonCode: "explicit_semantic_role_mapping", providers: ["secondary"], visualEvidenceUsed }
        });
        try {
          const annotated = await coordinator.annotateRoles({
            semanticAnalyzer: analyzer,
            requestedRoles: semanticRoles,
            intentHints,
            ...review,
            decisionId,
            ...(input.useVisualEvidence === true ? { useVisualEvidence: true } : {})
          });
          semantic = annotated.semantic;
          semanticFailureCode = annotated.semanticFailureCode;
          semanticContextEventIds = annotated.contextEventIds ?? [];
          semanticEventIds = annotated.eventIds ?? [];
        } catch (error) {
          if (!error?.kind) throw error;
          semanticFailureCode = error.kind;
        }
      } else if (Array.isArray(semanticRoles) && semanticRoles.length) {
        semanticUnavailable = coordinator.recordSemanticUnavailable({
          ...review,
          decisionId,
          requestedRoles: semanticRoles,
          analyzerProvider: semanticProviderId,
          analyzerModel: semanticModel
        });
        semanticFailureCode = "configuration";
      }
      if (Array.isArray(semanticRoles) && semanticRoles.length) {
        const uncertaintyClass = !semantic?.annotations?.length || semantic.annotations.some(annotation =>
          annotation.resultCode !== "mapped" || annotation.confidence < 0.8
        ) ? "ambiguous" : "resolved";
        const visualEvidenceAvailable = client.allowImages === true && isBoundVisualEvidence(review.observation, review.observation?.visualEvidence);
        const route = selectPreActionDecisionRoute({
          reviewRequired: input.reviewRequired === true || ["shared_mutation", "security_change"].includes(review.operationClass) || review.candidate?.submitsForm === true,
          riskClass: review.operationClass ?? "unknown",
          uncertaintyClass,
          visualEvidenceAvailable,
          reviewIntentAvailable: hasReviewIntent({ targetRole: review.targetRole, purposeCode: review.purposeCode })
        });
        store.append({
          episodeId: review.episodeId, runId: review.runId, stepId: review.stepId,
          decisionId, observationId: review.observation?.evidenceId,
          eventType: "inference.route_selected", trainingEligibility: "pending",
          payload: { ...route }
        });
        if (route.route !== "jev_only") {
          const insufficientReviewEvidence = route.reasonCode === "review_insufficient_evidence";
          coordinator.recordReviewSkipped({
            ...review,
            decisionId,
            reasonCode: insufficientReviewEvidence
              ? route.reasonCode
              : semantic ? "semantic_mapping_sufficient" : semanticFailureCode === "configuration" ? "semantic_provider_unavailable" : route.reasonCode
          });
          return {
            decisionId,
            ...(semantic ? { semantic } : {}),
            ...(semanticFailureCode ? { semanticFailureCode } : {}),
            semanticUnavailable: Boolean(semanticUnavailable),
            ...(insufficientReviewEvidence ? { evidenceStatus: "insufficient_evidence", reasonCode: route.reasonCode } : {}),
            jevSkipped: true,
            authorizesOperation: false
          };
        }
        const semanticAnnotation = semantic?.annotations?.find(annotation => annotation.semanticRole === review.targetRole)
          ?? semantic?.annotations?.[0]
          ?? null;
        try {
          const jev = await coordinator.reviewBeforeAction({
            ...review,
            decisionId,
            semanticAnnotation,
            semanticEventIds,
            inputEventIds: [...semanticContextEventIds, ...semanticEventIds],
            recordContext: false
          });
          return {
            decisionId,
            ...(semantic ? { semantic } : {}),
            ...(semanticFailureCode ? { semanticFailureCode } : {}),
            ...(semanticUnavailable ? { semanticUnavailable: true } : {}),
            jev,
            authorizesOperation: false
          };
        } catch (error) {
          if (!error?.kind) throw error;
          return {
            decisionId,
            ...(semantic ? { semantic } : {}),
            ...(semanticFailureCode ? { semanticFailureCode } : {}),
            jevFailureCode: error.kind,
            reviewer: { provider: "openrouter", model: JEV_MODEL_ID },
            authorizesOperation: false
          };
        }
      }
      try {
        const jev = await coordinator.reviewBeforeAction({
          ...review,
          decisionId,
          ...(semanticUnavailable ? { inputEventIds: semanticUnavailable.contextEventIds, recordContext: false } : {})
        });
        return {
          decisionId,
          semanticUnavailable: Boolean(semanticUnavailable),
          jev,
          ...(jev?.evidenceStatus ? { evidenceStatus: jev.evidenceStatus, reasonCode: jev.reasonCode } : {}),
          authorizesOperation: false
        };
      } catch (error) {
        if (!error?.kind) throw error;
        return {
          decisionId,
          ...(semanticUnavailable ? { semanticFailureCode: "configuration" } : {}),
          jevFailureCode: error.kind,
          reviewer: { provider: "openrouter", model: JEV_MODEL_ID },
          authorizesOperation: false
        };
      }
    },
    recordReviewSkipped(input) {
      return coordinator.recordReviewSkipped(input);
    },
    recordInferenceRoute({ episodeId, runId, stepId, decisionId, observationId, parentEventId = null, route, reasonCode, providers, visualEvidenceUsed = false }) {
      return store.append({
        episodeId,
        runId,
        stepId,
        decisionId,
        observationId,
        ...(parentEventId ? { parentEventId } : {}),
        eventType: "inference.route_selected",
        trainingEligibility: "pending",
        payload: { route, reasonCode, providers, visualEvidenceUsed }
      });
    },
    recordPlannerPrediction({ episodeId, runId, stepId, decisionId, observationId, model, goal, candidateIdentity = null, resultCode, reasonCode = null, actionType = null, inputModality = "text_only", usage = null, clientRequestId, providerLatencyMs }) {
      const usageProjection = usage && typeof usage === "object" ? {
        ...(Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? { inputTokens: usage.prompt_tokens } : {}),
        ...(Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? { outputTokens: usage.completion_tokens } : {}),
        ...(Number.isInteger(usage.total_tokens) && usage.total_tokens >= 0 ? { totalTokens: usage.total_tokens } : {})
      } : null;
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "planner.predicted", trainingEligibility: "pending",
        payload: {
          provider: "secondary",
          model,
          inputFingerprint: createHash("sha256").update(randomUUID()).update(String(goal ?? "")).update(String(observationId ?? "")).digest("hex"),
          inputModality,
          resultCode,
          ...(reasonCode ? { reasonCode } : {}),
          ...(actionType ? { actionType } : {}),
          ...(candidateIdentity ? { selectedCandidateFingerprint: createHash("sha256").update(String(observationId)).update("\0").update(String(candidateIdentity)).digest("hex") } : {}),
          ...(clientRequestId ? { clientRequestId } : {}),
          ...(Number.isInteger(providerLatencyMs) ? { providerLatencyMs } : {}),
          ...(usageProjection && Object.keys(usageProjection).length ? { usage: usageProjection } : {})
        }
      });
    },
    recordPlannerFailure({ episodeId, runId, stepId, decisionId, observationId, model, goal, failureCode, inputModality = "text_only", clientRequestId, providerLatencyMs }) {
      const safeFailureCode = new Set(["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted", "unknown"]).has(failureCode)
        ? failureCode : "unknown";
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "planner.failed", trainingEligibility: "pending",
        payload: {
          provider: "secondary",
          model,
          inputFingerprint: createHash("sha256").update(randomUUID()).update(String(goal ?? "")).update(String(observationId ?? "")).digest("hex"),
          inputModality,
          failureCode: safeFailureCode,
          ...(clientRequestId ? { clientRequestId } : {}),
          ...(Number.isInteger(providerLatencyMs) ? { providerLatencyMs } : {})
        }
      });
    },
    async annotateRoles(input) {
      if (analyzer) {
        return await coordinator.annotateRoles({ semanticAnalyzer: analyzer, ...input });
      }
      const decisionId = input?.decisionId ?? randomUUID();
      const missing = coordinator.recordSemanticUnavailable({
        ...input,
        decisionId,
        analyzerProvider: semanticProviderId,
        analyzerModel: semanticModel,
        failureCode: "configuration"
      });
      return {
        decisionId,
        semantic: null,
        semanticFailureCode: "configuration",
        contextEventIds: missing.contextEventIds,
        eventIds: missing.eventIds
      };
    },
    async reviewOutcome(input) {
      const decisionId = input?.decisionId ?? randomUUID();
      try {
        return await coordinator.reviewOutcome({ ...input, decisionId });
      } catch (error) {
        if (!error?.kind) throw error;
        return { decisionId, jevFailureCode: error.kind, reviewer: { provider: "openrouter", model: JEV_MODEL_ID }, authorizesOperation: false };
      }
    },
    async reviewWorkflowPlan(input) {
      const decisionId = input?.decisionId ?? randomUUID();
      try {
        return await coordinator.reviewWorkflowPlan({ ...input, decisionId });
      } catch (error) {
        if (!error?.kind) throw error;
        return { decisionId, status: "unavailable", failureCode: error.kind, authorizesOperation: false };
      }
    },
    recordSemanticUnavailable(input) {
      return coordinator.recordSemanticUnavailable({
        ...input,
        analyzerProvider: semanticProviderId,
        analyzerModel: semanticModel
      });
    },
    recordTargetResolution({ episodeId, runId, stepId, decisionId, observationId, resolver, roleMappings, reasonCode, evidenceRefs = [], inputEventIds = [] }) {
      return store.append({
        episodeId,
        runId,
        stepId,
        decisionId,
        observationId,
        ...(inputEventIds.length ? { parentEventId: inputEventIds.at(-1) } : {}),
        eventType: "target.resolved",
        trainingEligibility: "pending",
        payload: { resolver, roleMappings, reasonCode, evidenceRefs, inputEventIds }
      });
    },
    recordTargetLookup({ episodeId, runId, stepId, decisionId, observationId, ...lookup }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "target.lookup", trainingEligibility: "pending",
        payload: lookup
      });
    },
    recordPolicy({ episodeId, runId, stepId, decisionId, observationId, disposition, reasonCode, policyVersion = "active_policy_v1" }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "policy.adjudicated", trainingEligibility: "pending",
        payload: { disposition, reasonCode, policyVersion }
      });
    },
    reserveExecution({ episodeId, runId, stepId, decisionId, observationId, operation, targetRole, operationId }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "execution.reserved", trainingEligibility: "pending",
        payload: { operation, targetRole, operationId }
      });
    },
    recordDispatch({ episodeId, runId, stepId, decisionId, observationId, operation, targetRole, operationId, dispatchStatus }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "execution.dispatched", trainingEligibility: "pending",
        payload: { operation, targetRole, dispatchStatus, operationId }
      });
    },
    recordReconciliationRequired({ episodeId, runId, stepId, decisionId, observationId, operation, targetRole, operationId, dispatchStatus, reasonCode, observationErrorClass, observationAttempts, evidenceRefs = [] }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "execution.reconciliation_required", trainingEligibility: "pending",
        payload: { operation, targetRole, operationId, dispatchStatus, reasonCode, observationErrorClass, observationAttempts, evidenceRefs }
      });
    },
    recordObserved({ episodeId, runId, stepId, decisionId, observationId, outcomeClass, changed, evidenceRefs = [] }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "execution.observed", trainingEligibility: "pending",
        payload: { outcomeClass, changed, evidenceRefs }
      });
    },
    recordVerification({ episodeId, runId, stepId, decisionId, observationId, status, oracleType, reasonCode, verifiedCode, evidenceRefs = [] }) {
      return store.append({
        episodeId, runId, stepId, decisionId, observationId,
        eventType: "verification.completed", trainingEligibility: "pending",
        payload: { status, oracleType, reasonCode, ...(verifiedCode !== undefined ? { verifiedCode } : {}), evidenceRefs }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (typeof store.close === "function") store.close();
    }
  });
}
