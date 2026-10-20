import { trackRunResult } from "../../runtime/runTracker.js";
import { receiptFromRunState } from "../../testing/receipts.js";
import { requestRunCancellation } from "../../testing/runState.js";
import { ApplicationRunService } from "../../navigation/applicationRunService.js";
import { resolveObservedApplication } from "../../environments/model.js";
import { selectBrowserSession } from "../session-selection.js";

/** Declarative test-run tools composed through ApplicationRunService. */
export function createWorkflowToolHandlers({
  sessions,
  testRuns,
  runStateStore,
  loadEnvironmentProfile,
  interventionContext,
  interventionStore,
  decisionRuntime,
  qualificationService,
  fileUploadGrantStore,
  verifyObservedUrl
}) {
  function startWorkflowRun({ session, workflow, environment = null, operationAuthorizer = null, runId = null, controller = new AbortController(), verifyAuthentication = null, verifyEnvironment = null, profileId = null, principalId = null, existingRunStateId = null, resumeReceipt = null } = {}) {
    const effectiveRunId = runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runCtx = {
      ...interventionContext,
      hasAttachmentGrant: async targetId => sessions.has(targetId)
        ? { ok: true }
        : { ok: false, reason: `No authorized attachment grant for target '${targetId}'.` },
      observe: async () => await session.observe().catch(() => null),
      ...(typeof verifyAuthentication === "function" ? { verifyAuthentication } : {}),
      ...(typeof verifyEnvironment === "function" ? { verifyEnvironment } : environment ? { verifyEnvironment: url => verifyObservedUrl(environment, url) } : {})
    };
    const { collector, correlator, runner, runPromise: initialRunPromise } = new ApplicationRunService({ runStateStore }).startWorkflowRun({
      session,
      workflow,
      runId: effectiveRunId,
      signal: controller.signal,
      resumeReceipt,
      resumeOptions: { verify: runCtx, workflow },
      runnerOptions: {
        interventions: interventionStore,
        decisionRuntime,
        qualificationService,
        fileUploadGrantStore,
        environment,
        operationAuthorizer,
        existingRunStateId,
        profileId,
        principalId: principalId ?? session?.principalId ?? session?.authorizationPrincipalId ?? "local_mcp_automation"
      }
    });
    const runPromise = resumeReceipt
      ? initialRunPromise.then(result => {
          if (!result.receipt) throw new Error(result.reason ?? "The durable intervention was not independently verified.");
          return result.receipt;
        })
      : initialRunPromise;
    const runState = trackRunResult(runPromise);
    testRuns.set(effectiveRunId, {
      collector, correlator, controller, runState, runPromise, session, runner, workflow, environment,
      ...(typeof verifyAuthentication === "function" ? { verifyAuthentication } : {}),
      ...(typeof verifyEnvironment === "function" ? { verifyEnvironment } : {}),
      startedAt: new Date().toISOString(),
      resume: async () => {
        if (!runState.settled) return { resumed: false, reason: "Run is still executing." };
        if (!runState.receipt) return { resumed: false, reason: "Run did not produce a receipt.", error: String(runState.error?.message ?? runState.error ?? "unknown failure").slice(0, 300) };
        runState.status = "RUNNING";
        runState.settled = false;
        try {
          const result = await runner.resume(runState.receipt, { verify: runCtx, workflow });
          if (result.receipt) runState.receipt = result.receipt;
          runState.status = runState.receipt?.status ?? "UNKNOWN";
          return result;
        } catch (error) {
          runState.status = runState.receipt?.status ?? "UNCERTAIN";
          runState.error = error;
          throw error;
        } finally {
          runState.settled = true;
        }
      },
      getState: async () => runState.status,
      cancel: async () => {
        await runStateStore.requestCancellation(effectiveRunId).catch(() => {});
        controller.abort();
      }
    });
    return { status: "started", runId: effectiveRunId };
  }

  const handlers = Object.freeze({
    start_test_run: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      if (!session) throw new Error("No attached browser session available.");
      const selectedProfile = await loadEnvironmentProfile(args.profileId);
      return startWorkflowRun({
        session,
        workflow: args.workflow,
        environment: selectedProfile?.environment ?? null,
        profileId: selectedProfile?.profile.profile_id ?? null
      });
    },

    resume_test_run: async args => {
      const state = await runStateStore.getFresh(args.runId);
      if (!state) throw new Error(`No durable test run found for runId '${args.runId}'.`);
      if (testRuns.get(args.runId)?.runState?.settled === false) throw new Error("This run already has an active worker.");
      if (["passed", "failed", "blocked", "canceled", "expired"].includes(state.status)) throw new Error(`Run is already terminal (${state.status}).`);
      const unresolved = (state.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
      if (unresolved.length) return { runId: args.runId, status: "UNCERTAIN", reason: "The DAG is suspended until every dispatched operation is independently reconciled.", operationIds: unresolved.map(operation => operation.operationId) };
      const session = sessions.get(args.targetId);
      if (!session || session.attached !== true || session.target?.id !== state.target?.targetId) {
        throw new Error("Resume requires an explicitly attached session for the exact target bound to this run.");
      }
      const selectedProfile = await loadEnvironmentProfile(args.profileId);
      const environment = selectedProfile?.environment ?? null;
      const profileId = selectedProfile?.profile.profile_id ?? null;
      const principalId = session.principalId ?? session.authorizationPrincipalId ?? "local_mcp_automation";
      const application = session.target?.url && environment
        ? resolveObservedApplication(environment, session.target.url)
        : { status: "unmatched" };
      const authenticationRealm = application.status === "matched" ? application.authenticationRealm : state.authenticationRealm ?? null;
      if ((environment?.environmentId ?? null) !== state.environmentId
        || profileId !== state.profileId
        || principalId !== state.principalId
        || authenticationRealm !== state.authenticationRealm) {
        throw new Error("The selected profile, principal, environment, or authentication realm differs from the durable run binding.");
      }
      const intervention = state.pendingInterventionId ? interventionStore.get(state.pendingInterventionId) : null;
      if (state.pendingInterventionId && (!intervention || intervention.runId !== state.runId)) {
        throw new Error("The durable intervention required by this run is missing or mismatched.");
      }
      const resumeReceipt = intervention ? receiptFromRunState(state, intervention) : null;
      return startWorkflowRun({
        session,
        workflow: args.workflow,
        environment,
        profileId,
        principalId,
        runId: args.runId,
        existingRunStateId: args.runId,
        ...(resumeReceipt ? { resumeReceipt } : {})
      });
    },

    get_test_run: async args => {
      const run = testRuns.get(args.runId);
      const durable = await runStateStore.getFresh(args.runId);
      if (!durable) throw new Error(`No test run found for runId '${args.runId}'.`);
      const receipt = receiptFromRunState(durable).toObject();
      const unresolvedOperations = (durable.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
      return {
        ...receipt,
        pendingInterventionId: durable.pendingInterventionId ?? null,
        unresolvedOperationIds: unresolvedOperations.map(operation => operation.operationId),
        cancellationRequested: durable.cancellationRequested === true,
        workerAvailable: Boolean(run)
      };
    },

    cancel_test_run: async args => {
      const run = testRuns.get(args.runId);
      const cancellation = await requestRunCancellation(runStateStore, args.runId, {
        abort: run ? () => run.controller.abort() : undefined,
        runPromise: run?.runPromise
      });
      if (!cancellation) throw new Error(`No test run found for runId '${args.runId}'.`);
      return {
        status: cancellation.requested ? "cancel_requested" : cancellation.run.status,
        runId: args.runId,
        requiresReconciliation: cancellation.requiresReconciliation
      };
    }
  });

  return Object.freeze({ handlers, startWorkflowRun });
}
