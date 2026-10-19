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
import { createQualificationRuntime } from "./qualificationRuntime.js";
import { TestReceipt } from "./receipts.js";
import { InterventionStore, InterventionWatcher } from "../runtime/interventions.js";
import { loadEnvironmentBinding } from "./profiles.js";
import { verifyObservedUrl } from "../environments/model.js";
import { classifyHumanHandoff } from "../navigation/handoff.js";
import { createCloudAgentEntryWorkflow, discoverVisibleDiagnosticSurfaces, verifyCloudAgentReady } from "./cloudAgentEntry.js";
import { RUN_STATUS, isWaitingRunStatus } from "./schema.js";

const QUALIFICATION_STATES = Object.freeze({
  PASSED: "PASSED",
  FAILED: "FAILED",
  WAITING_FOR_HUMAN: "WAITING_FOR_HUMAN",
  BLOCKED: "BLOCKED",
  UNCERTAIN: "UNCERTAIN",
  CANCELED: "CANCELED"
});

/** Owned qualification Chrome stays available until the operator stops it. */
export function shouldKeepOwnedBrowserOpen(mode, report, signal) {
  return mode === "owned" && Boolean(report) && signal?.aborted !== true;
}

const MANDATORY_GATES = Object.freeze([
  "environment_identity_verified",
  "real_staging_site_reached",
  "agents_application_entered",
  "cloud_agent_operation_executed",
  "operation_result_independently_verified",
  "cleanup_verified"
]);


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
  decisionRuntime = null,
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
  const diagnosticHealthRef = { value: null };
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
    const entryFlow = createCloudAgentEntryWorkflow(environment, observation, { forceEntryStep: Boolean(resumeRunState) });
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
    const runner = new TestRunner({
      session, interventions, environment, signal, decisionRuntime,
      qualificationService: createQualificationRuntime({ decisionRuntime }),
      ...(runStore && runState ? {
        runStateStore: runStore,
        existingRunStateId: runState.runId,
        profileId: profileId ?? runState.profileId ?? null,
        policyVersion: runState.policyVersion ?? "active_policy_v1"
      } : {})
    });
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
    if (resumeReceipt) {
      const suspendedStepId = resumeRunState.suspendedStepId;
      if (suspendedStepId !== "follow-visible-agents-route") {
        return finalize(QUALIFICATION_STATES.BLOCKED, { reason: "The persisted Cloud Agent suspension is not at the supported visible-entry step.", receipt: resumeReceipt });
      }
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
            workflow,
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
    if (diagUrl && diagToken) {
      const { cloudAgentAdapterFromEnv } = await import("../diagnostics/adapters/cloudAgentApi.js");
      const adapter = cloudAgentAdapterFromEnv(process.env, { environmentBinding: environment });
      if (!adapter) {
        limitations.push("Diagnostic credentials or endpoint were configured, but they do not match a diagnostic service explicitly bound by the active environment profile; no backend request was made.");
        emit("Diagnostic service is not bound by the active profile; backend request skipped.");
      } else {
        const health = await adapter.healthCheck().catch(error => ({ healthy: false, reason: String(error?.message ?? error) }));
        if (health.adminAuthority === "not_probed") {
          limitations.push("Diagnostic credentials were configured, but the profile has no validated diagnostic endpoint binding; no backend request was made.");
          emit("No profile-validated diagnostic route is configured; backend request skipped.");
        } else if (health.healthy) {
          diagnosticHealthRef.value = { status: "healthy", transport: health.transport ?? "direct", adminAuthority: health.adminAuthority ?? "not_probed" };
          limitations.push("The diagnostic health endpoint was checked, but this qualification run did not submit a Cloud Agent task or capture its exact run ID; no backend run correlation is claimed.");
          emit(`Diagnostic health checked (${health.transport ?? "direct"}); run correlation remains unavailable.`);
        } else {
          diagnosticHealthRef.value = { status: "unavailable", reason: health.reason ?? "no validated endpoint response" };
          limitations.push(`Diagnostic health check unavailable: ${health.reason ?? "no validated endpoint response"}`);
          emit(`Diagnostic health check unavailable: ${health.reason ?? "no validated endpoint response"}`);
        }
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
    gate("cloud_agent_operation_executed", false, "No test-owned Cloud Agent operation was executed through the Agents application.");
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
      verifiedBackendOperations: null,
      diagnosticHealth: diagnosticHealthRef.value,
      diagnosticEvidence: evidence,
      discoveries,
      correlation: null,
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

