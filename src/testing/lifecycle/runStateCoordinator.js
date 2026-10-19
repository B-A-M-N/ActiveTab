import { isWaitingRunStatus, RUN_STATUS, STEP_STATUS } from "../schema.js";
import { INTERVENTION_STATE } from "../../runtime/interventions.js";
import { acquireBrowserTargetLease } from "../runState.js";
import { resolveObservedApplication } from "../../environments/model.js";

/** Owns durable workflow-run bindings, leases, checkpoints, and terminal state. */
export class RunStateCoordinator {
  constructor({ runStateStore = null, session = null, environment = null, principalId = null, profileId = null, policyVersion = "active_policy_v1", targetLease = null } = {}) {
    this.runStateStore = runStateStore;
    this.session = session;
    this.environment = environment;
    this.principalId = principalId;
    this.profileId = profileId;
    this.policyVersion = policyVersion;
    this.externalTargetLease = targetLease;
    this.targetLease = targetLease;
  }

  async acquireExecutionLeases(runId) {
    if (!this.runStateStore && !this.externalTargetLease) return null;
    const releaseRunLease = this.runStateStore
      ? await this.runStateStore.acquireExecutionLease(runId)
      : async () => {};
    let targetLease = this.externalTargetLease;
    let ownsTargetLease = false;
    try {
      const targetId = this.session?.target?.id;
      if (targetId && !targetLease) {
        targetLease = await acquireBrowserTargetLease(this.runStateStore, this.session, runId);
        ownsTargetLease = true;
      }
      if (targetLease) await targetLease.assertCurrent();
      this.targetLease = targetLease;
    } catch (error) {
      await releaseRunLease();
      throw error;
    }
    return async () => {
      if (this.targetLease === targetLease) this.targetLease = this.externalTargetLease;
      if (ownsTargetLease) await targetLease?.release();
      await releaseRunLease();
    };
  }

  async assertTargetLeaseCurrent() {
    if (this.targetLease) await this.targetLease.assertCurrent();
  }

  async initializeRunState(workflow, receipt, { existingRunStateId = null, decisionEpisodeId = null, workflowHash } = {}) {
    if (!this.runStateStore) return null;
    let run = await this.runStateStore.getFresh(existingRunStateId ?? receipt.runId);
    if (existingRunStateId && !run) throw new Error("The bound durable run state no longer exists.");
    const environmentId = this.environment?.environmentId ?? null;
    const targetId = this.session?.target?.id ?? null;
    const application = this.session?.target?.url && this.environment
      ? resolveObservedApplication(this.environment, this.session.target.url)
      : { status: "unmatched" };
    const authenticationRealm = application.status === "matched" ? application.authenticationRealm : run?.authenticationRealm ?? null;
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
        episodeId: decisionEpisodeId
      });
      run = await this.runStateStore.getFresh(receipt.runId);
    }
    if (targetId && this.session?.attached !== true) throw new Error("Durable run continuation requires the exact browser target to be attached.");
    await this.runStateStore.bindExecutionContract(receipt.runId, {
      workflowId: workflow.id,
      workflowVersion: workflow.version ?? null,
      workflowHash,
      environmentId,
      targetId,
      principalId: this.principalId,
      profileId: this.profileId,
      policyVersion: this.policyVersion
    });
    run = await this.runStateStore.getFresh(receipt.runId);
    if (decisionEpisodeId && !run?.episodeId) {
      await this.runStateStore.update(receipt.runId, { episodeId: decisionEpisodeId });
      run = await this.runStateStore.getFresh(receipt.runId);
    } else if (decisionEpisodeId && run?.episodeId !== decisionEpisodeId) {
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

  async persistStepCheckpoint(receipt, stepId) {
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

  async checkpointRecordedStep(receipt, stepId) {
    try {
      await this.persistStepCheckpoint(receipt, stepId);
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

  async completeRunState(receipt) {
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
}
