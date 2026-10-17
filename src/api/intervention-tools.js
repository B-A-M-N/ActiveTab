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

import { evaluateCompletion, externalRunState } from "../runtime/interventions.js";

export function createInterventionTools({ store, runs = new Map(), ctx = {} }) {
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
      // Agent-callable: creates a pending approval request only. It never
      // issues authority; resolution requires an independently authenticated
      // operator channel.
      return {
        interventionId,
        status: "pending_approval",
        message: "Approval requested. Resolve via an independently authenticated operator channel; this client cannot issue grants."
      };
    },

    async resolve_operation_approval({ interventionId, authenticatedOperator, decision = "approve", expectedRevision = null } = {}) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      if (!authenticatedOperator || typeof authenticatedOperator !== "string") {
        throw new Error("Operator authentication is required to resolve an approval.");
      }
      if (decision !== "approve") {
        const canceled = await store.cancel(interventionId);
        return { interventionId, state: canceled.state, decision: "rejected" };
      }
      if (typeof ctx.issueGrant !== "function") throw new Error("No approval-grant issuer is configured.");
      const grant = ctx.issueGrant({
        principal: authenticatedOperator,
        environmentId: record.environmentId,
        authenticationRealm: record.authenticationRealm,
        resource: record.applicationId ?? record.runId,
        operation: record.completionCondition?.operation ?? record.type,
        input: record.completionCondition?.input ?? {},
        allowedEffects: record.completionCondition?.allowedEffects ?? [`${record.type}:approved`]
      });
      return { interventionId, grantId: grant.grantId, expiresAt: grant.expiresAt, state: grant.state };
    },

    async reject_operation({ interventionId, reason = "rejected by operator" } = {}) {
      const record = await store.cancel(interventionId);
      return { interventionId: record.intervention_id, state: record.state, reason };
    },

    /**
     * Resume a run: acquire continuation ownership, verify the exact
     * completion predicate with fresh evidence, then admit execution.
     */
    async resume_run({ interventionId, verify = {} } = {}) {
      const { record, lease } = await store.acquireResume(interventionId);
      try {
        const evaluation = await evaluateCompletion(record, { ...ctx, intervention: record, ...verify });
        if (!evaluation.satisfied) {
          await store.releaseResume(interventionId, lease);
          return {
            resumed: false,
            interventionId,
            state: record.state,
            reason: `Completion condition not verified: ${evaluation.reason}`
          };
        }
        const satisfied = await store.completeResume(interventionId, lease, { evidenceId: evaluation.evidenceId ?? null, note: evaluation.summary });
        const run = runs.get(record.runId);
        if (run && typeof run.resume === "function") {
          await run.resume(satisfied);
        }
        return {
          resumed: true,
          interventionId,
          runId: record.runId,
          stepId: record.stepId,
          state: satisfied.state,
          verifiedBy: record.completionCondition?.type,
          summary: evaluation.summary
        };
      } catch (error) {
        await store.releaseResume(interventionId, lease).catch(() => {});
        throw error;
      }
    },

    async get_run_state({ runId }) {
      const run = runs.get(runId);
      if (!run) {
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
      if (!run) throw new Error(`No run '${runId}' is known.`);
      if (typeof run.cancel === "function") await run.cancel();
      return { canceled: true, runId };
    }
  };
}
