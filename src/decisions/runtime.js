import { randomUUID } from "node:crypto";
import { DecisionEventStore } from "../telemetry/eventStore.js";
import { DecisionCoordinator } from "./decisionCoordinator.js";
import { JEV_MODEL_ID, JevDecisionClient, JevRequestError } from "./jevClient.js";
import { createConfiguredSemanticAnalyzer, DEFAULT_SEMANTIC_MODEL } from "../navigation/semanticAnalyzer.js";

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
  authenticateTrainingApprover,
  jevOptions,
  semanticOptions
} = {}) {
  const store = eventStore ?? new DecisionEventStore({
    ...(databasePath ? { databasePath } : {}),
    ...(authenticateTrainingApprover ? { authenticateTrainingApprover } : {})
  });
  let client = jevClient;
  if (!client) {
    try { client = new JevDecisionClient(jevOptions); }
    catch { client = { async decide() { throw new JevRequestError("configuration", "Jev reviewer configuration is unavailable."); } }; }
  }
  let analyzer = semanticAnalyzer;
  if (semanticAnalyzer === undefined) {
    try { analyzer = createConfiguredSemanticAnalyzer({ eventStore: store, ...semanticOptions }); }
    catch { analyzer = null; }
  }
  const semanticProviderId = analyzer?.providerId ?? semanticOptions?.providerId ?? process.env.ACTIVETAB_SEMANTIC_PROVIDER_ID ?? "freeinference_production";
  const semanticModel = analyzer?.model ?? semanticOptions?.model ?? process.env.ACTIVETAB_SEMANTIC_MODEL ?? DEFAULT_SEMANTIC_MODEL;
  const coordinator = new DecisionCoordinator({ client, eventStore: store });
  let closed = false;

  return Object.freeze({
    eventStore: store,
    jevClient: client,
    semanticAnalyzer: analyzer,
    coordinator,
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
      if (analyzer && Array.isArray(input.semanticRoles) && input.semanticRoles.length) {
        const { semanticRoles, intentHints, ...review } = input;
        try {
          return await coordinator.mapAndReviewBeforeAction({ semanticAnalyzer: analyzer, requestedRoles: semanticRoles, intentHints, ...review });
        } catch (error) {
          if (!error?.kind) throw error;
          return { decisionId: review.decisionId, semanticFailureCode: null, jevFailureCode: error.kind, authorizesOperation: false };
        }
      }
      const { semanticRoles, intentHints: _intentHints, ...review } = input;
      const decisionId = review.decisionId ?? randomUUID();
      let semanticUnavailable = null;
      if (Array.isArray(semanticRoles) && semanticRoles.length) {
        semanticUnavailable = coordinator.recordSemanticUnavailable({
          ...review,
          decisionId,
          requestedRoles: semanticRoles,
          analyzerProvider: semanticProviderId,
          analyzerModel: semanticModel
        });
      }
      try {
        const jev = await coordinator.reviewBeforeAction({
          ...review,
          decisionId,
          ...(semanticUnavailable ? { inputEventIds: semanticUnavailable.contextEventIds, recordContext: false } : {})
        });
        return { decisionId, semanticUnavailable: Boolean(semanticUnavailable), jev, authorizesOperation: false };
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
