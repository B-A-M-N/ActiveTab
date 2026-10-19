import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { canonicalJson } from "../telemetry/decisionEvents.js";
import { ProfileLoader } from "../testing/profiles.js";
import { buildEnvironmentBinding } from "../environments/model.js";
import { validateScenario } from "../../test-lab/runtime/scenario.js";
import { stateDirectory } from "../extension/paths.js";
import { indexMarkdownDocument, selectMarkdownRange, renderStructuredMarkdown } from "../observe/responseBodyInspector.js";
import { classifyCausalDivergence } from "./failureTaxonomy.js";

const ZERO_HASH = "0".repeat(64);
const SECRET_FIELD = /password|passwd|secret|token|credential|authorization|cookie|private.?key|csrf|xsrf/i;
const CONTENT_FIELD = /^(?:value|text|label|context|goal|prompt|answer|message|url)$/i;
const MAX_TRACE_EPISODES = 32;
const MAX_TRACE_EVENTS = 20_000;

function pathsFor({ cwd = process.cwd(), env = process.env } = {}) {
  const root = resolve(cwd);
  return {
    runStateDir: resolve(env.ACTIVETAB_RUN_STATE_DIR ?? join(root, ".activetab", "runs")),
    telemetryDb: resolve(env.ACTIVETAB_TELEMETRY_DB ?? join(root, ".activetab", "telemetry", "decision-events.sqlite")),
    reportDir: resolve(env.ACTIVETAB_REPORT_DIR ?? join(root, ".activetab", "reports"))
  };
}

async function inspectPath(path, expectedType) {
  try {
    const stat = await lstat(path);
    const typeMatches = expectedType === "directory" ? stat.isDirectory() : stat.isFile();
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    const mode = stat.mode & 0o777;
    const privatePermissions = process.platform === "win32" ? null : (mode & 0o077) === 0;
    return {
      status: stat.isSymbolicLink() ? "unsafe_symlink"
        : !typeMatches || !owned ? "unsafe_or_wrong_type"
          : privatePermissions === false ? "unsafe_permissions" : "available",
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      owned,
      privatePermissions,
      mode: mode.toString(8).padStart(4, "0")
    };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not_initialized" };
    return { status: "unavailable", reasonCode: error.code ?? "filesystem_error" };
  }
}

async function chromeBinary(env) {
  const candidates = [env.CHROME_PATH, env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .filter((value, index, all) => typeof value === "string" && value && all.indexOf(value) === index);
  for (const path of candidates) {
    try {
      await access(path, fsConstants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Keep checking known platform paths without invoking Chrome. */ }
  }
  return null;
}

function doctorCheck(id, status, detail, recommendation = null, severity = "info", metadata = {}) {
  return { id, status, severity, detail, ...(recommendation ? { recommendation } : {}), ...metadata };
}

async function inspectJevCredential({ cwd, env }) {
  let candidates;
  if (env.ACTIVETAB_JEV_KEY_FILE) candidates = [resolve(env.ACTIVETAB_JEV_KEY_FILE)];
  else {
    const workingDirectoryFile = resolve(cwd, "JEV.txt");
    try {
      await lstat(workingDirectoryFile);
      candidates = [workingDirectoryFile];
    } catch (error) {
      if (error.code !== "ENOENT") return { status: "unavailable", reasonCode: error.code ?? "credential_file_unavailable" };
      candidates = [join(homedir(), "JEV.txt")];
    }
  }
  for (const path of candidates) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") continue; return { status: "unavailable", reasonCode: error.code ?? "credential_file_unavailable" }; }
    if (!info.isFile() || info.isSymbolicLink()) return { status: "invalid", reasonCode: "credential_file_not_regular" };
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return { status: "unsafe_permissions", reasonCode: "credential_file_not_owner_only" };
    if (info.size > 4096) return { status: "invalid", reasonCode: "credential_file_too_large" };
    let contents;
    try { contents = await readFile(path, "utf8"); }
    catch (error) { return { status: "unavailable", reasonCode: error.code ?? "credential_file_unavailable" }; }
    const lines = contents.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    if (lines.length !== 1) return { status: "invalid", reasonCode: "credential_file_format_invalid" };
    const separator = lines[0].indexOf("=");
    let key = lines[0];
    if (separator >= 0) {
      const name = lines[0].slice(0, separator).trim();
      if (name !== "OPENROUTER_API_KEY" && name !== "JEV_API_KEY") return { status: "invalid", reasonCode: "credential_file_format_invalid" };
      key = lines[0].slice(separator + 1).trim();
    }
    if (!key || key.length > 512 || /\s/u.test(key)) return { status: "invalid", reasonCode: "credential_file_format_invalid" };
    return { status: "configured", source: "owner_only_file" };
  }
  if (env.OPENROUTER_API_KEY || env.JEV_API_KEY) return { status: "configured", source: "environment" };
  return { status: "not_configured", source: "none" };
}

async function inspectProfiles(profilesDir, profileId) {
  const loader = new ProfileLoader(profilesDir);
  const profiles = await loader.listProfiles();
  const profileIds = profiles.map(profile => profile.profile_id).filter(id => typeof id === "string").sort();
  if (!profileId) return { status: profileIds.length ? "selection_required" : "not_configured", profileIds };
  const profile = profiles.find(item => item.profile_id === profileId);
  if (!profile) return { status: "invalid", profileIds, reasonCode: "selected_profile_missing" };
  try {
    const binding = buildEnvironmentBinding(profile);
    return {
      status: "available",
      profileIds,
      profileId,
      environmentId: binding.environmentId,
      applicationIds: (binding.applications ?? []).map(application => application.applicationId).filter(Boolean)
    };
  } catch {
    return { status: "invalid", profileIds, profileId, reasonCode: "selected_profile_binding_invalid" };
  }
}

async function inspectFixtureCatalog(directory) {
  let files;
  try { files = await readdir(directory); }
  catch (error) {
    if (error.code === "ENOENT") return { status: "not_configured", scenarioCount: 0, invalidScenarioCount: 0 };
    return { status: "unavailable", reasonCode: error.code ?? "fixture_catalog_unavailable", scenarioCount: 0, invalidScenarioCount: 0 };
  }
  let scenarioCount = 0;
  let invalidScenarioCount = 0;
  for (const file of files.filter(name => name.endsWith(".json")).slice(0, 500)) {
    try {
      const scenario = JSON.parse(await readFile(join(directory, file), "utf8"));
      const validation = validateScenario(scenario);
      if (validation.valid) scenarioCount++;
      else invalidScenarioCount++;
    } catch { invalidScenarioCount++; }
  }
  return {
    status: scenarioCount > 0 && invalidScenarioCount === 0 ? "available"
      : invalidScenarioCount ? "invalid" : "not_configured",
    scenarioCount,
    invalidScenarioCount
  };
}

async function inspectBrokerSocket(path) {
  try {
    const info = await lstat(path);
    const owned = typeof process.getuid !== "function" || info.uid === process.getuid();
    const privatePermissions = process.platform === "win32" ? null : (info.mode & 0o077) === 0;
    if (info.isSymbolicLink() || !info.isSocket() || !owned) return { status: "unsafe", owned, privatePermissions };
    return { status: privatePermissions === false ? "unsafe_permissions" : "available", owned, privatePermissions };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not_running" };
    return { status: "unavailable", reasonCode: error.code ?? "broker_socket_unavailable" };
  }
}

/** Read-only preflight report. It never attaches to a browser or emits credentials or endpoints. */
export async function inspectOperatorEnvironment({
  cwd = process.cwd(), env = process.env, session = null, profileId = null,
  profilesDir = join(resolve(cwd), "profiles"), fixtureScenarioDir = join(resolve(cwd), "test-lab", "catalog", "scenarios"),
  extensionDir = join(resolve(cwd), "extension")
} = {}) {
  const paths = pathsFor({ cwd, env });
  let browserStateDir;
  let broker;
  try {
    browserStateDir = stateDirectory({ env });
    broker = await inspectBrokerSocket(join(browserStateDir, "extension-broker.sock"));
  } catch {
    broker = { status: "unavailable", reasonCode: "browser_state_directory_invalid" };
  }
  const [chrome, runState, telemetry, reports, jev, profiles, fixtureLab, extensionManifest] = await Promise.all([
    chromeBinary(env),
    inspectPath(paths.runStateDir, "directory"),
    inspectPath(paths.telemetryDb, "file"),
    inspectPath(paths.reportDir, "directory"),
    inspectJevCredential({ cwd, env }),
    inspectProfiles(profilesDir, profileId),
    inspectFixtureCatalog(fixtureScenarioDir),
    readFile(join(extensionDir, "manifest.json"), "utf8").then(JSON.parse).catch(() => null)
  ]);
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
  const modelEndpointConfigured = Boolean(env.ACTIVETAB_MODEL_ENDPOINT ?? env.ACTIVETAB_SEMANTIC_ENDPOINT);
  const modelId = env.ACTIVETAB_MODEL ?? env.ACTIVETAB_SEMANTIC_MODEL ?? (modelEndpointConfigured ? "glm-5.3-flash" : "");
  const modelConfigured = Boolean(modelId);
  const modelPageContentAllowed = env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT === "1";
  const modelCredentialConfigured = Boolean(env.ACTIVETAB_MODEL_API_KEY ?? env.ACTIVETAB_SEMANTIC_API_KEY ?? env.FREEINFERENCE_API_KEY);
  const imageProviderEnabled = env.ACTIVETAB_MODEL_IMAGE_INPUT === "1";
  const screenshotPrivacyEnabled = env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1";
  const screenshotReady = imageProviderEnabled && screenshotPrivacyEnabled && modelEndpointConfigured && modelConfigured;
  const semanticConfigured = Boolean(env.ACTIVETAB_SEMANTIC_ENDPOINT ?? env.ACTIVETAB_MODEL_ENDPOINT);
  const semanticCredentialConfigured = modelCredentialConfigured;
  const workflowConfigured = Boolean(env.ACTIVETAB_WORKFLOW_ENDPOINT ?? env.ACTIVETAB_SEMANTIC_ENDPOINT ?? env.ACTIVETAB_MODEL_ENDPOINT);
  const permissions = Array.isArray(extensionManifest?.permissions) ? extensionManifest.permissions : [];
  const attached = session?.attached === true && typeof session?.target?.id === "string";
  const checks = [
    doctorCheck("node", nodeSupported ? "available" : "unsupported", process.version,
      nodeSupported ? null : "Use Node.js 22.5 or newer.", nodeSupported ? "info" : "error"),
    doctorCheck("chrome", chrome ? "available" : "missing", chrome ? basename(chrome) : "No executable Chrome binary was found.",
      chrome ? null : "Install Chromium or set CHROME_PATH; an explicitly attached Chrome tab can also supply the browser session.", chrome ? "info" : "warning"),
    doctorCheck("browser_mode", "configured", env.ACTIVETAB_HEADLESS === "1" ? "headless (explicit opt-in)" : "headed (default)"),
    doctorCheck("cdp_session", attached ? "attached" : "not_attached",
      attached ? "A caller-provided session is attached to an exact target." : "Doctor does not probe or attach to browser targets.",
      attached ? null : "Select an owned browser target or attach the exact tab through the ActiveTab extension before running browser work.", attached ? "info" : "warning",
      attached ? { targetBound: true } : { targetBound: false }),
    doctorCheck("browser_permissions", permissions.includes("debugger") ? "consent_required" : "extension_permission_missing",
      permissions.includes("debugger") ? "The extension declares debugger permission; Chrome grants it only after the tab-specific Attach action." : "The extension manifest does not declare debugger permission.",
      permissions.includes("debugger") ? "Open the ActiveTab extension and attach each intended tab explicitly." : "Rebuild or reinstall the ActiveTab extension with its declared debugger permission.", permissions.includes("debugger") ? "warning" : "error",
      { debuggerPermissionDeclared: permissions.includes("debugger"), brokerStatus: broker.status, liveGrantInspected: false }),
    doctorCheck("model_provider", modelEndpointConfigured && modelConfigured ? "configured" : "not_configured",
      modelEndpointConfigured && modelConfigured
        ? modelPageContentAllowed ? "Secondary endpoint and model are configured; automatic planning may send bounded page evidence." : "Secondary endpoint and model are configured, but automatic planning remains local until page-content consent is enabled."
        : "The deterministic local planner remains available; secondary planning is not configured.",
      modelEndpointConfigured && modelConfigured ? modelPageContentAllowed ? null : "Set ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1 before enabling automatic page-evidence requests." : "Set ACTIVETAB_MODEL_ENDPOINT or ACTIVETAB_SEMANTIC_ENDPOINT to enable secondary planning.", modelEndpointConfigured && modelConfigured ? "info" : "warning",
      { endpointConfigured: modelEndpointConfigured, modelConfigured, pageContentConsent: modelPageContentAllowed, credentialConfigured: modelCredentialConfigured }),
    doctorCheck("image_support", screenshotReady ? "configured" : imageProviderEnabled || screenshotPrivacyEnabled ? "incomplete_configuration" : "disabled",
      screenshotReady ? "Image input is declared for the configured provider and screenshot privacy opt-in is enabled; verify the selected route with a live provider pretest." : "Screenshots reach a model only when image input and the separate screenshot privacy opt-in are both enabled.",
      screenshotReady ? "Run the provider pretest against the configured production route before relying on image input." : "Set ACTIVETAB_MODEL_IMAGE_INPUT=1 and ACTIVETAB_MODEL_ALLOW_SCREENSHOTS=1 only for a provider and task approved to receive screenshots.", screenshotReady ? "info" : "warning",
      { providerImageInput: imageProviderEnabled, screenshotPrivacyOptIn: screenshotPrivacyEnabled, endpointConfigured: modelEndpointConfigured, modelConfigured }),
    doctorCheck("semantic_model", semanticConfigured ? "configured" : "not_configured",
      semanticConfigured ? "Semantic page/control annotations have an endpoint." : "Optional semantic annotations are disabled.",
      semanticConfigured ? null : "Set ACTIVETAB_SEMANTIC_ENDPOINT (or ACTIVETAB_MODEL_ENDPOINT) to enable semantic annotations.", semanticConfigured ? "info" : "warning",
      { endpointConfigured: semanticConfigured, credentialConfigured: semanticCredentialConfigured }),
    doctorCheck("workflow_model", workflowConfigured ? "configured" : "not_configured",
      workflowConfigured ? "Workflow synthesis endpoint and model are configured." : "Optional workflow synthesis is disabled.",
      workflowConfigured ? null : "Set a workflow, semantic, or model endpoint and model to enable synthesis.", workflowConfigured ? "info" : "warning"),
    doctorCheck("jev_reviewer", jev.status, jev.status === "configured" ? "Pinned Jev reviewer credential is available locally." : "Pinned Jev review is advisory and will be unavailable without a valid local credential.",
      jev.status === "configured" ? null : jev.status === "not_configured" ? "Configure an owner-only ACTIVETAB_JEV_KEY_FILE or OPENROUTER_API_KEY if Jev reviews are required." : "Repair the owner-only Jev credential configuration.", jev.status === "configured" ? "info" : "warning",
      { model: "typesafe/jev-1.14", credentialSource: jev.source, credentialValueExposed: false }),
    doctorCheck("policy_bindings", profiles.status, profiles.status === "available"
      ? `Profile ${profiles.profileId} binds environment ${profiles.environmentId}.`
      : `${profiles.profileIds.length} local profiles are available; no valid profile was selected.`,
    profiles.status === "available" ? null : "Pass --profile ID to validate the exact local environment binding used by a task.", profiles.status === "invalid" ? "error" : "warning",
    { profileIds: profiles.profileIds, ...(profiles.status === "available" ? { profileId: profiles.profileId, environmentId: profiles.environmentId, applicationIds: profiles.applicationIds } : {}), ...(profiles.reasonCode ? { reasonCode: profiles.reasonCode } : {}) }),
    doctorCheck("run_state", runState.status, runState.status === "available" ? "Durable run state is owner-only and available." : "Durable run state has not been initialized.",
      runState.status === "available" ? null : "A run will initialize the private state directory on first use.", ["unsafe_symlink", "unsafe_or_wrong_type", "unsafe_permissions", "unavailable"].includes(runState.status) ? "error" : "info",
      { directory: paths.runStateDir, privatePermissions: runState.privatePermissions ?? null }),
    doctorCheck("decision_trace", telemetry.status, telemetry.status === "available" ? "Append-only decision trace exists." : "No local decision trace has been written yet.",
      telemetry.status === "available" ? null : "A run with decision telemetry will create the local trace database.", ["unsafe_symlink", "unsafe_or_wrong_type", "unsafe_permissions", "unavailable"].includes(telemetry.status) ? "error" : "info",
      { file: paths.telemetryDb, privatePermissions: telemetry.privatePermissions ?? null }),
    doctorCheck("fixture_lab", fixtureLab.status, `${fixtureLab.scenarioCount} valid scenarios; ${fixtureLab.invalidScenarioCount} invalid scenarios.`,
      fixtureLab.status === "available" ? null : "Restore or correct the local test-lab/catalog/scenarios entries before qualifying capabilities.", fixtureLab.status === "invalid" ? "error" : "warning", fixtureLab),
    doctorCheck("output_storage", reports.status, reports.status === "available" ? "Report storage exists with owner-only access." : "Report storage has not been initialized.",
      reports.status === "available" ? null : "A diagnostic or test run will create the private report directory when needed.", ["unsafe_symlink", "unsafe_or_wrong_type", "unsafe_permissions", "unavailable"].includes(reports.status) ? "error" : "info",
      { directory: paths.reportDir, privatePermissions: reports.privatePermissions ?? null })
  ];
  const status = checks.some(check => check.severity === "error") ? "attention"
    : checks.some(check => check.severity === "warning") ? "needs_action" : "ok";
  return { status, generatedAt: new Date().toISOString(), checks };
}

function requireRunId(runId) {
  if (typeof runId !== "string" || runId.length < 1 || runId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(runId)) {
    throw new Error("runId must be a bounded identifier without path separators.");
  }
  return runId;
}

function safeString(value, maxLength = 160) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function projectRun(run) {
  return {
    runId: run.runId,
    episodeId: safeString(run.episodeId),
    status: safeString(run.status, 64),
    revision: Number.isSafeInteger(run.revision) ? run.revision : null,
    workflow: {
      id: safeString(run.workflowId),
      name: safeString(run.workflowName, 160),
      version: safeString(run.workflowVersion, 96),
      hash: safeString(run.workflowHash, 128)
    },
    binding: {
      environmentId: safeString(run.environmentId),
      profileId: safeString(run.profileId),
      principalId: safeString(run.principalId),
      targetId: safeString(run.target?.targetId),
      targetFencingToken: Number.isSafeInteger(run.target?.fencingToken) ? run.target.fencingToken : null,
      policyVersion: safeString(run.policyVersion)
    },
    progress: {
      currentStepId: safeString(run.currentStepId),
      completedSteps: (Array.isArray(run.completedSteps) ? run.completedSteps : []).slice(-256).map(step => ({
        stepId: safeString(step.stepId, 160),
        type: safeString(step.type, 64),
        status: safeString(step.status, 64),
        evidenceIds: (Array.isArray(step.evidenceIds) ? step.evidenceIds : []).filter(id => typeof id === "string").slice(0, 20),
        updatedAt: safeString(step.updatedAt, 64)
      })),
      pendingOperations: (Array.isArray(run.pendingOperations) ? run.pendingOperations : []).map(operation => ({
        operationId: safeString(operation.operationId),
        stepId: safeString(operation.stepId, 160),
        action: safeString(operation.action, 64),
        status: safeString(operation.status, 64),
        receiptId: safeString(operation.receiptId),
        reservedAt: safeString(operation.reservedAt, 64),
        dispatchedAt: safeString(operation.dispatchedAt, 64)
      })),
      uncertainOperationIds: (Array.isArray(run.uncertainOperations) ? run.uncertainOperations : []).map(operation => safeString(operation.operationId)).filter(Boolean),
      latestVerifiedEvidenceId: safeString(run.latestVerifiedEvidenceId),
      diagnosticProgress: {
        collectedSources: (Array.isArray(run.diagnosticProgress?.collectedSources) ? run.diagnosticProgress.collectedSources : []).filter(id => typeof id === "string"),
        lastCollectedAt: safeString(run.diagnosticProgress?.lastCollectedAt, 64)
      }
    },
    cleanup: (Array.isArray(run.testOwnedResources) ? run.testOwnedResources : []).map(resource => ({
      resourceId: safeString(resource.resourceId),
      type: safeString(resource.type, 64),
      cleanupStatus: safeString(resource.cleanupStatus, 64),
      expiresAt: safeString(resource.expiresAt, 64)
    })),
    createdAt: safeString(run.createdAt, 64),
    updatedAt: safeString(run.updatedAt, 64)
  };
}

function projectResumeSafety(run) {
  const unresolved = (run.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
  const unverifiedCleanup = (run.testOwnedResources ?? []).filter(resource => resource.cleanupStatus !== "verified");
  if (unresolved.length) return {
    status: "unsafe_pending_reconciliation",
    reasonCode: "operation_outcome_unresolved",
    operationIds: unresolved.map(operation => operation.operationId).filter(Boolean).slice(0, 64)
  };
  if (unverifiedCleanup.length) return {
    status: "unsafe_cleanup_unverified",
    reasonCode: "test_owned_resource_cleanup_unverified",
    resourceIds: unverifiedCleanup.map(resource => resource.resourceId).filter(Boolean).slice(0, 64)
  };
  if (["running", "created", "discovering", "dispatching", "uncertain", "reconciling"].includes(run.status)) {
    return { status: "wait_for_current_run", reasonCode: "run_not_settled" };
  }
  if (String(run.status).startsWith("waiting_for_")) {
    return { status: "requires_human_action", reasonCode: "human_intervention_pending" };
  }
  if (["passed", "failed", "blocked", "canceled", "expired"].includes(run.status)) {
    return { status: "terminal", reasonCode: "run_is_terminal" };
  }
  return {
    status: "requires_exact_workflow_and_fresh_evidence",
    reasonCode: "resume_requires_rebinding_and_reobservation",
    workflowHashAvailable: typeof run.executionContract?.workflowHash === "string" || typeof run.workflowHash === "string"
  };
}

function eventEvidenceRefs(event) {
  const payload = event.payload ?? {};
  return [event.observationId, ...(Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : []),
    ...(Array.isArray(payload.inputEventIds) ? payload.inputEventIds : []),
    ...(Array.isArray(payload.sourceEventIds) ? payload.sourceEventIds : [])]
    .filter(value => typeof value === "string" && value.length <= 128);
}

function usageTotals(events) {
  const total = { modelCallCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };
  const calls = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    if (!payload.usage || typeof payload.usage !== "object") continue;
    const usage = payload.usage;
    const inputTokens = usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;
    const cachedInputTokens = usage.cachedInputTokens ?? usage.cached_tokens ?? usage.cached_input_tokens ?? 0;
    const cost = usage.cost ?? 0;
    total.modelCallCount++;
    total.inputTokens += Number.isFinite(inputTokens) ? inputTokens : 0;
    total.outputTokens += Number.isFinite(outputTokens) ? outputTokens : 0;
    total.cachedInputTokens += Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0;
    total.cost += Number.isFinite(cost) ? cost : 0;
    calls.push({
      eventId: event.eventId,
      eventType: event.eventType,
      model: payload.model ?? payload.analyzerModel ?? null,
      provider: payload.provider ?? payload.analyzerProvider ?? null,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
      cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : null,
      cost: Number.isFinite(cost) ? cost : null
    });
  }
  return { ...total, cost: Number(total.cost.toFixed(8)), calls };
}

function summarizeEpisodeCausality(events) {
  const divergence = [...events].sort((a, b) => a.sequence - b.sequence)
    .map(event => ({ event, finding: classifyCausalDivergence(event) }))
    .find(item => item.finding !== null) ?? null;
  const policy = events.filter(event => event.eventType === "policy.adjudicated").at(-1) ?? null;
  const dispatch = events.filter(event => event.eventType === "execution.dispatched").at(-1) ?? null;
  const verification = events.filter(event => event.eventType === "verification.completed").at(-1) ?? null;
  const plan = events.filter(event => event.eventType === "workflow.plan_synthesized").at(-1) ?? null;
  const jevReviews = [...new Set(events.filter(event => ["decision.predicted", "decision.failed", "decision.skipped"].includes(event.eventType)
    && event.decisionId).map(event => event.decisionId))].map(decisionId => {
    const reviewEvents = events.filter(event => event.decisionId === decisionId
      && ["decision.predicted", "decision.failed", "decision.skipped"].includes(event.eventType));
    const predictions = reviewEvents.filter(event => event.eventType === "decision.predicted");
    const failure = reviewEvents.find(event => event.eventType === "decision.failed" || event.eventType === "decision.skipped");
    const dispositions = [...new Set(predictions.map(event => event.payload.reviewDisposition).filter(Boolean))];
    return {
      decisionId,
      eventIds: reviewEvents.map(event => event.eventId),
      model: predictions[0]?.payload.model ?? failure?.payload.model ?? null,
      disposition: dispositions.length === 1 ? dispositions[0] : failure ? "advisory_only" : null,
      rubricIds: [...new Set(reviewEvents.map(event => event.payload.rubricId).filter(Boolean))],
      failureCode: failure?.payload.failureCode ?? failure?.payload.reasonCode ?? null
    };
  });
  const qualifications = events.filter(event => event.eventType === "qualification.completed").map(event => ({
    eventId: event.eventId,
    scenarioId: event.payload.scenarioId,
    providerId: event.payload.providerId,
    status: event.payload.qualificationStatus,
    reasonCode: event.payload.reasonCode,
    ...(Number.isSafeInteger(event.payload.fixtureSeed) ? { fixtureSeed: event.payload.fixtureSeed } : {}),
    ...(event.payload.qualificationLevel ? {
      qualificationLevel: event.payload.qualificationLevel,
      providerIdentity: event.payload.providerIdentity,
      scenarioSeed: event.payload.scenarioSeed,
      sourceRevision: event.payload.sourceRevision,
      oracleReference: event.payload.oracleReference,
      independentApplicationOutcome: event.payload.independentApplicationOutcome,
      cleanupResult: event.payload.cleanupResult
    } : {}),
    ...(typeof event.payload.applicationBuild === "string" ? { applicationBuild: event.payload.applicationBuild } : {}),
    evidenceRefs: event.payload.evidenceRefs ?? []
  }));
  const firstDivergence = divergence?.finding ?? null;
  const evidenceRefs = [...new Set(events.flatMap(eventEvidenceRefs))].slice(0, 512);
  const failureClassification = firstDivergence?.category ?? null;
  return {
    failureClassification,
    firstDivergence,
    authorizationResult: policy ? {
      eventId: policy.eventId,
      decisionId: policy.decisionId ?? null,
      stepId: policy.stepId ?? null,
      disposition: policy.payload.disposition,
      reasonCode: policy.payload.reasonCode
    } : null,
    dispatchResult: dispatch ? {
      eventId: dispatch.eventId,
      operationId: dispatch.payload.operationId,
      stepId: dispatch.stepId ?? null,
      dispatchStatus: dispatch.payload.dispatchStatus,
      operation: dispatch.payload.operation
    } : null,
    postcondition: verification ? {
      eventId: verification.eventId,
      decisionId: verification.decisionId ?? null,
      stepId: verification.stepId ?? null,
      status: verification.payload.status,
      oracleType: verification.payload.oracleType,
      reasonCode: verification.payload.reasonCode,
      evidenceRefs: verification.payload.evidenceRefs ?? []
    } : null,
    workflow: plan ? {
      eventId: plan.eventId,
      provider: plan.payload.provider,
      model: plan.payload.model,
      planHash: plan.payload.planHash,
      stepCount: plan.payload.stepCount,
      planProjection: plan.payload.planProjection ?? []
    } : null,
    jevReviews,
    modelAccounting: usageTotals(events),
    qualifications,
    evidenceRefs
  };
}

/** Inspect the bounded, redacted durable run projection without initializing or mutating state. */
export async function inspectDurableRun(runId, {
  runStateDir = resolve(process.env.ACTIVETAB_RUN_STATE_DIR ?? ".activetab/runs"),
  telemetryDb = resolve(process.env.ACTIVETAB_TELEMETRY_DB ?? join(process.cwd(), ".activetab", "telemetry", "decision-events.sqlite"))
} = {}) {
  const id = requireRunId(runId);
  const directory = resolve(runStateDir);
  const directoryStatus = await inspectPath(directory, "directory");
  if (directoryStatus.status === "not_initialized") return { status: "not_found", runId: id, reasonCode: "run_state_directory_missing" };
  if (directoryStatus.status !== "available") return { status: "unavailable", runId: id, reasonCode: "unsafe_run_state_directory" };
  const path = join(directory, `${id}.json`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      return { status: "unavailable", runId: id, reasonCode: "unsafe_run_state_file" };
    }
    if (stat.size > 64 * 1024) return { status: "unavailable", runId: id, reasonCode: "run_state_too_large" };
    const run = JSON.parse(await readFile(path, "utf8"));
    if (run?.runId !== id) return { status: "unavailable", runId: id, reasonCode: "run_id_mismatch" };
    const safeRun = projectRun(run);
    const trace = await exportRedactedTrace(id, { databasePath: telemetryDb });
    const matchingEpisodes = trace.status === "available"
      ? trace.episodes.filter(item => !run.episodeId || item.episode.episodeId === run.episodeId)
      : [];
    const eventCausality = matchingEpisodes[0]?.causal ?? null;
    const firstFailedPhase = safeRun.progress.completedSteps.find(step => !["PASS", "VERIFIED", "SKIPPED"].includes(step.status)) ?? null;
    return {
      status: "available",
      run: safeRun,
      failedPhase: firstFailedPhase,
      firstDivergence: eventCausality?.firstDivergence ?? null,
      failureClassification: eventCausality?.failureClassification ?? (firstFailedPhase?.status === "BLOCKED" ? "authorization_or_environment" : null),
      authorizationResult: eventCausality?.authorizationResult ?? null,
      dispatchResult: eventCausality?.dispatchResult ?? null,
      postcondition: eventCausality?.postcondition ?? null,
      workflow: eventCausality?.workflow ?? (run.workflowHash ? { hash: run.workflowHash, version: run.workflowVersion ?? null } : null),
      jevReview: eventCausality?.jevReviews ?? [],
      modelAccounting: eventCausality?.modelAccounting ?? { modelCallCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0, calls: [] },
      fixtureQualifications: eventCausality?.qualifications ?? [],
      evidenceRefs: eventCausality?.evidenceRefs ?? [...new Set([
        safeRun.progress.latestVerifiedEvidenceId,
        ...safeRun.progress.completedSteps.flatMap(step => step.evidenceIds),
        ...safeRun.progress.pendingOperations.map(operation => operation.receiptId)
      ].filter(Boolean))].slice(0, 512),
      resumeSafety: projectResumeSafety(run),
      traceStatus: trace.status,
      ...(trace.reasonCode ? { traceReasonCode: trace.reasonCode } : {})
    };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "not_found", runId: id, reasonCode: "run_state_missing" };
    if (error instanceof SyntaxError) return { status: "unavailable", runId: id, reasonCode: "run_state_invalid_json" };
    return { status: "unavailable", runId: id, reasonCode: error.code ?? "run_state_unavailable" };
  }
}

function redactTrace(value, key = "") {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const usageMetric = /^(?:input|output|cached_input|prompt|completion|total)_tokens?$/.test(normalizedKey);
  if (key && (CONTENT_FIELD.test(key) || SECRET_FIELD.test(key) && !usageMetric)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactTrace(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactTrace(child, childKey)]));
}

function eventFromRow(row) {
  return {
    eventId: row.event_id,
    episodeId: row.episode_id,
    runId: row.run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.observation_id ? { observationId: row.observation_id } : {}),
    ...(row.parent_event_id ? { parentEventId: row.parent_event_id } : {}),
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    trainingEligibility: row.training_eligibility,
    payload: JSON.parse(row.payload_json),
    previousHash: row.previous_hash,
    eventHash: row.event_hash
  };
}

function verifyTraceEvents(events) {
  let previousHash = ZERO_HASH;
  for (let index = 0; index < events.length; index++) {
    const { eventHash, ...event } = events[index];
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) {
      return { ok: false, eventCount: events.length, sequence: event.sequence, reasonCode: "sequence_or_previous_hash_mismatch" };
    }
    const actualHash = createHash("sha256").update(`${previousHash}\n${canonicalJson(event)}`).digest("hex");
    if (actualHash !== eventHash) return { ok: false, eventCount: events.length, sequence: event.sequence, reasonCode: "event_hash_mismatch" };
    previousHash = eventHash;
  }
  return { ok: events.length > 0, eventCount: events.length, lastHash: previousHash, ...(events.length ? {} : { reasonCode: "episode_has_no_events" }) };
}

/** Export event lineage from an existing telemetry database using a read-only SQLite connection. */
export async function exportRedactedTrace(runId, {
  databasePath = resolve(process.env.ACTIVETAB_TELEMETRY_DB ?? join(process.cwd(), ".activetab", "telemetry", "decision-events.sqlite"))
} = {}) {
  const id = requireRunId(runId);
  const path = resolve(databasePath);
  const pathStatus = await inspectPath(path, "file");
  if (pathStatus.status === "not_initialized") return { status: "not_found", runId: id, reasonCode: "telemetry_database_missing" };
  if (pathStatus.status !== "available") return { status: "unavailable", runId: id, reasonCode: "unsafe_telemetry_database" };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const episodeRows = db.prepare("SELECT * FROM episodes WHERE run_id = ? ORDER BY created_at, episode_id").all(id);
    if (!episodeRows.length) return { status: "not_found", runId: id, reasonCode: "trace_missing" };
    if (episodeRows.length > MAX_TRACE_EPISODES) return { status: "unavailable", runId: id, reasonCode: "trace_episode_limit_exceeded" };
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM decision_events WHERE run_id = ?").get(id)?.count ?? 0;
    if (eventCount > MAX_TRACE_EVENTS) return { status: "unavailable", runId: id, reasonCode: "trace_event_limit_exceeded" };
    const episodes = episodeRows.map(episode => {
      const events = db.prepare("SELECT * FROM decision_events WHERE episode_id = ? ORDER BY sequence").all(episode.episode_id).map(eventFromRow);
      const integrity = verifyTraceEvents(events);
      const causal = summarizeEpisodeCausality(events);
      return {
        episode: {
          episodeId: episode.episode_id,
          runId: episode.run_id,
          workflowId: episode.workflow_id,
          applicationId: episode.application_id,
          environmentClass: episode.environment_class,
          executionMode: episode.execution_mode,
          policyVersion: episode.policy_version,
          status: episode.status,
          createdAt: episode.created_at,
          completedAt: episode.completed_at
        },
        integrity,
        causal,
        events: events.map(event => ({ ...event, payload: redactTrace(event.payload) }))
      };
    });
    const firstDivergence = episodes.map(item => item.causal.firstDivergence).find(Boolean) ?? null;
    const evidenceRefs = [...new Set(episodes.flatMap(item => item.causal.evidenceRefs))].slice(0, 1024);
    const modelAccounting = episodes.reduce((total, item) => {
      const usage = item.causal.modelAccounting;
      total.modelCallCount += usage.modelCallCount;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedInputTokens += usage.cachedInputTokens;
      total.cost += usage.cost;
      total.calls.push(...usage.calls);
      return total;
    }, { modelCallCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0, calls: [] });
    modelAccounting.cost = Number(modelAccounting.cost.toFixed(8));
    return {
      status: "available",
      runId: id,
      redacted: true,
      bundleVersion: 1,
      episodeCount: episodes.length,
      failureClassification: episodes.map(item => item.causal.failureClassification).find(Boolean) ?? null,
      firstDivergence,
      workflow: episodes.map(item => item.causal.workflow).filter(Boolean),
      jevReview: episodes.flatMap(item => item.causal.jevReviews),
      modelAccounting,
      fixtureQualifications: episodes.flatMap(item => item.causal.qualifications),
      evidenceRefs,
      episodes
    };
  } catch (error) {
    if (/no such table/i.test(String(error?.message))) return { status: "not_found", runId: id, reasonCode: "telemetry_database_uninitialized" };
    return { status: "unavailable", runId: id, reasonCode: error.code ?? "telemetry_read_failed" };
  } finally {
    db?.close();
  }
}

function appendStructuredSection(lines, title, value, { sectionLevel = 2 } = {}) {
  const dataHeadingLevel = Math.min(5, sectionLevel + 1);
  lines.push("", `${"#".repeat(sectionLevel)} ${title}`, "", renderStructuredMarkdown(value, {
    title: "Diagnostic structure",
    completeTitle: "Complete section data",
    headingLevel: dataHeadingLevel
  }));
}

function finishOperatorMarkdown(lines, { sectionId = null, listSections = false } = {}) {
  const markdown = lines.join("\n");
  if (!sectionId && !listSections) return markdown;
  const index = indexMarkdownDocument(markdown);
  if (listSections) {
    return ["# Markdown sections", "", "| ID | Parent | Heading | Level | Bytes |", "| --- | --- | --- | ---: | ---: |",
      ...index.sections.map(section => `| \`${section.id}\` | ${section.parentId ? `\`${section.parentId}\`` : ""} | ${String(section.title).replace(/[|\r\n]/g, " ")} | ${section.level} | ${section.subtreeByteLength} |`)
    ].join("\n");
  }
  const selected = selectMarkdownRange(markdown, index, { sectionId });
  if (selected) return selected.text;
  return `# Markdown section not found\n\nRequested section: \`${String(sectionId).replace(/[\r\n`]/g, "") }\`\n\nRun with \`--list-sections\` to inspect available section IDs.`;
}

function safeHeading(value) {
  return String(value ?? "unavailable").normalize("NFKC").replace(/[\r\n#<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "unavailable";
}

export function formatOperatorMarkdown(report, kind, options = {}) {
  const lines = [];
  if (kind === "doctor") {
    lines.push("# ActiveTab doctor", "", `Status: **${report.status}**`);
    for (const check of report.checks) {
      lines.push("", `## ${safeHeading(check.id)}`, "", `- Status: ${safeHeading(check.status)}`,
        `- Detail: ${safeHeading(check.detail ?? check.reasonCode ?? check.directory ?? check.file ?? "not reported")}`,
        ...(check.recommendation ? [`- Action: ${safeHeading(check.recommendation)}`] : []));
    }
    return finishOperatorMarkdown(lines, options);
  }
  if (kind === "inspect-run") {
    lines.push(`# Run ${safeHeading(report.run?.runId ?? report.runId)}`, "", `Status: **${safeHeading(report.status)}**`);
    if (report.status !== "available") {
      lines.push("", `Reason: \`${safeHeading(report.reasonCode)}\``);
      return finishOperatorMarkdown(lines, options);
    }
    appendStructuredSection(lines, "Run state", report.run);
    appendStructuredSection(lines, "Failure phase", report.failedPhase);
    appendStructuredSection(lines, "First divergence", report.firstDivergence);
    appendStructuredSection(lines, "Authorization and outcome", {
      authorizationResult: report.authorizationResult,
      dispatchResult: report.dispatchResult,
      postcondition: report.postcondition
    });
    appendStructuredSection(lines, "Workflow and review", { workflow: report.workflow, jevReview: report.jevReview });
    appendStructuredSection(lines, "Model accounting", report.modelAccounting);
    appendStructuredSection(lines, "Fixture qualifications", report.fixtureQualifications);
    appendStructuredSection(lines, "Evidence references", report.evidenceRefs);
    appendStructuredSection(lines, "Resume safety", report.resumeSafety);
    appendStructuredSection(lines, "Trace integrity", {
      traceStatus: report.traceStatus,
      ...(report.traceReasonCode ? { traceReasonCode: report.traceReasonCode } : {})
    });
    return finishOperatorMarkdown(lines, options);
  }
  lines.push(`# Redacted trace ${safeHeading(report.runId)}`, "", `Status: **${safeHeading(report.status)}**`);
  if (report.status !== "available") {
    lines.push("", `Reason: \`${safeHeading(report.reasonCode)}\``);
    return finishOperatorMarkdown(lines, options);
  }
  appendStructuredSection(lines, "Trace summary", {
    episodeCount: report.episodeCount,
    failureClassification: report.failureClassification,
    eventHashChainsVerified: report.episodes.every(item => item.integrity.ok)
  });
  appendStructuredSection(lines, "Causal bundle", {
    firstDivergence: report.firstDivergence,
    workflow: report.workflow,
    jevReview: report.jevReview,
    fixtureQualifications: report.fixtureQualifications,
    modelAccounting: report.modelAccounting,
    evidenceRefs: report.evidenceRefs
  });
  for (const [episodeIndex, { episode, integrity, events }] of report.episodes.entries()) {
    lines.push("", `## Episode ${episodeIndex + 1}`, "", `- Episode ID: \`${safeHeading(episode.episodeId)}\``, `- Workflow: \`${safeHeading(episode.workflowId)}\``, `- Status: **${safeHeading(episode.status)}**`, `- Chain integrity: **${integrity.ok ? "verified" : "failed"}**`);
    appendStructuredSection(lines, `Episode ${episodeIndex + 1} metadata`, { episode, integrity }, { sectionLevel: 3 });
    for (const event of events) {
      appendStructuredSection(lines, `Event ${event.sequence}`, {
        eventId: event.eventId,
        eventType: event.eventType,
        stepId: event.stepId,
        decisionId: event.decisionId,
        observationId: event.observationId,
        parentEventId: event.parentEventId,
        payload: event.payload
      }, { sectionLevel: 3 });
    }
  }
  return finishOperatorMarkdown(lines, options);
}
