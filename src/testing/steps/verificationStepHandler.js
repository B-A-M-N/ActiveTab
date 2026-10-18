import { evaluateAssertion } from "../assertions.js";
import { STEP_STATUS } from "../schema.js";

/** Executes evidence checks and cleanup verification without owning planning or policy. */
export class VerificationStepHandler {
  constructor({ collector = null, correlator = null, session = null, signal = null, observe, correlateStepDiagnostics, executeApiCall, executeInteract } = {}) {
    this.collector = collector;
    this.correlator = correlator;
    this.session = session;
    this.signal = signal;
    this.observe = observe ?? (async () => null);
    this.correlateStepDiagnostics = correlateStepDiagnostics ?? (() => {});
    this.executeApiCall = executeApiCall;
    this.executeInteract = executeInteract;
  }

  async executeWaitFor(step, receipt, startedAt) {
    const deadline = Date.now() + (step.timeoutMs ?? 5_000);
    const interval = step.pollMs ?? 250;
    while (Date.now() < deadline) {
      if (this.signal?.aborted) {
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.CANCELED, reason: "Run was canceled.", startedAt });
        return { status: STEP_STATUS.CANCELED, reason: "Run was canceled." };
      }
      const observation = await this.observe();
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

  async executeAssert(step, receipt, startedAt) {
    const observation = await this.observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({ stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt, evidenceIds: result.evidenceIds });
    return result;
  }

  async executeDiagnosticSnapshot(step, receipt, startedAt) {
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
    const results = await this.collector.collectAll(sourceIds.map(sourceId => ({ sourceId, operation: "read" })));
    const errors = results.filter(result => result.status === "error");
    if (errors.length === sourceIds.length) {
      const reason = `All diagnostic sources failed: ${errors.map(error => error.error).join("; ")}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
    const okCount = results.length - errors.length;
    this.correlateStepDiagnostics(step, receipt, results.filter(result => result.status === "ok"));
    const status = STEP_STATUS.PASS;
    const reason = `Diagnostic snapshot collected from ${okCount}/${sourceIds.length} sources.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, details: { okCount, totalSources: sourceIds.length, errors: errors.map(error => error.error) } });
    return { status, reason, results };
  }

  async executeControlledFailure(step, receipt, startedAt) {
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

  async executeRetryVerification(step, receipt, startedAt) {
    const targetStepId = step.targetStepId;
    if (typeof targetStepId !== "string" || !targetStepId) {
      const reason = "Retry verification requires a targetStepId to reconcile.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const targetStep = receipt.steps.find(item => item.stepId === targetStepId);
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
    if (!step.assertion) {
      const reason = "Retry verification requires an assertion to independently verify recovery.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const observation = await this.observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({
      stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt,
      evidenceIds: [...(result.evidenceIds ?? []), `retry:${targetStepId}`].filter(Boolean)
    });
    return result;
  }

  async executePostcondition(step, receipt, startedAt) {
    const observation = await this.observe();
    const result = evaluateAssertion(step.assertion, { observation, collector: this.collector, correlator: this.correlator });
    receipt.recordStep({ stepId: step.id, type: step.type, status: result.status, reason: result.reason, startedAt, evidenceIds: result.evidenceIds });
    return result;
  }

  async executeCleanup(step, receipt, startedAt, context = null) {
    if (!step.action) {
      receipt.recordCleanup({ stepId: step.id, status: "not_required", reason: "No cleanup action declared; no test-owned resources were created by this workflow." });
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason: "No cleanup action declared; no test-owned resources to clean.", startedAt });
      return { status: STEP_STATUS.PASS, reason: "No test-owned resources to clean." };
    }
    if (step.action.type === "api_call") {
      const apiStep = { ...step, type: "api_call", operation: step.action.operation };
      return await this.#verifyCleanup(step, receipt, startedAt, await this.executeApiCall(apiStep, receipt, startedAt));
    }
    if (step.action.type === "interact") {
      const interactStep = { ...step, type: "cleanup", action: step.action };
      return await this.#verifyCleanup(step, receipt, startedAt, await this.executeInteract(interactStep, receipt, startedAt, context));
    }
    const reason = `Cleanup action type '${step.action.type}' is not supported.`;
    receipt.recordCleanup({ stepId: step.id, status: "not_performed", reason });
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
    return { status: STEP_STATUS.UNCERTAIN, reason };
  }

  async #verifyCleanup(step, receipt, startedAt, operationResult) {
    if (operationResult.status !== STEP_STATUS.PASS) {
      const cleanupStatus = operationResult.status === STEP_STATUS.FAIL ? "failed"
        : operationResult.status === STEP_STATUS.BLOCKED ? "not_performed" : "uncertain";
      receipt.recordCleanup({ stepId: step.id, status: cleanupStatus, reason: operationResult.reason });
      return operationResult;
    }
    if (!step.verify) {
      const reason = "Cleanup operation was dispatched but has no independent verification assertion.";
      const latest = receipt.steps.findLast(item => item.stepId === step.id);
      if (latest) { latest.status = STEP_STATUS.UNCERTAIN; latest.reason = reason; }
      receipt.recordCleanup({ stepId: step.id, status: "uncertain", reason });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const verification = evaluateAssertion(step.verify, {
      observation: await this.observe(),
      collector: this.collector,
      correlator: this.correlator
    });
    const status = verification.status;
    const reason = status === STEP_STATUS.PASS ? "Cleanup postcondition independently verified." : verification.reason;
    const latest = receipt.steps.findLast(item => item.stepId === step.id);
    if (latest) {
      latest.status = status;
      latest.reason = reason;
      latest.evidenceIds = [...new Set([...(latest.evidenceIds ?? []), ...(verification.evidenceIds ?? [])])].slice(0, 20);
    }
    receipt.recordCleanup({
      stepId: step.id,
      status: status === STEP_STATUS.PASS ? "verified" : status === STEP_STATUS.FAIL ? "failed" : "uncertain",
      reason
    });
    return { status, reason, evidenceIds: verification.evidenceIds ?? [] };
  }
}
