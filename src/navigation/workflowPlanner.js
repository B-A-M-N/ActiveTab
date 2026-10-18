import { DeterministicPlanner } from "./planner.js";
import { rebindWorkflowTarget } from "./workflowSynthesizer.js";
import { isLowercaseCode } from "../telemetry/privacy.js";

const TERMINAL_STEP_STATUSES = new Set(["passed", "failed", "blocked", "uncertain", "skipped"]);
const MUTATING_EFFECTS = new Set(["test_owned_mutation", "shared_mutation", "security_change"]);

function safeInputValue(value, action) {
  if (value === undefined || value === null) return null;
  if (!["string", "number", "boolean"].includes(typeof value)) return null;
  const text = String(value);
  const maxLength = action === "select" ? 500 : 10_000;
  return text.length <= maxLength ? text : null;
}

function conditionMatches(step, statuses) {
  if (!step.when) return true;
  return statuses.get(step.when.stepId) === step.when.status;
}

export class WorkflowGraphPlanner {
  constructor({ synthesizer, capabilities = [], knowledge = [], scope = {}, inputs = {}, taskIntent = null, decisionRuntime = null, episodeId = null, runId = null, stepId = "workflow_plan", fallbackPlanner = new DeterministicPlanner(), maxRepairCalls = 1 } = {}) {
    this.synthesizer = synthesizer;
    this.capabilityInputs = capabilities;
    this.knowledge = knowledge;
    this.scope = scope;
    this.inputs = inputs;
    this.taskIntent = taskIntent;
    this.decisionRuntime = decisionRuntime;
    this.episodeId = episodeId;
    this.runId = runId;
    this.stepId = stepId;
    this.fallbackPlanner = fallbackPlanner;
    this.maxRepairCalls = Math.max(0, Math.min(1, maxRepairCalls));
    this.repairCalls = 0;
    this.result = null;
    this.statuses = new Map();
    this.completedStepIds = new Set();
    this.completedMutationCapabilityIds = new Set();
    this.pendingStep = null;
    this.fallbackReason = null;
    this.reviews = [];
    this.planCalls = 0;
  }

  async plan(goal, observation, options = {}) {
    if (!this.result && !this.synthesizer) {
      this.fallbackReason = "workflow_synthesizer_unconfigured";
      return this.fallbackPlanner.plan(goal, observation, options);
    }
    if (!this.result) {
      const synthesized = await this.#synthesize(observation, options.signal);
      if (synthesized.status !== "synthesized") {
        this.fallbackReason = synthesized.failureCode ?? "workflow_synthesis_unavailable";
        return this.fallbackPlanner.plan(goal, observation, options);
      }
      await this.#review(synthesized);
    }
    if (this.pendingStep) {
      return { status: "ambiguous", reason: "The previous synthesized workflow action has no observed verification result; no next action was planned." };
    }
    let next = this.#nextStep();
    while (next?.skip) {
      this.statuses.set(next.step.id, "skipped");
      next = this.#nextStep();
    }
    if (!next) {
      if (this.#isComplete()) return { status: "completed", reason: "Every executed workflow step passed its registered verification contract." };
      return { status: "ambiguous", reason: "The synthesized workflow is blocked by an incomplete or failed dependency." };
    }
    const capability = this.result.capabilities.byId.get(next.step.capabilityId);
    if (!capability) return { status: "ambiguous", reason: "The plan referenced a capability that is no longer registered." };
    let target = await this.#resolveTarget(next, capability, observation);
    if (!target && next.step.onMissing === "repair" && this.repairCalls < this.maxRepairCalls) {
      const repaired = await this.#repair(observation, next.step, options.signal);
      if (repaired) {
        next = this.#nextStep();
        const repairedCapability = next ? this.result.capabilities.byId.get(next.step.capabilityId) : null;
        target = next && repairedCapability ? await this.#resolveTarget(next, repairedCapability, observation) : null;
      }
    }
    if (!target || target.visible !== true || target.disabled === true) {
      return {
        status: "ambiguous",
        reason: next.step.onMissing === "repair"
          ? "The synthesized workflow target did not resolve uniquely after its bounded repair attempt; no action was dispatched."
          : "The synthesized workflow target is absent or ambiguous in the fresh observation; no action was dispatched."
      };
    }
    const value = next.step.inputRef ? safeInputValue(this.inputs[next.step.inputRef], capability.action) : null;
    if (next.step.inputRef && value === null) return { status: "ambiguous", reason: "A caller input reference is absent or exceeds its allowed scalar bound." };
    this.pendingStep = { step: next.step, capability, target, beforeObservation: observation, value };
    return {
      status: "planned",
      action: { type: capability.action, target, ...(value !== null ? { value } : {}), ...(capability.action === "scroll" ? { direction: "down" } : {}) },
      expected: { targetText: capability.targetRole, targetTokens: [] },
      confidence: null,
      reasoning: "ActiveTab selected the next operation from a validated bounded workflow graph.",
      workflowCapability: capability,
      workflowStepId: next.step.id,
      workflowReview: this.reviews.at(-1) ?? null
    };
  }

  getPendingCapability() {
    return this.pendingStep?.capability ?? null;
  }

  async recordOutcome({ action, beforeObservation, afterObservation, dispatchStatus, error = null, signal } = {}) {
    const pending = this.pendingStep;
    if (!pending) return { status: "uncertain", reasonCode: "workflow_step_missing" };
    this.pendingStep = null;
    if (dispatchStatus !== "dispatched" || error) {
      const status = dispatchStatus === "uncertain" ? "uncertain" : "failed";
      this.statuses.set(pending.step.id, status);
      return { status: status === "failed" ? "verified_fail" : "uncertain", reasonCode: dispatchStatus === "uncertain" ? "dispatch_uncertain" : "dispatch_failed", evidenceRefs: [beforeObservation?.evidenceId, afterObservation?.evidenceId].filter(Boolean) };
    }
    if (typeof pending.capability.verify !== "function") {
      this.statuses.set(pending.step.id, "uncertain");
      return { status: "uncertain", reasonCode: "verification_contract_unavailable", evidenceRefs: [beforeObservation?.evidenceId, afterObservation?.evidenceId].filter(Boolean) };
    }
    let verification;
    try {
      verification = await pending.capability.verify({
        verificationCode: pending.step.verifyCode,
        action,
        target: pending.target,
        inputValue: pending.value,
        beforeObservation,
        afterObservation,
        signal
      });
    } catch {
      verification = null;
    }
    const normalizedStatus = verification === true || verification?.status === "verified"
      ? "passed"
      : verification === false || verification?.status === "failed"
        ? "failed"
        : "uncertain";
    this.statuses.set(pending.step.id, normalizedStatus);
    if (normalizedStatus === "passed") {
      this.completedStepIds.add(pending.step.id);
      if (MUTATING_EFFECTS.has(pending.capability.effectClass)) this.completedMutationCapabilityIds.add(pending.capability.id);
    }
    return {
      status: normalizedStatus === "passed" ? "verified_pass" : normalizedStatus === "failed" ? "verified_fail" : "uncertain",
      reasonCode: verification?.reasonCode ?? (normalizedStatus === "passed" ? pending.step.verifyCode : normalizedStatus === "failed" ? "postcondition_failed" : "postcondition_uncertain"),
      verifiedCode: normalizedStatus === "passed" ? pending.step.verifyCode : undefined,
      evidenceRefs: Array.isArray(verification?.evidenceRefs) ? verification.evidenceRefs : [beforeObservation?.evidenceId, afterObservation?.evidenceId].filter(Boolean)
    };
  }

  getStatus() {
    return {
      status: this.isComplete() ? "completed" : this.result ? "synthesized" : this.fallbackReason ? "fallback" : "pending",
      fallbackReason: this.fallbackReason,
      planHash: this.result?.planHash ?? null,
      synthesisCalls: this.planCalls,
      repairCalls: this.repairCalls,
      reviewCount: this.reviews.length,
      stepStatuses: Object.fromEntries(this.statuses)
    };
  }

  isComplete() {
    return Boolean(this.result && !this.pendingStep && this.#isComplete());
  }

  #nextStep() {
    if (!this.result) return null;
    for (const step of this.result.plan.steps) {
      if (TERMINAL_STEP_STATUSES.has(this.statuses.get(step.id))) continue;
      const dependencyStatuses = step.dependsOn.map(id => this.statuses.get(id));
      if (dependencyStatuses.some(status => !TERMINAL_STEP_STATUSES.has(status))) continue;
      if (step.dependsOn.some(id => this.statuses.get(id) !== "passed") && !step.when) {
        this.statuses.set(step.id, "blocked");
        continue;
      }
      if (!conditionMatches(step, this.statuses)) return { step, skip: true };
      const binding = step.targetRef ? this.result.bindings.get(step.targetRef) : null;
      return { step, binding };
    }
    return null;
  }

  #isComplete() {
    const statuses = this.result?.plan.steps.map(step => this.statuses.get(step.id)) ?? [];
    return statuses.length > 0
      && statuses.every(status => status === "passed" || status === "skipped")
      && statuses.includes("passed");
  }

  async #synthesize(observation, signal, repairContext = null, capabilities = this.capabilityInputs) {
    this.planCalls++;
    const inputRefs = Object.keys(this.inputs).filter(value => isLowercaseCode(value, { maxLength: 64 }));
    if (!Array.isArray(capabilities) || capabilities.length === 0) return { status: "unavailable", failureCode: "workflow_capabilities_unconfigured" };
    const result = await this.synthesizer.synthesize({
      taskIntent: this.taskIntent,
      observation,
      capabilities,
      inputRefs,
      knowledge: this.knowledge,
      scope: this.scope,
      repairContext,
      episodeId: this.episodeId,
      runId: this.runId,
      stepId: this.stepId,
      signal
    });
    if (result.status === "synthesized") this.result = result;
    return result;
  }

  async #review(result) {
    if (typeof this.decisionRuntime?.reviewWorkflowPlan !== "function") return null;
    const review = await this.decisionRuntime.reviewWorkflowPlan({
      episodeId: this.episodeId,
      runId: this.runId,
      stepId: this.stepId,
      decisionId: result.decisionId,
      observationId: result.observationId,
      planProjection: result.planProjection
    });
    this.reviews.push(review);
    return review;
  }

  async #repair(observation, failedStep, signal) {
    const eligibleCapabilities = this.capabilityInputs.filter(capability => !this.completedMutationCapabilityIds.has(capability.id));
    const result = await this.#synthesize(observation, signal, {
      failedStepId: failedStep.id,
      failureCode: "target_not_present",
      completedStepIds: [...this.completedStepIds],
      completedCapabilityIds: [...this.completedMutationCapabilityIds]
    }, eligibleCapabilities);
    this.repairCalls++;
    if (result.status !== "synthesized") return false;
    if (result.plan.steps.some(step => this.completedStepIds.has(step.id))) {
      this.result = null;
      this.fallbackReason = "workflow_repair_reused_completed_step";
      return false;
    }
    await this.#review(result);
    return true;
  }

  async #resolveTarget(next, capability, observation) {
    if (next.binding) return rebindWorkflowTarget(next.binding, observation);
    if (typeof capability.resolveTarget !== "function") return null;
    let identities;
    try { identities = await capability.resolveTarget(observation); }
    catch { return null; }
    if (!Array.isArray(identities) || identities.length !== 1 || typeof identities[0] !== "string") return null;
    const matches = (observation.candidates ?? []).filter(candidate => candidate.identity === identities[0]);
    return matches.length === 1 ? matches[0] : null;
  }
}
