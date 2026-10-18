/**
 * Intervention tools (P0-6) shared by the MCP server and the local API.
 *
 * Semantics:
 *  - acknowledge_human_action: "the operator believes the requested action
 *    is complete". It does NOT resume execution.
 *  - resume_run: verifies the exact completion predicate (authorization
 *    grant scope/expiry, authenticated session, broker attachment grant,
 *    or outcome reconciliation) before admitting execution.
 *  - Status/cancellation tools work on long-running and suspended runs.
 */

import { externalRunState, INTERVENTION_STATE, INTERVENTION_TYPE } from "../runtime/interventions.js";

export function createInterventionTools({ store, runs = new Map(), runStateStore = null, ctx = {} }) {
  if (!store) throw new Error("Intervention tools require an InterventionStore.");

  return {
    async list_pending_interventions() {
      await store.expireStale();
      return {
        interventions: store.listPending().map(record => ({
          interventionId: record.intervention_id,
          runId: record.runId,
          stepId: record.stepId,
          type: record.type,
          state: record.state,
          revision: record.revision,
          reason: record.reason,
          requiredHumanAction: record.requiredHumanAction,
          completionCondition: record.completionCondition,
          environmentId: record.environmentId,
          authenticationRealm: record.authenticationRealm,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt
        }))
      };
    },

    async get_pending_intervention({ interventionId }) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      return { intervention: record, externalRunState: externalRunState(record) };
    },

    /** Acknowledgement only — satisfaction is verified separately on resume. */
    async acknowledge_human_action({ interventionId }) {
      const record = await store.acknowledge(interventionId);
      return {
        interventionId: record.intervention_id,
        state: record.state,
        message: "Acknowledged. Execution resumes only when the completion condition is verified."
      };
    },

    async request_operation_approval({ interventionId } = {}) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      if (record.type !== INTERVENTION_TYPE.HUMAN_APPROVAL || record.completionCondition?.type !== "approval_grant") {
        throw new Error("This intervention does not contain a scoped operation-approval request.");
      }
      if (record.approvalResolution || (record.state !== INTERVENTION_STATE.WAITING && record.state !== INTERVENTION_STATE.ACKNOWLEDGED)) {
        throw new Error("This approval request is no longer pending.");
      }
      const condition = record.completionCondition;
      // Agent-callable: creates a pending approval request only. It never
      // issues authority; resolution requires an independently authenticated
      // operator channel.
      return {
        interventionId,
        requestId: record.intervention_id,
        expectedRevision: record.revision,
        status: "pending_approval",
        operation: condition.operation ?? null,
        effects: Array.isArray(condition.allowedEffects) ? [...condition.allowedEffects] : [],
        resource: condition.resource ?? record.applicationId ?? null,
        environmentId: record.environmentId,
        authenticationRealm: record.authenticationRealm,
        reason: record.reason,
        reversible: typeof condition.reversible === "boolean" ? condition.reversible : null,
        message: "Approval requested. Resolve this exact revision through an independently authenticated operator channel; this client cannot issue grants."
      };
    },

    async resolve_operation_approval({ interventionId, authenticatedOperator, decision = "approve", expectedRevision = null } = {}) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      if (!authenticatedOperator || typeof authenticatedOperator !== "string") {
        throw new Error("Operator authentication is required to resolve an approval.");
      }
      if (record.type !== INTERVENTION_TYPE.HUMAN_APPROVAL || record.completionCondition?.type !== "approval_grant") {
        throw new Error("This intervention does not contain a scoped operation-approval request.");
      }
      const condition = record.completionCondition;
      if (decision !== "approve" && decision !== "reject") throw new Error("Approval decision must be approve or reject.");
      let resource = null;
      if (decision === "approve") {
        if (typeof condition.operation !== "string" || !condition.operation ||
            !Array.isArray(condition.allowedEffects) || condition.allowedEffects.length === 0 ||
            condition.allowedEffects.some(effect => typeof effect !== "string" || !effect) ||
            typeof condition.inputHash !== "string" || condition.inputHash.length !== 64) {
          throw new Error("Approval request lacks an exact operation, effect, or structured input binding.");
        }
        resource = condition.resource ?? record.applicationId ?? record.runId;
        if (typeof resource !== "string" || !resource) throw new Error("Approval request lacks an exact resource binding.");
        if (typeof ctx.issueGrant !== "function") throw new Error("No approval-grant issuer is configured.");
      }

      const reserved = await store.reserveApprovalResolution(interventionId, expectedRevision, authenticatedOperator, decision);
      if (decision === "reject") {
        return { interventionId, requestId: record.intervention_id, state: reserved.state, decision: "rejected", revision: reserved.revision };
      }

      let grant;
      try {
        grant = await ctx.issueGrant({
          principal: authenticatedOperator,
          environmentId: record.environmentId,
          authenticationRealm: record.authenticationRealm,
          resource,
          operation: condition.operation,
          inputHash: condition.inputHash,
          allowedEffects: condition.allowedEffects
        });
        const completed = await store.completeApprovalResolution(interventionId, reserved.revision, grant);
        return { interventionId, requestId: record.intervention_id, grantId: grant.grantId, expiresAt: grant.expiresAt, state: grant.state, revision: completed.revision };
      } catch (error) {
        if (grant?.grantId && typeof ctx.revokeGrant === "function") ctx.revokeGrant(grant.grantId);
        throw error;
      }
    },

    async reject_operation({ interventionId, reason = "rejected by operator" } = {}) {
      const record = await store.cancel(interventionId);
      return { interventionId: record.intervention_id, state: record.state, reason };
    },

    /**
     * Resume a run: acquire continuation ownership, verify the exact
     * completion predicate with fresh evidence, then admit execution.
     */
    async resume_run({ interventionId } = {}) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      const run = runs.get(record.runId);
      if (!run || typeof run.resume !== "function") {
        return {
          resumed: false,
          interventionId,
          runId: record.runId,
          stepId: record.stepId,
          state: record.state,
          reason: "No live continuation owner is available; the intervention remains pending."
        };
      }
      // TestRunner.resume is the sole continuation-lease owner. It evaluates
      // the exact predicate, commits satisfaction, and resumes the original
      // workflow under the same fencing lease.
      const result = await run.resume(record);
      const current = store.get(interventionId);
      const runStatus = typeof run.getState === "function" ? await run.getState() : result.receipt?.status ?? null;
      return {
        resumed: result.resumed === true,
        interventionId,
        runId: record.runId,
        stepId: record.stepId,
        state: current?.state ?? record.state,
        ...(runStatus ? { runStatus } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.evaluation?.summary ? { summary: result.evaluation.summary } : {}),
        ...(result.expired ? { expired: true } : {})
      };
    },

    async get_run_state({ runId }) {
      const run = runs.get(runId);
      if (!run) {
        const durable = await runStateStore?.getFresh(runId);
        if (durable) {
          const unresolvedOperations = (durable.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
          return {
            runId,
            state: durable.status,
            currentStepId: durable.currentStepId ?? null,
            pendingInterventionId: durable.pendingInterventionId ?? null,
            unresolvedOperationIds: unresolvedOperations.map(operation => operation.operationId),
            cancellationRequested: durable.cancellationRequested === true,
            resumable: !["passed", "failed", "blocked", "canceled", "expired"].includes(durable.status)
          };
        }
        // Fall back to durable interventions for suspended runs.
        const interventions = store.listForRun(runId);
        if (interventions.length === 0) throw new Error(`No run '${runId}' is known.`);
        const pending = interventions.find(i => i.state === "waiting_for_human" || i.state === "acknowledged");
        return {
          runId,
          state: pending ? externalRunState(pending) : "unknown",
          pendingInterventionId: pending?.intervention_id ?? null,
          resumable: Boolean(pending)
        };
      }
      const state = typeof run.getState === "function" ? await run.getState() : run.state ?? null;
      return { runId, state, ...(state ? { resumable: String(state).startsWith("waiting_for") } : {}) };
    },

    async cancel_run({ runId, interventionId }) {
      if (interventionId) {
        const record = await store.cancel(interventionId);
        return { canceled: true, interventionId: record.intervention_id, state: record.state };
      }
      const run = runs.get(runId);
      if (!run) {
        const durable = await runStateStore?.getFresh(runId);
        if (!durable) throw new Error(`No run '${runId}' is known.`);
        await runStateStore.requestCancellation(runId);
        const unresolved = (durable.pendingOperations ?? []).some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
        return { canceled: true, runId, cancellationRequested: true, requiresReconciliation: unresolved };
      }
      if (typeof run.cancel === "function") await run.cancel();
      return { canceled: true, runId };
    }
  };
}
