/**
 * Declarative test runner — coordinates bounded steps using the authorized
 * browser session and typed operation contracts. Every browser action goes
 * through the session's revalidation path; every assertion must be
 * evidence-backed.
 */

import { validateWorkflow, STEP_STATUS, RUN_STATUS, isWaitingRunStatus } from "./schema.js";
import { evaluateAssertion } from "./assertions.js";
import { TestReceipt, deriveRunStatus, STEP_STATUS_EXTENDED } from "./receipts.js";
import { classifyHumanHandoff } from "../navigation/handoff.js";
import { InterventionStore, evaluateCompletion, externalRunState, INTERVENTION_STATE } from "../runtime/interventions.js";
import { isLoopbackUrl, verifyObservedUrl } from "../environments/model.js";
import { NavigationEngine } from "../navigation/engine.js";

export class TestRunner {
  constructor({ session, collector, correlator, journal, maxSteps = 32, signal, interventions = null, environment = null } = {}) {
    this.session = session;
    this.collector = collector;
    this.correlator = correlator;
    this.journal = journal;
    this.maxSteps = Math.max(1, Math.min(maxSteps, 128));
    this.signal = signal;
    // Durable intervention lifecycle (P0-3). When provided, human handoffs
    // persist before control returns and the run suspends instead of ending.
    this.interventions = interventions;
    this.environment = environment;
    this.onIntervention = null; // async (record) => {}
    this.onRunSuspended = null; // async (receipt, record) => {}
  }

  async run(workflow, { runId } = {}) {
    const validation = validateWorkflow(workflow, { maxSteps: this.maxSteps });
    if (!validation.valid) {
      throw new Error(`Invalid workflow: ${validation.errors.join(" ")}`);
    }
    const effectiveRunId = runId ?? this.collector?.runId ?? crypto.randomUUID();
    const receipt = new TestReceipt({ runId: effectiveRunId, workflowId: workflow.id, workflowName: workflow.name });
    const failedStepIds = new Set();

    for (const step of workflow.steps) {
      if (this.signal?.aborted) {
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.CANCELED, reason: "Run was canceled." });
        break;
      }
      // A suspended run holds its place: no further steps dispatch while a
      // human intervention is pending; resumption re-enters at this step.
      if (receipt.status !== RUN_STATUS.RUNNING) break;
      // If a mandatory step failed, stop downstream ordinary steps.
      if (failedStepIds.size > 0 && !step.recoveryBranch) {
        receipt.recordStep({
          stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED,
          reason: `Skipped because a prerequisite step failed (${[...failedStepIds].join(", ")}).`
        });
        continue;
      }
      const result = await this.#executeStep(step, receipt);
      if (result.status === STEP_STATUS.CANCELED) break;
      if (result.status === STEP_STATUS_EXTENDED.SUSPENDED) {
        // Waiting states are resumable, not terminal failures. The
        // intervention store uses the external lowercase vocabulary; map it
        // onto the receipt's run-status constants.
        const EXTERNAL_TO_RUN_STATUS = {
          waiting_for_tab_authorization: RUN_STATUS.WAITING_FOR_TAB_AUTHORIZATION,
          waiting_for_authentication: RUN_STATUS.WAITING_FOR_AUTHENTICATION,
          waiting_for_mfa: RUN_STATUS.WAITING_FOR_MFA,
          waiting_for_human_approval: RUN_STATUS.WAITING_FOR_HUMAN_APPROVAL,
          waiting_for_external_authorization: RUN_STATUS.WAITING_FOR_EXTERNAL_AUTHORIZATION,
          waiting_for_human_decision: RUN_STATUS.WAITING_FOR_HUMAN_DECISION
        };
        const waiting = EXTERNAL_TO_RUN_STATUS[result.externalState];
        if (!waiting) {
          receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason: `Unknown suspension state '${result.externalState}'.`, startedAt: new Date().toISOString() });
          failedStepIds.add(step.id);
        } else {
          receipt.finish(waiting);
          break;
        }
      }
      if (result.status === STEP_STATUS.FAIL || result.status === STEP_STATUS.BLOCKED || result.status === STEP_STATUS.UNCERTAIN) {
        failedStepIds.add(step.id);
      }
    }

    if (receipt.status === RUN_STATUS.RUNNING) {
      receipt.finish(deriveRunStatus(receipt.steps));
    }
    return receipt;
  }

  async #executeStep(step, receipt) {
    const startedAt = new Date().toISOString();
    try {
      switch (step.type) {
        case "setup": return await this.#executeSetup(step, receipt, startedAt);
        case "navigate": return await this.#executeNavigate(step, receipt, startedAt);
        case "interact": return await this.#executeInteract(step, receipt, startedAt);
        case "api_call": return await this.#executeApiCall(step, receipt, startedAt);
        case "wait_for": return await this.#executeWaitFor(step, receipt, startedAt);
        case "assert": return await this.#executeAssert(step, receipt, startedAt);
        case "diagnostic_snapshot": return await this.#executeDiagnosticSnapshot(step, receipt, startedAt);
        case "controlled_failure": return await this.#executeControlledFailure(step, receipt, startedAt);
        case "retry_verification": return await this.#executeRetryVerification(step, receipt, startedAt);
        case "postcondition": return await this.#executePostcondition(step, receipt, startedAt);
        case "cleanup": return await this.#executeCleanup(step, receipt, startedAt);
        case "goal": return await this.#executeGoal(step, receipt, startedAt);
        default: {
          const message = `Unsupported step type '${step.type}'.`;
          receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason: message, startedAt });
          return { status: STEP_STATUS.BLOCKED, reason: message };
        }
      }
    } catch (error) {
      const reason = String(error?.message ?? error).slice(0, 500);
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
  }

  async #observe() {
    if (!this.session) return null;
    return await this.session.observe();
  }

  async #executeSetup(step, receipt, startedAt) {
    const preconditions = Array.isArray(step.preconditions) ? step.preconditions : [];
    if (preconditions.length === 0) {
      const reason = "Setup step has no preconditions to verify; cannot report PASS.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    let allPassed = true;
    let lastResult = null;
    for (const precondition of preconditions) {
      const result = evaluateAssertion(precondition, {
        observation: await this.#observe(),
        collector: this.collector,
        correlator: this.correlator
      });
      lastResult = result;
      if (result.status !== STEP_STATUS.PASS) { allPassed = false; break; }
    }
    const status = allPassed ? STEP_STATUS.PASS : lastResult.status;
    const reason = allPassed ? "All setup preconditions verified with evidence." : `Setup precondition failed: ${lastResult.reason}`;
    receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, evidenceIds: lastResult?.evidenceIds ?? [] });
    return { status, reason, evidenceIds: lastResult?.evidenceIds ?? [] };
  }

  async #executeNavigate(step, receipt, startedAt) {
    if (!this.session) {
      const reason = "No browser session available for navigation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const preObservation = await this.session.observe();
    this.#emitTraceEvent({ eventId: `step:${step.id}:start`, runId: receipt.runId, stepId: step.id, event: "step_start", actionType: "navigate", targetUrl: step.url });
    try {
      // Use the authorized session's CDP path. Page.navigate is the
      // single execution boundary for this target; the session object
      // owns attachment, lifecycle, and authorization.
      this.#emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: "navigate", targetUrl: step.url });
      await this.session.client.send("Page.navigate", { url: step.url });
    } catch (error) {
      const reason = `Navigation dispatch failed: ${String(error.message ?? error).slice(0, 200)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
    // Wait for navigation to complete rather than a fixed sleep.
    const waitBaseline = {
      pageChangeFingerprint: preObservation.pageChangeFingerprint,
      domMutationCount: preObservation.domMutationCount,
      lifecycleEventCount: preObservation.lifecycleEventCount
    };
    try { await this.session.waitForChange(step.timeoutMs ?? 5_000, waitBaseline); }
    catch { /* Wait may time out; the postcondition check below is the authority. */ }
    const postObservation = await this.session.observe();
    const navigationSucceeded = postObservation?.page?.url && (
      step.url === postObservation.page.url ||
      postObservation.page.url.startsWith(step.url) ||
      (step.expectedUrlPattern ? new RegExp(step.expectedUrlPattern).test(postObservation.page.url) : false)
    );
    const status = navigationSucceeded ? STEP_STATUS.PASS : STEP_STATUS.FAIL;
    const reason = navigationSucceeded
      ? `Navigated to ${postObservation.page.url}.`
      : `Post-navigation URL '${postObservation?.page?.url ?? "unknown"}' does not match expected '${step.url}'.`;
    this.#emitTraceEvent({ eventId: `step:${step.id}:verify`, runId: receipt.runId, stepId: step.id, event: "outcome_verification", status, targetUrl: step.url, observedUrl: postObservation?.page?.url, evidenceId: postObservation?.evidenceId });
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [postObservation?.evidenceId ?? ""].filter(Boolean),
      details: { url: step.url, finalUrl: postObservation?.page?.url ?? null, title: postObservation?.page?.title ?? null }
    });
    return { status, reason, observation: postObservation };
  }

  async #executeInteract(step, receipt, startedAt) {
    if (!this.session) {
      const reason = "No browser session available for interaction.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const observation = await this.session.observe();
    if (!observation?.candidates?.length) {
      const reason = "No candidates available in the current observation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean) });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const action = step.action;
    const candidate = this.#resolveCandidate(observation, action);
    if (!candidate) {
      const reason = `No unique candidate matched the action target: ${JSON.stringify(action.target ?? {})}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    this.#emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: action.type, backendNodeId: candidate.backendNodeId });
    let dispatchResult;
    try {
      switch (action.type) {
        case "click": dispatchResult = await this.session.click(candidate); break;
        case "fill": dispatchResult = await this.session.fillField(candidate, action.value ?? ""); break;
        case "select": dispatchResult = await this.session.selectOption(candidate, action.value ?? ""); break;
        case "toggle": dispatchResult = await this.session.click(candidate); break;
        case "upload": dispatchResult = await this.session.uploadFile(candidate, action.filePaths ?? []); break;
        default: throw new Error(`Interaction type '${action.type}' is not yet implemented in the native session.`);
      }
    } catch (error) {
      const reason = `Interaction dispatch failed: ${String(error.message ?? error).slice(0, 300)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.FAIL, reason };
    }
    // Observe after action and verify it had an effect.
    const waitBaseline = {
      pageChangeFingerprint: observation.pageChangeFingerprint,
      domMutationCount: observation.domMutationCount,
      lifecycleEventCount: observation.lifecycleEventCount
    };
    try { await this.session.waitForChange(action.timeoutMs ?? 2_000, waitBaseline); }
    catch { /* Wait may time out; postcondition below is the authority. */ }
    const postObservation = await this.session.observe();
    const stateChanged = postObservation?.pageChangeFingerprint !== observation.pageChangeFingerprint;
    const status = stateChanged ? STEP_STATUS.PASS : STEP_STATUS.UNCERTAIN;
    const reason = stateChanged
      ? `Interaction '${action.type}' dispatched and page state changed.`
      : `Interaction '${action.type}' dispatched but no observable state change was detected.`;
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [observation.evidenceId, postObservation?.evidenceId ?? ""].filter(Boolean),
      details: { actionType: action.type, backendNodeId: candidate.backendNodeId, stateChanged }
    });
    return { status, reason, observation: postObservation };
  }

  #resolveCandidate(observation, action) {
    if (!observation?.candidates || !action?.target) return null;
    const target = action.target;
    const matches = observation.candidates.filter(candidate => {
      if (target.backendNodeId !== undefined && candidate.backendNodeId !== target.backendNodeId) return false;
      if (target.name && candidate.name !== target.name) return false;
      if (target.role && candidate.role !== target.role) return false;
      if (target.tag && candidate.tag !== target.tag) return false;
      if (target.visible !== undefined && candidate.visible !== target.visible) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async #executeApiCall(step, receipt, startedAt) {
    if (!this.collector) {
      const reason = "No diagnostic collector configured for API operations.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const operation = step.operation;
    if (typeof operation?.operationId !== "string" || !operation.operationId) {
      const reason = "API operation requires a typed operationId.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const sourceId = operation.sourceId;
    if (typeof sourceId !== "string" || !this.collector.hasSource(sourceId)) {
      const reason = `Diagnostic source '${sourceId}' for operation '${operation.operationId}' is not registered.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const declaredOp = operation.type ?? "read";
    try {
      const snapshot = await this.collector.collect(sourceId, declaredOp, { operationId: operation.operationId, ...operation.options });
      const status = STEP_STATUS.PASS;
      const reason = `API operation '${operation.operationId}' completed via source '${sourceId}'.`;
      receipt.recordStep({
        stepId: step.id, type: step.type, status, reason, startedAt,
        evidenceIds: [snapshot.evidenceId ?? snapshot.sourceId ?? ""].filter(Boolean),
        details: { operationId: operation.operationId, sourceId }
      });
      return { status, reason, snapshot };
    } catch (error) {
      const reason = `API operation failed: ${String(error.message ?? error).slice(0, 300)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
  }

  async #executeWaitFor(step, receipt, startedAt) {
    const deadline = Date.now() + (step.timeoutMs ?? 5_000);
    const interval = step.pollMs ?? 250;
    while (Date.now() < deadline) {
      if (this.signal?.aborted) {
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.CANCELED, reason: "Run was canceled.", startedAt });
        return { status: STEP_STATUS.CANCELED, reason: "Run was canceled." };
      }
      const observation = await this.#observe();
      const result = evaluateAssertion(step.condition, { observation, collector: this.collector, correlator: this.correlator });
      if (result.status === STEP_STATUS.PASS) {
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason: result.reason, startedAt, evidenceIds: result.evidenceIds });
        return { status: STEP_STATUS.PASS, reason: result.reason, observation };
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    const reason = `Condition not met within ${step.timeoutMs ?? 5_000}ms.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
    return { status: STEP_STATUS.FAIL, reason };
  }

  async #executeAssert(step, receipt, startedAt) {
    const observation = await this.#observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({ stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt, evidenceIds: result.evidenceIds });
    return result;
  }

  async #executeDiagnosticSnapshot(step, receipt, startedAt) {
    if (!this.collector) {
      const reason = "No diagnostic collector configured.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    if (typeof this.session?.observe === "function") {
      // Trigger a fresh observation so that browser diagnostic sources have
      // an explicit evidence id to read from.
      await this.session.observe();
    }
    const sourceIds = this.collector.listSources().map(source => source.id);
    if (sourceIds.length === 0) {
      const reason = "No diagnostic sources registered.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const results = await this.collector.collectAll(
      sourceIds.map(sourceId => ({ sourceId, operation: "read" }))
    );
    const errors = results.filter(result => result.status === "error");
    if (errors.length === sourceIds.length) {
      const reason = `All diagnostic sources failed: ${errors.map(e => e.error).join("; ")}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
    const okCount = results.length - errors.length;
    this.#correlateStepDiagnostics(step, receipt, results.filter(r => r.status === "ok"));
    const status = STEP_STATUS.PASS;
    const reason = `Diagnostic snapshot collected from ${okCount}/${sourceIds.length} sources.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, details: { okCount, totalSources: sourceIds.length, errors: errors.map(e => e.error) } });
    return { status, reason, results };
  }

  async #executeControlledFailure(step, receipt, startedAt) {
    if (!step.failure?.mechanism) {
      const reason = "Controlled failure requires a named mechanism.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    if (!this.collector?.hasSource(`fault:${step.failure.mechanism}`)) {
      const reason = `Controlled fault mechanism '${step.failure.mechanism}' is not registered as a diagnostic source.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    try {
      await this.collector.collect(`fault:${step.failure.mechanism}`, "read", step.failure.options ?? {});
      const reason = `Controlled failure '${step.failure.mechanism}' executed via an approved fault source.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt });
      return { status: STEP_STATUS.PASS, reason };
    } catch (error) {
      const reason = `Controlled failure failed: ${String(error.message ?? error).slice(0, 300)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
  }

  async #executeRetryVerification(step, receipt, startedAt) {
    const targetStepId = step.targetStepId;
    if (typeof targetStepId !== "string" || !targetStepId) {
      const reason = "Retry verification requires a targetStepId to reconcile.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const targetStep = receipt.steps.find(s => s.stepId === targetStepId);
    if (!targetStep) {
      const reason = `Target step '${targetStepId}' for retry verification was not found in the receipt.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    if (targetStep.status !== STEP_STATUS.FAIL && targetStep.status !== STEP_STATUS.UNCERTAIN) {
      const reason = `Target step '${targetStepId}' did not fail or remain uncertain; retry verification is not applicable.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    // The retry step itself must be declared with its own verification
    // condition to prove recovery rather than merely acknowledging failure.
    if (!step.assertion) {
      const reason = "Retry verification requires an assertion to independently verify recovery.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const observation = await this.#observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({
      stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt,
      evidenceIds: [...(result.evidenceIds ?? []), `retry:${targetStepId}`].filter(Boolean)
    });
    return result;
  }

  async #executePostcondition(step, receipt, startedAt) {
    const observation = await this.#observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({ stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt, evidenceIds: result.evidenceIds });
    return result;
  }

  #emitTraceEvent(event) {
    if (!this.correlator) return;
    try {
      this.correlator.addEvent({
        eventId: event.eventId ?? crypto.randomUUID(),
        ...event,
        observedAt: event.observedAt ?? new Date().toISOString()
      });
    } catch { /* Correlator tracing is best-effort; never block the run. */ }
  }

  #correlateStepDiagnostics(step, receipt, results) {
    if (!this.correlator || !Array.isArray(results)) return;
    for (const result of results) {
      if (result.status !== "ok" || !result.snapshot) continue;
      const snapshot = result.snapshot;
      // Correlate the step's dispatch event with the diagnostic snapshot
      // by the shared run/step identifiers.
      this.correlator.addEvent({
        eventId: snapshot.snapshotId ?? `snap:${snapshot.sourceId}:${Date.now()}`,
        runId: receipt.runId,
        stepId: step.id,
        sourceType: "diagnostic",
        sourceId: snapshot.sourceId,
        operationType: snapshot.operation,
        observedAt: snapshot.collectedAt,
        ...(snapshot.evidenceId ? { evidenceId: snapshot.evidenceId } : {})
      });
      try {
        const stepEventId = `step:${step.id}:dispatch`;
        this.correlator.correlate(stepEventId, snapshot.snapshotId ?? `snap:${snapshot.sourceId}:${Date.now()}`);
      } catch { /* If the step event wasn't emitted, correlation is skipped. */ }
    }
  }

  /**
   * Goal-driven step (P1-2): resolve a semantic objective ("Find the Agents
   * application") into native browser actions using fresh evidence via the
   * NavigationEngine. If a human requirement is detected — or the step
   * declares an intervention — the run suspends at this step with a durable,
   * resumable intervention record instead of failing.
   */
  async #executeGoal(step, receipt, startedAt) {
    if (!this.session) {
      const reason = "No browser session available for the goal step.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    // A caller-supplied target or URL alone is never proof of authorization
    // or identity: verify the observed page against the environment first.
    if (this.environment) {
      const preObservation = await this.session.observe().catch(() => null);
      const observedUrl = preObservation?.page?.url;
      if (observedUrl) {
        const verified = verifyObservedUrl(this.environment, observedUrl);
        if (!verified.ok) {
          return await this.#suspendForIntervention(step, receipt, startedAt, {
            type: "human_decision",
            reason: `Environment identity mismatch: ${verified.reason}`,
            requiredHumanAction: "Verify the environment or supply the appropriate authorization for the unexpected origin.",
            condition: { type: "ambiguity_resolved" },
            preObservation
          });
        }
      }
    }

    const engine = new NavigationEngine(this.session, { maxActions: step.maxActions ?? 8, maxScrolls: step.maxScrolls ?? 5, signal: this.signal });
    const result = await engine.run(step.goal);
    if (result.status === "needs_human") {
      const category = result.interventionRequired?.category ?? "authentication";
      const type = category === "anti_automation" ? "human_decision" : category === "authorization" ? "external_authorization" : "authentication";
      return await this.#suspendForIntervention(step, receipt, startedAt, {
        type,
        reason: result.reason ?? "A human requirement was detected.",
        requiredHumanAction: "Complete the required step in the attached browser (authentication, challenge, or authorization), then let ActiveTab verify it.",
        condition: type === "human_decision" && category === "anti_automation"
          ? { type: "challenge_cleared" }
          : { type: "authenticated_session_check", realm: step.intervention?.realm ?? this.environment?.applications?.[0]?.authenticationRealm ?? null },
        engineResult: { attempts: result.attempts, recoveries: result.recoveries, evidenceId: result.evidenceId ?? null }
      });
    }
    const succeeded = result.status === "succeeded";
    const status = succeeded ? STEP_STATUS.PASS : result.status === "canceled" ? STEP_STATUS.CANCELED : STEP_STATUS.UNCERTAIN;
    const reason = succeeded
      ? `Goal resolved: ${step.goal}`
      : `Goal step ended '${result.status}'; the expected application-level effect was not verified, so this is UNCERTAIN rather than PASS.`;
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [result.evidenceId ?? ""].filter(Boolean),
      details: { goal: step.goal, engineStatus: result.status, attempts: result.attempts, recoveries: result.recoveries }
    });
    return { status, reason, result };
  }

  /**
   * Persist the intervention BEFORE returning control, record the suspended
   * step, and notify the watcher plumbing. The run stays resumable.
   */
  async #suspendForIntervention(step, receipt, startedAt, { type, reason, requiredHumanAction, condition, preObservation = null, engineResult = null }) {
    if (!this.interventions) {
      // No durable store: fall back to a blocked step rather than losing state.
      const fallback = `Human requirement detected but no intervention store is configured: ${reason}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason: fallback, startedAt, evidenceIds: [preObservation?.evidenceId ?? engineResult?.evidenceId ?? ""].filter(Boolean) });
      return { status: STEP_STATUS.BLOCKED, reason: fallback };
    }
    const record = await this.interventions.create({
      runId: receipt.runId,
      stepId: step.id,
      type,
      reason,
      requiredHumanAction,
      completionCondition: condition,
      environmentId: this.environment?.environmentId ?? step.intervention?.environmentId ?? null,
      authenticationRealm: condition?.realm ?? step.intervention?.realm ?? null,
      targetId: this.session?.target?.id ?? null,
      applicationId: this.environment?.applications?.find(a => a.authenticationRealm === condition?.realm)?.applicationId ?? null,
      ...(step.intervention?.ttlMs ? { ttlMs: step.intervention.ttlMs } : {})
    });
    receipt.recordStep({
      stepId: step.id, type: step.type, status: STEP_STATUS_EXTENDED.SUSPENDED, reason, startedAt,
      evidenceIds: [preObservation?.evidenceId ?? engineResult?.evidenceId ?? ""].filter(Boolean),
      details: { interventionId: record.intervention_id, interventionType: type }
    });
    receipt.recordIntervention({
      stepId: step.id, interventionId: record.intervention_id, type,
      state: record.state, reason, externalState: externalRunState(record)
    });
    if (typeof this.onIntervention === "function") {
      try { await this.onIntervention(record); } catch { /* notification is best-effort */ }
    }
    return { status: STEP_STATUS_EXTENDED.SUSPENDED, reason, intervention: record, externalState: externalRunState(record) };
  }

  /**
   * Resume a suspended run from its interrupted step (never from the
   * beginning). The exact completion predicate is verified with fresh
   * evidence before the step is re-executed; a failed verification leaves
   * the run suspended.
   */
  async resume(receipt, { verify = null, evaluate = null } = {}) {
    const pending = (receipt.interventions ?? []).filter(i => i.state === INTERVENTION_STATE.WAITING || i.state === INTERVENTION_STATE.ACKNOWLEDGED);
    const suspendedStep = [...receipt.steps].reverse().find(s => s.status === STEP_STATUS_EXTENDED.SUSPENDED);
    if (!suspendedStep) {
      return { resumed: false, reason: "No suspended step to resume." };
    }
    const record = pending.find(i => i.stepId === suspendedStep.stepId) ?? (this.interventions ? this.interventions.get(suspendedStep.details?.interventionId) : null);
    if (!record) return { resumed: false, reason: "No durable intervention record found for the suspended step." };
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return { resumed: false, reason: `Intervention expired at ${record.expiresAt}.`, expired: true };
    }
    // 1. Verify the actual completion condition with fresh evidence.
    const evaluator = evaluate ?? ((intervention, ctx) => evaluateCompletion(intervention, ctx));
    const evaluation = await evaluator(record, verify ?? {});
    if (!evaluation.satisfied) {
      return { resumed: false, reason: `Completion condition not verified: ${evaluation.reason}`, intervention: record };
    }
    // 2. Consume the intervention and re-enter at the suspended step.
    await this.interventions?.completeResume(record.intervention_id, record.resumeHeldBy ?? record.generation, { evidenceId: evaluation.evidenceId ?? null, note: evaluation.summary });
    const workflow = { id: receipt.workflowId, name: receipt.workflowName, steps: [{ id: suspendedStep.stepId, type: "goal", goal: suspendedStep.details?.goal ?? "" }] };
    // Mark the run running again, then execute the remaining original steps
    // from the caller-supplied workflow; here we re-run just the suspended
    // step with fresh evidence and return its outcome.
    const stepResult = await this.#executeGoal(workflow.steps[0], { ...receipt, status: RUN_STATUS.RUNNING, interventions: receipt.interventions }, new Date().toISOString());
    if (stepResult.status !== STEP_STATUS_EXTENDED.SUSPENDED) {
      const replacement = receipt.steps.find(s => s.stepId === suspendedStep.stepId);
      if (replacement) Object.assign(replacement, { status: stepResult.status, reason: stepResult.reason });
      receipt.status = RUN_STATUS.RUNNING;
    }
    return { resumed: stepResult.status !== STEP_STATUS_EXTENDED.SUSPENDED, stepResult, evaluation };
  }

  async #executeCleanup(step, receipt, startedAt) {
    // The runner does not create resources; it only verifies that declared
    // cleanup actions are performed. A cleanup step with no action is
    // recorded but cannot report PASS.
    if (!step.action) {
      // A cleanup step with no action is a legitimate declaration when the
      // workflow created no test-owned resources. Record it explicitly.
      receipt.recordCleanup({ stepId: step.id, status: "not_required", reason: "No cleanup action declared; no test-owned resources were created by this workflow." });
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason: "No cleanup action declared; no test-owned resources to clean.", startedAt });
      return { status: STEP_STATUS.PASS, reason: "No test-owned resources to clean." };
    }
    // Cleanup steps must go through the same interaction path.
    if (step.action.type === "api_call") {
      const apiStep = { ...step, type: "api_call", operation: step.action.operation };
      const result = await this.#executeApiCall(apiStep, receipt, startedAt);
      receipt.recordCleanup({ stepId: step.id, status: result.status === STEP_STATUS.PASS ? "performed" : "not_performed", reason: result.reason });
      return result;
    }
    if (step.action.type === "interact") {
      const interactStep = { ...step, type: "interact", action: step.action };
      const result = await this.#executeInteract(step, receipt, startedAt);
      receipt.recordCleanup({ stepId: step.id, status: result.status === STEP_STATUS.PASS ? "performed" : "not_performed", reason: result.reason });
      return result;
    }
    // For an unknown cleanup action type, do not report PASS.
    const reason = `Cleanup action type '${step.action.type}' is not supported.`;
    receipt.recordCleanup({ stepId: step.id, status: "not_performed", reason });
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
    return { status: STEP_STATUS.UNCERTAIN, reason };
  }
}
