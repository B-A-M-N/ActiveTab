/**
 * Cloud Agent operational qualification (P0-3 / P1-3 / P1-5).
 *
 * Shared runtime module used by BOTH the node:test wrapper
 * (test/cloud-agent-e2e.test.js) and the standalone single-invocation
 * entrypoint (scripts/qualify-staging.mjs). The function never depends
 * on the test-runner `t` object.
 *
 * The workflow operates the REAL FreeInference staging website
 * (https://staging.freeinference.org → Agents) in a headed browser. A
 * localhost fixture or tunneled backend UI can never substitute for it.
 *
 * Honest gating (P1-3 / P1-5): each evidence gate below is separate and
 * named. A PASS is claimed ONLY when every mandatory gate passed:
 * environment identity, real site reached, Agents entered, an actual
 * test-owned Cloud Agent operation executed, its application-level result
 * independently verified, and cleanup verified. Reaching Agents or
 * discovering controls is NEVER reported as operational qualification.
 *
 * Qualification states: PASSED, FAILED, WAITING_FOR_HUMAN, BLOCKED,
 * UNCERTAIN, CANCELED. An UNCERTAIN step remains unresolved.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

import { TestRunner } from "./runner.js";
import { TestReceipt } from "./receipts.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { loadEnvironmentBinding } from "./profiles.js";
import { verifyObservedUrl, isLoopbackUrl } from "../environments/model.js";
import { classifyHumanHandoff } from "../navigation/handoff.js";
import { RUN_STATUS, isWaitingRunStatus } from "./schema.js";

const QUALIFICATION_STATES = Object.freeze({
  PASSED: "PASSED",
  FAILED: "FAILED",
  WAITING_FOR_HUMAN: "WAITING_FOR_HUMAN",
  BLOCKED: "BLOCKED",
  UNCERTAIN: "UNCERTAIN",
  CANCELED: "CANCELED"
});

const MANDATORY_GATES = Object.freeze([
  "environment_identity_verified",
  "real_staging_site_reached",
  "agents_application_entered",
  "cloud_agent_operation_executed",
  "operation_result_independently_verified",
  "cleanup_verified"
]);


const DIAGNOSTIC_SURFACE_HINT = /\b(?:admin|diagnostic|logs?|history|requests?|activity|events?|audit|analytics|usage|metrics?|traces?|monitor(?:ing)?|observability|executions?|runs?|reports?|errors?|failures?|workers?|queues?)\b/i;
const TASK_HISTORY_HINT = /\b(?:tasks?|jobs?)\b/i;
const SAFE_SURFACE_TERMS = /\b(?:admin|console|dashboard|diagnostics?|logs?|history|requests?|activity|events?|audit|analytics|usage|metrics?|traces?|monitor(?:ing)?|observability|executions?|runs?|reports?|errors?|failures?|workers?|queues?|tasks?|jobs?|recent|completed|failed|view|page|panel)\b/ig;

function redactPath(pathname) {
  return pathname.split("/").map(segment => {
    if (!segment) return segment;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || /^\d{4,}$/.test(segment) || segment.length > 64) return ":id";
    return segment;
  }).join("/");
}

function resumeCursorFor(receipt, statusOverride = null) {
  if (!receipt) return null;
  const suspended = [...receipt.steps].reverse().find(step => step.status === "SUSPENDED");
  if (!suspended) return null;
  const object = receipt.toObject();
  return {
    schemaVersion: 1,
    suspendedStepId: suspended.stepId,
    receipt: {
      runId: object.runId,
      workflowId: object.workflowId,
      workflowName: object.workflowName,
      startedAt: object.startedAt,
      finishedAt: null,
      status: statusOverride ?? object.status,
      steps: object.steps.map(step => ({
        stepId: step.stepId,
        type: step.type,
        status: step.status,
        evidenceIds: (step.evidenceIds ?? []).slice(0, 20),
        startedAt: step.startedAt,
        finishedAt: step.finishedAt
      })),
      cleanup: [],
      interventions: object.interventions.map(item => ({
        stepId: item.stepId,
        interventionId: item.interventionId,
        type: item.type,
        state: item.state,
        externalState: item.externalState
      })),
      limitations: []
    }
  };
}

/**
 * Inventory only visible, relevant links from the current page. This is a
 * discovery hint for an operator: it never opens a link or reads its target.
 */
export function discoverVisibleDiagnosticSurfaces(observation, environment) {
  const allowedOrigins = new Set(environment?.authorizedOrigins ?? []);
  const seen = new Set();
  const surfaces = [];
  for (const candidate of observation?.candidates ?? []) {
    if (candidate.visible !== true || (!candidate.href && String(candidate.role).toLowerCase() !== "link")) continue;
    const label = String(candidate.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    let destination = null;
    let pathname = "";
    if (candidate.href) {
      try {
        const url = new URL(candidate.href, observation?.page?.url);
        if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) continue;
        pathname = url.pathname;
        destination = `${url.origin}${redactPath(pathname)}`;
      } catch { continue; }
    }
    const taskHistoryLabel = TASK_HISTORY_HINT.test(label) && /\b(?:history|recent|past|completed|failed|runs?)\b/i.test(label);
    if (!label || (!DIAGNOSTIC_SURFACE_HINT.test(label) && !DIAGNOSTIC_SURFACE_HINT.test(pathname) && !taskHistoryLabel)) continue;
    const safeTerms = [...label.matchAll(SAFE_SURFACE_TERMS)].map(match => match[0]);
    const pathTerms = [...pathname.matchAll(SAFE_SURFACE_TERMS)].map(match => match[0]);
    const reportedLabel = (safeTerms.length ? safeTerms : pathTerms).join(" ").slice(0, 120);
    const key = `${label.toLowerCase()}|${destination ?? "no-href"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let sourceOrigin = null;
    let sourcePage = null;
    try {
      const sourceUrl = new URL(observation?.page?.url);
      sourceOrigin = sourceUrl.origin;
      sourcePage = `${sourceUrl.origin}${redactPath(sourceUrl.pathname)}`;
    } catch { /* keep source unknown */ }
    surfaces.push({
      sourceOrigin,
      sourcePage,
      label: reportedLabel || "diagnostic candidate",
      role: String(candidate.role ?? "link").slice(0, 32),
      destination,
      category: /\badmin\b/i.test(`${label} ${pathname}`) ? "admin-entry" : "diagnostic-candidate",
      action: "not opened"
    });
    if (surfaces.length >= 20) break;
  }
  return surfaces;
}

/** Bounded wait for the page to finish loading (origin is 'null' mid-load). */
async function observeLoadedPage(session, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const observation = await session.observe().catch(() => null);
    last = observation;
    const url = observation?.page?.url;
    if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) return observation;
    await new Promise(r => setTimeout(r, 250));
  }
  return last;
}

/** Return a profile identity hint. This URL is never used as a navigation target. */
export function resolveCloudAgentEntry(environment) {
  const app = (environment?.applications ?? []).find(item => item.applicationId === "fi-agents");
  if (!app?.candidateEntry) return null;
  let url;
  try { url = new URL(app.candidateEntry, environment.applicationEntryUrl); }
  catch { throw new Error("The profile's Cloud Agent entry is not a valid URL."); }
  const identity = verifyObservedUrl(environment, url.href);
  if (!identity.ok) throw new Error(`The profile's Cloud Agent entry is not authorized: ${identity.reason}`);
  return { url: url.href, origin: url.origin, applicationId: app.applicationId, authenticationRealm: app.authenticationRealm ?? "agents-session" };
}

/** The actual Agent destination must be reached through the staging UI. */
export function verifyCloudAgentReady(observation, environment, expectedOrigin) {
  const url = observation?.page?.url;
  const identity = verifyObservedUrl(environment, url);
  if (!identity.ok) return { ok: false, reason: identity.reason ?? "Observed URL is outside the authorized staging environment." };
  if (expectedOrigin && identity.origin !== expectedOrigin) {
    return { ok: false, reason: `Observed application origin '${identity.origin}' does not match the profile's Cloud Agent identity hint.` };
  }
  if (!/\bagent\b/i.test(String(observation?.page?.title ?? ""))) {
    return { ok: false, reason: "The observed page title does not identify the Cloud Agent application." };
  }
  if (!hasCloudAgentTaskComposer(observation)) {
    return { ok: false, reason: "The protected Cloud Agent task composer is not visible yet." };
  }
  return { ok: true, origin: identity.origin, evidenceId: observation.evidenceId ?? null };
}

/** Positive UI evidence that the protected task application, not its login page, is ready. */
export function hasCloudAgentTaskComposer(observation) {
  const candidates = observation?.candidates ?? [];
  const hasNewTaskControl = candidates.some(candidate =>
    candidate.visible !== false && /\bnew task\b/i.test(String(candidate.name ?? ""))
  );
  const hasTaskInput = candidates.some(candidate =>
    candidate.visible !== false && candidate.disabled !== true &&
    String(candidate.role ?? "").toLowerCase() === "textbox"
  );
  return hasNewTaskControl && hasTaskInput;
}

/** Build a workflow that follows visible UI navigation and never auto-navigates to candidate_entry. */
export function createCloudAgentEntryWorkflow(environment, observation) {
  const agentEntry = resolveCloudAgentEntry(environment);
  if (!agentEntry) return null;
  const alreadyAtComposer = verifyCloudAgentReady(observation, environment, agentEntry.origin).ok;
  const steps = [];
  if (!alreadyAtComposer) {
    steps.push({
      type: "goal",
      id: "follow-visible-agents-route",
      goal: "Follow the visible Cloud Agents link from the current FreeInference staging page, complete the visible Agent login link if required, and reach the Cloud Agent task composer",
      intervention: {
        type: "authentication",
        realm: agentEntry.authenticationRealm,
        requiredAction: "In the open browser, finish the current login if needed, return to the staging page, click its visible Cloud Agents link, then click the Agent page's visible login link. Stop when the Cloud Agent task composer is visible.",
        condition: { type: "authenticated_session_check", realm: agentEntry.authenticationRealm }
      }
    });
  }
  steps.push({
    id: "verify-task-composer",
    type: "assert",
    assertion: { type: "candidate_name_contains", value: "new task" }
  });
  return {
    agentEntry,
    alreadyAtComposer,
    workflow: {
      id: "cloud-agent-enter-agents",
      name: "Follow staging navigation and verify the Cloud Agent task composer",
      steps
    }
  };
}

/**
 * Execute the real Cloud Agent staging qualification.
 *
 * @param {object} options
 * @param {object} options.session - Authorized attached BrowserSession.
 * @param {object} options.environment - Verified environment binding.
 * @param {InterventionStore} options.interventions - Durable store.
 * @param {object} [options.runStore] - Optional RunStateStore (durable mode).
 * @param {object} [options.diagnostics] - Optional DiagnosticCollector.
 * @param {object} [options.mode] - "test" | "owned" | "attached".
 * @param {Function} [options.onHumanIntervention] - Wait for an operator, then verify and resume.
 * @param {AbortSignal} [options.signal] - Cancellation.
 * @param {Function} [options.onEvent] - Progress callback (text) => {}.
 */
export async function qualifyCloudAgent({
  session,
  environment,
  interventions,
  runStore = null,
  resumeRunState = null,
  profileId = null,
  reportDir: reportDirOption = null,
  diagnostics = null,
  mode = "test",
  onHumanIntervention = null,
  signal,
  onEvent = null
}) {
  const emit = text => { if (typeof onEvent === "function") { try { onEvent(text); } catch { /* best-effort */ } } };
  let runState = resumeRunState;
  let runId = runState?.runId ?? `cloud-agent-staging-${randomUUID()}`;
  let resumeReceipt = null;
  let resumeError = null;
  if (resumeRunState) {
    try {
      if (resumeRunState.resumeCursor?.schemaVersion !== 1
        || resumeRunState.resumeCursor.suspendedStepId !== resumeRunState.suspendedStepId) {
        throw new Error("Suspended qualification has no valid resume cursor.");
      }
      resumeReceipt = TestReceipt.fromObject(resumeRunState.resumeCursor.receipt);
      if (resumeReceipt.runId !== resumeRunState.runId || !isWaitingRunStatus(resumeReceipt.status)) {
        throw new Error("Suspended qualification receipt identity or status is invalid.");
      }
    } catch (error) {
      resumeError = String(error?.message ?? error);
    }
  }
  const backendCorrelationRef = { value: null };
  const gates = {};
  const evidence = [];
  const steps = [];
  const limitations = [];
  const discoveries = { visibleDiagnosticSurfaces: [] };
  const gate = (name, passed, detail = null) => {
    gates[name] = { passed: passed === true, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
    emit(`${passed === true ? "PASS" : "FAIL"} gate: ${name}${detail ? ` — ${detail}` : ""}`);
    return passed === true;
  };

  if (resumeError) return finalize(QUALIFICATION_STATES.BLOCKED, { reason: resumeError });

  if (!session || session.attached !== true) {
    return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "No authorized attached browser session." });
  }
  if (!environment) {
    return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "No verified environment binding." });
  }
  if (resumeRunState && !runStore) {
    return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "Restart resume requires a durable RunStateStore." });
  }

  // Durable run-state cursor is independent of browser-profile persistence.
  if (runStore) {
    if (!runState) {
      runState = await runStore.create({
        workflowId: "cloud-agent-staging-qualification",
        workflowName: "Cloud Agent staging qualification",
        environmentId: environment.environmentId,
        authenticationRealm: "agents-session",
        targetId: session.target?.id ?? null,
        goalFingerprint: createHash("sha256").update(String(environment.applicationEntryUrl)).digest("hex").slice(0, 32),
        mode,
        profileId
      });
      runId = runState.runId;
    } else if (runState.workflowId !== "cloud-agent-staging-qualification"
      || runState.environmentId !== environment.environmentId
      || (profileId && runState.profileId !== profileId)
      || (runState.mode && runState.mode !== mode)) {
      return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "Suspended run does not match the selected workflow, profile, mode, or environment." });
    }
    await runStore.update(runState.runId, {
      status: resumeRunState ? runState.status : "running",
      profileId: profileId ?? runState.profileId ?? null,
      mode,
      target: session.target?.id ? { targetId: session.target.id, attached: true } : runState.target,
      resumeCursor: resumeRunState ? runState.resumeCursor : null
    });
  }

  // Wire the intervention watcher (P0-5): bound to this run's exact
  // session, store, environment, and realm-specific verification. The
  // authentication verifier intentionally has NO authoritative source
  // here (a missing login form or a redirect is never proof); the
  // operator/integration supplies one in host-backed deployments.
  const watcher = new InterventionWatcher({
    store: interventions,
    pollIntervalMs: 5_000,
    signal,
    ctx: {
      hasAttachmentGrant: async targetId => session.target?.id === targetId && session.attached === true
        ? { ok: true }
        : { ok: false, reason: `No authorized attachment grant for target '${targetId}'.` },
      verifyAuthentication: async realm => ({ authenticated: false, reason: `No authentication verifier configured for realm '${realm ?? "unknown"}'.` }),
      observe: async () => await session.observe().catch(() => null),
      verifyEnvironment: async url => verifyObservedUrl(environment, url)
    }
  });
  watcher.watchBrowser(session);
  watcher.start();

  let finalState = QUALIFICATION_STATES.UNCERTAIN;
  let reason = null;
  let cleanupResult = null;
  let screenshotPath = null;

  try {
    // ── 1. Correct environment and application identity (mandatory) ──
    const observation = await observeLoadedPage(session);
    const observedUrl = observation?.page?.url ?? null;
    if (!observedUrl) {
      finalState = QUALIFICATION_STATES.FAILED;
      reason = "The browser produced no observable page URL.";
      gate("environment_identity_verified", false, reason);
      return finalize(finalState, { reason });
    }
    const identity = verifyObservedUrl(environment, observedUrl);
    if (!identity.ok) {
      finalState = QUALIFICATION_STATES.FAILED;
      reason = `Environment identity mismatch: ${identity.reason}`;
      gate("environment_identity_verified", false, reason);
      return finalize(finalState, { reason });
    }
    gate("environment_identity_verified", true, `${observedUrl} (${observation.page.title ?? "untitled"})`);
    evidence.push({ kind: "identity", url: observedUrl, title: observation.page.title ?? null, evidenceId: observation.evidenceId ?? null });
    if (runState) await runStore.update(runState.runId, {
      latestVerifiedEvidenceId: observation.evidenceId ?? null,
      target: session.target?.id ? { targetId: session.target.id, attached: true } : runState.target
    });
    emit(`Environment: ${environment.environmentId} → ${observedUrl}`);

    // ── 2. Real staging site reached (mandatory) ──
    // Reaching the verified staging origin over HTTPS in the real browser
    // is itself a named gate; it is NOT operational qualification.
    gate("real_staging_site_reached", true, observedUrl);

    discoveries.visibleDiagnosticSurfaces.push(...discoverVisibleDiagnosticSurfaces(observation, environment));

    // ── 3. Authentication and Agent entry use the real visible UI route ──
    const handoff = classifyHumanHandoff(observation);
    const authRequired = handoff?.category === "authentication" || handoff?.category === "anti_automation";
    if (authRequired) {
      emit(`Authentication handoff detected (${handoff.category}); the same qualification run will wait while the operator completes the staging → visible Agents → Agent login path.`);
    } else {
      emit("Entry page observed. Cloud Agent will be reached through a visible staging UI link.");
    }

    // ── 4. Profile route is an identity hint only; never navigate to it ──
    const entryFlow = createCloudAgentEntryWorkflow(environment, observation);
    if (!entryFlow) {
      finalState = QUALIFICATION_STATES.BLOCKED;
      reason = "The environment profile has no authorized Cloud Agent identity hint.";
      gate("agents_application_entered", false, reason);
      return finalize(finalState, { reason });
    }
    const { agentEntry, workflow } = entryFlow;
    emit(`Cloud Agent identity hint loaded (${agentEntry.origin}); browser navigation remains driven by the visible staging UI.`);
    if (entryFlow.alreadyAtComposer) emit("The task composer is already visible; skipping goal navigation and performing read-only verification.");

    // ── 5. Follow the visible route, hand off for login, then verify and resume ──
    const runner = new TestRunner({ session, interventions, environment, signal });
    runner.onRunSuspended = async (suspendedReceipt, record) => {
      if (!runState) return;
      const suspendedStatus = {
        tab_authorization: RUN_STATUS.WAITING_FOR_TAB_AUTHORIZATION,
        authentication: RUN_STATUS.WAITING_FOR_AUTHENTICATION,
        mfa: RUN_STATUS.WAITING_FOR_MFA,
        human_approval: RUN_STATUS.WAITING_FOR_HUMAN_APPROVAL,
        external_authorization: RUN_STATUS.WAITING_FOR_EXTERNAL_AUTHORIZATION,
        human_decision: RUN_STATUS.WAITING_FOR_HUMAN_DECISION
      }[record.type] ?? RUN_STATUS.WAITING_FOR_HUMAN_DECISION;
      const cursor = resumeCursorFor(suspendedReceipt, suspendedStatus);
      await runStore.update(runState.runId, {
        status: suspendedStatus.toLowerCase(),
        pendingInterventionId: record.intervention_id,
        suspendedStepId: record.stepId,
        resumeCursor: cursor,
        target: session.target?.id ? { targetId: session.target.id, attached: true } : runState.target
      });
    };
    let activeWorkflow = workflow;
    if (resumeReceipt) {
      const suspendedStepId = resumeRunState.suspendedStepId;
      if (suspendedStepId !== "follow-visible-agents-route") {
        return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "The persisted Cloud Agent suspension is not at the supported visible-entry step.", receipt: resumeReceipt });
      }
      activeWorkflow = {
        ...workflow,
        steps: [
          { id: suspendedStepId, type: "goal", goal: "Resume after the verified Cloud Agent task composer predicate." },
          ...workflow.steps.filter(step => step.id !== suspendedStepId)
        ]
      };
    }
    let receipt = resumeReceipt ?? await runner.run(workflow, { runId });

    if (isWaitingRunStatus(receipt.status)) {
      const interventionRef = [...(receipt.interventions ?? [])].reverse().find(item => item.state === "waiting_for_human" || item.state === "acknowledged");
      const pendingId = resumeRunState?.pendingInterventionId ?? interventionRef?.interventionId;
      const record = pendingId ? interventions.get(pendingId) : null;
      if (resumeReceipt && (!record || record.runId !== runId || record.stepId !== resumeRunState.suspendedStepId
        || record.intervention_id !== resumeRunState.pendingInterventionId)) {
        return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "The durable human intervention does not match the suspended run and step.", receipt });
      }
      emit(`Suspended: ${receipt.interventions.map(i => `${i.type}(${i.state})`).join(", ")}`);
      if (runState) await runStore.update(runState.runId, {
        status: receipt.status.toLowerCase(),
        pendingInterventionId: record?.intervention_id ?? null,
        suspendedStepId: record?.stepId ?? null,
        resumeCursor: resumeCursorFor(receipt),
        target: session.target?.id ? { targetId: session.target.id, attached: true } : runState.target
      });
      if (record && typeof onHumanIntervention === "function") {
        const verify = {
          hasAttachmentGrant: async targetId => session.target?.id === targetId && session.attached === true
            ? { ok: true }
            : { ok: false, reason: `No authorized attachment grant for target '${targetId}'.` },
          verifyEnvironment: async url => verifyObservedUrl(environment, url),
          observe: async () => await session.observe().catch(() => null),
          verifyAuthentication: async realm => {
            if (realm !== agentEntry.authenticationRealm) {
              return { authenticated: false, reason: `Unexpected authentication realm '${realm ?? "unknown"}'.` };
            }
            const current = await session.observe().catch(() => null);
            const handoffNow = classifyHumanHandoff(current);
            if (handoffNow) return { authenticated: false, reason: handoffNow.reason };
            const ready = verifyCloudAgentReady(current, environment, agentEntry.origin);
            return ready.ok
              ? { authenticated: true, identity: "Cloud Agent task composer", evidenceId: ready.evidenceId }
              : { authenticated: false, reason: ready.reason };
          }
        };

        while (!signal?.aborted && isWaitingRunStatus(receipt.status)) {
          const shouldResume = await onHumanIntervention(record, {
            session,
            environment,
            expectedOrigin: agentEntry.origin,
            inspectCurrentPage: async () => {
              const current = await session.observe().catch(() => null);
              discoveries.visibleDiagnosticSurfaces.push(...discoverVisibleDiagnosticSurfaces(current, environment));
              const ready = verifyCloudAgentReady(current, environment, agentEntry.origin);
              return { ...ready, observation: current };
            },
            verifyReady: async () => verifyCloudAgentReady(await session.observe().catch(() => null), environment, agentEntry.origin)
          });
          if (shouldResume === false) break;
          const resumed = await runner.resume(receipt, {
            workflow: activeWorkflow,
            verify,
            completedStepIds: record.stepId === "follow-visible-agents-route" ? [record.stepId] : []
          });
          if (resumed.resumed && resumed.receipt) {
            receipt = resumed.receipt;
            if (runState) await runStore.update(runState.runId, { status: "running" });
            break;
          }
          emit(`Authentication is not verified yet: ${resumed.reason ?? "the Agent task composer is still unavailable."}`);
        }
      }

      if (isWaitingRunStatus(receipt.status)) {
        finalState = signal?.aborted ? QUALIFICATION_STATES.CANCELED : QUALIFICATION_STATES.WAITING_FOR_HUMAN;
        reason = signal?.aborted
          ? "Run canceled while waiting for Cloud Agent authentication."
          : "The run is suspended for authentication; the browser remains available for a verified resume.";
        return finalize(finalState, { reason, interventionId: record?.intervention_id ?? null, receipt });
      }
    }

    for (const step of receipt.steps) {
      steps.push({ id: step.stepId, status: step.status, reason: step.reason });
    }

    if (receipt.status !== RUN_STATUS.PASSED) {
      // UNCERTAIN steps remain unresolved; entering Agents is NOT
      // operational qualification (P1-3).
      const uncertain = receipt.steps.find(s => s.status === "UNCERTAIN");
      if (uncertain) {
        finalState = QUALIFICATION_STATES.UNCERTAIN;
        reason = `Goal step ended uncertain: ${uncertain.reason}`;
      } else {
        finalState = QUALIFICATION_STATES.FAILED;
        reason = `Browser workflow did not pass mandatory gates (run status ${receipt.status}).`;
      }
      gate("agents_application_entered", false, reason);
      return finalize(finalState, { reason, receipt });
    }

    const composerEvidence = receipt.steps.find(s => s.stepId === "verify-task-composer")?.evidenceIds?.[0] ?? null;
    const finalObservation = await session.observe().catch(() => null);
    const ready = verifyCloudAgentReady(finalObservation, environment, agentEntry.origin);
    if (!ready.ok) {
      finalState = QUALIFICATION_STATES.UNCERTAIN;
      reason = `The Cloud Agent task composer was not independently re-observed: ${ready.reason}`;
      gate("agents_application_entered", false, reason);
      return finalize(finalState, { reason, receipt });
    }
    discoveries.visibleDiagnosticSurfaces.push(...discoverVisibleDiagnosticSurfaces(finalObservation, environment));
    discoveries.visibleDiagnosticSurfaces = [...new Map(discoveries.visibleDiagnosticSurfaces.map(surface => [`${surface.sourcePage ?? ""}|${surface.label.toLowerCase()}|${surface.destination ?? ""}`, surface])).values()].slice(0, 20);
    gate("agents_application_entered", true, `Task composer visible at observed Agent origin ${ready.origin}`);
    evidence.push({ kind: "cloud-agent-task-composer", evidenceId: composerEvidence });
    evidence.push({ kind: "observed-cloud-agent-destination", url: `${ready.origin}/`, evidenceId: ready.evidenceId });
    emit(discoveries.visibleDiagnosticSurfaces.length
      ? `Read-only discovery found ${discoveries.visibleDiagnosticSurfaces.length} visible history/logging navigation surface(s); none were opened.`
      : "No visible history/logging navigation surface found in the current view; no links were opened or guessed.");

    // ── 6. Backend diagnostic correlation (optional; exact identifiers) ──
    const diagUrl = process.env.ACTIVETAB_CLOUD_AGENT_URL;
    const diagToken = process.env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;
    let backendCorrelation = null;
    if (diagUrl && diagToken) {
      const { CloudAgentDiagnosticAdapter } = await import("../diagnostics/adapters/cloudAgentApi.js");
      const adapter = new CloudAgentDiagnosticAdapter({
        baseUrl: diagUrl,
        adminToken: diagToken,
        diagnosticTransport: process.env.ACTIVETAB_CLOUD_AGENT_TRANSPORT ?? null,
        remoteTarget: process.env.ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET ?? null,
        environmentBinding: environment
      });
      if (!isLoopbackUrl(diagUrl) || adapter.diagnosticTransport === "ssh_tunnel") {
        const health = await adapter.healthCheck().catch(error => ({ healthy: false, reason: String(error?.message ?? error) }));
        if (health.healthy) {
          backendCorrelation = { healthy: true, transport: health.transport ?? "direct" };
          emit(`Diagnostic adapter healthy (${health.transport ?? "direct"})`);
          // Correlation REQUIRES an exact operation identifier from the
          // browser workflow; without one, no correlation claim is made.
          const runIdFromBrowser = process.env.ACTIVETAB_CLOUD_AGENT_TEST_RUN_ID ?? null;
          if (typeof runIdFromBrowser === "string" && runIdFromBrowser) {
            const detail = await adapter.getRunDetail(runIdFromBrowser).catch(() => null);
            backendCorrelation.runDetail = detail ? { httpStatus: detail.httpStatus ?? null, status: detail.status ?? null } : null;
            backendCorrelation.correlatedRunId = runIdFromBrowser;
            emit(`Correlated browser operation with backend run ${runIdFromBrowser}`);
          } else {
            limitations.push("No test-owned Cloud Agent operation identifier was captured in the browser workflow; backend correlation by exact identifier is unavailable.");
            emit("No operation identifier captured; backend correlation skipped.");
          }
        } else {
          limitations.push(`Diagnostic adapter unreachable: ${health.reason}`);
          emit(`Diagnostic adapter unreachable: ${health.reason}`);
        }
      } else {
        limitations.push("Diagnostic endpoint is loopback without an explicitly configured, verified SSH tunnel; rejected.");
      }
    } else {
      limitations.push("No diagnostic endpoint configured; backend correlation is unavailable for this run and is reported as such.");
      emit("No diagnostic endpoint configured; backend correlation unavailable.");
    }

    // ── 7. Honest final gate (P1-3 / P1-5) ──
    // Reaching Agents is NOT Cloud Agent operational qualification. An
    // actual authorized test-owned Cloud Agent operation with an
    // independently verified application-level result and verified
    // cleanup has NOT been executed in this run: no operation identifier
    // exists, so the mandatory operation/verification/cleanup gates fail.
    const opId = backendCorrelation?.correlatedRunId ?? null;
    gate("cloud_agent_operation_executed", false, opId
      ? `Backend run ${opId} observed, but the operation was not executed through the browser application by this run.`
      : "No test-owned Cloud Agent operation was executed through the Agents application.");
    gate("operation_result_independently_verified", false, "No verified application-level result exists for a test-owned operation.");
    cleanupResult = { performed: false, reason: "No test-owned resources were created by this run; nothing to clean up." };
    gate("cleanup_verified", true, cleanupResult.reason);
    limitations.push("Cloud Agent operational execution (create/execute a test-owned agent operation and verify its result) remains outstanding; entering Agents is environment qualification, not operational qualification.");

    finalState = QUALIFICATION_STATES.UNCERTAIN;
    reason = "Environment and Agents-entry qualification passed against the real staging site. Operational Cloud Agent execution (a test-owned operation with verified result and exact-identifier backend correlation) remains outstanding and is reported as UNCERTAIN, not PASSED.";
    return finalize(finalState, { reason, receipt });
  } catch (error) {
    finalState = QUALIFICATION_STATES.FAILED;
    reason = String(error?.message ?? error).slice(0, 500);
    return finalize(finalState, { reason, error });
  } finally {
    watcher.stop();
  }

  async function finalize(state, { reason: r, error = null, receipt = null, interventionId = null } = {}) {
    if (runStore && runState) {
      const isSuspended = state === QUALIFICATION_STATES.WAITING_FOR_HUMAN
        && receipt && isWaitingRunStatus(receipt.status) && resumeCursorFor(receipt);
      const pending = isSuspended
        ? [...(receipt.interventions ?? [])].reverse().find(item => item.state === "waiting_for_human" || item.state === "acknowledged")
        : null;
      await runStore.update(runState.runId, {
        status: isSuspended ? receipt.status.toLowerCase() : state.toLowerCase(),
        pendingInterventionId: pending?.interventionId ?? (isSuspended ? interventionId : null),
        suspendedStepId: isSuspended ? resumeCursorFor(receipt).suspendedStepId : null,
        resumeCursor: isSuspended ? resumeCursorFor(receipt) : null,
        target: session?.target?.id ? { targetId: session.target.id, attached: session.attached === true } : runState.target,
        latestVerifiedEvidenceId: evidence.at(-1)?.evidenceId ?? runState.latestVerifiedEvidenceId ?? null
      });
    }
    const passedGates = MANDATORY_GATES.filter(name => gates[name]?.passed === true);
    const failedGates = MANDATORY_GATES.filter(name => gates[name] && gates[name].passed !== true);
    const report = {
      runId,
      qualificationState: state,
      reason: r ?? null,
      mode,
      environmentVerification: { environmentId: environment.environmentId, applicationEntryUrl: environment.applicationEntryUrl, identity: gates.environment_identity_verified ?? null },
      browserIdentity: session?.target ? { targetId: session.target.id, launchMode: session.persistent === false ? "runner-owned disposable" : "persistent authorized" } : null,
      authenticationStatus: gates.real_staging_site_reached && !(gates.environment_identity_verified && false) ? "entry page observed; realm-specific verification via interventions" : "not established",
      workflowSteps: steps,
      receipt: receipt ? receipt.toObject?.() ?? receipt : null,
      verifiedBackendOperations: backendCorrelationRef.value,
      diagnosticEvidence: evidence,
      discoveries,
      correlation: backendCorrelationRef.value,
      screenshotPath,
      pendingInterventions: interventionId ? [interventionId] : [],
      finalState: state,
      cleanupResult,
      gates,
      mandatoryGatesPassed: passedGates.length === MANDATORY_GATES.length,
      passedGates,
      failedGates,
      limitations,
      error: error ? String(error?.message ?? error).slice(0, 300) : null,
      generatedAt: new Date().toISOString()
    };
    // Save the final report under the repo's local output directory.
    let reportLocation = null;
    try {
      const reportDir = reportDirOption ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".activetab", "qualification");
      await mkdir(reportDir, { recursive: true, mode: 0o700 });
      reportLocation = join(reportDir, `${runId}.json`);
      await writeFile(reportLocation, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch { /* report location is best-effort */ }
    report.reportLocation = reportLocation;
    return report;
  }
}

