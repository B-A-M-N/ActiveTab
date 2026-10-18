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
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import { createHash, randomUUID } from "node:crypto";
import { adjudicatePreActionReview } from "../decisions/adjudication.js";
import { acquireBrowserTargetLease } from "./runState.js";
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

function classifyDiagnosticResult(snapshot) {
  const statuses = [snapshot?.data?.result?.status, snapshot?.data?.status, snapshot?.status]
    .filter(status => typeof status === "string");
  const refusal = statuses.find(status => ["refused", "denied"].includes(status));
  if (refusal) {
    return { status: STEP_STATUS.BLOCKED, effectStatus: refusal, resultStatus: refusal };
  }
  const failure = statuses.find(status => ["error", "failed"].includes(status));
  if (failure) {
    return { status: STEP_STATUS.FAIL, effectStatus: failure, resultStatus: failure };
  }
  const uncertain = statuses.find(status => ["uncertain", "unavailable", "unknown"].includes(status));
  if (uncertain) {
    return { status: STEP_STATUS.UNCERTAIN, effectStatus: uncertain, resultStatus: uncertain };
  }
  const unexpected = statuses.find(status => !["ok", "available", "empty"].includes(status));
  if (unexpected) {
    return { status: STEP_STATUS.UNCERTAIN, effectStatus: "unrecognized_status", resultStatus: unexpected };
  }
  const resultStatus = statuses[0] ?? null;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.data || typeof snapshot.data !== "object") {
    return { status: STEP_STATUS.UNCERTAIN, effectStatus: "missing_snapshot_data", resultStatus };
  }
  return { status: STEP_STATUS.PASS, effectStatus: resultStatus ?? "collected", resultStatus };
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
    this.targetLease = null;
    this.existingRunStateId = existingRunStateId;
    this.principalId = principalId;
    this.profileId = profileId;
    this.policyVersion = policyVersion;
    this.decisionEpisodeId = null;
    this.currentTelemetryStepId = null;
    this.currentRuntimeStepId = null;
    this.onIntervention = null; // async (record) => {}
    this.onRunSuspended = null; // async (receipt, record) => {}
  }

  async run(workflow, { runId } = {}) {
    const effectiveRunId = runId ?? this.existingRunStateId ?? this.collector?.runId ?? crypto.randomUUID();
    const releaseLease = await this.#acquireExecutionLeases(effectiveRunId);
    try { return await this.#runWorkflow(workflow, { runId: effectiveRunId }); }
    finally { await releaseLease?.(); }
  }

  async #acquireExecutionLeases(runId) {
    if (!this.runStateStore) return null;
    const releaseRunLease = await this.runStateStore.acquireExecutionLease(runId);
    let targetLease = null;
    try {
      const targetId = this.session?.target?.id;
      if (targetId) targetLease = await acquireBrowserTargetLease(this.runStateStore, this.session, runId);
      this.targetLease = targetLease;
    } catch (error) {
      await releaseRunLease();
      throw error;
    }
    return async () => {
      if (this.targetLease === targetLease) this.targetLease = null;
      await targetLease?.release();
      await releaseRunLease();
    };
  }

  async #assertTargetLeaseCurrent() {
    if (this.targetLease) await this.targetLease.assertCurrent();
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
    if (priorState?.episodeId) this.decisionEpisodeId = priorState.episodeId;
    await this.#ensureDecisionEpisode(receipt);
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
    this.#completeDecisionEpisode(receipt);
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
    let run = await this.runStateStore.getFresh(this.existingRunStateId ?? receipt.runId);
    if (this.existingRunStateId && !run) throw new Error("The bound durable run state no longer exists.");
    const environmentId = this.environment?.environmentId ?? null;
    const targetId = this.session?.target?.id ?? null;
    const authenticationRealm = this.environment?.applications?.[0]?.authenticationRealm ?? null;
    if (run) {
      if (run.runId !== receipt.runId || environmentId !== run.environmentId
        || targetId !== (run.target?.targetId ?? null)
        || authenticationRealm !== run.authenticationRealm
        || (this.profileId ?? null) !== (run.profileId ?? null)
        || (this.principalId ?? null) !== (run.principalId ?? null)
        || this.policyVersion !== run.policyVersion) {
        throw new Error("Existing run state does not match the current run, environment, or browser target binding.");
      }
    } else {
      await this.runStateStore.create({
        runId: receipt.runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersion: workflow.version ?? null,
        environmentId,
        authenticationRealm,
        targetId,
        principalId: this.principalId,
        profileId: this.profileId,
        policyVersion: this.policyVersion,
        episodeId: this.decisionEpisodeId
      });
      run = await this.runStateStore.getFresh(receipt.runId);
    }
    if (targetId && this.session?.attached !== true) throw new Error("Durable run continuation requires the exact browser target to be attached.");
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
    run = await this.runStateStore.getFresh(receipt.runId);
    if (this.decisionEpisodeId && !run?.episodeId) {
      await this.runStateStore.update(receipt.runId, { episodeId: this.decisionEpisodeId });
      run = await this.runStateStore.getFresh(receipt.runId);
    } else if (this.decisionEpisodeId && run?.episodeId !== this.decisionEpisodeId) {
      throw new Error("Decision episode does not match the durable run binding.");
    }
    if (run?.pendingOperations?.some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status))) return run;
    if (["passed", "failed", "blocked", "canceled", "expired", "reconciling"].includes(run?.status)) return run;
    if (targetId) {
      const current = await this.runStateStore.getFresh(receipt.runId);
      await this.runStateStore.update(receipt.runId, { target: { ...current.target, targetId, attached: true } });
      if (this.targetLease) await this.runStateStore.bindTargetLease(receipt.runId, { targetId, fencingToken: this.targetLease.fencingToken });
    }
    await this.runStateStore.update(receipt.runId, { status: "running", currentStepId: null });
    return this.runStateStore.getFresh(receipt.runId);
  }

  async #persistStepCheckpoint(receipt, stepId) {
    if (!this.runStateStore) return;
    const step = receipt.steps.findLast(item => item.stepId === stepId);
    if (!step) return;
    await this.runStateStore.updateCheckpoint(receipt.runId, {
      currentStepId: step.status === STEP_STATUS.PASS || step.status === STEP_STATUS.SKIPPED ? null : stepId,
      stepId,
      type: step.type,
      status: step.status,
      evidenceIds: step.evidenceIds ?? []
    });
  }

  async #checkpointRecordedStep(receipt, stepId) {
    try {
      await this.#persistStepCheckpoint(receipt, stepId);
      return true;
    } catch {
      const step = receipt.steps.findLast(item => item.stepId === stepId);
      if (step) {
        step.status = STEP_STATUS.UNCERTAIN;
        step.reason = "The execution result could not be durably checkpointed; reconciliation is required.";
      }
      return false;
    }
  }

  async #completeRunState(receipt) {
    if (!this.runStateStore) return;
    const waiting = isWaitingRunStatus(receipt.status);
    const status = waiting ? receipt.status.toLowerCase()
      : receipt.status === RUN_STATUS.UNCERTAIN ? "reconciling" : receipt.status.toLowerCase();
    const state = await this.runStateStore.getFresh(receipt.runId);
    await this.runStateStore.update(receipt.runId, {
      status,
      currentStepId: waiting || receipt.status === RUN_STATUS.UNCERTAIN ? state?.currentStepId ?? null : null,
      pendingInterventionId: waiting
        ? receipt.interventions?.findLast(item => item.state === INTERVENTION_STATE.WAITING)?.interventionId ?? null
        : null
    });
  }

  async #ensureDecisionEpisode(receipt) {
    if (!this.decisionRuntime) return null;
    const environmentId = String(this.environment?.environmentId ?? "").toLowerCase();
    const environmentClass = this.environment?.environmentClass
      ?? (environmentId.includes("production") ? "production" : environmentId.includes("staging") ? "staging" : environmentId ? "local" : "unknown");
    const episode = this.decisionRuntime.startEpisode({
      ...(this.decisionEpisodeId ? { episodeId: this.decisionEpisodeId } : {}),
      runId: receipt.runId,
      workflowId: `workflow_${createHash("sha256").update(receipt.workflowId).digest("hex").slice(0, 16)}`,
      applicationId: this.environment?.applications?.[0]?.applicationId ?? "unknown",
      environmentClass,
      executionMode: "agent_directed",
      policyVersion: "active_policy_v1",
      workflowKind: "declarative_test"
    });
    this.decisionEpisodeId = episode.episodeId;
    return episode;
  }

  #completeDecisionEpisode(receipt) {
    if (!this.decisionRuntime || !this.decisionEpisodeId) return;
    const status = receipt.status === RUN_STATUS.PASSED ? "passed"
      : receipt.status === RUN_STATUS.BLOCKED ? "blocked"
        : receipt.status === RUN_STATUS.UNCERTAIN ? "uncertain"
        : receipt.status === RUN_STATUS.CANCELED ? "canceled"
          : receipt.status === RUN_STATUS.WAITING_FOR_HUMAN_DECISION || isWaitingRunStatus(receipt.status) ? "suspended"
            : "failed";
    if (status === "suspended" || status === "uncertain") return;
    const cleanupStatus = receipt.cleanup.length === 0 ? "not_required"
      : receipt.cleanup.every(item => item.status === "PASS" || item.status === "verified") ? "verified"
        : receipt.cleanup.some(item => item.status === "FAIL" || item.status === "failed") ? "failed"
          : "unknown";
    this.decisionRuntime.completeEpisode({ episodeId: this.decisionEpisodeId, runId: receipt.runId, status, cleanupStatus });
  }

  async #telemetryHooks(receipt, action, candidate = null, decisionContext = null) {
    if (!this.decisionRuntime && !this.runStateStore) return null;
    if (this.decisionRuntime && !this.decisionEpisodeId) await this.#ensureDecisionEpisode(receipt);
    const decisionId = randomUUID();
    const stepId = this.currentTelemetryStepId ?? "step_unknown";
    const stateStepId = this.currentRuntimeStepId ?? stepId;
    const operationId = createHash("sha256").update(`${receipt.runId}\0${stateStepId}`).digest("hex").slice(0, 40);
    const operationClass = decisionContext?.operationClass ?? (action === "navigate" ? "navigation" : "unknown");
    const targetRole = decisionContext?.targetRole ?? (candidate ? "browser_target" : "navigation_destination");
    const reviewRequired = decisionContext?.reviewRequired ?? (
      action === "navigate" || action === "upload" || action === "toggle" || candidate?.submitsForm === true
      || (action === "click" && (candidate?.tag === "a" || candidate?.role === "link") && typeof candidate?.href === "string")
    );
    const runtime = this.decisionRuntime;
    const episodeId = this.decisionEpisodeId;
    const signal = this.signal;
    const thisRunner = this;
    let beforeEvidenceId = null;
    return {
      decisionId,
      operationId,
      stepId,
      async onAdmission({ observation } = {}) {
        if (!runtime) return { allowed: true, grantsAuthority: false, category: "deterministic_policy_only" };
        if (!observation?.evidenceId) throw new Error("The admitted operation has no fresh observation identity.");
        beforeEvidenceId = observation.evidenceId;
        let adjudication;
        if (reviewRequired) {
          const review = await runtime.reviewBeforeAction({
            episodeId,
            runId: receipt.runId,
            stepId,
            decisionId,
            observation,
            operation: action,
            operationClass,
            targetRole,
            expectedOutcomeClass: "browser_state_change",
            ...(candidate ? { candidate } : {}),
            ...(decisionContext?.semanticAnnotation ? { semanticAnnotation: decisionContext.semanticAnnotation } : {}),
            ...(decisionContext?.semanticEventIds?.length ? { semanticEventIds: decisionContext.semanticEventIds } : {}),
            signal
          });
          adjudication = adjudicatePreActionReview(review);
        } else {
          await runtime.recordReviewSkipped({
            episodeId,
            runId: receipt.runId,
            stepId,
            decisionId,
            observation,
            operation: action,
            operationClass,
            targetRole,
            expectedOutcomeClass: "browser_state_change",
            reasonCode: "policy_boundary_not_triggered"
          });
          adjudication = {
            allowed: true,
            grantsAuthority: false,
            category: "review_not_required",
            reason: null
          };
        }
        if (!adjudication.allowed) return adjudication;
        await runtime.recordPolicy({
          episodeId,
          runId: receipt.runId,
          stepId,
          decisionId,
          observationId: observation.evidenceId,
          disposition: "allow",
          reasonCode: reviewRequired ? "independent_review_admitted" : "review_not_required_by_boundary_policy"
        });
        return adjudication;
      },
      async onReserve({ observation } = {}) {
        const effectDigest = createHash("sha256").update(JSON.stringify({
          operationId,
          stepId: stateStepId,
          action,
          operationClass,
          environmentId: thisRunner.environment?.environmentId ?? null,
          targetId: thisRunner.session?.target?.id ?? null,
          candidateIdentity: candidate?.identity ?? null,
          candidateKind: candidate?.kind ?? null,
          candidateTag: candidate?.tag ?? null
        })).digest("hex");
        if (thisRunner.runStateStore) {
          await thisRunner.runStateStore.reserveOperation(receipt.runId, {
            operationId,
            stepId: stateStepId,
            action,
            effectDigest,
            environmentId: thisRunner.environment?.environmentId ?? null,
            targetId: thisRunner.session?.target?.id ?? null,
            targetFencingToken: thisRunner.targetLease?.fencingToken ?? null
          });
          await thisRunner.runStateStore.update(receipt.runId, { status: "dispatching", currentStepId: stateStepId });
        }
        if (runtime) {
          await runtime.reserveExecution({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation?.evidenceId ?? beforeEvidenceId, operation: action, targetRole, operationId });
        }
        return { allowed: true };
      },
      async onDispatch({ dispatchStatus, observation } = {}) {
        const errors = [];
        if (runtime) {
          try { await runtime.recordDispatch({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: beforeEvidenceId, operation: action, targetRole, operationId, dispatchStatus }); }
          catch (error) { errors.push(error); }
        }
        if (thisRunner.runStateStore) {
          try {
            await thisRunner.runStateStore.recordOperationDispatch(receipt.runId, {
              operationId,
              status: dispatchStatus === "uncertain" ? "UNCERTAIN"
                : dispatchStatus === "refused" ? "REFUSED" : "DISPATCHED",
              receiptId: observation?.evidenceId ?? null
            });
          } catch (error) { errors.push(error); }
        }
        if (errors.length) throw errors[0];
      },
      async recordDenied(observation) {
        if (!runtime || !observation?.evidenceId) return;
        beforeEvidenceId = observation.evidenceId;
        await runtime.recordPolicy({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation.evidenceId, disposition: "deny", reasonCode: "authorized_executor_refused" });
      },
      async recordObserved(observation, changed, outcomeClass = "browser_state_observed") {
        if (!runtime || !observation?.evidenceId || !beforeEvidenceId) return;
        await runtime.recordObserved({ episodeId, runId: receipt.runId, stepId, decisionId, observationId: observation.evidenceId, outcomeClass, changed, evidenceRefs: [beforeEvidenceId, observation.evidenceId] });
      },
      async recordVerification({ status, oracleType, reasonCode, verifiedCode, observation, evidenceIds = [] } = {}) {
        if (thisRunner.runStateStore) {
          await thisRunner.runStateStore.reconcileOperation(receipt.runId, {
            operationId,
            status: status === STEP_STATUS.PASS ? "VERIFIED"
              : status === STEP_STATUS.FAIL ? "FAILED" : "UNCERTAIN",
            evidenceIds,
            summary: reasonCode ?? status ?? "unresolved verification"
          });
        }
        if (runtime && typeof runtime.recordVerification === "function" && observation?.evidenceId) {
          await runtime.recordVerification({
            episodeId, runId: receipt.runId, stepId, decisionId,
            observationId: observation.evidenceId,
            status: status === STEP_STATUS.PASS ? "verified_pass"
              : status === STEP_STATUS.FAIL ? "verified_fail"
                : status === STEP_STATUS.CANCELED ? "not_run" : "uncertain",
            oracleType: oracleType ?? "unavailable",
            reasonCode: reasonCode ?? "verification_unresolved",
            ...(verifiedCode !== undefined ? { verifiedCode } : {}),
            evidenceRefs: [...new Set([beforeEvidenceId, ...evidenceIds].filter(Boolean))]
          });
        }
        return true;
      }
    };
  }

  async #executeStep(step, receipt, context = null, stepStatuses = new Map()) {
    const startedAt = new Date().toISOString();
    try {
      switch (step.type) {
        case "setup": return await this.#executeSetup(step, receipt, startedAt);
        case "navigate": return await this.#executeNavigate(step, receipt, startedAt, context);
        case "interact": return await this.#executeInteract(step, receipt, startedAt, context);
        case "api_call": return await this.#executeApiCall(step, receipt, startedAt);
        case "wait_for": return await this.#executeWaitFor(step, receipt, startedAt);
        case "assert": return await this.#executeAssert(step, receipt, startedAt);
        case "diagnostic_snapshot": return await this.#executeDiagnosticSnapshot(step, receipt, startedAt);
        case "controlled_failure": return await this.#executeControlledFailure(step, receipt, startedAt);
        case "retry_verification": return await this.#executeRetryVerification(step, receipt, startedAt);
        case "postcondition": return await this.#executePostcondition(step, receipt, startedAt);
        case "cleanup": return await this.#executeCleanup(step, receipt, startedAt, context);
        case "goal": return await this.#executeGoal(step, receipt, startedAt);
        case "qualify": return await this.#executeQualification(step, receipt, startedAt, context);
        case "set_variable": return this.#executeSetVariable(step, receipt, startedAt, context, stepStatuses);
        case "repeat": return await this.#executeRepeat(step, receipt, startedAt, context);
        case "subworkflow": return await this.#executeSubworkflow(step, receipt, startedAt, context);
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

  async #executeQualification(step, receipt, startedAt, context) {
    const unavailable = reasonCode => ({
      status: "unavailable",
      qualificationId: null,
      reasonCode,
      evidenceRefs: []
    });
    let result;
    if (!this.qualificationService || !this.decisionEpisodeId) {
      result = unavailable("qualification_service_unavailable");
    } else {
      try {
        result = await this.qualificationService.qualify({
          runId: receipt.runId,
          episodeId: this.decisionEpisodeId,
          stepId: this.currentTelemetryStepId ?? telemetryStepId(step.id),
          scenarioId: step.scenarioId,
          providerId: step.providerId,
          trigger: step.trigger,
          principalId: this.principalId ?? "unknown",
          strategyFingerprint: context?.workflowHash ?? createHash("sha256").update(step.id).digest("hex"),
          sourceEventIds: step.sourceEventIds ?? [],
          evidenceRefs: step.evidenceRefs ?? [],
          signal: this.signal
        });
      } catch {
        result = unavailable("qualification_invocation_unavailable");
      }
    }
    const qualificationStatus = result?.status ?? "unavailable";
    const required = step.required === true;
    const stepStatus = required && qualificationStatus !== "qualified" ? STEP_STATUS.FAIL : STEP_STATUS.PASS;
    const reason = qualificationStatus === "qualified" ? "Candidate strategy qualified against the independent fixture oracle."
      : qualificationStatus === "not_qualified" ? "Candidate strategy did not satisfy the independent fixture oracle."
        : qualificationStatus === "inconclusive" ? "Fixture qualification was inconclusive; actual task execution remains governed by its own policy and evidence."
          : "Fixture qualification was unavailable; actual task execution remains governed by its own policy and evidence.";
    const details = {
      qualificationStatus,
      required,
      ...(typeof result?.qualificationId === "string" ? { qualificationId: result.qualificationId } : {}),
      ...(typeof result?.reasonCode === "string" ? { reasonCode: result.reasonCode } : {}),
      evidenceRefs: (result?.evidenceRefs ?? []).filter(ref => typeof ref === "string").slice(0, 32)
    };
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status: stepStatus,
      reason,
      evidenceIds: details.evidenceRefs,
      startedAt,
      details
    });
    return { status: stepStatus, reason, qualificationStatus };
  }

  async #observe() {
    if (!this.session) return null;
    return await this.session.observe();
  }

  #resolveWorkflowValue(value, context, stepStatuses = context?.stepStatuses) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value).length === 1 && typeof value.variable === "string") {
        return context?.variables?.get(value.variable);
      }
      if (Object.keys(value).length === 1 && typeof value.stepStatus === "string") {
        return stepStatuses?.get(value.stepStatus);
      }
    }
    return value;
  }

  #executeSetVariable(step, receipt, startedAt, context, stepStatuses) {
    const resolved = this.#resolveWorkflowValue(step.value, context, stepStatuses);
    if (resolved === undefined || !(resolved === null || ["string", "number", "boolean"].includes(typeof resolved))) {
      const reason = "Variable assignment source is unavailable or is not a scalar value.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    if (!context?.variables) {
      const reason = "No scoped workflow variable context is available.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    context.variables.set(step.name, resolved);
    const reason = "Scoped workflow variable assigned in memory.";
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt });
    return { status: STEP_STATUS.PASS, reason };
  }

  async #executeRepeat(step, receipt, startedAt, parentContext) {
    const context = parentContext ?? { variables: new Map(), workflowStack: new Set(), depth: 0 };
    for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
      if (this.signal?.aborted) {
        const reason = "Run was canceled before the next bounded loop iteration.";
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.CANCELED, reason, startedAt });
        return { status: STEP_STATUS.CANCELED, reason };
      }
      const iterationContext = {
        variables: new Map(context.variables),
        workflowStack: new Set(context.workflowStack),
        depth: context.depth + 1,
        stepStatuses: new Map(),
        completedStatuses: context.completedStatuses,
        budget: context.budget
      };
      const result = await this.#executeWorkflowSteps(
        { id: `${step.id}-body`, name: "bounded repeat body", steps: step.body },
        receipt,
        iterationContext,
        { stepIdPrefix: `${step.id}/iteration-${iteration}` }
      );
      if (result.suspension) {
        return {
          status: STEP_STATUS_EXTENDED.SUSPENDED,
          externalState: result.suspension.externalState,
          reason: `Bounded loop suspended at '${result.suspension.stepId}'.`
        };
      }
      const bodyStatuses = [...result.stepStatuses.values()];
      const failedBodyStatus = bodyStatuses.find(status => status !== STEP_STATUS.PASS);
      if (failedBodyStatus) {
        const reason = `Bounded loop body ended with ${failedBodyStatus}; no further iteration was dispatched.`;
        return { status: failedBodyStatus, reason };
      }
      const until = evaluateAssertion(step.until, {
        observation: await this.#observe(),
        collector: this.collector,
        correlator: this.correlator
      });
      if (until.status === STEP_STATUS.PASS) {
        const reason = `Loop condition verified after ${iteration} bounded iteration${iteration === 1 ? "" : "s"}.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: STEP_STATUS.PASS, reason };
      }
      if (until.status === STEP_STATUS.UNCERTAIN) {
        const reason = `Loop condition could not be verified after iteration ${iteration}; execution stopped without another retry.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: STEP_STATUS.UNCERTAIN, reason };
      }
      if (until.status === STEP_STATUS.BLOCKED || until.status === STEP_STATUS.CANCELED) {
        const reason = until.status === STEP_STATUS.CANCELED
          ? "The bounded loop was canceled after its current iteration."
          : "The bounded loop condition is blocked; no further iteration was dispatched.";
        receipt.recordStep({ stepId: step.id, type: step.type, status: until.status, reason, startedAt, evidenceIds: until.evidenceIds ?? [] });
        return { status: until.status, reason };
      }
    }
    const reason = `Loop condition remained false after the declared maximum of ${step.maxIterations} iterations.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
    return { status: STEP_STATUS.FAIL, reason };
  }

  async #executeSubworkflow(step, receipt, startedAt, parentContext) {
    const workflow = this.#registeredWorkflow(step.workflowRef);
    if (!workflow) {
      const reason = `Trusted workflow registry has no subworkflow '${step.workflowRef}'.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const parent = parentContext ?? { variables: new Map(), workflowStack: new Set(), depth: 0 };
    if (parent.depth >= 8 || parent.workflowStack.has(workflow.id)) {
      const reason = "Subworkflow nesting exceeded its depth limit or formed a recursive reference.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const validation = validateWorkflow(workflow, { maxSteps: this.maxSteps });
    if (!validation.valid) {
      const reason = "Registered subworkflow failed schema validation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const inputs = step.inputs ?? {};
    const allowedInputs = new Set(workflow.inputNames ?? []);
    if (Object.keys(inputs).some(name => !allowedInputs.has(name))
      || [...allowedInputs].some(name => !Object.hasOwn(inputs, name) && !Object.hasOwn(workflow.inputs ?? {}, name))) {
      const reason = "Subworkflow inputs do not satisfy the registered workflow interface.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const variables = new Map(Object.entries(workflow.inputs ?? {}));
    for (const [name, value] of Object.entries(inputs)) {
      const resolved = this.#resolveWorkflowValue(value, parent);
      if (resolved === undefined || !(resolved === null || ["string", "number", "boolean"].includes(typeof resolved))) {
        const reason = `Subworkflow input '${name}' could not be resolved to a scalar.`;
        receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
        return { status: STEP_STATUS.BLOCKED, reason };
      }
      variables.set(name, resolved);
    }
    const workflowStack = new Set(parent.workflowStack);
    workflowStack.add(workflow.id);
    const childContext = { variables, workflowStack, depth: parent.depth + 1, stepStatuses: new Map(), completedStatuses: parent.completedStatuses, budget: parent.budget };
    const childResult = await this.#executeWorkflowSteps(workflow, receipt, childContext, { stepIdPrefix: step.id });
    if (isWaitingRunStatus(receipt.status)) {
      const reason = `Registered subworkflow '${step.workflowRef}' suspended at its child step.`;
      return {
        status: STEP_STATUS_EXTENDED.SUSPENDED,
        externalState: childResult.suspension?.externalState ?? "waiting_for_human_decision",
        reason
      };
    }
    const childStatus = deriveWorkflowRunStatus(workflow, childResult.stepStatuses);
    if (childStatus === RUN_STATUS.PASSED) {
      for (const [from, to] of Object.entries(step.outputs ?? {})) {
        if (!variables.has(from)) {
          const reason = "Registered subworkflow output was not defined in its private scope.";
          receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt });
          return { status: STEP_STATUS.UNCERTAIN, reason };
        }
        parent.variables.set(to, variables.get(from));
      }
      const reason = `Registered subworkflow '${step.workflowRef}' completed its declared steps.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.PASS, reason, startedAt });
      return { status: STEP_STATUS.PASS, reason };
    }
    const status = childStatus === RUN_STATUS.UNCERTAIN ? STEP_STATUS.UNCERTAIN
      : childStatus === RUN_STATUS.BLOCKED ? STEP_STATUS.BLOCKED
        : childStatus === RUN_STATUS.CANCELED ? STEP_STATUS.CANCELED : STEP_STATUS.FAIL;
    const reason = `Registered subworkflow '${step.workflowRef}' ended ${status}.`;
    receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt });
    return { status, reason };
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
    if (!this.session) {
      const reason = "No browser session available for navigation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const url = this.#resolveWorkflowValue(step.url, context);
    if (typeof url !== "string" || url.length === 0) {
      const reason = "Navigation URL is unavailable in the current scoped workflow inputs.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const preObservation = await this.session.observe();
    const telemetry = await this.#telemetryHooks(receipt, "navigate");
    this.#emitTraceEvent({ eventId: `step:${step.id}:start`, runId: receipt.runId, stepId: step.id, event: "step_start", actionType: "navigate" });
    let authResult;
    try {
      this.#emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: "navigate" });
      authResult = await executeAuthorizedAction({
        session: this.session,
        environment: this.environment,
        action: "navigate",
        url,
        expectedUrlPattern: step.expectedUrlPattern ?? null,
        localFixture: this.localFixture,
        assertExecutionLease: this.targetLease ? () => this.#assertTargetLeaseCurrent() : null,
        ...(telemetry ? { onAdmission: telemetry.onAdmission, onReserve: telemetry.onReserve, onDispatch: telemetry.onDispatch } : {})
      });
      if (!authResult.dispatched) {
        if (telemetry && !authResult.authorized) await telemetry.recordDenied(authResult.observation ?? preObservation);
        const status = authResult.status === "uncertain" ? STEP_STATUS.UNCERTAIN
          : authResult.authorized ? STEP_STATUS.FAIL : STEP_STATUS.BLOCKED;
        const reason = authResult.status === "uncertain"
          ? `Navigation outcome is uncertain: ${authResult.reason}`
          : authResult.authorized
          ? `Navigation dispatch failed: ${authResult.reason}`
          : `Navigation refused by policy: ${authResult.reason}`;
        receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt });
        return { status, reason };
      }
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
      url === postObservation.page.url ||
      postObservation.page.url.startsWith(url) ||
      (step.expectedUrlPattern ? new RegExp(step.expectedUrlPattern).test(postObservation.page.url) : false)
    );
    const telemetryChanged = postObservation?.pageChangeFingerprint !== preObservation.pageChangeFingerprint;
    if (telemetry) await telemetry.recordObserved(postObservation, telemetryChanged, navigationSucceeded ? "navigation_destination_observed" : "navigation_mismatch_observed");
    let status = authResult?.telemetryError ? STEP_STATUS.UNCERTAIN : navigationSucceeded ? STEP_STATUS.PASS : STEP_STATUS.FAIL;
    let reason = navigationSucceeded
      ? `Navigated to ${postObservation.page.url}.`
      : "Post-navigation URL did not match the requested destination.";
    if (telemetry) {
      try {
        await telemetry.recordVerification({
          status,
          oracleType: "authorized_destination_url",
          reasonCode: navigationSucceeded ? "destination_observed" : "destination_mismatch",
          observation: postObservation,
          evidenceIds: [preObservation.evidenceId, postObservation?.evidenceId].filter(Boolean)
        });
      } catch {
        status = STEP_STATUS.UNCERTAIN;
        reason = "Navigation was observed but its durable operation receipt could not be reconciled.";
      }
    }
    this.#emitTraceEvent({ eventId: `step:${step.id}:verify`, runId: receipt.runId, stepId: step.id, event: "outcome_verification", status, observedUrl: postObservation?.page?.url, evidenceId: postObservation?.evidenceId });
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [postObservation?.evidenceId ?? ""].filter(Boolean),
      details: { finalUrl: postObservation?.page?.url ?? null, title: postObservation?.page?.title ?? null }
    });
    return { status, reason, observation: postObservation };
  }

  async #executeInteract(step, receipt, startedAt, context = null) {
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
    const action = { ...step.action, value: this.#resolveWorkflowValue(step.action.value, context) };
    if (step.action.value !== undefined && action.value === undefined) {
      const reason = "Interaction value is unavailable in the current scoped workflow inputs.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const candidate = this.#resolveCandidate(observation, action);
    if (!candidate) {
      const reason = `No unique candidate matched the action target: ${JSON.stringify(action.target ?? {})}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const decisionContext = this.operationAuthorizer?.decisionContext?.(action.operationId) ?? null;
    const telemetry = await this.#telemetryHooks(receipt, action.type, candidate, decisionContext);
    this.#emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: action.type, backendNodeId: candidate.backendNodeId });
    let dispatchResult;
    let authResult;
    try {
      authResult = await executeAuthorizedAction({
        session: this.session,
        environment: this.environment,
        goal: step.goal ?? null,
        action: action.type,
        candidate,
        value: action.value ?? null,
        filePaths: action.filePaths ?? null,
        localFixture: this.localFixture,
        operationId: action.operationId ?? null,
        operationAuthorizer: this.operationAuthorizer,
        assertExecutionLease: this.targetLease ? () => this.#assertTargetLeaseCurrent() : null,
        ...(telemetry ? { onAdmission: telemetry.onAdmission, onReserve: telemetry.onReserve, onDispatch: telemetry.onDispatch } : {})
      });
      if (!authResult.dispatched) {
        if (telemetry && !authResult.authorized) await telemetry.recordDenied(authResult.observation ?? observation);
        const status = authResult.status === "uncertain" ? STEP_STATUS.UNCERTAIN
          : authResult.authorized ? STEP_STATUS.FAIL : STEP_STATUS.BLOCKED;
        const reason = authResult.status === "uncertain"
          ? `Interaction outcome is uncertain: ${authResult.reason}`
          : authResult.authorized
          ? `Interaction dispatch failed: ${authResult.reason}`
          : `Interaction refused by policy: ${authResult.reason}`;
        receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, evidenceIds: [observation.evidenceId] });
        return { status, reason };
      }
      dispatchResult = authResult.dispatchResult;
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
    if (telemetry) await telemetry.recordObserved(postObservation, stateChanged, stateChanged ? "interaction_state_changed" : "interaction_state_unchanged");
    let valueVerification = null;
    if (action.verifyValue === true) {
      if (typeof this.session.verifyControlValue !== "function") {
        valueVerification = { verified: false, matches: false, reason: "The browser adapter cannot verify the exact control value." };
      } else {
        try { valueVerification = await this.session.verifyControlValue(candidate, action.value ?? ""); }
        catch { valueVerification = { verified: false, matches: false, reason: "Exact control-value verification failed." }; }
      }
    }
    const actionPostcondition = action.postcondition
      ? evaluateAssertion(action.postcondition, { observation: postObservation, collector: this.collector, correlator: this.correlator })
      : null;
    let status = authResult.telemetryError || authResult.operationError
      ? STEP_STATUS.UNCERTAIN
      : action.verifyValue === true
        ? valueVerification?.verified ? valueVerification.matches ? STEP_STATUS.PASS : STEP_STATUS.FAIL : STEP_STATUS.UNCERTAIN
        : actionPostcondition
          ? actionPostcondition.status
          : STEP_STATUS.UNCERTAIN;
    let reason = action.verifyValue === true
      ? valueVerification?.matches === true
        ? `Interaction '${action.type}' value was verified locally.`
        : valueVerification?.verified
          ? `Interaction '${action.type}' value did not match the caller-supplied value.`
          : `Interaction '${action.type}' was dispatched, but its exact value could not be verified.`
      : actionPostcondition
        ? actionPostcondition.reason
        : stateChanged
          ? `Interaction '${action.type}' changed page state, but no independent postcondition was supplied.`
          : `Interaction '${action.type}' was dispatched, but no independent postcondition was supplied.`;
    if (telemetry) {
      try {
        await telemetry.recordVerification({
          status,
          oracleType: actionPostcondition ? `assertion:${action.postcondition.type}` : action.verifyValue === true ? "control_value" : "none",
          reasonCode: status === STEP_STATUS.PASS ? "postcondition_verified"
            : status === STEP_STATUS.FAIL ? "postcondition_failed" : "independent_postcondition_missing_or_uncertain",
          observation: postObservation,
          evidenceIds: [...new Set([observation.evidenceId, postObservation?.evidenceId, ...(actionPostcondition?.evidenceIds ?? [])].filter(Boolean))]
        });
      } catch {
        status = STEP_STATUS.UNCERTAIN;
        reason = "Interaction was observed but its durable operation receipt could not be reconciled.";
      }
    }
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [...new Set([observation.evidenceId, postObservation?.evidenceId ?? "", ...(actionPostcondition?.evidenceIds ?? [])].filter(Boolean))],
      details: {
        actionType: action.type,
        backendNodeId: candidate.backendNodeId,
        dispatchStatus: authResult.status,
        beforeEvidenceId: observation.evidenceId,
        afterEvidenceId: postObservation?.evidenceId ?? null,
        ...(telemetry ? { decisionId: telemetry.decisionId, operationId: telemetry.operationId } : {}),
        stateChanged,
        ...(action.verifyValue === true ? { valueVerified: valueVerification?.matches === true } : {}),
        ...(actionPostcondition ? { postconditionStatus: actionPostcondition.status } : {})
      }
    });
    return { status, reason, observation: postObservation };
  }

  #resolveCandidate(observation, action) {
    if (!observation?.candidates || !action?.target) return null;
    const target = action.target;
    if (target.observationId !== undefined && target.observationId !== observation.evidenceId) return null;
    const matches = observation.candidates.filter(candidate => {
      if (target.identity && candidate.identity !== target.identity) return false;
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
      const classified = classifyDiagnosticResult(snapshot);
      const status = classified.status;
      const reason = status === STEP_STATUS.PASS
        ? `Diagnostic snapshot collected from source '${sourceId}'; this does not verify an application outcome.`
        : status === STEP_STATUS.BLOCKED
          ? `Diagnostic operation '${operation.operationId}' was refused by source '${sourceId}'.`
          : status === STEP_STATUS.FAIL
            ? `Diagnostic operation '${operation.operationId}' returned an error from source '${sourceId}'.`
            : `Diagnostic operation '${operation.operationId}' returned an unavailable or unrecognized result; outcome remains uncertain.`;
      receipt.recordStep({
        stepId: step.id, type: step.type, status, reason, startedAt,
        evidenceIds: [snapshot?.evidenceId ?? snapshot?.sourceId ?? ""].filter(Boolean),
        details: {
          operationId: operation.operationId,
          sourceId,
          dispatchStatus: "dispatched",
          effectStatus: classified.effectStatus,
          verificationStatus: "not_verified",
          ...(classified.resultStatus ? { resultStatus: classified.resultStatus } : {})
        }
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
          episodeId: this.decisionEpisodeId,
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
      return await this.#verifyCleanup(step, receipt, startedAt, await this.#executeApiCall(apiStep, receipt, startedAt));
    }
    if (step.action.type === "interact") {
      const interactStep = { ...step, type: "cleanup", action: step.action };
      return await this.#verifyCleanup(step, receipt, startedAt, await this.#executeInteract(interactStep, receipt, startedAt, context));
    }
    // For an unknown cleanup action type, do not report PASS.
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
      observation: await this.#observe(),
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
