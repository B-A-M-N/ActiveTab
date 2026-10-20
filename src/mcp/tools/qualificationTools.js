import { randomUUID } from "node:crypto";
import { cloudAgentAdapterFromEnv } from "../../diagnostics/adapters/cloudAgentApi.js";
import { OPERATION } from "../../diagnostics/contracts.js";
import { prepareCloudAgentTask } from "../../integrations/freeinference/prepareCloudAgentTask.js";
import { verifyCloudAgentRunOutcome } from "../../integrations/freeinference/cloudAgentWorkflow.js";
import { eventIdsForEvidence } from "../../telemetry/evidenceRefs.js";
import { createCloudAgentEntryWorkflow, verifyCloudAgentReady } from "../../testing/cloudAgentEntry.js";
import { selectBrowserSession } from "../session-selection.js";

/** Staging qualification handlers composed from trusted MCP-owned runtime services. */
export function createQualificationToolHandlers({
  sessions, testRuns, workflowToolRuntime, loadEnvironmentProfile,
  decisionRuntime, runStateStore, verifyObservedUrl
}) {
  async function recordCloudAgentOutcome(run, submit, integration, args, outcome, backendOutcome, backendEvidenceRef) {
    const episodeId = run.runner?.decisionEpisodeId;
    let finalOutcome = outcome;
    const decisionId = submit.details?.decisionId ?? randomUUID();
    const stepId = submit.stepId;
    const evidenceRefs = [...new Set([args.browserEvidenceId, backendEvidenceRef].filter(value => typeof value === "string"))];
    const operationId = submit.details?.operationId;
    if (typeof operationId !== "string" || !operationId) {
      finalOutcome = {
        status: "UNCERTAIN",
        reasonCode: "durable_operation_identity_missing",
        reason: "The submit operation has no durable identity for outcome reconciliation."
      };
    } else {
      try {
        await runStateStore.reconcileOperation(args.runId, {
          operationId,
          status: outcome.status === "VERIFIED" ? "VERIFIED" : outcome.status === "FAILED" ? "FAILED" : "UNCERTAIN",
          evidenceIds: evidenceRefs,
          summary: outcome.reasonCode ?? outcome.reason ?? "Cloud Agent outcome reconciliation"
        });
      } catch {
        finalOutcome = {
          status: "UNCERTAIN",
          reasonCode: "durable_outcome_reconciliation_failed",
          reason: "Independent evidence was collected, but the outcome could not be durably reconciled."
        };
      }
    }
    run.cloudAgentOutcome = finalOutcome;
    let verificationEvent = null;
    try {
      if (!episodeId) throw new Error("Decision episode is unavailable.");
      verificationEvent = decisionRuntime.recordVerification({
        episodeId,
        runId: args.runId,
        stepId,
        decisionId,
        observationId: args.browserEvidenceId,
        status: finalOutcome.status === "VERIFIED" ? "verified_pass" : finalOutcome.status === "FAILED" ? "verified_fail" : "uncertain",
        oracleType: "correlated_backend",
        reasonCode: finalOutcome.reasonCode,
        evidenceRefs
      });
    } catch { /* preserve the outcome if local telemetry is unavailable */ }
    let review = null;
    try {
      if (!episodeId) throw new Error("Decision episode is unavailable.");
      const inputEventIds = eventIdsForEvidence(decisionRuntime.eventStore, {
        episodeId,
        decisionId,
        evidenceIds: [submit.details?.afterEvidenceId, args.browserEvidenceId],
        eventTypes: ["execution.observed", "verification.completed"]
      });
      if (verificationEvent?.eventId && !inputEventIds.includes(verificationEvent.eventId)) inputEventIds.push(verificationEvent.eventId);
      review = await decisionRuntime.reviewOutcome({
        episodeId,
        runId: args.runId,
        stepId,
        decisionId,
        observationId: args.browserEvidenceId,
        expectedOutcomeClass: `status_expected_${integration.expectedOutcome.value}`,
        browserOutcomeClass: "run_id_observed",
        backendOutcomeClass: backendOutcome,
        inputEventIds
      });
    } catch { /* Jev is an advisory; refusal or failure cannot alter deterministic verification. */ }
    const stepStatus = finalOutcome.status === "VERIFIED" ? "PASS" : finalOutcome.status === "FAILED" ? "FAIL" : "UNCERTAIN";
    run.runState.receipt.reconcileStep("submit-authorized-test-task", {
      status: stepStatus,
      reason: finalOutcome.reason,
      evidenceIds: evidenceRefs,
      details: {
        ...submit.details,
        verificationStatus: finalOutcome.status,
        verificationReasonCode: finalOutcome.reasonCode,
        backendRunId: args.cloudAgentRunId
      }
    });
    run.runState.status = run.runState.receipt.status;
    if (finalOutcome.status !== "UNCERTAIN" && ["PASSED", "FAILED"].includes(run.runState.receipt.status)) {
      const current = await runStateStore.getFresh(args.runId).catch(() => null);
      const unresolved = (current?.pendingOperations ?? []).some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
      if (current && !unresolved) {
        await runStateStore.update(args.runId, { status: run.runState.receipt.status.toLowerCase(), currentStepId: null }).catch(() => {});
      }
    }
    return review;
  }

  return Object.freeze({
    enter_cloud_agent: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      if (!session) throw new Error("No attached browser session available.");
      const selectedProfile = await loadEnvironmentProfile("cloud-agent-staging");
      const profile = selectedProfile?.profile;
      const environment = selectedProfile?.environment;
      if (!profile || !environment) throw new Error("The cloud-agent-staging profile is unavailable.");
      if (environment.environmentId !== "freeinference-staging") throw new Error("Cloud Agent entry is limited to the FreeInference staging environment.");
      const observation = await session.observe();
      if (!observation?.evidenceId || observation.targetId !== session.target.id || !observation.page?.url) {
        throw new Error("Cloud Agent entry requires a fresh observation from the selected attached tab.");
      }
      const identity = verifyObservedUrl(environment, observation.page.url);
      if (!identity.ok) throw new Error(`The attached tab is outside the authorized staging environment: ${identity.reason}`);
      const entry = createCloudAgentEntryWorkflow(environment, observation);
      if (!entry) throw new Error("The staging profile has no declared Cloud Agent application identity.");
      if (entry.alreadyAtComposer) {
        return {
          status: "ready",
          targetId: session.target.id,
          environmentId: environment.environmentId,
          applicationId: entry.agentEntry.applicationId,
          evidenceId: observation.evidenceId,
          taskSubmitted: false
        };
      }
      const verifyAuthentication = async realm => {
        if (realm !== entry.agentEntry.authenticationRealm) {
          return { authenticated: false, reason: `Unexpected authentication realm '${realm ?? "unknown"}'.` };
        }
        const current = await session.observe().catch(() => null);
        const ready = verifyCloudAgentReady(current, environment, entry.agentEntry.origin);
        return ready.ok
          ? { authenticated: true, identity: "Cloud Agent task composer", evidenceId: ready.evidenceId }
          : { authenticated: false, reason: ready.reason };
      };
      const started = workflowToolRuntime.startWorkflowRun({
        session,
        workflow: entry.workflow,
        environment,
        profileId: profile.profile_id,
        verifyAuthentication,
        verifyEnvironment: url => verifyObservedUrl(environment, url),
        runId: `cloud-agent-entry-${randomUUID()}`
      });
      testRuns.get(started.runId).integration = Object.freeze({
        adapterId: "freeinference-cloud-agent-entry",
        targetId: session.target.id,
        environmentId: environment.environmentId,
        applicationId: entry.agentEntry.applicationId,
        authenticationRealm: entry.agentEntry.authenticationRealm,
        taskSubmitted: false
      });
      return { ...started, targetId: session.target.id, environmentId: environment.environmentId, taskSubmitted: false };
    },
    start_cloud_agent_task: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      if (!session) throw new Error("No attached browser session available.");
      const selectedProfile = await loadEnvironmentProfile("cloud-agent-staging");
      const profile = selectedProfile?.profile;
      if (!profile) throw new Error("The cloud-agent-staging profile is unavailable.");
      const runId = `cloud-agent-${randomUUID()}`;
      const controller = new AbortController();
      const plan = await prepareCloudAgentTask({
        session, profile, request: args.request, decisionRuntime, runId, signal: controller.signal
      });
      const started = workflowToolRuntime.startWorkflowRun({
        session,
        workflow: plan.workflow,
        environment: plan.environment,
        operationAuthorizer: plan.operationAuthorizer,
        profileId: profile.profile_id,
        runId,
        controller
      });
      testRuns.get(runId).integration = Object.freeze({
        adapterId: "freeinference-cloud-agent",
        requestId: plan.requestId,
        decisionEpisodeId: plan.episodeId,
        semanticMappingDecisionId: plan.semanticMappingDecisionId,
        semanticMappingSource: plan.semanticMappingSource,
        semanticMappingEventIds: plan.semanticMappingEventIds,
        targetResolutionEventId: plan.targetResolutionEventId,
        observationId: plan.observationId,
        targetId: session.target.id,
        environmentId: plan.environment.environmentId,
        diagnosticEndpoint: plan.environment.diagnosticEndpoint ?? null,
        diagnosticTransport: plan.environment.diagnosticTransport ?? null,
        remoteTarget: plan.environment.remoteTarget ?? null,
        agentOrigin: new URL(plan.observation.page.url).origin,
        expectedOutcome: plan.expectedOutcome,
        diagnosticSources: plan.diagnosticSources,
        diagnosticEndpointBindings: plan.diagnosticEndpointBindings,
        verificationRequired: true
      });
      return { ...started, requestId: plan.requestId, verificationStatus: "pending_independent_evidence" };
    },
    collect_cloud_agent_run_evidence: async args => {
      const run = testRuns.get(args.runId);
      if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
      const integration = run.integration;
      if (integration?.adapterId !== "freeinference-cloud-agent") throw new Error("Cloud Agent run evidence can only be collected for a Cloud Agent task started by ActiveTab.");
      if (!run.runState.settled || !run.runState.receipt) throw new Error("Wait for the ActiveTab Cloud Agent workflow to finish before collecting backend evidence.");
      const submit = run.runState.receipt.steps.find(step => step.stepId === "submit-authorized-test-task");
      if (!submit || !["PASS", "UNCERTAIN"].includes(submit.status)
        || submit.details?.dispatchStatus !== "dispatched"
        || typeof submit.details?.beforeEvidenceId !== "string") {
        throw new Error("The ActiveTab receipt does not confirm a dispatched Cloud Agent submit with its pre-dispatch evidence.");
      }
      const { verifyCloudAgentRunIdentifierEvidence } = await import("../../integrations/freeinference/browserRunIdentifier.js");
      const browserMatch = verifyCloudAgentRunIdentifierEvidence({
        session: run.session,
        evidenceId: args.browserEvidenceId,
        beforeEvidenceId: submit.details.beforeEvidenceId,
        cloudAgentRunId: args.cloudAgentRunId,
        agentOrigin: integration.agentOrigin,
        startedAt: run.startedAt
      });
      if (!browserMatch.verified) throw new Error(`Cloud Agent run ID is not linked to current task evidence: ${browserMatch.reason}`);
      if (run.cloudAgentEvidenceBinding && run.cloudAgentEvidenceBinding.cloudAgentRunId !== args.cloudAgentRunId) {
        throw new Error("This ActiveTab task is already bound to a different Cloud Agent run ID.");
      }
      if (!run.cloudAgentEvidenceBinding) {
        const adapter = cloudAgentAdapterFromEnv(process.env, {
          environmentBinding: {
            environmentId: integration.environmentId,
            diagnosticEndpoint: integration.diagnosticEndpoint,
            diagnosticTransport: integration.diagnosticTransport,
            remoteTarget: integration.remoteTarget,
            diagnosticEndpointBindings: integration.diagnosticEndpointBindings
          }
        });
        if (!adapter) throw new Error("Cloud Agent backend diagnostics are not configured. Set the diagnostic endpoint and admin credential explicitly.");
        adapter.registerRunScopedSources(run.collector, {
          activeTabRunId: args.runId,
          cloudAgentRunId: args.cloudAgentRunId,
          sourceIds: integration.diagnosticSources
        });
        run.cloudAgentEvidenceBinding = {
          cloudAgentRunId: args.cloudAgentRunId,
          browserEvidenceId: args.browserEvidenceId,
          browserMatchLocation: browserMatch.location
        };
        run.cloudAgentEvidencePromise = run.collector.collectAll(integration.diagnosticSources.map(sourceId => ({
          sourceId,
          operation: OPERATION.READ_SCOPED
        })));
      } else if (run.cloudAgentEvidenceBinding.browserEvidenceId !== args.browserEvidenceId) {
        throw new Error("The exact Cloud Agent run evidence is already bound to a different browser observation.");
      }
      const results = await run.cloudAgentEvidencePromise;
      run.cloudAgentEvidenceResults = results;
      run.cloudAgentRunId = args.cloudAgentRunId;
      const runResult = results.find(result => result.sourceId === "cloud-agent-runs");
      const backendRun = runResult?.snapshot?.data?.records?.[0];
      if (runResult?.status !== "ok" || runResult.snapshot?.data?.status !== "available" || backendRun?.id !== args.cloudAgentRunId) {
        const outcome = {
          status: "UNCERTAIN",
          reasonCode: "exact_run_record_unavailable",
          reason: "The exact backend run record could not be confirmed."
        };
        run.cloudAgentOutcome = outcome;
        const review = await recordCloudAgentOutcome(run, submit, integration, args, outcome, "unavailable", null);
        return {
          runId: args.runId,
          cloudAgentRunId: args.cloudAgentRunId,
          correlation: { strength: "unknown", reason: "The exact backend run record could not be confirmed." },
          verificationStatus: outcome.status,
          verificationReason: outcome.reason,
          ...(review ? { jevReview: review } : {}),
          results
        };
      }
      const browserEventId = `browser:${args.runId}:${args.browserEvidenceId}`;
      const backendEventId = `backend:${args.runId}:${args.cloudAgentRunId}`;
      const backendEvidenceRef = runResult.snapshot.snapshotId ?? runResult.snapshot.evidenceId ?? backendEventId;
      const principalId = run.session.principalId ?? run.session.authorizationPrincipalId ?? "local_mcp_automation";
      const correlationProof = {
        namespace: "cloud-agent-run",
        value: args.cloudAgentRunId,
        pairKind: "freeinference_cloud_agent_run",
        provenance: "verified_in_browser_and_backend",
        scope: {
          environmentId: integration.environmentId,
          targetId: run.session.target.id,
          runId: args.runId,
          principalId,
          operationNamespace: "freeinference.cloud_agent.run"
        },
        evidenceRefs: [args.browserEvidenceId, backendEvidenceRef]
      };
      run.correlator.addEvent({ eventId: browserEventId, evidenceId: args.browserEvidenceId, sourceType: "browser_ui", correlation: correlationProof, observedAt: run.startedAt });
      run.correlator.addEvent({ eventId: backendEventId, evidenceId: backendEvidenceRef, sourceType: "cloud_agent_backend", correlation: correlationProof });
      const correlation = run.correlator.correlate(browserEventId, backendEventId);
      const outcome = verifyCloudAgentRunOutcome(integration.expectedOutcome, backendRun);
      run.cloudAgentCorrelation = correlation;
      run.cloudAgentOutcome = outcome;
      const review = await recordCloudAgentOutcome(run, submit, integration, args, outcome, backendRun.status ?? "unavailable", backendEvidenceRef);
      return {
        runId: args.runId,
        requestId: integration.requestId,
        cloudAgentRunId: args.cloudAgentRunId,
        correlation,
        verificationStatus: outcome.status,
        verificationReason: outcome.reason,
        ...(review ? { jevReview: review } : {}),
        results
      };
    }
  });
}
