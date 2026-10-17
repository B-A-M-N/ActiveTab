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

import { ApplicationDiscoveryEngine } from "../discovery/engine.js";
import { TestRunner } from "./runner.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { loadEnvironmentBinding } from "./profiles.js";
import { verifyObservedUrl, isLoopbackUrl, normalizeOrigin } from "../environments/model.js";
import { classifyHumanHandoff } from "../navigation/handoff.js";
import { RUN_STATUS } from "./schema.js";

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


/** Resolve a possibly-relative href against the observed page URL. */
function absolutize(href, baseUrl) {
  try { return new URL(String(href ?? ""), String(baseUrl ?? "")).href; } catch { return null; }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * @param {boolean} [options.waitForHuman] - Allow a bounded in-process
 *   wait for human authentication (only meaningful with a usable display).
 * @param {number} [options.humanWaitMs] - Bound for the human wait.
 * @param {AbortSignal} [options.signal] - Cancellation.
 * @param {Function} [options.onEvent] - Progress callback (text) => {}.
 */
export async function qualifyCloudAgent({
  session,
  environment,
  interventions,
  runStore = null,
  diagnostics = null,
  mode = "test",
  waitForHuman = false,
  humanWaitMs = 5 * 60_000,
  signal,
  onEvent = null
}) {
  const emit = text => { if (typeof onEvent === "function") { try { onEvent(text); } catch { /* best-effort */ } } };
  const runId = `cloud-agent-staging-${randomUUID()}`;
  const backendCorrelationRef = { value: null };
  const gates = {};
  const evidence = [];
  const steps = [];
  const limitations = [];
  const gate = (name, passed, detail = null) => {
    gates[name] = { passed: passed === true, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
    emit(`${passed === true ? "PASS" : "FAIL"} gate: ${name}${detail ? ` — ${detail}` : ""}`);
    return passed === true;
  };

  if (!session || session.attached !== true) {
    return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "No authorized attached browser session." });
  }
  if (!environment) {
    return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "No verified environment binding." });
  }

  // Optional durable run-state cursor (P0-4 durable mode).
  let runState = null;
  if (runStore) {
    runState = await runStore.create({
      workflowId: "cloud-agent-staging-qualification",
      workflowName: "Cloud Agent staging qualification",
      environmentId: environment.environmentId,
      authenticationRealm: "agents-session",
      targetId: session.target?.id ?? null,
      goalFingerprint: createHash("sha256").update(String(environment.applicationEntryUrl)).digest("hex").slice(0, 32)
    });
    await runStore.update(runState.runId, { status: "running" });
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
    if (runState) await runStore.update(runState.runId, { latestVerifiedEvidenceId: observation.evidenceId ?? null });
    emit(`Environment: ${environment.environmentId} → ${observedUrl}`);

    // ── 2. Real staging site reached (mandatory) ──
    // Reaching the verified staging origin over HTTPS in the real browser
    // is itself a named gate; it is NOT operational qualification.
    gate("real_staging_site_reached", true, observedUrl);

    // ── 3. Authenticated application access (human-intervention boundary) ──
    const handoff = classifyHumanHandoff(observation);
    const authRequired = handoff?.category === "authentication" || handoff?.category === "anti_automation";
    if (authRequired) {
      const type = handoff.category === "anti_automation" ? "human_decision" : "authentication";
      const record = await interventions.create({
        runId,
        stepId: "enter-agents",
        type,
        reason: handoff.reason,
        requiredHumanAction: "Complete sign-in in the attached browser tab. No password or MFA code passes through the agent.",
        completionCondition: type === "human_decision"
          ? { type: "challenge_cleared" }
          : { type: "authenticated_session_check", realm: "agents-session" },
        environmentId: environment.environmentId,
        authenticationRealm: "agents-session",
        targetId: session.target?.id ?? null,
        applicationId: "fi-agents"
      });
      emit(`Authentication required → durable resumable state ${record.state} (${record.intervention_id})`);
      if (runState) await runStore.update(runState.runId, { status: "waiting_for_authentication", pendingInterventionId: record.intervention_id, suspendedStepId: "enter-agents" });

      if (waitForHuman) {
        // Bounded in-process wait (only meaningful with a usable display).
        const deadline = Date.now() + Math.max(5_000, humanWaitMs);
        let satisfied = false;
        while (Date.now() < deadline) {
          if (signal?.aborted) break;
          const pending = interventions.get(record.intervention_id);
          if (pending?.state === "satisfied") { satisfied = true; break; }
          const fresh = await observeLoadedPage(session, { timeoutMs: 5_000 });
          const freshHandoff = classifyHumanHandoff(fresh);
          if (fresh && !freshHandoff) {
            // No authoritative verifier: do not fabricate satisfaction.
            emit("Authentication state changed, but no authoritative verifier is configured; continuing to observe.");
          }
          await new Promise(r => setTimeout(r, 2_000));
        }
        if (!satisfied) {
          finalState = QUALIFICATION_STATES.WAITING_FOR_HUMAN;
          reason = "Human authentication was not verified within the bounded wait. The run is suspended durably and resumes when the agents-session realm is verifiably authenticated.";
          emit(reason);
          return finalize(finalState, { reason, interventionId: record.intervention_id });
        }
      } else {
        finalState = QUALIFICATION_STATES.WAITING_FOR_HUMAN;
        reason = "Authentication is required on the real staging site. The run is suspended in a durable resumable state; resume after the agents-session realm is verifiably authenticated.";
        emit(reason);
        return finalize(finalState, { reason, interventionId: record.intervention_id });
      }
    }
    emit("Authentication state: no login/challenge handoff detected on the entry page.");

    // ── 4. Discover the Agents application through the site's navigation ──
    const discovery = new ApplicationDiscoveryEngine({
      session,
      maxSteps: 8,
      maxLinksPerStep: 4,
      environment,
      onAuthorizationBoundary: boundary => emit(`Authorization boundary: ${boundary.category} at ${boundary.url}`)
    });
    const discoveryResult = await discovery.discover();
    const map = discoveryResult.capabilityMap;
    emit(`Discovered ${map.pages.length} pages, ${map.controls.length} controls, ${(map.childApplications ?? []).length} child applications`);
    steps.push({ id: "discover", status: "PASS", detail: `${map.pages.length} pages, ${map.controls.length} controls` });
    for (const child of map.childApplications ?? []) {
      emit(`Child application: ${child.applicationId} via ${child.entryFrom} (${child.verified ? "verified" : "unverified"})`);
    }

    // ── 4b. Resolve the Agents entry from the environment binding ──
    // The entry to the child application is resolved from the verified
    // environment binding FIRST: (a) an actually verified same-origin
    // navigation candidate matching the application label, else (b) the
    // profile's candidate_entry route under the authorized origin. Blind
    // semantic exploration is only a last resort, and the engine refuses
    // to count navigation onto a non-authorized origin as progress.
    const agentsApp = (environment.applications ?? []).find(a => a.applicationId === "fi-agents") ?? environment.applications?.[0] ?? null;
    const agentsLabel = /agent/i;
    let entryResolution = null;
    {
      const latest = await session.observe().catch(() => null);
      const sameOrigin = (environment.authorizedOrigins ?? []).includes(normalizeOrigin(latest?.page?.url));
      if (latest && sameOrigin) {
        const candidates = latest.candidates ?? [];
        const verified = candidates.filter(c =>
          c.visible === true && c.disabled !== true &&
          agentsLabel.test(String(c.name ?? "")) &&
          (environment.authorizedOrigins ?? []).includes(normalizeOrigin(absolutize(c.href, latest.page.url)))
        );
        if (verified.length >= 1) {
          entryResolution = { kind: "verified-candidate", href: absolutize(verified[0].href, latest.page.url), label: verified[0].name };
          emit(`Agents entry resolved from verified same-origin candidate: '${verified[0].name}' → ${entryResolution.href}`);
        }
      }
      if (!entryResolution && agentsApp?.candidateEntry) {
        try {
          const candidateUrl = new URL(agentsApp.candidateEntry, environment.applicationEntryUrl).href;
          if ((environment.authorizedOrigins ?? []).includes(new URL(candidateUrl).origin)) {
            entryResolution = { kind: "candidate-route", href: candidateUrl };
            emit(`Agents entry resolved from environment candidate_entry: ${candidateUrl}`);
          }
        } catch { /* invalid candidate_entry: fall through to discovery-only */ }
      }
    }

    // ── 5. Goal-driven workflow: enter Agents and verify the realm ──
    const runner = new TestRunner({ session, interventions, environment, signal });
    const receipt = await runner.run({
      id: "cloud-agent-enter-agents",
      name: "Enter the Agents application from FreeInference staging",
      steps: [
        // Navigate to the resolved authorized Agents entry via the native
        // navigate step (URL target from the verified binding, never from
        // the diagnostic adapter). The target is always on an authorized
        // origin; a login wall is caught by the assert + handoff below.
        ...(entryResolution ? [{
          id: "navigate-agents",
          type: "navigate",
          url: entryResolution.href,
          expectedUrlPattern: "^" + escapeRegExp(entryResolution.href).replace(/\/$/, "") + "(/|$)"
        }] : []),
        {
          id: "enter-agents",
          type: "goal",
          goal: entryResolution
            ? `Open the Agents (Cloud Agent) application at ${entryResolution.href}`
            : "Find and open the Agents (Cloud Agent) application from the FreeInference staging navigation",
          intervention: {
            type: "authentication",
            realm: "agents-session",
            requiredAction: "Complete Agents authentication in the attached browser tab.",
            condition: { type: "authenticated_session_check", realm: "agents-session" }
          }
        },
        {
          id: "verify-agents-realm",
          type: "assert",
          assertion: { type: "page_title_contains", value: "agent" }
        }
      ]
    }, { runId });

    for (const step of receipt.steps) {
      steps.push({ id: step.stepId, status: step.status, reason: step.reason });
    }

    if (receipt.interventions?.length > 0) {
      // Suspended at a human-intervention boundary with durable state.
      const record = receipt.interventions[0];
      emit(`Suspended: ${receipt.interventions.map(i => `${i.type}(${i.state})`).join(", ")}`);
      if (runState) await runStore.update(runState.runId, { status: "waiting_for_authentication", pendingInterventionId: record.interventionId, suspendedStepId: record.stepId });
      finalState = QUALIFICATION_STATES.WAITING_FOR_HUMAN;
      reason = "Workflow suspended at a durable human-intervention boundary; it resumes from the suspended step once the completion condition is verified.";
      return finalize(finalState, { reason, interventionId: record.interventionId, receipt });
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

    gate("agents_application_entered", true, "Agents realm verified");
    evidence.push({ kind: "agents-realm", evidenceId: receipt.steps.find(s => s.stepId === "verify-agents-realm")?.evidenceIds?.[0] ?? null });

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
      const reportDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".activetab", "qualification");
      await mkdir(reportDir, { recursive: true });
      reportLocation = join(reportDir, `${runId}.json`);
      await writeFile(reportLocation, JSON.stringify(report, null, 2), "utf8");
    } catch { /* report location is best-effort */ }
    report.reportLocation = reportLocation;
    return report;
  }
}

