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
import { createHash } from "node:crypto";
import { RunDecisionRecorder } from "./telemetry/runDecisionRecorder.js";
import { RunStateCoordinator } from "./lifecycle/runStateCoordinator.js";
import { ControlFlowStepHandler } from "./steps/controlFlowStepHandler.js";
import { VerificationStepHandler } from "./steps/verificationStepHandler.js";
import { QualificationStepHandler } from "./steps/qualificationStepHandler.js";
import { BrowserStepHandler } from "./steps/browserStepHandler.js";
import { ApiStepHandler } from "./steps/apiStepHandler.js";
import {
  deriveWorkflowRunStatus,
  estimateWorkflowExecutionCost,
  evaluateWorkflowStepAdmission,
  validateSubworkflowReferences
} from "./execution/workflowScheduler.js";

function telemetryStepId(stepId) {
  return `step_${createHash("sha256").update(String(stepId)).digest("hex").slice(0, 16)}`;
}

function canonicalWorkflow(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflow).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalWorkflow(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function executionWorkflowFingerprint(workflow, registry) {
  const referenced = [];
  const visited = new Set();
  const visit = current => {
    for (const step of current.steps ?? []) {
      if (step?.type !== "subworkflow" || visited.has(step.workflowRef)) continue;
      visited.add(step.workflowRef);
      const child = registry instanceof Map ? registry.get(step.workflowRef) : registry?.[step.workflowRef];
      if (!child) continue;
      referenced.push({ registryKey: step.workflowRef, workflow: child });
      visit(child);
    }
  };
  visit(workflow);
  return createHash("sha256").update(canonicalWorkflow({ workflow, referencedSubworkflows: referenced })).digest("hex");
}

function canRestoreStepWithoutExecution(step, status) {
  if (status === STEP_STATUS.PASS) return true;
  const effectfulStepTypes = new Set(["navigate", "interact", "api_call", "cleanup", "goal", "controlled_failure"]);
  return effectfulStepTypes.has(step?.type) && status === STEP_STATUS.FAIL;
}

export class TestRunner {
  constructor({ session, collector, correlator, journal, maxSteps = 32, signal, interventions = null, environment = null, localFixture = false, decisionRuntime = null, qualificationService = null, operationAuthorizer = null, workflowRegistry = null, runStateStore = null, existingRunStateId = null, principalId = null, profileId = null, policyVersion = "active_policy_v1" } = {}) {
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
    this.localFixture = localFixture;
    this.decisionRuntime = decisionRuntime;
    this.qualificationService = qualificationService;
    // Supplied only by trusted profile/integration composition code. Workflow
    // JSON can name an operation, but cannot provide or replace this authority.
    this.operationAuthorizer = operationAuthorizer;
    this.workflowRegistry = workflowRegistry;
    this.runStateStore = runStateStore;
    this.runStateCoordinator = new RunStateCoordinator({
      runStateStore,
      session,
      environment,
      principalId,
      profileId,
      policyVersion
    });
    this.decisionRecorder = new RunDecisionRecorder({
      decisionRuntime,
      runStateStore,
      environment,
      session,
      signal,
      getTargetFencingToken: () => this.targetLease?.fencingToken ?? null
    });
    this.controlFlowStepHandler = new ControlFlowStepHandler({
      maxSteps: this.maxSteps,
      signal,
      collector,
      correlator,
      observe: () => this.#observe(),
      executeWorkflowSteps: (...args) => this.#executeWorkflowSteps(...args),
      getWorkflow: workflowRef => this.#registeredWorkflow(workflowRef)
    });
    this.verificationStepHandler = new VerificationStepHandler({
      collector,
      correlator,
      session,
      signal,
      observe: () => this.#observe(),
      correlateStepDiagnostics: (...args) => this.#correlateStepDiagnostics(...args),
      executeApiCall: (...args) => this.apiStepHandler.execute(...args),
      executeInteract: (...args) => this.#executeInteract(...args)
    });
    this.qualificationStepHandler = new QualificationStepHandler({
      qualificationService,
      getEpisodeId: () => this.decisionRecorder.episodeId,
      principalId,
      signal
    });
    this.browserStepHandler = new BrowserStepHandler({
      session,
      environment,
      localFixture,
      collector,
      correlator,
      operationAuthorizer,
      resolveWorkflowValue: (value, context) => this.controlFlowStepHandler.resolveWorkflowValue(value, context),
      createTelemetryHooks: (...args) => this.#telemetryHooks(...args),
      emitTraceEvent: event => this.#emitTraceEvent(event),
      getExecutionLeaseAssertion: () => this.targetLease ? () => this.#assertTargetLeaseCurrent() : null
    });
    this.apiStepHandler = new ApiStepHandler({ collector });
    this.existingRunStateId = existingRunStateId;
    this.principalId = principalId;
    this.profileId = profileId;
    this.policyVersion = policyVersion;
    this.currentTelemetryStepId = null;
    this.currentRuntimeStepId = null;
    this.onIntervention = null; // async (record) => {}
    this.onRunSuspended = null; // async (receipt, record) => {}
  }

  get targetLease() {
    return this.runStateCoordinator.targetLease;
  }

  async run(workflow, { runId } = {}) {
    const effectiveRunId = runId ?? this.existingRunStateId ?? this.collector?.runId ?? crypto.randomUUID();
    const releaseLease = await this.#acquireExecutionLeases(effectiveRunId);
    try { return await this.#runWorkflow(workflow, { runId: effectiveRunId }); }
    finally { await releaseLease?.(); }
  }

  async #acquireExecutionLeases(runId) {
    return this.runStateCoordinator.acquireExecutionLeases(runId);
  }

  async #assertTargetLeaseCurrent() {
    await this.runStateCoordinator.assertTargetLeaseCurrent();
  }

  async #runWorkflow(workflow, { runId } = {}) {
    const validation = validateWorkflow(workflow, { maxSteps: this.maxSteps });
    if (!validation.valid) {
      throw new Error(`Invalid workflow: ${validation.errors.join(" ")}`);
    }
    const referenceErrors = validateSubworkflowReferences({
      workflow,
      activeWorkflowIds: new Set([workflow.id]),
      maxSteps: this.maxSteps,
      getWorkflow: workflowRef => this.#registeredWorkflow(workflowRef)
    });
    if (referenceErrors.length) throw new Error(`Invalid workflow references: ${referenceErrors.join(" ")}`);
    const executionCost = estimateWorkflowExecutionCost({
      workflow,
      maxSteps: this.maxSteps,
      getWorkflow: workflowRef => this.#registeredWorkflow(workflowRef)
    });
    if (executionCost > this.maxSteps) throw new Error(`Expanded workflow exceeds the total execution budget of ${this.maxSteps} steps.`);
    const declaredInputs = new Set(workflow.inputNames ?? []);
    if ([...declaredInputs].some(name => !Object.hasOwn(workflow.inputs ?? {}, name))) {
      throw new Error("Invalid workflow inputs: every declared input must be supplied before execution.");
    }
    const effectiveRunId = runId ?? this.collector?.runId ?? crypto.randomUUID();
    const receipt = new TestReceipt({ runId: effectiveRunId, workflowId: workflow.id, workflowName: workflow.name });
    const priorState = this.runStateStore
      ? await this.runStateStore.getFresh(this.existingRunStateId ?? effectiveRunId)
      : null;
    if (priorState?.episodeId) this.decisionRecorder.bindEpisode(priorState.episodeId);
    await this.decisionRecorder.ensureEpisode(receipt);
    const context = {
      variables: new Map(Object.entries(workflow.inputs ?? {})),
      workflowStack: new Set([workflow.id]),
      workflowHash: executionWorkflowFingerprint(workflow, this.workflowRegistry),
      depth: 0,
      stepStatuses: new Map(),
      completedStatuses: new Map(),
      budget: { limit: this.maxSteps, used: 0 }
    };
    const persistedState = await this.#initializeRunState(workflow, receipt);
    if (persistedState?.completedSteps?.length) {
      for (const item of persistedState.completedSteps) {
        if (!Object.values(STEP_STATUS).includes(item.status)) continue;
        context.completedStatuses.set(item.stepId, item.status);
        receipt.recordStep({
          stepId: item.stepId,
          type: item.type ?? "checkpoint",
          status: item.status,
          reason: "Restored from a durable checkpoint; completed operations are not replayed.",
          evidenceIds: item.evidenceIds ?? []
        });
      }
    }
    const unresolvedOperations = persistedState?.pendingOperations?.filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status)) ?? [];
    if (unresolvedOperations.length > 0) {
      const operations = new Map(unresolvedOperations.map(operation => [operation.operationId, operation]));
      for (const operation of operations.values()) {
        if (receipt.steps.some(step => step.stepId === operation.stepId && step.status === STEP_STATUS.UNCERTAIN)) continue;
        receipt.recordStep({
          stepId: operation.stepId,
          type: "interact",
          status: STEP_STATUS.UNCERTAIN,
          reason: "A prior dispatch has no terminal independent receipt; reconcile it before resuming this run."
        });
      }
      receipt.finish(RUN_STATUS.UNCERTAIN);
      await this.#completeRunState(receipt);
      return receipt;
    }
    const durableTerminal = {
      passed: RUN_STATUS.PASSED,
      failed: RUN_STATUS.FAILED,
      blocked: RUN_STATUS.BLOCKED,
      canceled: RUN_STATUS.CANCELED,
      cancel_requested: RUN_STATUS.CANCELED,
      expired: RUN_STATUS.EXPIRED,
      reconciling: RUN_STATUS.UNCERTAIN
    }[persistedState?.status];
    if (durableTerminal) {
      receipt.finish(durableTerminal);
      return receipt;
    }
    const execution = await this.#executeWorkflowSteps(workflow, receipt, context);

    if (receipt.status === RUN_STATUS.RUNNING) receipt.finish(deriveWorkflowRunStatus(workflow, execution.stepStatuses));
    await this.#completeRunState(receipt);
    this.decisionRecorder.completeEpisode(receipt);
    return receipt;
  }

  async #executeWorkflowSteps(workflow, receipt, context, { stepIdPrefix = "" } = {}) {
    const failedStepIds = new Set();
    const stepStatuses = new Map();
    let suspension = null;
    const validation = validateWorkflow(workflow, { maxSteps: this.maxSteps });
    if (!validation.valid) throw new Error(`Invalid nested workflow: ${validation.errors.join(" ")}`);
    const orderedSteps = validation.order ?? workflow.steps;

    for (const step of orderedSteps) {
      const runtimeStepId = stepIdPrefix ? `${stepIdPrefix}/${step.id}` : step.id;
      const runtimeStep = runtimeStepId === step.id ? step : { ...step, id: runtimeStepId };
      const priorStatus = context.completedStatuses?.get(runtimeStepId);
      if (priorStatus && canRestoreStepWithoutExecution(step, priorStatus)
        && !["set_variable", "subworkflow"].includes(step.type)) {
        stepStatuses.set(step.id, priorStatus);
        if (workflow.execution !== "dag" && [STEP_STATUS.FAIL, STEP_STATUS.BLOCKED, STEP_STATUS.UNCERTAIN].includes(priorStatus)) failedStepIds.add(step.id);
        continue;
      }
      if (this.signal?.aborted && this.runStateStore) {
        await this.runStateStore.requestCancellation(receipt.runId).catch(() => {});
      }
      const durableCancellation = this.runStateStore
        ? (await this.runStateStore.getFresh(receipt.runId))?.cancellationRequested === true
        : false;
      if (this.signal?.aborted || durableCancellation) {
        receipt.recordStep({ stepId: runtimeStepId, type: step.type, status: STEP_STATUS.CANCELED, reason: "Run cancellation was requested; no new dispatch was admitted." });
        await this.#checkpointRecordedStep(receipt, runtimeStepId);
        stepStatuses.set(step.id, STEP_STATUS.CANCELED);
        continue;
      }
      if (context.budget && context.budget.used >= context.budget.limit) {
        receipt.recordStep({ stepId: runtimeStepId, type: step.type, status: STEP_STATUS.BLOCKED, reason: "The workflow execution budget is exhausted." });
        await this.#checkpointRecordedStep(receipt, runtimeStepId);
        stepStatuses.set(step.id, receipt.steps.findLast(item => item.stepId === runtimeStepId)?.status ?? STEP_STATUS.BLOCKED);
        continue;
      }
      if (context.budget) context.budget.used++;
      if (this.signal?.aborted) {
        receipt.recordStep({ stepId: runtimeStepId, type: step.type, status: STEP_STATUS.CANCELED, reason: "Run was canceled." });
        await this.#checkpointRecordedStep(receipt, runtimeStepId);
        stepStatuses.set(step.id, STEP_STATUS.CANCELED);
        break;
      }
      // A suspended run holds its place: no further steps dispatch while a
      // human intervention is pending; resumption re-enters at this step.
      if (receipt.status !== RUN_STATUS.RUNNING) break;
      const admission = evaluateWorkflowStepAdmission({ workflow, step, stepStatuses, failedStepIds });
      if (admission.action !== "execute") {
        const status = admission.action === "skip" ? STEP_STATUS.SKIPPED : STEP_STATUS.BLOCKED;
        receipt.recordStep({ stepId: runtimeStepId, type: step.type, status, reason: admission.reason });
        await this.#checkpointRecordedStep(receipt, runtimeStepId);
        stepStatuses.set(step.id, receipt.steps.findLast(item => item.stepId === runtimeStepId)?.status ?? status);
        continue;
      }
      this.currentTelemetryStepId = telemetryStepId(runtimeStepId);
      this.currentRuntimeStepId = runtimeStepId;
      context.stepStatuses = stepStatuses;
      const hadSuspendedAttempt = receipt.steps.some(item => item.stepId === runtimeStepId && item.status === STEP_STATUS_EXTENDED.SUSPENDED);
      let result = await this.#executeStep(runtimeStep, receipt, context, stepStatuses);
      if (hadSuspendedAttempt) receipt.replaceSuspendedStep(runtimeStepId);
      if (!await this.#checkpointRecordedStep(receipt, runtimeStepId)) {
        result = { ...result, status: STEP_STATUS.UNCERTAIN, reason: "Step result could not be durably checkpointed; reconcile before continuing." };
      }
      stepStatuses.set(step.id, result.status);
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
          receipt.recordStep({ stepId: runtimeStepId, type: step.type, status: STEP_STATUS.FAIL, reason: `Unknown suspension state '${result.externalState}'.`, startedAt: new Date().toISOString() });
          failedStepIds.add(step.id);
        } else {
          receipt.finish(waiting);
          suspension = { stepId: runtimeStepId, externalState: result.externalState };
          break;
        }
      }
      if (workflow.execution !== "dag" && (result.status === STEP_STATUS.FAIL || result.status === STEP_STATUS.BLOCKED || result.status === STEP_STATUS.UNCERTAIN)) {
        failedStepIds.add(step.id);
      }
    }
    return { stepStatuses, suspension };
  }

  #registeredWorkflow(workflowRef) {
    return this.workflowRegistry instanceof Map
      ? this.workflowRegistry.get(workflowRef)
      : this.workflowRegistry?.[workflowRef];
  }

  async #initializeRunState(workflow, receipt) {
    if (!this.runStateStore) return null;
    return this.runStateCoordinator.initializeRunState(workflow, receipt, {
      existingRunStateId: this.existingRunStateId,
      decisionEpisodeId: this.decisionRecorder.episodeId,
      workflowHash: executionWorkflowFingerprint(workflow, this.workflowRegistry)
    });
  }

  async #persistStepCheckpoint(receipt, stepId) {
    return this.runStateCoordinator.persistStepCheckpoint(receipt, stepId);
  }

  async #checkpointRecordedStep(receipt, stepId) {
    return this.runStateCoordinator.checkpointRecordedStep(receipt, stepId);
  }

  async #completeRunState(receipt) {
    return this.runStateCoordinator.completeRunState(receipt);
  }

  async #ensureDecisionEpisode(receipt) {
    return this.decisionRecorder.ensureEpisode(receipt);
  }

  #completeDecisionEpisode(receipt) {
    return this.decisionRecorder.completeEpisode(receipt);
  }

  async #telemetryHooks(receipt, action, candidate = null, decisionContext = null) {
    return this.decisionRecorder.createHooks({
      receipt,
      action,
      candidate,
      decisionContext,
      telemetryStepId: this.currentTelemetryStepId,
      runtimeStepId: this.currentRuntimeStepId
    });
  }

  async #executeStep(step, receipt, context = null, stepStatuses = new Map()) {
    const startedAt = new Date().toISOString();
    try {
      switch (step.type) {
        case "setup": return await this.#executeSetup(step, receipt, startedAt);
        case "navigate": return await this.#executeNavigate(step, receipt, startedAt, context);
        case "interact": return await this.#executeInteract(step, receipt, startedAt, context);
        case "api_call": return await this.apiStepHandler.execute(step, receipt, startedAt);
        case "wait_for": return await this.verificationStepHandler.executeWaitFor(step, receipt, startedAt);
        case "assert": return await this.verificationStepHandler.executeAssert(step, receipt, startedAt);
        case "diagnostic_snapshot": return await this.verificationStepHandler.executeDiagnosticSnapshot(step, receipt, startedAt);
        case "controlled_failure": return await this.verificationStepHandler.executeControlledFailure(step, receipt, startedAt);
        case "retry_verification": return await this.verificationStepHandler.executeRetryVerification(step, receipt, startedAt);
        case "postcondition": return await this.verificationStepHandler.executePostcondition(step, receipt, startedAt);
        case "cleanup": return await this.verificationStepHandler.executeCleanup(step, receipt, startedAt, context);
        case "goal": return await this.#executeGoal(step, receipt, startedAt);
        case "qualify": return await this.qualificationStepHandler.execute(
          step,
          receipt,
          startedAt,
          context,
          this.currentTelemetryStepId ?? telemetryStepId(step.id)
        );
        case "set_variable": return this.controlFlowStepHandler.executeSetVariable(step, receipt, startedAt, context, stepStatuses);
        case "repeat": return await this.controlFlowStepHandler.executeRepeat(step, receipt, startedAt, context);
        case "subworkflow": return await this.controlFlowStepHandler.executeSubworkflow(step, receipt, startedAt, context);
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

  async #executeNavigate(step, receipt, startedAt, context = null) {
    return this.browserStepHandler.executeNavigate(step, receipt, startedAt, context);
  }

  async #executeInteract(step, receipt, startedAt, context = null) {
    return this.browserStepHandler.executeInteract(step, receipt, startedAt, context);
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
            reasonCode: "environment_identity_mismatch",
            reason: `Environment identity mismatch: ${verified.reason}`,
            requiredHumanAction: "Verify the environment or supply the appropriate authorization for the unexpected origin.",
            condition: { type: "ambiguity_resolved" },
            preObservation
          });
        }
      }
    }

    // Pass the verified environment binding so the engine refuses to
    // count navigation onto a non-authorized origin as goal progress.
    const engine = new NavigationEngine(this.session, {
      maxActions: step.maxActions ?? 8,
      maxScrolls: step.maxScrolls ?? 5,
      signal: this.signal,
      environment: this.environment ?? null,
      localFixture: this.localFixture,
      decisionRuntime: this.decisionRuntime,
      operationAuthorizer: this.operationAuthorizer,
      assertExecutionLease: this.targetLease ? () => this.#assertTargetLeaseCurrent() : null,
      ...(this.decisionRuntime ? {
        decisionContext: {
          runId: receipt.runId,
          episodeId: this.decisionRecorder.episodeId,
          workflowId: `workflow_${createHash("sha256").update(receipt.workflowId).digest("hex").slice(0, 16)}`,
          stepPrefix: this.currentTelemetryStepId ?? telemetryStepId(step.id),
          sharedEpisode: true
        }
      } : {})
    });
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
  async #suspendForIntervention(step, receipt, startedAt, { type, reason, reasonCode = null, requiredHumanAction, condition, preObservation = null, engineResult = null }) {
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
      reasonCode,
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
    if (typeof this.onRunSuspended === "function") {
      await this.onRunSuspended(receipt, record);
    }
    if (typeof this.onIntervention === "function") {
      try { await this.onIntervention(record); } catch { /* notification is best-effort */ }
    }
    return { status: STEP_STATUS_EXTENDED.SUSPENDED, reason, intervention: record, externalState: externalRunState(record) };
  }

  /**
   * Resume a suspended run from its interrupted step (P0-6). The exact
   * completion predicate is verified with fresh evidence before any
   * continuation; a failed verification leaves the run suspended. Callers
   * may identify steps whose full postcondition is exactly the verified
   * predicate, so those steps are completed from evidence without replay.
   * Resume acquires continuation ownership through a fencing lease, so only
   * one worker may resume a given run at a time. When the caller supplies the
   * original workflow, the remaining steps after the suspended one
   * continue to execute; already-passed steps are never replayed (a
   * successful non-idempotent operation must not be duplicated).
   *
   * @param {TestReceipt} receipt - The suspended run's receipt.
   * @param {object} [options]
   * @param {object} [options.verify] - Context for completion predicates.
   * @param {Function} [options.evaluate] - Custom completion evaluator.
   * @param {object} [options.workflow] - The ORIGINAL workflow definition
   *   (or an immutable versioned reference). When provided, resume
   *   re-enters at the suspended step and continues the subsequent steps.
   * @param {string[]} [options.completedStepIds] - Suspended steps fully
   *   covered by the verified completion predicate; these are never replayed.
   */
  async resume(receipt, options = {}) {
    const releaseLease = await this.#acquireExecutionLeases(receipt.runId);
    try { return await this.#resumeWorkflow(receipt, options); }
    finally { await releaseLease?.(); }
  }

  async #resumeWorkflow(receipt, { verify = null, evaluate = null, workflow = null, completedStepIds = [] } = {}) {
    const pending = (receipt.interventions ?? []).filter(i => i.state === INTERVENTION_STATE.WAITING || i.state === INTERVENTION_STATE.ACKNOWLEDGED);
    const suspendedStep = [...receipt.steps].reverse().find(s => s.status === STEP_STATUS_EXTENDED.SUSPENDED);
    if (!suspendedStep) {
      return { resumed: false, reason: "No suspended step to resume." };
    }
    await this.#ensureDecisionEpisode(receipt);
    const interventionRef = pending.find(i => i.stepId === suspendedStep.stepId);
    const record = (interventionRef?.interventionId && this.interventions
      ? this.interventions.get(interventionRef.interventionId)
      : null)
      ?? (this.interventions ? this.interventions.get(suspendedStep.details?.interventionId) : null);
    if (!record) return { resumed: false, reason: "No durable intervention record found for the suspended step." };
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return { resumed: false, reason: `Intervention expired at ${record.expiresAt}.`, expired: true };
    }
    // 1. Acquire continuation ownership (fencing lease): only one worker
    //    may resume this run. Without a store, the single in-process
    //    runner implicitly holds ownership.
    let lease = null;
    const alreadySatisfied = record.state === INTERVENTION_STATE.SATISFIED;
    if (this.interventions && !alreadySatisfied) {
      try {
        const acquired = await this.interventions.acquireResume(record.intervention_id);
        lease = acquired.lease;
      } catch (error) {
        return { resumed: false, reason: `Could not acquire resume ownership: ${String(error?.message ?? error).slice(0, 200)}` };
      }
    }
    try {
      // 2. Evaluate the completion predicate with fresh evidence.
      const evaluator = evaluate ?? ((intervention, ctx) => evaluateCompletion(intervention, ctx));
      const evaluation = await evaluator(record, verify ?? {});
      if (!evaluation.satisfied) {
        if (lease) await this.interventions.releaseResume(record.intervention_id, lease).catch(() => {});
        return { resumed: false, reason: `Completion condition not verified: ${evaluation.reason}`, intervention: record };
      }
      // 3. Consume the intervention with the held lease.
      if (!alreadySatisfied) {
        await this.interventions?.completeResume(record.intervention_id, lease ?? record.resumeHeldBy ?? record.generation, { evidenceId: evaluation.evidenceId ?? null, note: evaluation.summary });
      }
      const receiptIntervention = receipt.interventions?.find(item => item.interventionId === record.intervention_id);
      if (receiptIntervention) {
        receiptIntervention.state = "satisfied";
        receiptIntervention.resumedAt = new Date().toISOString();
      }

      // 4. Re-enter the original workflow graph. Completed nodes are restored
      //    as prior outcomes, so topological dependencies and branches are
      //    reevaluated without replaying completed effects.
      if (workflow && Array.isArray(workflow.steps)) {
        if (this.runStateStore) {
          const state = await this.runStateStore.getFresh(receipt.runId);
          const environmentId = this.environment?.environmentId ?? null;
          const targetId = this.session?.target?.id ?? null;
          const authenticationRealm = this.environment?.applications?.[0]?.authenticationRealm ?? null;
          if (!state || state.runId !== receipt.runId || state.environmentId !== environmentId
            || (state.target?.targetId ?? null) !== targetId
            || state.authenticationRealm !== authenticationRealm
            || (state.profileId ?? null) !== (this.profileId ?? null)
            || (state.principalId ?? null) !== (this.principalId ?? null)
            || state.policyVersion !== this.policyVersion) {
            return { resumed: false, reason: "Durable continuation bindings do not match the current workflow, environment, target, principal, or policy." };
          }
          if (targetId && this.targetLease) {
            await this.runStateStore.bindTargetLease(receipt.runId, { targetId, fencingToken: this.targetLease.fencingToken });
          }
          await this.runStateStore.bindExecutionContract(receipt.runId, {
            workflowId: workflow.id,
            workflowVersion: workflow.version ?? null,
            workflowHash: executionWorkflowFingerprint(workflow, this.workflowRegistry),
            environmentId,
            targetId,
            principalId: this.principalId,
            profileId: this.profileId,
            policyVersion: this.policyVersion
          });
        }
        receipt.status = RUN_STATUS.RUNNING;
        const completedByPredicate = new Set(completedStepIds).has(suspendedStep.stepId);
        if (completedByPredicate && !receipt.completeSuspendedStep(suspendedStep.stepId, {
          reason: evaluation.summary ?? "The suspended step's exact completion predicate was verified.",
          evidenceId: evaluation.evidenceId ?? null
        })) {
          return { resumed: false, reason: "The verified suspended step is missing from the receipt.", intervention: record };
        }
        if (completedByPredicate) await this.#persistStepCheckpoint(receipt, suspendedStep.stepId);
        const completedStatuses = new Map();
        for (const step of receipt.steps) {
          if (step.status !== STEP_STATUS_EXTENDED.SUSPENDED) completedStatuses.set(step.stepId, step.status);
        }
        const context = {
          variables: new Map(Object.entries(workflow.inputs ?? {})),
          workflowStack: new Set([workflow.id]),
          depth: 0,
          stepStatuses: new Map(),
          completedStatuses,
          budget: { limit: this.maxSteps, used: 0 }
        };
        const execution = await this.#executeWorkflowSteps(workflow, receipt, context);
        if (receipt.status === RUN_STATUS.RUNNING) receipt.finish(deriveWorkflowRunStatus(workflow, execution.stepStatuses));
        await this.#completeRunState(receipt);
        this.#completeDecisionEpisode(receipt);
        return { resumed: !isWaitingRunStatus(receipt.status), receipt, evaluation };
      }
      // No original workflow available: re-run only the suspended step with
      // fresh evidence and return its outcome (never the whole run).
      if (this.runStateStore && this.session?.target?.id && this.targetLease) {
        const state = await this.runStateStore.getFresh(receipt.runId);
        if (state?.target?.targetId !== this.session.target.id) {
          return { resumed: false, reason: "Durable continuation target does not match the attached browser target." };
        }
        await this.runStateStore.bindTargetLease(receipt.runId, {
          targetId: this.session.target.id,
          fencingToken: this.targetLease.fencingToken
        });
      }
      const suspendedGoal = workflow?.steps?.find(s => s.id === suspendedStep.stepId)?.goal
        ?? receipt.steps.find(s => s.stepId === suspendedStep.stepId)?.details?.goal
        ?? "";
      this.currentTelemetryStepId = telemetryStepId(suspendedStep.stepId);
      const stepResult = await this.#executeGoal({ id: suspendedStep.stepId, type: "goal", goal: suspendedGoal }, { ...receipt, status: RUN_STATUS.RUNNING, interventions: receipt.interventions }, new Date().toISOString());
      receipt.replaceSuspendedStep(suspendedStep.stepId);
      if (stepResult.status === STEP_STATUS_EXTENDED.SUSPENDED) {
        const EXTERNAL_TO_RUN = {
          waiting_for_tab_authorization: RUN_STATUS.WAITING_FOR_TAB_AUTHORIZATION,
          waiting_for_authentication: RUN_STATUS.WAITING_FOR_AUTHENTICATION,
          waiting_for_mfa: RUN_STATUS.WAITING_FOR_MFA,
          waiting_for_human_approval: RUN_STATUS.WAITING_FOR_HUMAN_APPROVAL,
          waiting_for_external_authorization: RUN_STATUS.WAITING_FOR_EXTERNAL_AUTHORIZATION,
          waiting_for_human_decision: RUN_STATUS.WAITING_FOR_HUMAN_DECISION
        };
        receipt.finish(EXTERNAL_TO_RUN[stepResult.externalState] ?? RUN_STATUS.WAITING_FOR_HUMAN_DECISION);
      } else {
        receipt.finish(deriveRunStatus(receipt.steps));
      }
      this.#completeDecisionEpisode(receipt);
      return { resumed: !isWaitingRunStatus(receipt.status), stepResult, receipt, evaluation };
    } catch (error) {
      if (lease) await this.interventions.releaseResume(record.intervention_id, lease).catch(() => {});
      throw error;
    }
  }

  async #executeCleanup(step, receipt, startedAt, context = null) {
    return this.verificationStepHandler.executeCleanup(step, receipt, startedAt, context);
  }

}
