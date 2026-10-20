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
 * - Test-run worker lifecycle and durable views: ./testRunLifecycle.js
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
import { RunStateStore } from "../testing/runState.js";
import { ApplicationRunService } from "../navigation/applicationRunService.js";
import { InterventionStore } from "../runtime/interventions.js";
import { createInterventionTools } from "./intervention-tools.js";
import { AuthorizationGrantStore } from "../runtime/approvals.js";
import { createQualificationRuntime } from "../testing/qualificationRuntime.js";
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
import { createTestRunLifecycle } from "./testRunLifecycle.js";

const DEFAULT_PORT = 9377;
const API_PREFIX = "/v3/bots";
const MAX_TASK_RECORDS = 1_000;
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

  async function ensureRunStateStore() {
    runStateStoreReady ??= runStateStore.init();
    await runStateStoreReady;
  }

  const testRunHandlers = createTestRunLifecycle({
    testRuns,
    grantStore,
    testSessionResolver,
    testEnvironmentResolver,
    testProfileIdResolver,
    testPrincipalResolver,
    ensureRunStateStore,
    ensureInterventionStoreReady,
    runStateStore,
    interventionStore,
    applicationRunService,
    decisionRuntime,
    runQualificationService,
    capabilityRegistry,
    capabilityService,
    fileUploadGrantStore,
    authorizeExtractionField,
    authorizeExtractionRelease,
    isShuttingDown: () => shuttingDown,
    rejectIfShuttingDown,
    readBody,
    sendJson,
    sendError
  });
  const {
    handleStartTestRun,
    handleGetTestRun,
    handleResumeTestRun,
    handleCancelTestRun,
    handleCollectTestRunDiagnostics,
    handleGetTestReport
  } = testRunHandlers;

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
