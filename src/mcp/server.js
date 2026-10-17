import { createInterface } from "node:readline";
import { join } from "node:path";
import { listTargets, resolveAuthorizedTarget } from "../browser/targets.js";
import { BrowserSession } from "../browser/session.js";
import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "../browser/chrome-autoconnect.js";
import { clickObservedElement } from "../navigation/observedAction.js";
import { ExtensionBroker } from "../extension/broker.js";
import { brokerSocketPath } from "../extension/paths.js";
import { WorkflowStore } from "../state/workflows.js";
import { McpTaskJournalStore } from "../state/mcpTaskJournals.js";
import { selectBrowserSession } from "./session-selection.js";
import { runMcpGoal } from "./runGoal.js";
import { DiagnosticCollector } from "../diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../diagnostics/contracts.js";
import { registerBrowserDiagnosticSources } from "../diagnostics/adapters/browserSources.js";
import { cloudAgentAdapterFromEnv } from "../diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCorrelator } from "../diagnostics/correlator.js";
import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS } from "../diagnostics/report.js";
import { TestRunner } from "../testing/runner.js";
import { ApplicationDiscoveryEngine } from "../discovery/engine.js";
import { InvestigationEngine } from "../investigation/engine.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { createInterventionTools } from "../api/intervention-tools.js";
import { AuthorizationGrantStore } from "../runtime/approvals.js";

const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const sessions = new Map();
let chromeConnection;
const autoConnect = process.env.ACTIVETAB_AUTO_CONNECT === "1";
const extensionMode = process.env.ACTIVETAB_EXTENSION === "1";
let extensionBroker;
if (extensionMode) extensionBroker = await new ExtensionBroker({ socketPath: brokerSocketPath() }).start();
const workflowStore = process.env.ACTIVETAB_WORKFLOW_STORE ? new WorkflowStore(process.env.ACTIVETAB_WORKFLOW_STORE) : undefined;
const taskJournalStore = new McpTaskJournalStore();
// Run registry is declared BEFORE any service that depends on it (P0-7):
// constructing the intervention tools with an uninitialized registry was a
// temporal-dead-zone error that could prevent MCP startup.
const testRuns = new Map();
const targetIdOptional = { targetId: { type: "string", description: "Select an attached tab. Required when more than one tab is attached." } };
let interventionTools = null;
let interventionWatcher = null;

const interventionStore = new InterventionStore(process.env.ACTIVETAB_INTERVENTION_DIR ?? join(process.cwd(), ".activetab", "interventions"));
const grantStore = new AuthorizationGrantStore({ trustedIssuer: process.env.ACTIVETAB_TRUSTED_ISSUER ?? "activetab-mcp" });
const interventionCtx = {
  grantStore,
  issueGrant: (...args) => grantStore.issue(...args),
  // Attachment verification: a caller-provided target ID alone is never proof.
  hasAttachmentGrant: async targetId => sessions.has(targetId)
    ? { ok: true }
    : { ok: false, reason: `No authorized attachment grant for target '${targetId}'. Authorize the tab through the ActiveTab extension.` },
  // Authentication verification: supplied by the operator/integration; the
  // default refuses to treat a disappeared login form as proof.
  verifyAuthentication: async realm => ({ authenticated: false, reason: `No authentication verifier configured for realm '${realm ?? "unknown"}'.` }),
  observe: async () => {
    const session = [...sessions.values()][0];
    return session ? await session.observe() : null;
  }
};

// Explicit startup: a failed intervention-store initialization must not
// leave the server claiming durable resumability.
await interventionStore.init();
interventionTools = createInterventionTools({ store: interventionStore, runs: testRuns, ctx: interventionCtx });
interventionWatcher = new InterventionWatcher({ store: interventionStore, ctx: interventionCtx, pollIntervalMs: 5_000 });
interventionWatcher.onResume = async (record) => {
  const run = testRuns.get(record.runId);
  if (run && typeof run.resume === "function") await run.resume(record);
};
interventionWatcher.start();

function createBrowserDiagnosticSources(session, collector) {
  registerBrowserDiagnosticSources(session, collector);
  const cloudAgent = cloudAgentAdapterFromEnv();
  if (cloudAgent) cloudAgent.registerSources(collector);
  return collector;
}
const tools = [
  { name: "list_tabs", description: "List page targets on the configured loopback CDP endpoint. ACTIVETAB_AUTO_CONNECT=1 uses Chrome's opt-in debugging bridge. ACTIVETAB_EXTENSION=1 lists tabs individually attached from the ActiveTab toolbar popup. Listing alone does not grant control.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "attach_tab", description: "Adopt the exact tab authorized out of band, by a Chrome permission prompt, or by a separate ActiveTab toolbar Attach click on that tab. An MCP argument alone never grants consent; attaching another authorized tab preserves existing sessions.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "detach_tab", description: "Close ActiveTab's session for one explicitly attached tab. This releases its extension lease or native transport; it does not close the Chrome tab.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "observe_page", description: "Capture current URL, frame tree, DOMSnapshot, accessibility, layout, bounded lifecycle, network metadata and DOM mutation deltas, screenshot, compact interactable candidates, and visible scroll regions. Sensitive URL components, form values, and mutation text are omitted from compact output.", inputSchema: { type: "object", properties: { ...targetIdOptional, includeScreenshot: { type: "boolean" } }, additionalProperties: false } },
  { name: "get_evidence", description: "Retrieve retained browser instrumentation facets by evidence id. OOPIF snapshots are selected with the outOfProcessFrames facet; scrollTargets describes bounded observed page and nested scroll regions; selectedElement accepts frameTargetId to distinguish target-scoped node ids. Runtime values stay redacted unless includeSensitiveRuntimeValues is explicitly true. URL query/fragment/user-info, form values, and mutation text stay redacted unless their matching explicit true flag is supplied; request bodies and headers are never captured, and selected response bodies require `inspect_network_response` with explicit opt-in.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, facets: { type: "array", items: { type: "string", enum: ["page", "domSnapshot", "accessibilityTree", "frameTree", "outOfProcessFrames", "scrollTargets", "selectedElement", "networkActivity", "lifecycleEvents", "domMutations", "runtimeState"] } }, backendNodeId: { type: "integer" }, frameTargetId: { type: "string" }, includeSensitiveFormValues: { type: "boolean" }, includeSensitivePageText: { type: "boolean" }, includeSensitiveUrlData: { type: "boolean" }, includeSensitiveRuntimeValues: { type: "boolean" }, includeScreenshot: { type: "boolean" } }, required: ["evidenceId"], additionalProperties: false } },
  { name: "inspect_runtime_state", description: "Read one selected JavaScript-exposed value from the page or an attached out-of-process iframe through an exact own-property path. This never accepts or evaluates caller JavaScript; path traversal uses V8 side-effect checking and reports accessors without reading them. Selecting an object returns its type; specify a deeper path to inspect a child value. Sensitive primitive values are omitted unless includeSensitiveValues is explicitly true. Same-process child-frame execution contexts are not yet selectable.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, path: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } }, frameTargetId: { type: "string" }, includeSensitiveValues: { type: "boolean" } }, required: ["evidenceId"], additionalProperties: false } },
  { name: "click_observed_element", description: "Perform one click on a target selected from retained evidence. The target must still appear in a fresh observation; current human-handoff and caller-intent policy are checked. Returns a post-action observation and requires the caller to verify the task outcome; it never reports task success.", inputSchema: { type: "object", properties: { ...targetIdOptional, goal: { type: "string", minLength: 1, maxLength: 2000 }, evidenceId: { type: "string" }, backendNodeId: { type: "integer", minimum: 0 }, frameTargetId: { type: "string" } }, required: ["goal", "evidenceId", "backendNodeId"], additionalProperties: false } },
  { name: "inspect_network_response", description: "Inspect one response selected from a retained networkActivity facet. No response body is fetched or returned unless includeSensitive is explicitly true; page responses may contain credentials or personal data. Output is capped at 256 KiB. Request and response headers are never returned.", inputSchema: { type: "object", properties: { ...targetIdOptional, evidenceId: { type: "string" }, requestId: { type: "string" }, includeSensitive: { type: "boolean" }, includeSensitiveUrlData: { type: "boolean" }, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } }, required: ["evidenceId", "requestId"], additionalProperties: false } },
  { name: "discover_application", description: "Run bounded autonomous discovery on an attached tab. Builds an application capability map from passive observations and safe same-origin link navigation. Returns discoveries and the capability map.", inputSchema: { type: "object", properties: { ...targetIdOptional, maxSteps: { type: "integer", minimum: 1, maximum: 16 }, maxLinksPerStep: { type: "integer", minimum: 1, maximum: 6 } }, additionalProperties: false } },
  { name: "investigate_failure", description: "Run a bounded bug-isolation investigation after a failed step or run. Classifies the failure, generates hypotheses, executes safe discriminating checks, and returns a qualified report.", inputSchema: { type: "object", properties: { ...targetIdOptional, runId: { type: "string" }, subject: { type: "string" }, reason: { type: "string" } }, required: ["subject", "reason"], additionalProperties: false } },
  { name: "start_test_run", description: "Start a declarative test workflow on an authorized attached tab. Requires a workflow object with id, name, and steps. Returns runId for status polling.", inputSchema: { type: "object", properties: { ...targetIdOptional, workflow: { type: "object" } }, required: ["workflow"], additionalProperties: false } },
  { name: "get_test_run", description: "Get the receipt for a started test run by runId.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "cancel_test_run", description: "Cancel a running test run by runId. Cancellation takes effect at the next step boundary.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "collect_diagnostics", description: "Collect from registered diagnostic sources for a test run. Uses contract-validated, run-scoped, metadata-first retrieval.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "get_test_report", description: "Generate a qualified diagnostic report for a completed test run. Returns findings, correlation summary, source access log, and limitations.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "list_pending_interventions", description: "List durable, resumable human interventions (waiting or acknowledged) across runs, with their exact completion conditions.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_pending_intervention", description: "Get one intervention record including its verified resume predicate.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "acknowledge_human_action", description: "Record that the operator believes the requested human action is complete. This does NOT resume execution; resume_run verifies the completion predicate first.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "request_operation_approval", description: "Request (do not grant) approval for an intervention's exact operation. An MCP client cannot approve its own requested effects; resolution requires an independently authenticated operator channel.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "reject_operation", description: "Reject and cancel a pending intervention.", inputSchema: { type: "object", properties: { interventionId: { type: "string" }, reason: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "resume_run", description: "Resume a suspended run: verifies the exact completion predicate (grant scope/expiry, authenticated session, attachment grant, or outcome reconciliation) with fresh evidence before admitting execution.", inputSchema: { type: "object", properties: { interventionId: { type: "string" } }, required: ["interventionId"], additionalProperties: false } },
  { name: "get_run_state", description: "Get the resumable state of a run (including suspended/waiting states).", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } },
  { name: "cancel_run", description: "Cancel a run or intervention. Cancellation is permitted during suspension.", inputSchema: { type: "object", properties: { runId: { type: "string" }, interventionId: { type: "string" } }, additionalProperties: false } },
  { name: "run_goal", description: "Run a natural-language navigation goal with bounded actions and scrolling, outcome verification, one recovery by default, and a policy gate that refuses sensitive actions not explicitly requested by the caller. Task continuation is stored locally using only a goal fingerprint and bounded continuation state; repeating the same goal on the same target resumes an incomplete task. A completed task is returned idempotently; set newTask=true to explicitly start it again. Tied targets stop unresolved and return evidence-linked backend/frame handles for caller inspection; select one with click_observed_element, which revalidates it before dispatch. Set reuseWorkflows=true to replay or record verified workflows; scroll-driven traces are not persisted until they have freshness checks. Configure ACTIVETAB_WORKFLOW_STORE first.", inputSchema: { type: "object", properties: { ...targetIdOptional, goal: { type: "string" }, maxActions: { type: "integer", minimum: 1, maximum: 10 }, maxScrolls: { type: "integer", minimum: 0, maximum: 8 }, reuseWorkflows: { type: "boolean" }, newTask: { type: "boolean" } }, required: ["goal"], additionalProperties: false } }
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
  if (name === "list_tabs") {
    if (extensionMode) return await extensionBroker.listTabs();
    if (!autoConnect) return await listTargets(endpoint);
    chromeConnection ??= await connectChromeAuto();
    return await listChromeTargets(chromeConnection);
  }
  if (name === "attach_tab") {
    const existing = sessions.get(args.targetId);
    if (existing?.attached) return { status: "attached", targetId: existing.target.id, url: existing.target.url };
    if (existing) {
      sessions.delete(args.targetId);
      await existing.close();
    }
    let target;
    if (extensionMode) {
      target = await extensionBroker.resolveTarget(args.targetId);
    } else if (autoConnect) {
      chromeConnection ??= await connectChromeAuto();
      target = await resolveChromeTarget(chromeConnection, args.targetId, process.env.ACTIVETAB_AUTHORIZED_TARGET_ID);
    } else target = await resolveAuthorizedTarget(endpoint, args.targetId, process.env.ACTIVETAB_AUTHORIZED_TARGET_ID);
    const session = await new BrowserSession(target).attach();
    sessions.set(target.id, session);
    return { status: "attached", targetId: target.id, url: target.url };
  }
  if (name === "detach_tab") {
    const session = sessions.get(args.targetId);
    if (!session) throw new Error("No explicitly authorized tab is attached for that targetId.");
    sessions.delete(args.targetId);
    try { await session.close(); }
    finally { if (extensionMode) await extensionBroker.detach(args.targetId); }
    return { status: "detached", targetId: args.targetId };
  }
  if (name === "start_test_run") {
    const session = selectBrowserSession(sessions, args.targetId);
    if (!session) throw new Error("No attached browser session available.");
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const collector = new DiagnosticCollector({ runId });
    createBrowserDiagnosticSources(session, collector);
    const correlator = new DiagnosticCorrelator();
    const controller = new AbortController();
    const runner = new TestRunner({ session, collector, correlator, signal: controller.signal, interventions: interventionStore });
    // The watcher stays bound to the run's exact session and realm-specific
    // verification, not to the first available session (P0-5).
    const runCtx = {
      ...interventionCtx,
      hasAttachmentGrant: async targetId => sessions.has(targetId)
        ? { ok: true }
        : { ok: false, reason: `No authorized attachment grant for target '${targetId}'.` },
      observe: async () => await session.observe().catch(() => null)
    };
    const runPromise = runner.run(args.workflow, { runId });
    testRuns.set(runId, {
      collector, correlator, controller, runPromise, session, runner,
      startedAt: new Date().toISOString(),
      resume: async (record) => {
        const receipt = await Promise.race([runPromise, Promise.resolve(null)]).catch(() => null);
        if (!receipt) return { resumed: false, reason: "Run receipt unavailable." };
        return await runner.resume(receipt, {
          verify: runCtx,
          workflow: args.workflow
        });
      },
      getState: async () => {
        const receipt = await Promise.race([runPromise, Promise.resolve(null)]).catch(() => null);
        return receipt?.status ?? "RUNNING";
      },
      cancel: async () => { controller.abort(); }
    });
    return { status: "started", runId };
  }
  if (name === "get_test_run") {
    const run = testRuns.get(args.runId);
    if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
    let receipt;
    try { receipt = await Promise.race([run.runPromise, Promise.resolve(null)]); } catch { receipt = null; }
    if (receipt) return receipt.toObject();
    return { runId: args.runId, status: "RUNNING", startedAt: run.startedAt };
  }
  if (name === "cancel_test_run") {
    const run = testRuns.get(args.runId);
    if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
    run.controller.abort();
    return { status: "cancel_requested", runId: args.runId };
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
  if (name === "discover_application") {
    const session = selectBrowserSession(sessions, args.targetId);
    const engine = new ApplicationDiscoveryEngine({
      session,
      maxSteps: args.maxSteps ?? 8,
      maxLinksPerStep: args.maxLinksPerStep ?? 4
    });
    return await engine.discover();
  }
  if (name === "investigate_failure") {
    const session = selectBrowserSession(sessions, args.targetId);
    const run = args.runId ? testRuns.get(args.runId) : null;
    const collector = run?.collector ?? null;
    const correlator = run?.correlator ?? new DiagnosticCorrelator();
    const engine = new InvestigationEngine({ collector, correlator });
    return await engine.investigate({ subject: args.subject, reason: args.reason, runId: args.runId ?? null });
  }
  if (name === "get_test_report") {
    const run = testRuns.get(args.runId);
    if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
    const receipt = await run.runPromise;
    const report = new DiagnosticReport({ runId: args.runId, title: `Test run: ${receipt.workflowName}` });
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
    report.setInvestigationStatus(receipt.status === "PASSED" ? INVESTIGATION_STATUS.COMPLETE : INVESTIGATION_STATUS.COMPLETE);
    return report.redacted();
  }
  const session = selectBrowserSession(sessions, args.targetId);
  if (name === "observe_page") return await session.observe({ includeScreenshot: args.includeScreenshot !== false });
  if (name === "get_evidence") return session.observer.getEvidence(args.evidenceId, { facets: args.facets, backendNodeId: args.backendNodeId, frameTargetId: args.frameTargetId, includeSensitiveFormValues: args.includeSensitiveFormValues === true, includeSensitivePageText: args.includeSensitivePageText === true, includeSensitiveUrlData: args.includeSensitiveUrlData === true, includeSensitiveRuntimeValues: args.includeSensitiveRuntimeValues === true, includeScreenshot: args.includeScreenshot === true });
  if (name === "inspect_runtime_state") return await session.observer.inspectRuntimeState(args.evidenceId, { path: args.path, frameTargetId: args.frameTargetId ?? null, includeSensitiveValues: args.includeSensitiveValues === true });
  if (name === "click_observed_element") return await clickObservedElement(session, { goal: args.goal, evidenceId: args.evidenceId, backendNodeId: args.backendNodeId, frameTargetId: args.frameTargetId ?? null });
  if (name === "inspect_network_response") return await session.observer.inspectNetworkResponse(args.evidenceId, { requestId: args.requestId, includeSensitive: args.includeSensitive === true, includeSensitiveUrlData: args.includeSensitiveUrlData === true, maxBytes: args.maxBytes });
  if (name === "run_goal") {
    return await runMcpGoal(session, args, { journalStore: taskJournalStore, workflowStore });
  }
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
          if (requestId !== undefined) write({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
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
await chromeConnection?.close();
await extensionBroker?.close();
