import { evaluateCompletion, externalRunState, INTERVENTION_STATE } from "../../runtime/interventions.js";
import { isWaitingRunStatus, RUN_STATUS, STEP_STATUS } from "../schema.js";
import { deriveRunStatus, STEP_STATUS_EXTENDED } from "../receipts.js";
import { deriveWorkflowRunStatus } from "../execution/workflowScheduler.js";
import { resolveObservedApplication } from "../../environments/model.js";

/** Owns durable human handoffs and evidence-gated workflow continuation. */
export class InterventionCoordinator {
  constructor({
    interventions = null,
    environment = null,
    session = null,
    runStateStore = null,
    runStateCoordinator,
    maxSteps,
    workflowRegistry = null,
    profileId = null,
    principalId = null,
    policyVersion = "active_policy_v1",
    acquireExecutionLeases,
    ensureDecisionEpisode,
    persistStepCheckpoint,
    completeRunState,
    completeDecisionEpisode,
    executeWorkflowSteps,
    executeGoalStep,
    getWorkflowFingerprint,
    getOnRunSuspended,
    getOnIntervention,
    setCurrentTelemetryStepId,
    telemetryStepId
  } = {}) {
    this.interventions = interventions;
    this.environment = environment;
    this.session = session;
    this.runStateStore = runStateStore;
    this.runStateCoordinator = runStateCoordinator;
    this.maxSteps = maxSteps;
    this.workflowRegistry = workflowRegistry;
    this.profileId = profileId;
    this.principalId = principalId;
    this.policyVersion = policyVersion;
    this.acquireExecutionLeases = acquireExecutionLeases ?? (async () => null);
    this.ensureDecisionEpisode = ensureDecisionEpisode ?? (async () => {});
    this.persistStepCheckpoint = persistStepCheckpoint ?? (async () => {});
    this.completeRunState = completeRunState ?? (async () => {});
    this.completeDecisionEpisode = completeDecisionEpisode ?? (() => {});
    this.executeWorkflowSteps = executeWorkflowSteps;
    this.executeGoalStep = executeGoalStep;
    this.getWorkflowFingerprint = getWorkflowFingerprint;
    this.getOnRunSuspended = getOnRunSuspended ?? (() => null);
    this.getOnIntervention = getOnIntervention ?? (() => null);
    this.setCurrentTelemetryStepId = setCurrentTelemetryStepId ?? (() => {});
    this.telemetryStepId = telemetryStepId ?? (value => value);
  }

  async suspend(step, receipt, startedAt, {
    type,
    reason,
    reasonCode = null,
    requiredHumanAction,
    condition,
    preObservation = null,
    engineResult = null
  }) {
    if (!this.interventions) {
      const fallback = `Human requirement detected but no intervention store is configured: ${reason}`;
      receipt.recordStep({
        stepId: step.id,
        type: step.type,
        status: STEP_STATUS.BLOCKED,
        reason: fallback,
        startedAt,
        evidenceIds: [preObservation?.evidenceId ?? engineResult?.evidenceId ?? ""].filter(Boolean)
      });
      return { status: STEP_STATUS.BLOCKED, reason: fallback };
    }
    const authenticationRealm = condition?.realm ?? step.intervention?.realm ?? null;
    const observedApplication = this.environment && this.session?.target?.url
      ? resolveObservedApplication(this.environment, this.session.target.url, { authenticationRealm })
      : { status: "unmatched" };
    const record = await this.interventions.create({
      runId: receipt.runId,
      stepId: step.id,
      type,
      reason,
      reasonCode,
      requiredHumanAction,
      completionCondition: condition,
      environmentId: this.environment?.environmentId ?? step.intervention?.environmentId ?? null,
      authenticationRealm,
      targetId: this.session?.target?.id ?? null,
      applicationId: observedApplication.status === "matched" ? observedApplication.applicationId : null,
      ...(step.intervention?.ttlMs ? { ttlMs: step.intervention.ttlMs } : {})
    });
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status: STEP_STATUS_EXTENDED.SUSPENDED,
      reason,
      startedAt,
      evidenceIds: [preObservation?.evidenceId ?? engineResult?.evidenceId ?? ""].filter(Boolean),
      details: { interventionId: record.intervention_id, interventionType: type }
    });
    receipt.recordIntervention({
      stepId: step.id,
      interventionId: record.intervention_id,
      type,
      state: record.state,
      reason,
      externalState: externalRunState(record)
    });
    const onRunSuspended = this.getOnRunSuspended();
    if (typeof onRunSuspended === "function") await onRunSuspended(receipt, record);
    const onIntervention = this.getOnIntervention();
    if (typeof onIntervention === "function") {
      try { await onIntervention(record); } catch { /* notification is best-effort */ }
    }
    return { status: STEP_STATUS_EXTENDED.SUSPENDED, reason, intervention: record, externalState: externalRunState(record) };
  }

  async resume(receipt, options = {}) {
    const releaseLease = await this.acquireExecutionLeases(receipt.runId);
    try { return await this.#resumeWorkflow(receipt, options); }
    finally { await releaseLease?.(); }
  }

  async #resumeWorkflow(receipt, { verify = null, evaluate = null, workflow = null, completedStepIds = [] } = {}) {
    const pending = (receipt.interventions ?? []).filter(intervention => intervention.state === INTERVENTION_STATE.WAITING || intervention.state === INTERVENTION_STATE.ACKNOWLEDGED);
    const suspendedStep = [...receipt.steps].reverse().find(step => step.status === STEP_STATUS_EXTENDED.SUSPENDED);
    if (!suspendedStep) return { resumed: false, reason: "No suspended step to resume." };
    await this.ensureDecisionEpisode(receipt);
    const interventionRef = pending.find(intervention => intervention.stepId === suspendedStep.stepId);
    const record = (interventionRef?.interventionId && this.interventions
      ? this.interventions.get(interventionRef.interventionId)
      : null)
      ?? (this.interventions ? this.interventions.get(suspendedStep.details?.interventionId) : null);
    if (!record) return { resumed: false, reason: "No durable intervention record found for the suspended step." };
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return { resumed: false, reason: `Intervention expired at ${record.expiresAt}.`, expired: true };
    }
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
      const evaluator = evaluate ?? ((intervention, context) => evaluateCompletion(intervention, context));
      const evaluation = await evaluator(record, verify ?? {});
      if (!evaluation.satisfied) {
        if (lease) await this.interventions.releaseResume(record.intervention_id, lease).catch(() => {});
        return { resumed: false, reason: `Completion condition not verified: ${evaluation.reason}`, intervention: record };
      }
      if (!alreadySatisfied) {
        await this.interventions?.completeResume(record.intervention_id, lease ?? record.resumeHeldBy ?? record.generation, {
          evidenceId: evaluation.evidenceId ?? null,
          note: evaluation.summary
        });
      }
      const receiptIntervention = receipt.interventions?.find(item => item.interventionId === record.intervention_id);
      if (receiptIntervention) {
        receiptIntervention.state = "satisfied";
        receiptIntervention.resumedAt = new Date().toISOString();
      }

      if (workflow && Array.isArray(workflow.steps)) {
        if (this.runStateStore) {
          const state = await this.runStateStore.getFresh(receipt.runId);
          const environmentId = this.environment?.environmentId ?? null;
          const targetId = this.session?.target?.id ?? null;
          const application = this.session?.target?.url && this.environment
            ? resolveObservedApplication(this.environment, this.session.target.url)
            : { status: "unmatched" };
          const authenticationRealm = application.status === "matched" ? application.authenticationRealm : state?.authenticationRealm ?? null;
          if (!state || state.runId !== receipt.runId || state.environmentId !== environmentId
            || (state.target?.targetId ?? null) !== targetId
            || state.authenticationRealm !== authenticationRealm
            || (state.profileId ?? null) !== (this.profileId ?? null)
            || (state.principalId ?? null) !== (this.principalId ?? null)
            || state.policyVersion !== this.policyVersion) {
            return { resumed: false, reason: "Durable continuation bindings do not match the current workflow, environment, target, principal, or policy." };
          }
          if (targetId && this.runStateCoordinator.targetLease) {
            await this.runStateStore.bindTargetLease(receipt.runId, {
              targetId,
              fencingToken: this.runStateCoordinator.targetLease.fencingToken
            });
          }
          await this.runStateStore.bindExecutionContract(receipt.runId, {
            workflowId: workflow.id,
            workflowVersion: workflow.version ?? null,
            workflowHash: this.getWorkflowFingerprint(workflow),
            environmentId,
            targetId,
            principalId: this.principalId,
            profileId: this.profileId,
            policyVersion: this.policyVersion
          });
          await this.runStateStore.update(receipt.runId, {
            status: "running",
            currentStepId: suspendedStep.stepId,
            pendingInterventionId: null
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
        if (completedByPredicate) await this.persistStepCheckpoint(receipt, suspendedStep.stepId);
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
        const execution = await this.executeWorkflowSteps(workflow, receipt, context);
        if (receipt.status === RUN_STATUS.RUNNING) receipt.finish(deriveWorkflowRunStatus(workflow, execution.stepStatuses));
        await this.completeRunState(receipt);
        this.completeDecisionEpisode(receipt);
        return { resumed: !isWaitingRunStatus(receipt.status), receipt, evaluation };
      }

      if (this.runStateStore && this.session?.target?.id && this.runStateCoordinator.targetLease) {
        const state = await this.runStateStore.getFresh(receipt.runId);
        if (state?.target?.targetId !== this.session.target.id) {
          return { resumed: false, reason: "Durable continuation target does not match the attached browser target." };
        }
        await this.runStateStore.bindTargetLease(receipt.runId, {
          targetId: this.session.target.id,
          fencingToken: this.runStateCoordinator.targetLease.fencingToken
        });
      }
      const suspendedGoal = workflow?.steps?.find(step => step.id === suspendedStep.stepId)?.goal
        ?? receipt.steps.find(step => step.stepId === suspendedStep.stepId)?.details?.goal
        ?? "";
      this.setCurrentTelemetryStepId(this.telemetryStepId(suspendedStep.stepId));
      const stepResult = await this.executeGoalStep(
        { id: suspendedStep.stepId, type: "goal", goal: suspendedGoal },
        { ...receipt, status: RUN_STATUS.RUNNING, interventions: receipt.interventions },
        new Date().toISOString()
      );
      receipt.replaceSuspendedStep(suspendedStep.stepId);
      if (stepResult.status === STEP_STATUS_EXTENDED.SUSPENDED) {
        const externalToRun = {
          waiting_for_tab_authorization: RUN_STATUS.WAITING_FOR_TAB_AUTHORIZATION,
          waiting_for_authentication: RUN_STATUS.WAITING_FOR_AUTHENTICATION,
          waiting_for_mfa: RUN_STATUS.WAITING_FOR_MFA,
          waiting_for_human_approval: RUN_STATUS.WAITING_FOR_HUMAN_APPROVAL,
          waiting_for_external_authorization: RUN_STATUS.WAITING_FOR_EXTERNAL_AUTHORIZATION,
          waiting_for_human_decision: RUN_STATUS.WAITING_FOR_HUMAN_DECISION
        };
        receipt.finish(externalToRun[stepResult.externalState] ?? RUN_STATUS.WAITING_FOR_HUMAN_DECISION);
      } else {
        receipt.finish(deriveRunStatus(receipt.steps));
      }
      this.completeDecisionEpisode(receipt);
      return { resumed: !isWaitingRunStatus(receipt.status), stepResult, receipt, evaluation };
    } catch (error) {
      if (lease) await this.interventions.releaseResume(record.intervention_id, lease).catch(() => {});
      throw error;
    }
  }
}
