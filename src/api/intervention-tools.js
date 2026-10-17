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

    async approve_operation({ interventionId, grantedBy = "human_operator", expiresInMs } = {}) {
      const record = store.get(interventionId);
      if (!record) throw new Error(`No intervention '${interventionId}'.`);
      if (typeof ctx.issueGrant !== "function") throw new Error("No approval-grant issuer is configured.");
      const grant = ctx.issueGrant({
        principal: grantedBy,
        environmentId: record.environmentId,
        authenticationRealm: record.authenticationRealm,
        resource: record.applicationId ?? record.runId,
        operation: record.completionCondition?.operation ?? record.type,
        input: record.completionCondition?.input ?? {},
        allowedEffects: record.completionCondition?.allowedEffects ?? [`${record.type}:approved`],
        ...(expiresInMs ? { expiresInMs } : {})
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
