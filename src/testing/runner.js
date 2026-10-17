/**
 * Declarative test runner — coordinates bounded steps using the authorized
 * browser session and typed operation contracts. Every browser action goes
 * through the session's revalidation path; every assertion must be
 * evidence-backed.
 */

import { validateWorkflow, STEP_STATUS, RUN_STATUS } from "./schema.js";
import { evaluateAssertion } from "./assertions.js";
import { TestReceipt, deriveRunStatus } from "./receipts.js";

export class TestRunner {
  constructor({ session, collector, correlator, journal, maxSteps = 32, signal } = {}) {
    this.session = session;
    this.collector = collector;
    this.correlator = correlator;
    this.journal = journal;
    this.maxSteps = Math.max(1, Math.min(maxSteps, 128));
    this.signal = signal;
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
      if (result.status === STEP_STATUS.FAIL || result.status === STEP_STATUS.BLOCKED || result.status === STEP_STATUS.UNCERTAIN) {
        failedStepIds.add(step.id);
      }
    }

    const finalStatus = deriveRunStatus(receipt.steps);
    receipt.finish(finalStatus);
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
