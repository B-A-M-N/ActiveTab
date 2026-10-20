import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ExtensionBroker } from "../extension/broker.js";
import { brokerSocketPath, stateDirectory } from "../extension/paths.js";
import { WorkflowStore } from "../state/workflows.js";
import { McpTaskJournalStore } from "../state/mcpTaskJournals.js";
import { selectBrowserSession } from "./session-selection.js";
import { runMcpGoal } from "./runGoal.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../diagnostics/contracts.js";
import { cloudAgentAdapterFromEnv } from "../diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCorrelator } from "../diagnostics/correlator.js";
import { DiagnosticReport, FINDING_LEVEL, deriveRunInvestigationStatus } from "../diagnostics/report.js";
import { receiptFromRunState } from "../testing/receipts.js";
import { buildDurableRunReport } from "../testing/durableRunReport.js";
import { RunStateStore, requestRunCancellation, withTargetExecutionLease } from "../testing/runState.js";
import { ApplicationRunService } from "../navigation/applicationRunService.js";
import { ApplicationDiscoveryEngine } from "../discovery/engine.js";
import { InvestigationEngine } from "../investigation/engine.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { createInterventionTools } from "../api/intervention-tools.js";
import { AuthorizationGrantStore } from "../runtime/approvals.js";
import { createDecisionRuntime } from "../decisions/runtime.js";
import { trackRunResult } from "../runtime/runTracker.js";
import { ProfileLoader } from "../testing/profiles.js";
import { buildEnvironmentBinding, resolveObservedApplication, verifyObservedUrl } from "../environments/model.js";
import { createCloudAgentEntryWorkflow, resolveCloudAgentEntry, verifyCloudAgentReady } from "../testing/cloudAgentEntry.js";
import { prepareCloudAgentTask } from "../integrations/freeinference/prepareCloudAgentTask.js";
import { verifyCloudAgentRunOutcome } from "../integrations/freeinference/cloudAgentWorkflow.js";
import { eventIdsForEvidence } from "../telemetry/evidenceRefs.js";
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
const targetIdOptional = { targetId: { type: "string", description: "Select an attached tab. Required when more than one tab is attached." } };
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

function startWorkflowRun({ session, workflow, environment = null, operationAuthorizer = null, runId = null, controller = new AbortController(), verifyAuthentication = null, verifyEnvironment = null, profileId = null, principalId = null, existingRunStateId = null, resumeReceipt = null } = {}) {
  const effectiveRunId = runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runCtx = {
    ...interventionCtx,
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

const tools = [
  { name: "get_runtime_capabilities", description: "Report current browser attachment, navigation scope requirements, extraction/form boundaries, workflow reuse, and catalog-preflight status for the configured inference routes. Catalog availability does not prove a live inference call will succeed; the response never returns credentials or full endpoint URLs.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_tabs", description: "List page targets on the configured loopback CDP endpoint. ACTIVETAB_AUTO_CONNECT=1 uses Chrome's opt-in debugging bridge. ACTIVETAB_EXTENSION=1 lists tabs individually attached from the ActiveTab toolbar popup. Listing alone does not grant control.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "attach_tab", description: "Adopt the exact tab authorized out of band, by a Chrome permission prompt, or by a separate ActiveTab toolbar Attach click on that tab. An MCP argument alone never grants consent; attaching another authorized tab preserves existing sessions.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "detach_tab", description: "Close ActiveTab's session for one explicitly attached tab. This releases its extension lease or native transport; it does not close the Chrome tab.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "observe_page", description: "Capture bounded browser evidence. Select visual to retain a screenshot for later separately approved release; observe_page itself returns no screenshot or sensitive page values.", inputSchema: { type: "object", properties: { ...targetIdOptional, profile: { type: "string", enum: ["lightweight", "interaction", "structural", "visual"] } }, additionalProperties: false } },
  { name: "read_page_records", description: "Read requested fields from one freshly observed visible table or repeated record group. This ephemeral read never registers a reusable capability and always reports observed_partial because page-level completeness is unproven. Profile-bound reads use that profile's field policy. An unfamiliar, conservatively classified public field requires an exact-origin publicReadEntries allowlist or exact run-local operator approval through the authenticated loopback API; unclassified and denied fields remain withheld. Query changes invalidate its candidate.", inputSchema: { type: "object", properties: { ...targetIdOptional, profileId: { type: "string", minLength: 1, maxLength: 128 }, candidateId: { type: "string", minLength: 1, maxLength: 128 }, fields: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 64 }, sourceHeader: { type: "string", minLength: 1, maxLength: 160 }, sourceKey: { type: "string", minLength: 1, maxLength: 128 }, type: { type: "string", enum: ["string", "integer", "number", "boolean"] }, required: { type: "boolean" } }, required: ["name", "type", "required"], additionalProperties: false } }, maxRecords: { type: "integer", minimum: 1, maximum: 1000 }, uniqueBy: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } } }, required: ["fields"], additionalProperties: false } },
  { name: "get_evidence", description: "Retrieve retained redacted browser instrumentation facets by evidence id. OOPIF snapshots are selected with the outOfProcessFrames facet; scrollTargets describes bounded observed page and nested scroll regions; selectedElement accepts frameTargetId to distinguish target-scoped node ids. Sensitive values and screenshots require an independently operator-approved, profile-bound evidence release.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, facets: { type: "array", items: { type: "string", enum: ["page", "domSnapshot", "accessibilityTree", "frameTree", "outOfProcessFrames", "scrollTargets", "selectedElement", "networkActivity", "lifecycleEvents", "domMutations", "runtimeState"] } }, backendNodeId: { type: "integer" }, frameTargetId: { type: "string" } }, required: ["evidenceId"], additionalProperties: false } },
  { name: "inspect_runtime_state", description: "Read one redacted JavaScript-exposed value from the page or an attached out-of-process iframe through an exact own-property path. This never accepts or evaluates caller JavaScript; path traversal uses V8 side-effect checking and reports accessors without reading them. Selecting an object returns its type; specify a deeper path to inspect a child value. Sensitive primitive values remain redacted because the separately authenticated evidence-grant release path is not implemented yet. Same-process child-frame execution contexts are not yet selectable.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, path: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } }, frameTargetId: { type: "string" } }, required: ["evidenceId"], additionalProperties: false } },
  { name: "click_observed_element", description: "Perform one click on a target selected from retained evidence. The target must still appear in a fresh observation; current human-handoff and caller-intent policy are checked. Returns a post-action observation and requires the caller to verify the task outcome; it never reports task success.", inputSchema: { type: "object", properties: { ...targetIdOptional, goal: { type: "string", minLength: 1, maxLength: 2000 }, evidenceId: { type: "string" }, backendNodeId: { type: "integer", minimum: 0 }, frameTargetId: { type: "string" } }, required: ["goal", "evidenceId", "backendNodeId"], additionalProperties: false } },
  { name: "inspect_network_response", description: "Inspect one selected response as redacted, format-aware diagnostics. By default it returns a page of Markdown with JSON repair or non-JSON analysis, credential metadata, indexed sections and blocks, and source offsets. Select view, sectionId, or blockId and page with offset/maxBytes. Recognized credential values stay redacted; this does not verify application success.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, requestId: { type: "string" }, view: { type: "string", enum: ["markdown", "source", "normalized"] }, sectionId: { type: "string" }, blockId: { type: "string" }, offset: { type: "integer", minimum: 0 }, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } }, required: ["evidenceId", "requestId"], additionalProperties: false } },
  { name: "request_evidence_release", description: "Create a pending request for sensitive retained evidence. It cannot approve itself. Scope is bound to the exact target, evidence, selected facet/Markdown subtree, verified profile application and this MCP process; an independently authenticated operator must approve it through the local API.", inputSchema: { type: "object", properties: { ...targetIdOptional, profileId: { type: "string", minLength: 1, maxLength: 128 }, evidenceId: { type: "string" }, facet: { type: "string", enum: ["screenshot", "form_values", "runtime_values", "response_body", "response_credential_values"] }, facets: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["domSnapshot", "accessibilityTree", "outOfProcessFrames"] } }, path: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } }, frameTargetId: { type: "string" }, requestId: { type: "string" }, view: { type: "string", enum: ["markdown", "source", "normalized"] }, sectionId: { type: "string" }, blockId: { type: "string" }, byteBudget: { type: "integer", minimum: 1, maximum: 8388608 }, expiresInMs: { type: "integer", minimum: 1000, maximum: 900000 } }, required: ["profileId", "evidenceId", "facet", "byteBudget"], additionalProperties: false } },
  { name: "release_evidence", description: "Release only the exact scope of an approved, unexpired operator grant. Response credential values require both a response_body grant and a separate response_credential_values grant. The token is bound to this MCP process, principal, target, evidence, profile application and selected Markdown subtree; byte budgets are cumulative and no content is truncated to fit.", inputSchema: { type: "object", properties: { ...targetIdOptional, profileId: { type: "string", minLength: 1, maxLength: 128 }, evidenceId: { type: "string" }, facet: { type: "string", enum: ["screenshot", "form_values", "runtime_values", "response_body", "response_credential_values"] }, grantToken: { type: "string" }, credentialGrantToken: { type: "string" }, facets: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["domSnapshot", "accessibilityTree", "outOfProcessFrames"] } }, path: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } }, frameTargetId: { type: "string" }, requestId: { type: "string" }, view: { type: "string", enum: ["markdown", "source", "normalized"] }, sectionId: { type: "string" }, blockId: { type: "string" }, offset: { type: "integer", minimum: 0 }, maxBytes: { type: "integer", minimum: 1, maximum: 262144 }, maxChars: { type: "integer", minimum: 1, maximum: 16384 } }, required: ["profileId", "evidenceId", "facet", "grantToken"], additionalProperties: false } },
  { name: "discover_application", description: "Run bounded autonomous discovery on an attached tab. Builds an application capability map from passive observations and safe same-origin link navigation. Returns discoveries and the capability map.", inputSchema: { type: "object", properties: { ...targetIdOptional, maxSteps: { type: "integer", minimum: 1, maximum: 16 }, maxLinksPerStep: { type: "integer", minimum: 1, maximum: 6 } }, additionalProperties: false } },
  { name: "investigate_failure", description: "Run read-only bug isolation after a failed step or run. It inspects durable operation reservations and later evidence; it never replays an effect. Pass runId and, when known, stepId or operationId to bind inspection to the exact prior operation. Raw observed values and full request URLs are omitted from diagnostic projections.", inputSchema: { type: "object", properties: { ...targetIdOptional, runId: { type: "string" }, stepId: { type: "string" }, operationId: { type: "string" }, subject: { type: "string" }, reason: { type: "string" } }, required: ["subject", "reason"], additionalProperties: false } },
  { name: "start_test_run", description: "Start a declarative workflow on an authorized attached tab. Select a local profileId whenever the workflow navigates or follows links; the profile is resolved from ActiveTab's local profiles directory and bound to run/resume. Returns runId for status polling.", inputSchema: { type: "object", properties: { ...targetIdOptional, profileId: { type: "string", minLength: 1, maxLength: 128 }, workflow: { type: "object" } }, required: ["workflow"], additionalProperties: false } },
  { name: "resume_test_run", description: "Continue a durable DAG after restart using the exact original workflow, run binding, and reattached target. This refuses changed workflow/authority bindings and unresolved dispatched effects; suspended human handoffs must pass their stored completion predicate first.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 160 }, targetId: { type: "string", minLength: 1, maxLength: 256 }, profileId: { type: "string", minLength: 1, maxLength: 128 }, workflow: { type: "object" } }, required: ["runId", "targetId", "workflow"], additionalProperties: false } },
  { name: "enter_cloud_agent", description: "On an explicitly attached FreeInference staging tab, follow the visible Agents/Cloud Agents UI path and verify the real Cloud Agent task composer. Uses the same browser session, never navigates to a guessed destination, and suspends for human authentication when needed. This entry primitive does not create or submit a Cloud Agent task; use start_cloud_agent_task afterward with exact caller-supplied values.", inputSchema: { type: "object", properties: { ...targetIdOptional }, additionalProperties: false } },
  { name: "start_cloud_agent_task", description: "Compile and start a caller-authored task in the already-open, authenticated FreeInference staging Cloud Agent. Does not navigate, invent a prompt, choose a model, or infer the expected result. Requires exact modelId, prompt, and expectedOutcome. Control mapping and every browser effect use ActiveTab's semantic, Jev, policy, and authorized-executor adapters; the result stays UNCERTAIN until independent run evidence is correlated.", inputSchema: { type: "object", properties: { ...targetIdOptional, request: { type: "object", properties: { requestId: { type: "string", minLength: 1, maxLength: 128 }, environmentId: { type: "string", const: "freeinference-staging" }, modelId: { type: "string", minLength: 1, maxLength: 500 }, prompt: { type: "string", minLength: 1, maxLength: 2000 }, expectedOutcome: { type: "object", minProperties: 1 }, diagnosticSources: { type: "array", maxItems: 6, items: { type: "string", enum: ["cloud-agent-runs", "cloud-agent-steps", "cloud-agent-usage"] } } }, required: ["requestId", "environmentId", "modelId", "prompt", "expectedOutcome"], additionalProperties: false } }, required: ["request"], additionalProperties: false } },
  { name: "get_test_run", description: "Get the receipt for a started test run by runId.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "cancel_test_run", description: "Cancel a running test run by runId. Cancellation takes effect at the next step boundary.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "collect_diagnostics", description: "Collect from registered diagnostic sources for a test run. Uses contract-validated, run-scoped, metadata-first retrieval.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "collect_cloud_agent_run_evidence", description: "Collect metadata for one exact Cloud Agent run. Requires the completed ActiveTab run, its latest browser evidence visibly showing the exact Cloud Agent run ID, and configured diagnostic credentials. Only the exact run record, bounded step metadata, and numeric usage fields are returned; this does not by itself verify the task's expected outcome.", inputSchema: { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 128 }, cloudAgentRunId: { type: "string", minLength: 1, maxLength: 128 }, browserEvidenceId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["runId", "cloudAgentRunId", "browserEvidenceId"], additionalProperties: false } },
  { name: "get_test_report", description: "Generate a qualified diagnostic report for a completed test run. Returns findings, correlation summary, source access log, and limitations.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "list_pending_interventions", description: "List durable, resumable human interventions (waiting or acknowledged) across runs, with their exact completion conditions.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_pending_intervention", description: "Get one intervention record including its verified resume predicate.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "acknowledge_human_action", description: "Record that the operator believes the requested human action is complete. This does NOT resume execution; resume_run verifies the completion predicate first.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "request_operation_approval", description: "Request (do not grant) approval for an intervention's exact operation. An MCP client cannot approve its own requested effects; resolution requires an independently authenticated operator channel.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "reject_operation", description: "Reject and cancel a pending intervention.", inputSchema: { type: "object", properties: { interventionId: { type: "string" }, reason: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "resume_run", description: "Resume a suspended run: verifies the exact completion predicate (grant scope/expiry, authenticated session, attachment grant, or outcome reconciliation) with fresh evidence before admitting execution.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "get_run_state", description: "Get the resumable state of a run (including suspended/waiting states).", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "cancel_run", description: "Cancel a run or intervention. Cancellation is permitted during suspension.", inputSchema: { type: "object", properties: { runId: { type: "string" }, interventionId: { type: "string" } }, additionalProperties: false } },
  { name: "run_goal", description: "Run a bounded standalone browser task. plannerMode=auto (the default) checks fresh DOM/AX evidence first, then calls Jev for an unclear visual page state or the configured secondary model for unresolved single-step navigation. Explicit read/extract/collect/retrieve/summarize/compare/scrape goals and output requests such as “list the names” or “return the prices” use the guarded workflow path so a single navigation cannot be reported as the requested data result. Compound requests and caller-typed workflow intents also enter guarded workflow planning; without a trusted complete plan they abstain before any partial browser action. A uniquely matched current-page HTML table may use a run-local read capability when every requested field passes exact trusted policy; its result is always observed_partial. Complete collection requests still need a matching qualified read capability. If no unique authorized source or usable synthesis route exists, the task abstains without browser mutation. Auto uses no remote model unless an endpoint is configured and page-content consent is enabled; it can reuse ACTIVETAB_SEMANTIC_ENDPOINT, defaults to FreeInference model ID glm-5.3-flash, and accepts FREEINFERENCE_API_KEY. Unique local matches need no inference. plannerMode=model explicitly uses the configured secondary action planner; plannerMode=workflow synthesizes one guarded workflow from typed intent or fresh application evidence, then executes it locally through the authorized executor. Set ACTIVETAB_MODEL_ALLOW_GOAL_TEXT=1 to send the natural-language goal for bounded model interpretation; otherwise task matching uses only caller-typed contracts and deterministic observed-field matches. This opt-in separately allows goal text to leave ActiveTab; ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1 is still required before page evidence is sent. Mutations, submissions, and unrelated read capabilities are never inferred. Select profileId from ActiveTab's local profiles directory whenever navigation is needed; the environment is bound to resumable state. Supply workflowIntent purposeCode and outcomeCode as lowercase structural identifiers (never as free-form task text); set cardinality to atomic, compound, or unknown. Unknown task shape routes through trusted workflow capabilities or abstains instead of selecting a partial action from goal wording. Optional targetRoles and constraints are bounded identifiers. Add a registered capability ID to requiredCapabilityIds when its output is required; this requires plannerMode=workflow, and synthesis cannot omit or conditionally skip it. Qualified, exact-scope, single-page extraction capabilities from the local registry are available only when the profile, principal, environment, read policy, and release policy match. Verified, policy-released outputs are retained in separate owner-only artifacts and rechecked before replay. The built-in workflow capability follows a unique visible link; application profiles may register additional trusted capabilities and fresh-page target resolvers. FreeInference Production model ID glm-5.3-flash is the default for an explicitly configured OpenAI-compatible endpoint. Jev 1.14 is the system's independent, advisory batch reviewer; its unavailability never grants or changes authority. Model retries count toward the durable per-run inference-attempt budget. Task continuation uses a goal fingerprint and bounded state. Set newTask=true to start a completed task again. When ACTIVETAB_WORKFLOW_STORE is configured, verified read-only workflow reuse is enabled automatically; set reuseWorkflows=false to skip it.", inputSchema: { type: "object", properties: { ...targetIdOptional, profileId: { type: "string", minLength: 1, maxLength: 128 }, goal: { type: "string" }, maxActions: { type: "integer", minimum: 1, maximum: 10 }, maxScrolls: { type: "integer", minimum: 0, maximum: 8 }, plannerMode: { type: "string", enum: ["deterministic", "auto", "model", "workflow"] }, workflowIntent: { type: "object", properties: { purposeCode: { type: "string", minLength: 1, maxLength: 64 }, outcomeCode: { type: "string", minLength: 1, maxLength: 64 }, cardinality: { type: "string", enum: ["atomic", "compound", "unknown"] }, targetRoles: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 64 } }, constraints: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 64 } }, requiredCapabilityIds: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 96 } } }, required: ["purposeCode", "outcomeCode"], additionalProperties: false }, reuseWorkflows: { type: "boolean" }, newTask: { type: "boolean" } }, required: ["goal"], additionalProperties: false } }
];
for (const tool of tools) {
  if (Object.hasOwn(tool.inputSchema.properties, "targetId") && tool.name !== "attach_tab" && tool.name !== "detach_tab") {
    tool.description += " `targetId` selects the browser session and is required when multiple tabs are attached.";
  }
}

async function callTool(name, args) {
  // Intervention tools (P0-6): long-running and suspended runs never block
  // these status/acknowledgement/approval/cancellation/resume tools.
  if (Object.hasOwn(interventionTools, name)) return await interventionTools[name](args);
  if (Object.hasOwn(browserToolHandlers, name)) return await browserToolHandlers[name](args);
  if (name === "get_runtime_capabilities") {
    const routeFor = roles => roles.map(role => modelPreflight.routes.find(route => route.role === role)).find(Boolean) ?? null;
    const secondary = routeFor(["planner", "semantic", "workflow"]);
    const jev = routeFor(["jev"]);
    const pageConsent = process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT === "1";
    const screenshotConsent = process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1";
    const configuredModelEndpoint = Boolean(process.env.ACTIVETAB_MODEL_ENDPOINT || process.env.ACTIVETAB_SEMANTIC_ENDPOINT || process.env.ACTIVETAB_WORKFLOW_ENDPOINT);
    const modelRouteStatus = route => !route ? "disabled" : route.status;
    const plannerStatus = !configuredModelEndpoint ? "disabled"
      : !pageConsent ? "requires_consent"
        : modelRouteStatus(secondary);
    const imageStatus = (route, optedIn) => !route || route.imageCapability !== true ? "unavailable"
      : !screenshotConsent || !optedIn ? "requires_consent"
        : route.status;
    const attachedTargetIds = [...sessions.entries()].filter(([, session]) => session?.attached === true).map(([targetId]) => targetId).sort();
    return {
      browser: { status: attachedTargetIds.length ? "attached" : "requires_target_attachment", attachedTargetCount: attachedTargetIds.length, targetIds: attachedTargetIds },
      navigation: { status: "requires_profile", reasonCode: "navigation_scope_required" },
      planning: { status: plannerStatus, reasonCode: plannerStatus === "requires_consent" ? "model_page_content_consent_required" : plannerStatus === "disabled" ? "provider_unavailable" : null, model: secondary?.model ?? null, preflight: secondary?.status ?? "not_configured", preflightKind: "authenticated_catalog_only", inferenceReachability: secondary?.inferenceReachability ?? "not_configured", pageContentConsent: pageConsent },
      visual: {
        secondary: { status: imageStatus(secondary, true), model: secondary?.model ?? null, catalogSupportsImages: secondary?.imageCapability === true, screenshotConsent },
        jev: { status: imageStatus(jev, process.env.ACTIVETAB_JEV_ALLOW_IMAGES === "1"), model: jev?.model ?? null, catalogSupportsImages: jev?.imageCapability === true, screenshotConsent }
      },
      jev: { status: modelRouteStatus(jev), model: jev?.model ?? null, preflight: jev?.status ?? "not_configured", preflightKind: "authenticated_catalog_only", inferenceReachability: jev?.inferenceReachability ?? "not_configured" },
      forms: { status: "requires_profile_operation_contract", reasonCode: "operation_not_admitted" },
      extraction: { status: "requires_profile_field_policy", reasonCode: "extraction_field_policy_required" },
      workflowReuse: { status: workflowStore ? "available" : "disabled" },
      modelPreflight: { status: modelPreflight.status, telemetryRecorded: modelPreflight.telemetryRecorded === true }
    };
  }
  if (name === "start_test_run") {
    const session = selectBrowserSession(sessions, args.targetId);
    if (!session) throw new Error("No attached browser session available.");
    const selectedProfile = await loadEnvironmentProfile(args.profileId);
    return startWorkflowRun({ session, workflow: args.workflow, environment: selectedProfile?.environment ?? null, profileId: selectedProfile?.profile.profile_id ?? null });
  }
  if (name === "resume_test_run") {
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
  }
  if (name === "enter_cloud_agent") {
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
    const started = startWorkflowRun({
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
  }
  if (name === "start_cloud_agent_task") {
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
    const started = startWorkflowRun({
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
  }
  if (name === "get_test_run") {
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
  }
  if (name === "cancel_test_run") {
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
  if (name === "collect_diagnostics") {
    const run = testRuns.get(args.runId);
    if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
    const results = await run.collector.collectAll([
      { sourceId: "browser-network", operation: OPERATION.READ },
      { sourceId: "browser-lifecycle", operation: OPERATION.READ }
    ]);
    return { runId: args.runId, results };
  }
  if (name === "collect_cloud_agent_run_evidence") {
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
    const { verifyCloudAgentRunIdentifierEvidence } = await import("../integrations/freeinference/browserRunIdentifier.js");
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
  if (name === "discover_application") {
    const session = selectBrowserSession(sessions, args.targetId);
    return await withTargetExecutionLease(runStateStore, session, `mcp-discovery-${randomUUID()}`, async lease => {
      const engine = new ApplicationDiscoveryEngine({
        session,
        maxSteps: args.maxSteps ?? 8,
        maxLinksPerStep: args.maxLinksPerStep ?? 4,
        decisionRuntime,
        assertExecutionLease: lease.assertCurrent
      });
      return await engine.discover();
    });
  }
  if (name === "investigate_failure") {
    const session = selectBrowserSession(sessions, args.targetId);
    const run = args.runId ? testRuns.get(args.runId) : null;
    const collector = run?.collector ?? null;
    const correlator = run?.correlator ?? new DiagnosticCorrelator();
    const engine = new InvestigationEngine({ collector, correlator, session, runStateStore });
    return await engine.investigate({ subject: args.subject, reason: args.reason, runId: args.runId ?? null, stepId: args.stepId ?? null, operationId: args.operationId ?? null });
  }
  if (name === "get_test_report") {
    const run = testRuns.get(args.runId);
    if (!run) {
      const durableState = await runStateStore.getFresh(args.runId);
      if (!durableState) throw new Error(`No test run found for runId '${args.runId}'.`);
      return buildDurableRunReport(durableState);
    }
    const receipt = await run.runPromise;
    const durableState = await runStateStore.getFresh(args.runId).catch(() => null);
    const report = new DiagnosticReport({ runId: args.runId, title: `Test run: ${receipt.workflowName}` });
    report.setCorrelationSummary(run.correlator.summary());
    for (const step of receipt.steps) {
      const level = step.status === "PASS" ? FINDING_LEVEL.CONFIRMED
        : step.status === "FAIL" ? FINDING_LEVEL.LIKELY
        : step.status === "BLOCKED" ? FINDING_LEVEL.BLOCKED
        : FINDING_LEVEL.INSUFFICIENT;
      report.addFinding({ level, subject: `Step ${step.stepId} (${step.type})`, description: step.reason, evidenceIds: step.evidenceIds });
    }
    const cloudDiagnosticSources = new Set((run.cloudAgentEvidenceResults ?? []).map(result => result.sourceId));
    for (const entry of run.collector.getSnapshots()) {
      if (cloudDiagnosticSources.has(entry.sourceId)) continue;
      report.logSourceAccess({ sourceId: entry.sourceId, operation: entry.operation, status: "ok" });
    }
    for (const result of run.cloudAgentEvidenceResults ?? []) {
      report.logSourceAccess({
        sourceId: result.sourceId,
        operation: OPERATION.READ_SCOPED,
        status: result.status,
        ...(result.status === "error" ? { error: result.error } : {})
      });
    }
    const assessment = deriveRunInvestigationStatus({
      receipt: receipt.toObject(),
      durableStateAvailable: durableState !== null,
      durableRunStatus: durableState?.status ?? null,
      unresolvedOperations: (durableState?.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status)),
      testOwnedResources: durableState?.testOwnedResources ?? [],
      integration: run.integration?.verificationRequired ? {
        ...run.integration,
        outcomeStatus: run.cloudAgentOutcome?.status,
        cloudAgentRunId: run.cloudAgentRunId,
        correlationStrength: run.cloudAgentCorrelation?.strength
      } : null,
      diagnosticResults: run.cloudAgentEvidenceResults ?? []
    });
    report.setInvestigationStatus(assessment.status);
    for (const limitation of assessment.limitations) report.addLimitation(limitation);
    return report.redacted();
  }
  const session = selectBrowserSession(sessions, args.targetId);
  if (name === "read_page_records") {
    const loaded = await loadEnvironmentProfile(args.profileId);
    return await capabilityService.readObservedRecords({
      session,
      environment: loaded?.environment ?? null,
      principalId: mcpPrincipalId,
      ...(args.candidateId ? { candidateId: args.candidateId } : {}),
      requestedFields: args.fields,
      maxRecords: args.maxRecords ?? 100,
      uniqueBy: args.uniqueBy ?? []
    });
  }
  if (name === "request_evidence_release") return await evidenceReleaseTools.requestEvidenceRelease(session, args);
  if (name === "release_evidence") return await evidenceReleaseTools.releaseEvidence(session, args);
  if (name === "run_goal") {
    const selectedProfile = await loadEnvironmentProfile(args.profileId);
    return await runMcpGoal(session, args, {
      journalStore: taskJournalStore,
      workflowStore,
      decisionRuntime,
      environment: selectedProfile?.environment ?? null,
      capabilityRegistry,
      capabilityService,
      authorizeExtractionField,
      authorizeExtractionRelease,
      runStateStore
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

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
