/**
 * ActiveTab Local API Server — routing and composition only.
 *
 * Responsibilities live in focused modules:
 * - Task persistence & interruption reconciliation: ./task-store.js
 * - Run workers & terminal-state translation:  ./run-lifecycle.js
 * - Host/Origin/bearer-token security:          ./security.js
 * - Template registry, input validation, goals: ./templates.js
 * - Redacted input projections:                 ./input-projection.js
 * - HTTP helpers:                               ./http-utils.js
 * - Local navigation execution:                 ./navigation-runner.js
 * - Remote (LAN peer) execution:                ../runtime/remote-executor.js
 * - Endpoint-family handlers:                   ./routes/
 *
 * The BrowserAct V3-shaped routes are an optional, compatibility-only
 * adapter over the native run lifecycle; template and bot runs share one
 * real execution path, and the peer endpoint forwards redacted requests
 * to a LAN executor node.
 */
import http from "node:http";
import { join, resolve } from "node:path";
import { TaskStore } from "./task-store.js";
import { RunLifecycle } from "./run-lifecycle.js";
import { checkHost, checkOrigin, createMutationAuthorizer, createOperatorAuthenticator } from "./security.js";
import { OFFICIAL_TEMPLATES, REGIONS, findTemplate, validateInput, renderGoal, buildPageDataExtractionWorkflow } from "./templates.js";
import { projectInput } from "./input-projection.js";
import { sendJson, sendError, readBody, parseQuery } from "./http-utils.js";
import { createDiagnostics } from "../runtime/diagnostics.js";
import { logger } from "../runtime/logger.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../diagnostics/contracts.js";
import { DiagnosticReport, FINDING_LEVEL, deriveRunInvestigationStatus } from "../diagnostics/report.js";
import { receiptFromRunState } from "../testing/receipts.js";
import { resolveObservedApplication } from "../environments/model.js";
import { buildDurableRunReport } from "../testing/durableRunReport.js";
import { RunStateStore, requestRunCancellation } from "../testing/runState.js";
import { ApplicationRunService } from "../navigation/applicationRunService.js";
import { InterventionStore } from "../runtime/interventions.js";
import { createInterventionTools } from "./intervention-tools.js";
import { AuthorizationGrantStore } from "../runtime/approvals.js";
import { trackRunResult } from "../runtime/runTracker.js";
import { randomUUID } from "node:crypto";
import { createQualificationRuntime } from "../testing/qualificationRuntime.js";
import { projectExtractionOutputs } from "../extraction/outputRelease.js";
import { EvidenceReleaseGrantStore } from "../runtime/evidenceReleaseGrants.js";
import { stateDirectory } from "../extension/paths.js";
import { RunLocalPublicReadApprovalBroker } from "../capabilities/publicReadApprovalBroker.js";
import { FileUploadGrantStore } from "../runtime/fileUploadGrants.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createCapabilityRoutes } from "./routes/capabilities.js";
import { createInterventionRoutes } from "./routes/interventions.js";
import { createPublicReadApprovalRoutes } from "./routes/publicReadApprovals.js";
import { createEvidenceReleaseRoutes } from "./routes/evidenceReleases.js";
import { createTestRunRoutes } from "./routes/testRuns.js";
import { createLegacyRunRoutes } from "./routes/legacyRuns.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createRunExecutionHandlers } from "./routes/runExecution.js";
import { createOutputFileHandler } from "./outputFileHandler.js";
import { createShutdownCoordinator } from "./shutdownCoordinator.js";

const DEFAULT_PORT = 9377;
const API_PREFIX = "/v3/bots";
const MAX_TASK_RECORDS = 1_000;
// Terminal states exclude human-handoff/waiting states: those are
// resumable suspensions (P0-3), and status reads on them must not report
// the run as finished.
const TERMINAL = new Set(["finished", "failed", "canceled"]);

export function createApiServer({ port = DEFAULT_PORT, taskStoreDir, discoveryKnowledgeDir = join(stateDirectory(), "discovery-knowledge"), discoveryEnvironment = null, discoveryPrincipalId = null, navigationRunner, decisionRuntime = null, qualificationService = null, capabilityRegistry = null, capabilityService = null, authorizeExtractionField = null, authorizeExtractionRelease = null, apiToken, operatorToken = process.env.ACTIVETAB_OPERATOR_TOKEN ?? null, operatorId = process.env.ACTIVETAB_OPERATOR_ID ?? null, operatorAuthenticator = null, evidenceReleaseStore: suppliedEvidenceReleaseStore = null, evidenceReleaseDatabasePath = process.env.ACTIVETAB_EVIDENCE_RELEASE_DB ?? join(stateDirectory(), "evidence-releases.sqlite"), fileUploadGrantStore: suppliedFileUploadGrantStore = null, interventionStore: suppliedInterventionStore = null, publicReadApprovalBroker = null, host = "127.0.0.1", maxTasks = MAX_TASK_RECORDS, shutdownTimeoutMs = 10_000, executorName, reportDir, testSessionResolver = null, testEnvironmentResolver = null, testProfileIdResolver = null, testPrincipalResolver = null, runStateStore: suppliedRunStateStore = null } = {}) {
  const configuredKnowledgeDir = resolve(discoveryKnowledgeDir);
  const maxTaskRecords = Number.isInteger(maxTasks) && maxTasks >= 1 ? Math.min(maxTasks, 10_000) : MAX_TASK_RECORDS;
  const store = new TaskStore(taskStoreDir ?? join(process.cwd(), ".activetab", "tasks"), { maxRecords: maxTaskRecords });
  const lifecycle = new RunLifecycle({ store, navigationRunner, executorName, reportDir });
  const token = apiToken ?? process.env.ACTIVETAB_API_TOKEN ?? null;
  const authorizeMutation = createMutationAuthorizer(token);
  const authenticateOperator = operatorAuthenticator ?? createOperatorAuthenticator(operatorToken, operatorId);
  let evidenceReleaseStore = suppliedEvidenceReleaseStore;
  let ownsEvidenceReleaseStore = false;
  function getEvidenceReleaseStore() {
    if (!evidenceReleaseStore) {
      evidenceReleaseStore = new EvidenceReleaseGrantStore({ databasePath: evidenceReleaseDatabasePath });
      ownsEvidenceReleaseStore = true;
    }
    return evidenceReleaseStore;
  }
  const diagnostics = createDiagnostics();
  const runQualificationService = qualificationService ?? createQualificationRuntime({ decisionRuntime });
  const testRuns = new Map();
  const ownsRunStateStore = !suppliedRunStateStore;
  const runStateStore = suppliedRunStateStore ?? new RunStateStore(
    process.env.ACTIVETAB_RUN_STATE_DIR ?? join(taskStoreDir ?? join(process.cwd(), ".activetab", "tasks"), "..", "runs")
  );
  const fileUploadGrantStore = suppliedFileUploadGrantStore ?? new FileUploadGrantStore({
    stagingDirectory: join(taskStoreDir ?? join(process.cwd(), ".activetab", "tasks"), "..", "uploads"),
    trustedIssuer: "activetab-api"
  });
  const applicationRunService = new ApplicationRunService({ runStateStore });
  let runStateStoreReady = null;
  const interventionStore = suppliedInterventionStore ?? new InterventionStore(join(taskStoreDir ?? join(process.cwd(), ".activetab", "tasks"), "..", "interventions"));
  let interventionStoreReady = null;
  async function ensureInterventionStoreReady() {
    interventionStoreReady ??= Promise.resolve().then(() => interventionStore.init());
    try { await interventionStoreReady; }
    catch (cause) {
      const error = Object.assign(new Error("Durable intervention storage is unavailable."), {
        code: "intervention_store_unavailable", cause
      });
      throw error;
    }
  }
  const grantStore = new AuthorizationGrantStore({ trustedIssuer: process.env.ACTIVETAB_TRUSTED_ISSUER ?? "activetab-api" });
  const interventionTools = createInterventionTools({
    store: interventionStore,
    runs: testRuns,
    runStateStore,
    ctx: {
      grantStore,
      issueGrant: (...args) => grantStore.issue(...args),
      revokeGrant: grantId => grantStore.revoke(grantId)
    }
  });
  let shuttingDown = false;
  let resourceClosePromise = null;

  function closeOwnedResources() {
    resourceClosePromise ??= Promise.resolve().then(() => {
      decisionRuntime?.close();
      if (ownsEvidenceReleaseStore) evidenceReleaseStore?.close();
      if (ownsRunStateStore) runStateStore.close();
    });
    return resourceClosePromise;
  }

  function rejectIfShuttingDown(res) {
    if (!shuttingDown) return false;
    sendError(res, 503, 99503, "The API server is shutting down.");
    return true;
  }

  function createTestVerificationContext(session) {
    return {
      observe: async intervention => {
        if (intervention?.targetId && session.target?.id !== intervention.targetId) return null;
        return await session.observe().catch(() => null);
      },
      hasAttachmentGrant: async targetId => {
        if (session.target?.id !== targetId || typeof session.hasAttachmentGrant !== "function") return { ok: false, reason: "No independently verified attachment grant for the intervention target." };
        return await session.hasAttachmentGrant(targetId);
      },
      verifyAuthentication: async (realm, intervention) => {
        if (intervention?.targetId && session.target?.id !== intervention.targetId) return { authenticated: false, reason: "The authenticated target does not match the suspended run." };
        if (typeof session.verifyAuthentication !== "function") return { authenticated: false, reason: "No authenticated-session verifier is bound to this run." };
        return await session.verifyAuthentication(realm, intervention);
      },
      verifyEnvironment: async (url, intervention) => {
        if (intervention?.targetId && session.target?.id !== intervention.targetId) return { ok: false, reason: "The observed target does not match the suspended run." };
        if (typeof session.verifyEnvironment !== "function") return { ok: false, reason: "No environment verifier is bound to this run." };
        return await session.verifyEnvironment(url, intervention);
      },
      verifyApprovalGrant: async (grantId, intervention) => {
        const condition = intervention?.completionCondition;
        const effects = condition?.allowedEffects;
        const operatorId = intervention?.approvalResolution?.operatorId;
        if (!Array.isArray(effects) || effects.length === 0 || !operatorId || !condition?.inputHash) return { ok: false, reason: "The exact approval scope is unavailable." };
        return grantStore.verify(grantId, {
          principal: operatorId,
          environmentId: intervention.environmentId,
          authenticationRealm: intervention.authenticationRealm,
          resource: condition.resource ?? intervention.applicationId ?? intervention.runId,
          operation: condition.operation,
          inputHash: condition.inputHash,
          effect: effects[0]
        });
      }
    };
  }

  async function resolveTestRunBinding(req, workflow, session, continuation = null) {
    let environment = null;
    let profileId = null;
    let principalId = "local_api_automation";
    const resolverContext = { workflow, session, ...(continuation ? { continuation } : {}) };
    if (typeof testEnvironmentResolver === "function") environment = await testEnvironmentResolver(resolverContext);
    if (typeof testProfileIdResolver === "function") profileId = await testProfileIdResolver({ ...resolverContext, environment });
    if (typeof testPrincipalResolver === "function") principalId = await testPrincipalResolver({ req, ...resolverContext }) ?? null;
    if (environment !== null && (!environment || typeof environment !== "object")) throw new Error("Environment resolver did not return a verified binding.");
    if (profileId !== null && typeof profileId !== "string") throw new Error("Profile resolver did not return a stable profile identifier.");
    if (principalId !== null && typeof principalId !== "string") throw new Error("Principal resolver did not return a stable principal identifier.");
    return { environment, profileId, principalId };
  }

  async function ensureRunStateStore() {
    runStateStoreReady ??= runStateStore.init();
    await runStateStoreReady;
  }

  function installTestRun({ runId, session, workflow, binding, controller, collector, correlator, runner, runPromise, runCtx }) {
    const runState = trackRunResult(runPromise);
    const runRecord = {
      runId, collector, correlator, controller, runPromise, runState, settlement: runState.completion, session, runner, workflow, binding,
      startedAt: new Date().toISOString(),
      resume: async () => {
        if (shuttingDown) return { resumed: false, reason: "The API server is shutting down." };
        if (!runState.settled) return { resumed: false, reason: "Run is still executing." };
        if (!runState.receipt) return { resumed: false, reason: "Run did not produce a receipt." };
        runState.status = "RUNNING";
        runState.settled = false;
        const resumption = (async () => {
          try {
            const result = await runner.resume(runState.receipt, { verify: runCtx, workflow });
            if (result.receipt) runState.receipt = result.receipt;
            runState.status = runState.receipt?.status ?? "UNKNOWN";
            return result;
          } catch (error) {
            runState.status = runState.receipt?.status ?? "UNCERTAIN";
            runState.error = error;
            throw error;
          } finally { runState.settled = true; }
        })();
        runRecord.runPromise = resumption;
        runRecord.settlement = resumption.then(() => undefined, () => undefined);
        runState.completion = runRecord.settlement;
        return await resumption;
      },
      getState: async () => runState.status,
      getVerificationContext: () => runCtx,
      cancel: async () => {
        await runStateStore.requestCancellation(runId);
        controller.abort();
      }
    };
    testRuns.set(runId, runRecord);
    return runState;
  }

  async function handleStartTestRun(req, res) {
    if (rejectIfShuttingDown(res)) return;
    const body = await readBody(req);
    const workflow = body?.workflow && structuredClone(body.workflow);
    if (!workflow || typeof workflow !== "object" || !workflow.id || !Array.isArray(workflow.steps)) {
      sendError(res, 400, 99001, "workflow with id and steps is required.");
      return;
    }
    let session = null;
    if (typeof testSessionResolver === "function") {
      try { session = await testSessionResolver({ workflow, input: body?.input ?? {} }); } catch { session = null; }
    } else if (typeof body?.session === "object" && typeof body.session.observe === "function") {
      session = body.session;
    }
    if (!session || typeof session !== "object" || typeof session.observe !== "function" || typeof session.client?.send !== "function") {
      sendError(res, 400, 99002, "An attached browser session is required for test runs.");
      return;
    }
    try { await ensureRunStateStore(); }
    catch (error) {
      sendError(res, 503, 99503, `Durable run-state storage is unavailable: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    let binding;
    try {
      binding = await resolveTestRunBinding(req, workflow, session);
    } catch (error) {
      sendError(res, 400, 99003, `Test-run identity or environment could not be verified: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    if (rejectIfShuttingDown(res)) return;
    const runId = `test-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const { collector, correlator, runner, runPromise } = applicationRunService.startWorkflowRun({
      session,
      workflow,
      runId,
      signal: controller.signal,
      runnerOptions: {
        interventions: interventionStore,
        decisionRuntime,
        qualificationService: runQualificationService,
        capabilityRegistry,
        capabilityService,
        fileUploadGrantStore,
        authorizeExtractionField,
        authorizeExtractionRelease,
        ...binding
      }
    });
    const runCtx = createTestVerificationContext(session);
    installTestRun({ runId, session, workflow, binding, controller, collector, correlator, runner, runPromise, runCtx });
    sendJson(res, 200, { status: "started", runId });
  }

  async function handleResumeTestRun(req, res, runId) {
    if (rejectIfShuttingDown(res)) return;
    const body = await readBody(req) ?? {};
    const workflow = body?.workflow && structuredClone(body.workflow);
    if (!workflow || typeof workflow !== "object" || !workflow.id || !Array.isArray(workflow.steps)) {
      sendError(res, 400, 99001, "The exact original workflow is required to resume a durable run.");
      return;
    }
    try { await ensureRunStateStore(); }
    catch (error) { sendError(res, 503, 99503, `Durable run-state storage is unavailable: ${String(error?.message ?? error).slice(0, 200)}`); return; }
    const state = await runStateStore.getFresh(runId);
    if (!state) { sendError(res, 404, 99404, `No durable test run found for runId '${runId}'.`); return; }
    const existing = testRuns.get(runId);
    if (existing && !existing.runState.settled) { sendError(res, 409, 99409, "The run already has an active local worker."); return; }
    if (["passed", "failed", "blocked", "canceled", "expired"].includes(state.status)) {
      sendError(res, 409, 99409, `Run is already terminal (${state.status}).`);
      return;
    }
    const unresolved = (state.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
    if (unresolved.length) {
      sendJson(res, 409, { runId, status: "UNCERTAIN", reason: "An operation is awaiting independent reconciliation; workflow dispatch is suspended.", operationIds: unresolved.map(operation => operation.operationId) });
      return;
    }
    let session = null;
    if (typeof testSessionResolver === "function") {
      try {
        session = await testSessionResolver({
          workflow,
          input: body?.input ?? {},
          continuation: { runId, targetId: state.target?.targetId ?? null, environmentId: state.environmentId, profileId: state.profileId, principalId: state.principalId }
        });
      } catch { session = null; }
    }
    if (!session || typeof session.observe !== "function" || typeof session.client?.send !== "function"
      || session.attached !== true || session.target?.id !== state.target?.targetId) {
      sendError(res, 409, 99409, "Resume requires a fresh attachment to the exact browser target bound to this run.");
      return;
    }
    let binding;
    try {
      binding = await resolveTestRunBinding(req, workflow, session, state);
      const application = session.target?.url && binding.environment
        ? resolveObservedApplication(binding.environment, session.target.url)
        : { status: "unmatched" };
      const authenticationRealm = application.status === "matched" ? application.authenticationRealm : state.authenticationRealm ?? null;
      if ((binding.environment?.environmentId ?? null) !== state.environmentId
        || (binding.profileId ?? null) !== state.profileId
        || (binding.principalId ?? null) !== state.principalId
        || authenticationRealm !== state.authenticationRealm) {
        throw new Error("The resolved environment, profile, principal, or authentication realm differs from the durable run binding.");
      }
    } catch (error) {
      sendError(res, 409, 99409, `Run continuation identity could not be verified: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    await ensureInterventionStoreReady();
    const intervention = state.pendingInterventionId ? interventionStore.get(state.pendingInterventionId) : null;
    if (state.pendingInterventionId && (!intervention || intervention.runId !== runId)) {
      sendError(res, 409, 99409, "The durable intervention required by this run is unavailable or mismatched.");
      return;
    }
    const controller = new AbortController();
    const runCtx = createTestVerificationContext(session);
    if (rejectIfShuttingDown(res)) return;
    const { collector, correlator, runner, runPromise: initialRunPromise } = applicationRunService.startWorkflowRun({
      session,
      workflow,
      runId,
      signal: controller.signal,
      resumeReceipt: intervention ? receiptFromRunState(state, intervention) : null,
      resumeOptions: { verify: runCtx, workflow },
      runnerOptions: {
        interventions: interventionStore,
        decisionRuntime,
        qualificationService: runQualificationService,
        capabilityRegistry,
        capabilityService,
        fileUploadGrantStore,
        authorizeExtractionField,
        authorizeExtractionRelease,
        existingRunStateId: runId,
        ...binding
      }
    });
    const runPromise = intervention
      ? initialRunPromise.then(result => {
          if (!result.receipt) throw new Error(result.reason ?? "The run resume predicate was not independently verified.");
          return result.receipt;
        })
      : initialRunPromise;
    installTestRun({ runId, session, workflow, binding, controller, collector, correlator, runner, runPromise, runCtx });
    sendJson(res, 202, { status: "resuming", runId });
  }

  async function handleGetTestRun(req, res, runId) {
    const run = testRuns.get(runId);
    let state;
    try {
      await ensureRunStateStore();
      state = await runStateStore.getFresh(runId);
    } catch (error) {
      sendError(res, 503, 99503, `Durable run-state lookup failed: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    if (!state) {
      // The worker acquires its durable run and target leases before creating
      // the first checkpoint. Keep a just-accepted local run visible during
      // that bounded initialization window without inventing a receipt.
      if (run && !run.runState.settled) {
        sendJson(res, 200, {
          runId,
          status: "RUNNING",
          pendingInterventionId: null,
          unresolvedOperationIds: [],
          cancellationRequested: false,
          outputs: {},
          capability_discoveries: []
        });
        return;
      }
      sendError(res, 404, 99404, `No test run found for runId '${runId}'.`);
      return;
    }

    const receipt = receiptFromRunState(state).toObject();
    const hasLocalWorker = Boolean(run);
    if (run && !run.runState.settled && receipt.status.startsWith("WAITING_FOR_")) {
      // A resumed worker has accepted the continuation but may still be
      // checking its intervention predicate. The durable waiting checkpoint
      // is stale for the duration of that active continuation.
      receipt.status = "RUNNING";
    }
    const hasLocalOutputs = Object.keys(run?.runner?.outputResults ?? {}).length > 0;
    const missingExtractionArtifact = !hasLocalOutputs && (state.completedSteps ?? []).some(item =>
      ["emit_output", "discover_tables", "extract_records", "collect_records"].includes(item.type) && item.status === "PASS");
    if (missingExtractionArtifact) {
      receipt.status = "UNCERTAIN";
      receipt.limitations.push("Capability discovery and structured extraction artifacts are unavailable in this process and cannot be reconstructed from durable run state.");
      const outputStep = [...receipt.steps].reverse().find(item => ["emit_output", "discover_tables", "extract_records", "collect_records"].includes(item.type));
      if (outputStep) {
        outputStep.status = "UNCERTAIN";
        outputStep.reason = "The durable checkpoint records this capability step, but its result artifact is unavailable.";
      }
    }
    const unresolvedOperations = (state.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
    sendJson(res, 200, {
      ...receipt,
      pendingInterventionId: state.pendingInterventionId ?? null,
      unresolvedOperationIds: unresolvedOperations.map(operation => operation.operationId),
      cancellationRequested: state.cancellationRequested === true,
      outputs: hasLocalWorker ? projectExtractionOutputs(run.runner?.outputResults ?? {}, authorizeExtractionRelease, { req, runId, principalId: state.principalId ?? null }) : {},
      capability_discoveries: hasLocalWorker ? run.runner?.capabilityDiscoveries ?? [] : []
    });
  }

  async function handleCancelTestRun(req, res, runId) {
    const run = testRuns.get(runId);
    try {
      await ensureRunStateStore();
      const cancellation = await requestRunCancellation(runStateStore, runId, {
        abort: run ? () => run.controller.abort() : undefined,
        runPromise: run?.runPromise
      });
      if (!cancellation) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
      sendJson(res, 200, {
        status: cancellation.requested ? "cancel_requested" : cancellation.run.status,
        runId,
        requiresReconciliation: cancellation.requiresReconciliation
      });
    } catch (error) {
      sendError(res, 503, 99503, `Cancellation could not be persisted: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }

  async function handleCollectTestRunDiagnostics(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
    const results = await run.collector.collectAll([
      { sourceId: "browser-network", operation: OPERATION.READ },
      { sourceId: "browser-lifecycle", operation: OPERATION.READ }
    ]);
    sendJson(res, 200, { runId, results });
  }

  async function handleGetTestReport(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) {
      try {
        await ensureRunStateStore();
        const durableState = await runStateStore.getFresh(runId);
        if (!durableState) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
        sendJson(res, 200, buildDurableRunReport(durableState));
      } catch (error) {
        sendError(res, 503, 99503, `Durable report reconstruction failed: ${String(error?.message ?? error).slice(0, 200)}`);
      }
      return;
    }
    if (!run.runState.settled) { sendError(res, 409, 99409, "The test run has not settled; a report is not available yet."); return; }
    const receipt = run.runState.receipt;
    if (!receipt) { sendError(res, 409, 99409, "The test run failed without a receipt; a report is unavailable."); return; }
    let durableState = null;
    try {
      await ensureRunStateStore();
      durableState = await runStateStore.getFresh(runId);
    } catch { /* A missing durable snapshot must keep the report inconclusive. */ }
    const report = new DiagnosticReport({ runId, title: `Test run: ${receipt.workflowName}` });
    report.setCorrelationSummary(run.correlator.summary());
    for (const step of receipt.steps) {
      const level = step.status === "PASS" ? FINDING_LEVEL.CONFIRMED
        : step.status === "FAIL" ? FINDING_LEVEL.LIKELY
        : step.status === "BLOCKED" ? FINDING_LEVEL.BLOCKED
        : FINDING_LEVEL.INSUFFICIENT;
      report.addFinding({ level, subject: `Step ${step.stepId} (${step.type})`, description: step.reason, evidenceIds: step.evidenceIds });
    }
    for (const entry of run.collector.getSnapshots()) {
      report.logSourceAccess({ sourceId: entry.sourceId, operation: entry.operation, status: "ok" });
    }
    const assessment = deriveRunInvestigationStatus({
      receipt: receipt.toObject(),
      durableStateAvailable: durableState !== null,
      durableRunStatus: durableState?.status ?? null,
      unresolvedOperations: (durableState?.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status)),
      testOwnedResources: durableState?.testOwnedResources ?? []
    });
    report.setInvestigationStatus(assessment.status);
    for (const limitation of assessment.limitations) report.addLimitation(limitation);
    sendJson(res, 200, report.redacted());
  }

  const handleDiscoveryRoute = createDiscoveryRoutes({
    authorizeMutation,
    readBody,
    sendJson,
    sendError,
    testSessionResolver,
    ensureRunStateStore,
    runStateStore,
    decisionRuntime,
    discoveryEnvironment,
    discoveryPrincipalId,
    configuredKnowledgeDir
  });
  const handleCapabilityRoute = createCapabilityRoutes({
    executorReady: lifecycle.executorReady,
    navigationRunner,
    capabilityRegistry,
    capabilityService,
    readBody,
    sendJson,
    sendError
  });
  const handleInterventionRoute = createInterventionRoutes({
    authorizeMutation,
    authenticateOperator,
    interventionTools,
    readBody,
    sendJson,
    sendError
  });
  const handlePublicReadApprovalRoute = createPublicReadApprovalRoutes({
    publicReadApprovalBroker,
    authorizeMutation,
    authenticateOperator,
    readBody,
    sendJson,
    sendError
  });
  const handleEvidenceReleaseRoute = createEvidenceReleaseRoutes({
    authenticateOperator,
    getEvidenceReleaseStore,
    readBody,
    sendJson,
    sendError
  });
  const handleTestRunRoute = createTestRunRoutes({
    authorizeMutation,
    handleStartTestRun,
    handleGetTestRun,
    handleResumeTestRun,
    handleCancelTestRun,
    handleCollectTestRunDiagnostics,
    handleGetTestReport,
    sendError
  });
  const handleLegacyRunRoute = createLegacyRunRoutes({
    store,
    lifecycle,
    findTemplate,
    projectInput,
    sendJson,
    sendError
  });
  const handleCatalogRoute = createCatalogRoutes({
    officialTemplates: OFFICIAL_TEMPLATES,
    regions: REGIONS,
    findTemplate,
    sendJson,
    sendError
  });

  // Executor readiness: fail closed when no real navigation runner was provided.
  const executorReady = lifecycle.executorReady;
  const executorDetail = executorReady ? "ready" : "unavailable: no navigation runner configured";
  const { handleCreateRun, handlePeerRun } = createRunExecutionHandlers({
    executorReady,
    store,
    lifecycle,
    maxTaskRecords,
    diagnostics,
    runStateStore,
    capabilityService,
    authorizeExtractionRelease,
    findTemplate,
    validateInput,
    buildPageDataExtractionWorkflow,
    renderGoal,
    isShuttingDown: () => shuttingDown,
    readBody,
    sendJson,
    sendError,
    logger
  });
  const handleOutputFile = createOutputFileHandler({ sendError });

  const server = http.createServer(async (req, res) => {
    if (rejectIfShuttingDown(res)) return;
    const requestStart = Date.now();
    res.on("finish", () => diagnostics.httpLogger(req, res, requestStart));
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const query = parseQuery(url);
    const method = req.method ?? "GET";
    const requestOrigin = req.headers.origin ?? null;

    if (!checkHost(req, res, sendError)) return;
    if (!checkOrigin(req, res, sendError)) return;

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...(requestOrigin ? { "Access-Control-Allow-Origin": requestOrigin } : {}),
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ActiveTab-Operator-Token"
      });
      res.end();
      return;
    }

    const isStateChanging = method === "POST" || method === "PUT" || method === "DELETE";

    try {
      if (method === "GET" && (path === "/health" || path === "/")) {
        sendJson(res, 200, {
          status: "ok", service: "activetab-local-api", version: "0.1.0",
          executor: { ready: executorReady, detail: executorDetail },
          auth: { tokenRequired: token !== null },
          diagnostics: diagnostics.snapshot()
        }, { allowOrigin: requestOrigin ?? undefined });
        return;
      }

      // Discovery handlers receive server-owned identity, storage, lease,
      // and engine dependencies; request JSON remains untrusted input only.
      if (await handleDiscoveryRoute(req, res, { method, path })) return;

      if (await handlePublicReadApprovalRoute(req, res, { method, path })) return;

      // Operator and API authentication remain enforced inside the injected route.
      if (await handleInterventionRoute(req, res, { method, path, query })) return;

      // Evidence release review and grant revocation require independent operator auth.
      if (await handleEvidenceReleaseRoute(req, res, { method, path, query })) return;

      if (await handleTestRunRoute(req, res, { method, path })) return;

      if (path.startsWith("/v3/") || path.startsWith("/v2/")) {
        // The peer-execution endpoint authenticates with its own peer token
        // ring inside handlePeerRun; it must not require the local API token.
        const isPeerRun = method === "POST" && path === `${API_PREFIX}/remote/runs`;
        if (!isPeerRun && !authorizeMutation(req)) {
          // All other /v3 and /v2 endpoints are privileged or expose run metadata.
          // Require explicit credentials for both reads and mutations.
          sendError(res, 401, 99401, "Authentication required.");
          return;
        }

        // ── POST /v3/bots/remote/runs (peer execution; must precede :bot_id) ──
        if (method === "POST" && path === `${API_PREFIX}/remote/runs`) {
          await handlePeerRun(req, res);
          return;
        }

        if (await handleCapabilityRoute(req, res, { method, path })) return;

        if (await handleCatalogRoute(req, res, { method, path, query })) return;

        // ── POST run creation (template and bot routes share one path) ──
        const templateRun = method === "POST" && path.match(/^\/v3\/bots\/templates\/[^/]+\/runs$/);
        const botRun = method === "POST" && path.match(/^\/v3\/bots\/[^/]+\/runs$/);
        if (templateRun || botRun) {
          await handleCreateRun(req, res, { templateRun, path });
          return;
        }

        if (await handleLegacyRunRoute(req, res, { method, path, query })) return;

        sendError(res, 404, 99404, `No static resource ${path.replace(/^\//, "")}.`);
        return;
      }

      // Output file serving: allowlisted extensions, safe path resolution, bounded size.
      if (method === "GET" && path.match(/^\/output\/[^/]+\/[^/]+$/)) {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        await handleOutputFile(res, { store, path });
        return;
      }

      sendError(res, 404, 99404, `No static resource ${path.replace(/^\//, "")}.`);
    } catch (error) {
      if (error?.code === "intervention_store_unavailable") {
        sendError(res, 503, 99503, "intervention_store_unavailable");
        return;
      }
      sendError(res, 500, 99500, String(error.message ?? error).slice(0, 500));
    }
  });

  const shutdownCoordinator = createShutdownCoordinator({
    stopAdmission: () => { shuttingDown = true; },
    getTestRuns: () => [...testRuns.values()],
    ensureRunStateStore,
    runStateStore,
    lifecycle,
    server,
    closeOwnedResources,
    logger,
    timeoutMs: shutdownTimeoutMs
  });

  return {
    server,
    store,
    async start() {
      await store.init();
      await ensureRunStateStore();
      await ensureInterventionStoreReady();
      return new Promise((resolvePromise, reject) => {
        server.listen(port, host, () => {
          const address = server.address();
          const boundHost = address.address === "::" ? "[::1]" : String(address.address);
          const url = `http://${boundHost}:${address.port}`;
          console.log(`ActiveTab local API server listening on ${url}`);
          resolvePromise({ port: address.port, url });
        });
        server.on("error", reject);
      });
    },
    async stop() { return await shutdownCoordinator.stop(); }
  };
}
