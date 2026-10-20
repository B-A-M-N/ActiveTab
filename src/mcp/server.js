import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ExtensionBroker } from "../extension/broker.js";
import { brokerSocketPath, stateDirectory } from "../extension/paths.js";
import { WorkflowStore } from "../state/workflows.js";
import { McpTaskJournalStore } from "../state/mcpTaskJournals.js";
import { selectBrowserSession } from "./session-selection.js";
import { createDiagnosticContract, AUTHORITY, SENSITIVITY } from "../diagnostics/contracts.js";
import { RunStateStore } from "../testing/runState.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { createInterventionTools } from "../api/intervention-tools.js";
import { AuthorizationGrantStore } from "../runtime/approvals.js";
import { createDecisionRuntime } from "../decisions/runtime.js";
import { ProfileLoader } from "../testing/profiles.js";
import { buildEnvironmentBinding, verifyObservedUrl } from "../environments/model.js";
import { randomUUID } from "node:crypto";
import { createQualificationRuntime } from "../testing/qualificationRuntime.js";
import { CapabilityRegistry } from "../capabilities/capabilityRegistry.js";
import { CapabilityService } from "../capabilities/capabilityService.js";
import { loadExtractionFieldPolicy } from "../capabilities/fieldPolicy.js";
import { EvidenceReleaseGrantStore } from "../runtime/evidenceReleaseGrants.js";
import { preflightModelCapabilities, writeModelPreflightSummary } from "../navigation/modelPreflight.js";
import { approvePublicReadThroughApi } from "../capabilities/publicReadApprovalClient.js";
import { FileUploadGrantStore } from "../runtime/fileUploadGrants.js";
import { createEvidenceReleaseTools } from "./evidenceReleaseTools.js";
import { createBrowserToolHandlers } from "./browserTools.js";
import { createDiagnosticToolHandlers } from "./tools/diagnosticTools.js";
import { createNavigationToolHandlers } from "./tools/navigationTools.js";
import { createWorkflowToolHandlers } from "./tools/workflowTools.js";
import { createQualificationToolHandlers } from "./tools/qualificationTools.js";
import { createRuntimeToolHandlers } from "./tools/runtimeTools.js";
import { tools } from "./tools/toolCatalog.js";

const modelPreflight = await preflightModelCapabilities();
writeModelPreflightSummary(modelPreflight);

const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const sessions = new Map();
const mcpInstanceId = randomUUID();
const mcpPrincipalId = `local_os_user:${userInfo().username}`;
const evidenceReleaseStore = new EvidenceReleaseGrantStore({
  databasePath: process.env.ACTIVETAB_EVIDENCE_RELEASE_DB ?? join(stateDirectory(), "evidence-releases.sqlite")
});
const MCP_IMAGE_CONTENT = Symbol("activetab.mcp.imageContent");
const decisionRuntime = createDecisionRuntime();
const qualificationService = createQualificationRuntime({ decisionRuntime });
const capabilityRegistry = await new CapabilityRegistry({
  directory: process.env.ACTIVETAB_CAPABILITY_DIR ?? join(process.cwd(), ".activetab", "capabilities")
}).init();
const extractionFieldPolicy = await loadExtractionFieldPolicy(process.env.ACTIVETAB_EXTRACTION_POLICY_FILE);
const capabilityService = new CapabilityService({
  registry: capabilityRegistry,
  classifyField: extractionFieldPolicy.classifyField,
  authorizeRead: extractionFieldPolicy.authorizeRead,
  authorizeRelease: extractionFieldPolicy.authorizeRelease,
  classifyPublicField: extractionFieldPolicy.classifyPublicField,
  publicFieldPolicy: extractionFieldPolicy.publicFieldPolicy,
  authorizePublicRead: extractionFieldPolicy.authorizePublicRead,
  authorizePublicRelease: extractionFieldPolicy.authorizePublicRelease,
  approvePublicRead: (proposal, options) => approvePublicReadThroughApi(proposal, options),
  authorizePagination: extractionFieldPolicy.authorizePagination
});
const authorizeExtractionField = field => extractionFieldPolicy.authorizeRead(field);
const authorizeExtractionRelease = field => extractionFieldPolicy.authorizeRelease(field);
const autoConnect = process.env.ACTIVETAB_AUTO_CONNECT === "1";
const extensionMode = process.env.ACTIVETAB_EXTENSION === "1";
let extensionBroker;
if (extensionMode) extensionBroker = await new ExtensionBroker({ socketPath: brokerSocketPath() }).start();
const workflowStore = process.env.ACTIVETAB_WORKFLOW_STORE ? new WorkflowStore(process.env.ACTIVETAB_WORKFLOW_STORE) : undefined;
const taskJournalStore = new McpTaskJournalStore();
const fileUploadGrantStore = new FileUploadGrantStore({
  stagingDirectory: join(stateDirectory(), "uploads"),
  trustedIssuer: "activetab-mcp"
});
// Run registry is declared BEFORE any service that depends on it (P0-7):
// constructing the intervention tools with an uninitialized registry was a
// temporal-dead-zone error that could prevent MCP startup.
const testRuns = new Map();
let interventionTools = null;
let interventionWatcher = null;

const interventionStore = new InterventionStore(process.env.ACTIVETAB_INTERVENTION_DIR ?? join(process.cwd(), ".activetab", "interventions"));
const runStateStore = new RunStateStore(process.env.ACTIVETAB_RUN_STATE_DIR ?? join(process.cwd(), ".activetab", "runs"));
const browserToolRuntime = createBrowserToolHandlers({
  sessions,
  endpoint,
  autoConnect,
  extensionMode,
  extensionBroker,
  runStateStore,
  decisionRuntime
});
const browserToolHandlers = browserToolRuntime.handlers;
const diagnosticToolHandlers = createDiagnosticToolHandlers({ testRuns, sessions, runStateStore });
const navigationToolHandlers = createNavigationToolHandlers({
  sessions,
  principalId: mcpPrincipalId,
  loadEnvironmentProfile,
  taskJournalStore,
  workflowStore,
  decisionRuntime,
  capabilityRegistry,
  capabilityService,
  authorizeExtractionField,
  authorizeExtractionRelease,
  runStateStore
});
const grantStore = new AuthorizationGrantStore({ trustedIssuer: process.env.ACTIVETAB_TRUSTED_ISSUER ?? "activetab-mcp" });
const interventionCtx = {
  grantStore,
  issueGrant: (...args) => grantStore.issue(...args),
  // Attachment verification: a caller-provided target ID alone is never proof.
  hasAttachmentGrant: async (targetId, intervention) => {
    const run = intervention?.runId ? testRuns.get(intervention.runId) : null;
    if (!run || run.session?.target?.id !== targetId) {
      return { ok: false, reason: "The intervention is not bound to this browser target and run." };
    }
    return sessions.has(targetId)
      ? { ok: true }
      : { ok: false, reason: `No authorized attachment grant for target '${targetId}'. Authorize the tab through the ActiveTab extension.` };
  },
  // Resume predicates receive their durable intervention and resolve the
  // verifier/session bound to that exact run. Never borrow the first attached
  // tab when multiple browser targets exist.
  verifyAuthentication: async (realm, intervention) => {
    const run = intervention?.runId ? testRuns.get(intervention.runId) : null;
    if (typeof run?.verifyAuthentication !== "function") {
      return { authenticated: false, reason: `No authentication verifier configured for realm '${realm ?? "unknown"}'.` };
    }
    return await run.verifyAuthentication(realm);
  },
  verifyEnvironment: async (url, intervention) => {
    const run = intervention?.runId ? testRuns.get(intervention.runId) : null;
    if (typeof run?.verifyEnvironment === "function") return await run.verifyEnvironment(url);
    if (!run?.environment) return { ok: false, reason: "No environment binding is available for this run." };
    return verifyObservedUrl(run.environment, url);
  },
  observe: async intervention => {
    const run = intervention?.runId ? testRuns.get(intervention.runId) : null;
    return run?.session ? await run.session.observe().catch(() => null) : null;
  }
};

// Explicit startup: a failed intervention-store initialization must not
// leave the server claiming durable resumability.
await interventionStore.init();
await runStateStore.init();
interventionTools = createInterventionTools({ store: interventionStore, runs: testRuns, runStateStore, ctx: interventionCtx });
interventionWatcher = new InterventionWatcher({ store: interventionStore, ctx: interventionCtx, pollIntervalMs: 5_000 });
interventionWatcher.onResume = async (record) => {
  const run = testRuns.get(record.runId);
  if (run && typeof run.resume === "function") await run.resume(record);
};
interventionWatcher.start();

async function loadEnvironmentProfile(profileId) {
  if (profileId === undefined || profileId === null) return null;
  if (typeof profileId !== "string" || profileId.length === 0) throw new Error("profileId must select a local ActiveTab environment profile.");
  const profile = await new ProfileLoader(join(process.cwd(), "profiles")).loadProfile(profileId);
  if (!profile) throw new Error(`No local environment profile '${profileId}' exists.`);
  return { profile, environment: buildEnvironmentBinding(profile) };
}

function mcpResult(value) {
  const images = value?.[MCP_IMAGE_CONTENT] ?? [];
  return {
    content: [
      { type: "text", text: JSON.stringify(value) },
      ...images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))
    ],
    structuredContent: value
  };
}

const evidenceReleaseTools = createEvidenceReleaseTools({
  store: evidenceReleaseStore,
  principalId: mcpPrincipalId,
  callerInstanceId: mcpInstanceId,
  loadEnvironmentProfile,
  imageContentKey: MCP_IMAGE_CONTENT,
  serializeResult: mcpResult
});


const workflowToolRuntime = createWorkflowToolHandlers({
  sessions,
  testRuns,
  runStateStore,
  loadEnvironmentProfile,
  interventionContext: interventionCtx,
  interventionStore,
  decisionRuntime,
  qualificationService,
  fileUploadGrantStore,
  verifyObservedUrl
});
const workflowToolHandlers = workflowToolRuntime.handlers;
const qualificationToolHandlers = createQualificationToolHandlers({
  sessions, testRuns, workflowToolRuntime, loadEnvironmentProfile,
  decisionRuntime, runStateStore, verifyObservedUrl
});
const runtimeToolHandlers = createRuntimeToolHandlers({ sessions, modelPreflight, workflowStore });

async function callTool(name, args) {
  // Intervention tools (P0-6): long-running and suspended runs never block
  // these status/acknowledgement/approval/cancellation/resume tools.
  if (Object.hasOwn(interventionTools, name)) return await interventionTools[name](args);
  if (Object.hasOwn(browserToolHandlers, name)) return await browserToolHandlers[name](args);
  if (Object.hasOwn(diagnosticToolHandlers, name)) return await diagnosticToolHandlers[name](args);
  if (Object.hasOwn(navigationToolHandlers, name)) return await navigationToolHandlers[name](args);
  if (Object.hasOwn(workflowToolHandlers, name)) return await workflowToolHandlers[name](args);
  if (Object.hasOwn(qualificationToolHandlers, name)) return await qualificationToolHandlers[name](args);
  if (Object.hasOwn(runtimeToolHandlers, name)) return await runtimeToolHandlers[name](args);
  const session = selectBrowserSession(sessions, args.targetId);
  if (name === "request_evidence_release") return await evidenceReleaseTools.requestEvidenceRelease(session, args);
  if (name === "release_evidence") return await evidenceReleaseTools.releaseEvidence(session, args);
  throw new Error(`Unknown tool: ${name}`);
}

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
  if (request.method === "notifications/initialized" || request.method?.startsWith("notifications/")) continue;
  try {
    let result;
    if (request.method === "initialize") result = { protocolVersion: request.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "activetab", version: "0.1.0" } };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      // Fire-and-forget: long-running tool calls do not block subsequent
      // requests. The response is written asynchronously when the call
      // completes. Status/cancellation tools remain responsive.
      const requestId = request.id;
      const toolName = request.params.name;
      const toolArgs = request.params.arguments ?? {};
      callTool(toolName, toolArgs)
          .then(value => {
          if (requestId !== undefined) write({ jsonrpc: "2.0", id: requestId, result: mcpResult(value) });
        })
        .catch(error => {
          if (requestId !== undefined) write({ jsonrpc: "2.0", id: requestId, error: { code: error.code ?? -32000, message: String(error.message).slice(0, 1000) } });
        });
      continue; // The result is written asynchronously; no further code in this iteration.
    } else if (request.method === "resources/list") result = { resources: [] };
    else throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
    if (request.id !== undefined) write({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request.id !== undefined) write({ jsonrpc: "2.0", id: request.id, error: { code: error.code ?? -32000, message: String(error.message).slice(0, 1000) } });
  }
}
interventionWatcher?.stop();
await Promise.all([...sessions.values()].map(session => session.close()));
decisionRuntime.close();
await browserToolRuntime.close();
await extensionBroker?.close();
evidenceReleaseStore.close();
