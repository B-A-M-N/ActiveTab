import { createHash, randomUUID } from "node:crypto";
import { DeterministicPlanner } from "./planner.js";
import { rebindWorkflowTarget } from "./workflowSynthesizer.js";
import { selectWorkflowPlanningRoute, selectWorkflowReviewRoute } from "../decisions/callPolicy.js";
import { isBoundVisualEvidence } from "./visualEvidence.js";
import { isLowercaseCode } from "../telemetry/privacy.js";
import { verifyExtractionResult, verifyObservedPartialExtractionResult } from "../extraction/extractionVerifier.js";
import { ACTION_VALUE_LIMITS } from "../browser/actionLimits.js";
import { applyVisibleRecordTransformations } from "../extraction/recordTransformations.js";

const TERMINAL_STEP_STATUSES = new Set(["passed", "failed", "blocked", "uncertain", "skipped"]);
const MUTATING_EFFECTS = new Set(["test_owned_mutation", "shared_mutation", "security_change"]);

function safeInputValue(value, action) {
  if (typeof value !== "string") return null;
  const maxLength = ACTION_VALUE_LIMITS[action];
  if (!Number.isInteger(maxLength)) return null;
  return value.length <= maxLength ? value : null;
}

function conditionMatches(step, statuses) {
  if (!step.when) return true;
  return statuses.get(step.when.stepId) === step.when.status;
}

function deterministicObservedReadPlan(taskIntent, capabilities, observation) {
  if (!taskIntent || taskIntent.cardinality !== "atomic"
    || taskIntent.purposeCode !== "extract_records"
    || taskIntent.outcomeCode !== "observed_records_returned"
    || !Array.isArray(taskIntent.requiredCapabilityIds) || taskIntent.requiredCapabilityIds.length !== 1
    || !Array.isArray(taskIntent.permittedPurposeCodes)
    || taskIntent.permittedPurposeCodes.length !== 1
    || taskIntent.permittedPurposeCodes[0] !== taskIntent.purposeCode
    || !Array.isArray(taskIntent.targetRoles) || taskIntent.targetRoles.length !== 1
    || taskIntent.targetRoles[0] !== "observed_records"
    || !Array.isArray(taskIntent.constraints) || taskIntent.constraints.length !== 1
    || taskIntent.constraints[0] !== "observed_partial"
    || !observation?.evidenceId || !observation?.targetId || !Number.isSafeInteger(observation?.documentGeneration)) return null;
  const [capabilityId] = taskIntent.requiredCapabilityIds;
  const matches = Array.isArray(capabilities) ? capabilities.filter(capability => capability?.id === capabilityId) : [];
  if (matches.length !== 1) return null;
  const [capability] = matches;
  if (capability.executionOrigin !== "ephemeral_observed_read"
    || capability.action !== "extract" || capability.effectClass !== "read"
    || capability.outputCompleteness !== "observed_partial"
    || capability.targetRole !== "observed_records"
    || capability.purposeCodes?.length !== 1 || capability.purposeCodes[0] !== taskIntent.purposeCode
    || !capability.postconditionCodes?.includes(taskIntent.outcomeCode)
    || !capability.verificationCodes?.includes("observed_records_verified")
    || typeof capability.execute !== "function"
    || !Array.isArray(capability.outputSchema) || capability.outputSchema.length < 1 || capability.outputSchema.length > 32
    || capability.outputSchema.some(field => !field || typeof field.name !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(field.name)
      || !["string", "integer", "number", "boolean"].includes(field.type)
      || typeof field.required !== "boolean")
    || new Set(capability.outputSchema.map(field => field.name)).size !== capability.outputSchema.length) return null;
  const step = Object.freeze({
    id: "read_observed_records",
    capabilityId,
    targetRole: capability.targetRole,
    targetRef: null,
    inputRef: null,
    dependsOn: Object.freeze([]),
    when: null,
    verifyCode: "observed_records_verified",
    onMissing: "stop"
  });
  const plan = Object.freeze({ version: 1, steps: Object.freeze([step]) });
  const planHash = createHash("sha256").update(JSON.stringify({
    plan,
    observationId: observation.evidenceId,
    targetId: observation.targetId,
    documentGeneration: observation.documentGeneration
  })).digest("hex");
  return Object.freeze({
    status: "deterministic_read",
    decisionId: randomUUID(),
    eventId: null,
    plan,
    planHash,
    observationId: observation.evidenceId,
    reviewBinding: null,
    bindings: new Map(),
    capabilities: { byId: new Map([[capabilityId, capability]]) },
    taskIntent
  });
}

export class WorkflowGraphPlanner {
  constructor({ synthesizer, capabilities = [], knowledge = [], scope = {}, inputs = {}, taskIntent = null, decisionRuntime = null, episodeId = null, runId = null, stepId = "workflow_plan", fallbackPlanner = new DeterministicPlanner(), allowDeterministicShortcut = false, allowAtomicFallback = true, maxRepairCalls = 1 } = {}) {
    this.synthesizer = synthesizer;
    this.allowScreenshots = synthesizer?.allowScreenshots === true;
    this.requiresScreenshot = false;
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
    this.allowDeterministicShortcut = allowDeterministicShortcut === true;
    this.allowAtomicFallback = allowAtomicFallback === true;
    this.maxRepairCalls = Math.max(0, Math.min(1, maxRepairCalls));
    this.repairCalls = 0;
    this.result = null;
    this.statuses = new Map();
    this.stepFailureCodes = new Map();
    this.completedStepIds = new Set();
    this.completedMutationCapabilityIds = new Set();
    this.outputs = new Map();
    this.pendingStep = null;
    this.fallbackReason = null;
    this.reviews = [];
    this.suspendedReview = null;
    this.planCalls = 0;
    this.localReadPlan = false;
  }

  async plan(goal, observation, options = {}) {
    // A negative review is a run-scoped suspension. The synthesized plan is
    // retained for an external review/continuation record, but a later call
    // to plan() must not turn the same refused plan into an executable step.
    if (this.suspendedReview) return this.#reviewHandoff();
    if (!this.result) {
      const hasRequiredCapabilities = this.taskIntent?.requiredCapabilityIds?.length > 0;
      const localReadPlan = deterministicObservedReadPlan(this.taskIntent, this.capabilityInputs, observation);
      const deterministicPlan = hasRequiredCapabilities ? null : await this.fallbackPlanner.plan(goal, observation, options);
      if (hasRequiredCapabilities && !this.synthesizer && !localReadPlan) {
        this.fallbackReason = "required_workflow_capability_unavailable";
        return { status: "ambiguous", reason: "The requested registered workflow capability cannot be preserved without the configured workflow synthesizer; no fallback action was selected." };
      }
      const route = selectWorkflowPlanningRoute({
        goal,
        deterministicPlan,
        deterministicReadAvailable: localReadPlan !== null,
        allowDeterministic: this.allowDeterministicShortcut,
        semanticAvailable: Boolean(this.synthesizer),
        taskIntent: this.taskIntent,
        inputs: this.inputs,
        knowledge: this.knowledge
      });
      const decisionId = randomUUID();
      if (route.route === "deterministic") {
        if (this.episodeId && this.runId) this.decisionRuntime?.recordInferenceRoute?.({
          episodeId: this.episodeId,
          runId: this.runId,
          stepId: this.stepId,
          decisionId,
          observationId: observation.evidenceId,
          route: route.route,
          reasonCode: route.reasonCode,
          providers: route.providers,
          visualEvidenceUsed: false
        });
        if (localReadPlan) {
          this.result = localReadPlan;
          this.localReadPlan = true;
        } else {
          this.fallbackReason = route.reasonCode;
          return deterministicPlan;
        }
      } else {
        if (!this.synthesizer) {
          this.fallbackReason = "workflow_synthesis_unavailable";
          return {
            status: "ambiguous",
            reason: this.taskIntent?.cardinality === "compound"
              ? "Workflow synthesis is unavailable for a compound task; no partial action was selected."
              : "Workflow synthesis is unavailable and no complete trusted plan can be established; no action was selected."
          };
        }
        const synthesized = await this.#synthesize(observation, options.signal, null, this.capabilityInputs, observation.visualEvidence ?? null, decisionId, route.reasonCode, goal);
        if (synthesized.status !== "synthesized") {
          this.fallbackReason = synthesized.failureCode ?? "workflow_synthesis_unavailable";
          if (hasRequiredCapabilities) {
            return { status: "ambiguous", reason: "Workflow synthesis could not preserve the required registered capability; no fallback action was selected." };
          }
          const action = deterministicPlan?.action;
          const safeAtomicFallback = this.allowAtomicFallback
            && this.taskIntent?.cardinality === "atomic"
            && deterministicPlan?.status === "planned"
            && Number.isFinite(deterministicPlan.confidence)
            && deterministicPlan.confidence >= 0.8
            && ["click", "scroll"].includes(action?.type)
            && action?.target?.visible === true
            && action?.target?.disabled !== true
            && action?.target?.submitsForm !== true;
          if (safeAtomicFallback) return deterministicPlan;
          return {
            status: "ambiguous",
            reason: this.taskIntent?.cardinality === "compound"
              ? "Workflow synthesis was unavailable for a compound task; no partial action was selected."
              : "Workflow synthesis was unavailable and the task has no uniquely resolved atomic action; no action was selected."
          };
        }
        if (!this.taskIntent && synthesized.taskIntent) this.taskIntent = synthesized.taskIntent;
        const workflowReview = await this.#review(synthesized, observation);
        if (workflowReview?.reviewOutcome === "needs_review" || workflowReview?.disposition === "needs_agent_review") {
          this.#suspendForReview(synthesized, workflowReview, observation);
          return this.#reviewHandoff();
        }
      }
    }
    if (this.pendingStep) {
      return { status: "ambiguous", reason: "The previous synthesized workflow action has no observed verification result; no next action was planned." };
    }
    let next = this.#nextStep();
    while (next?.skip) {
      this.statuses.set(next.step.id, "skipped");
      next = this.#nextStep();
    }
    while (next) {
      const capability = this.result.capabilities.byId.get(next.step.capabilityId);
      if (!capability) return { status: "ambiguous", reason: "The plan referenced a capability that is no longer registered." };
      if (capability.action === "extract") {
        const outcome = await this.#executeExtraction(next.step, capability, options.signal, observation);
        if (outcome.status !== "verified_pass") {
          return { status: "ambiguous", reason: "The extraction capability did not produce a valid output under its declared completeness contract; the workflow stopped." };
        }
        next = this.#nextStep();
        while (next?.skip) {
          this.statuses.set(next.step.id, "skipped");
          next = this.#nextStep();
        }
        continue;
      }
      let target = await this.#resolveTarget(next, capability, observation);
      if (!target && next.step.onMissing === "repair" && this.repairCalls < this.maxRepairCalls) {
        const repaired = await this.#repair(observation, next.step, options.signal, goal);
        if (this.suspendedReview) return this.#reviewHandoff();
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
    if (this.#isComplete()) return { status: "completed", reason: "Every executed workflow step passed its registered verification contract." };
    return { status: "ambiguous", reason: "The synthesized workflow is blocked by an incomplete or failed dependency." };
  }

  getPendingCapability() {
    return this.pendingStep?.capability ?? null;
  }

  getOutputs() {
    return this.isComplete() ? Object.fromEntries([...this.outputs].map(([name, output]) => [name, structuredClone(output)])) : {};
  }

  hasObservedPartialOutput() {
    return [...this.outputs.keys()].some(id => this.result?.capabilities.byId.get(id)?.outputCompleteness === "observed_partial");
  }

  getTaskIntent() {
    return this.taskIntent;
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
    const proofRefs = Array.isArray(verification?.evidenceRefs) ? verification.evidenceRefs : [];
    const hasBoundVerification = verification?.status === "verified"
      && verification.contractId === pending.capability.id
      && verification.verifiedCode === pending.step.verifyCode
      && typeof beforeObservation?.evidenceId === "string"
      && typeof afterObservation?.evidenceId === "string"
      && beforeObservation.evidenceId !== afterObservation.evidenceId
      && proofRefs.includes(beforeObservation.evidenceId)
      && proofRefs.includes(afterObservation.evidenceId);
    const normalizedStatus = hasBoundVerification
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
      evidenceRefs: proofRefs.length ? proofRefs : [beforeObservation?.evidenceId, afterObservation?.evidenceId].filter(Boolean)
    };
  }

  getStatus() {
    return {
      status: this.suspendedReview ? "suspended_review" : this.isComplete() ? "completed" : this.result ? this.localReadPlan ? "deterministic_read" : "synthesized" : this.fallbackReason ? "fallback" : "pending",
      fallbackReason: this.fallbackReason,
      planHash: this.result?.planHash ?? null,
      observationId: this.result?.observationId ?? null,
      reviewBindingHash: this.result?.reviewBinding?.bindingHash ?? null,
      taskContractHash: this.result?.reviewBinding?.taskContractHash ?? null,
      capabilityCatalogHash: this.result?.reviewBinding?.capabilityCatalogHash ?? null,
      targetId: this.result?.reviewBinding?.targetId ?? null,
      documentGeneration: this.result?.reviewBinding?.documentGeneration ?? null,
      suspendedPlanHash: this.suspendedReview?.plan?.planHash ?? null,
      suspendedObservationId: this.suspendedReview?.observationId ?? null,
      synthesisCalls: this.planCalls,
      repairCalls: this.repairCalls,
      reviewCount: this.reviews.length,
      reviewOutcome: this.reviews.at(-1)?.reviewOutcome ?? null,
      stepStatuses: Object.fromEntries(this.statuses),
      stepFailureCodes: Object.fromEntries(this.stepFailureCodes)
    };
  }

  isComplete() {
    if (!this.result || this.pendingStep || !this.#isComplete()) return false;
    return this.result.plan.steps.every(step => this.result.capabilities.byId.get(step.capabilityId)?.action !== "extract"
      || this.statuses.get(step.id) === "passed");
  }

  canFinishWithVisibleOutcome() {
    if (this.taskIntent?.requiredCapabilityIds?.length) return this.isComplete();
    const status = this.getStatus();
    return status.planHash ? this.isComplete() : status.status === "fallback";
  }

  async #executeExtraction(step, capability, signal, observation) {
    if (signal?.aborted) {
      this.statuses.set(step.id, "uncertain");
      return this.#recordStepFailure(step.id, "canceled_before_extraction", "uncertain");
    }
    let result;
    try {
      result = await capability.execute({ stepId: step.id, signal, observation });
    } catch {
      result = null;
    }
    if (signal?.aborted || result?.status !== "verified" || !result.output) {
      const status = result?.status === "failed" ? "failed" : result?.status === "blocked" ? "blocked" : "uncertain";
      this.statuses.set(step.id, status);
      const reasonCode = signal?.aborted ? "canceled_after_extraction" : result?.reasonCode ?? "extraction_unavailable";
      return this.#recordStepFailure(step.id, reasonCode, status);
    }
    const verification = capability.outputCompleteness === "observed_partial"
      ? verifyObservedPartialExtractionResult(result.output)
      : verifyExtractionResult(result.output);
    const actualFields = result.output.schema?.items ?? {};
    const declaredFields = capability.outputSchema;
    const schemaMatches = Object.keys(actualFields).length === declaredFields.length
      && declaredFields.every(field => actualFields[field.name]?.type === field.type
        && actualFields[field.name]?.required === field.required);
    const validCompleteness = capability.outputCompleteness === "observed_partial"
      ? verification.status === "valid_observed_partial" && result.output.completeness === "observed_partial"
      : verification.status === "complete" && result.output.completeness === "complete";
    if (!validCompleteness || !schemaMatches) {
      this.statuses.set(step.id, "failed");
      return this.#recordStepFailure(step.id, schemaMatches ? "extraction_incomplete" : "extraction_schema_mismatch", "failed");
    }
    let output = result.output;
    if (this.taskIntent?.localTransform) {
      try {
        output = applyVisibleRecordTransformations(output, this.taskIntent.localTransform);
      } catch {
        this.statuses.set(step.id, "failed");
        return this.#recordStepFailure(step.id, "local_record_transformation_failed", "failed");
      }
      if (verifyObservedPartialExtractionResult(output).status !== "valid_observed_partial"
        || output.completeness !== "observed_partial") {
        this.statuses.set(step.id, "failed");
        return this.#recordStepFailure(step.id, "local_record_transformation_unverified", "failed");
      }
    }
    this.statuses.set(step.id, "passed");
    this.stepFailureCodes.delete(step.id);
    this.completedStepIds.add(step.id);
    this.outputs.set(capability.id, output);
    return { status: "verified_pass", reasonCode: step.verifyCode };
  }

  #recordStepFailure(stepId, reasonCode, status) {
    const boundedCode = typeof reasonCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(reasonCode)
      ? reasonCode
      : "workflow_step_failed";
    this.stepFailureCodes.set(stepId, boundedCode);
    return { status: status === "failed" ? "verified_fail" : "uncertain", reasonCode: boundedCode };
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
    const stepsComplete = statuses.length > 0
      && statuses.every(status => status === "passed" || status === "skipped")
      && statuses.includes("passed");
    if (!stepsComplete) return false;
    const outcomeCode = this.taskIntent?.outcomeCode;
    if (!outcomeCode) return true;
    return this.result.plan.steps.some(step =>
      this.statuses.get(step.id) === "passed"
      && this.result.capabilities.byId.get(step.capabilityId)?.postconditionCodes?.includes(outcomeCode)
    );
  }

  async #synthesize(observation, signal, repairContext = null, capabilities = this.capabilityInputs, imageEvidence = observation?.visualEvidence ?? null, decisionId = randomUUID(), routeReasonCode = "workflow_synthesis_requested", selectionGoal = "") {
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
      decisionId,
      routeReasonCode,
      selectionGoal,
      ...(imageEvidence && this.allowScreenshots ? { imageEvidence } : {}),
      signal
    });
    if (result.status === "synthesized") this.result = result;
    return result;
  }

  async #review(result, observation) {
    if (typeof this.decisionRuntime?.reviewWorkflowPlan !== "function") return null;
    const route = selectWorkflowReviewRoute({
      result,
      observation,
      jevAvailable: typeof this.decisionRuntime?.jevClient?.decide === "function",
      jevImageAvailable: this.decisionRuntime?.jevClient?.allowImages === true
        && isBoundVisualEvidence(observation, observation.visualEvidence)
    });
    if (!route.review) return null;
    if (this.episodeId && this.runId) this.decisionRuntime.recordInferenceRoute?.({
      episodeId: this.episodeId,
      runId: this.runId,
      stepId: this.stepId,
      decisionId: result.decisionId,
      observationId: result.observationId,
      ...(result.eventId ? { parentEventId: result.eventId } : {}),
      route: route.route,
      reasonCode: route.reasonCode,
      providers: route.providers,
      visualEvidenceUsed: route.visualEvidenceUsed
    });
    const review = await this.decisionRuntime.reviewWorkflowPlan({
      episodeId: this.episodeId,
      runId: this.runId,
      stepId: this.stepId,
      decisionId: result.decisionId,
      observationId: result.observationId,
      planHash: result.planHash,
      reviewBinding: result.reviewBinding,
      parentEventId: result.eventId,
      observation,
      planProjection: result.planProjection,
      ...(observation?.visualEvidence ? {
        imageEvidence: observation?.visualEvidence ?? null
      } : {})
    });
    this.reviews.push(review);
    return review;
  }

  async #repair(observation, failedStep, signal, selectionGoal) {
    const eligibleCapabilities = this.capabilityInputs.filter(capability => !this.completedMutationCapabilityIds.has(capability.id));
    const decisionId = randomUUID();
    const result = await this.#synthesize(observation, signal, {
      failedStepId: failedStep.id,
      failureCode: "target_not_present",
      completedStepIds: [...this.completedStepIds],
      completedCapabilityIds: [...this.completedMutationCapabilityIds]
    }, eligibleCapabilities, observation?.visualEvidence ?? null, decisionId, "bounded_workflow_repair", selectionGoal);
    this.repairCalls++;
    if (result.status !== "synthesized") return false;
    if (result.plan.steps.some(step => this.completedStepIds.has(step.id))) {
      this.result = null;
      this.fallbackReason = "workflow_repair_reused_completed_step";
      return false;
    }
    const review = await this.#review(result, observation);
    if (review?.reviewOutcome === "needs_review" || review?.disposition === "needs_agent_review") {
      this.#suspendForReview(result, review, observation);
      return false;
    }
    return true;
  }

  #suspendForReview(plan, review, observation) {
    this.suspendedReview = Object.freeze({
      plan,
      review,
      observationId: observation?.evidenceId ?? plan?.observationId ?? null
    });
  }

  #reviewHandoff() {
    const suspended = this.suspendedReview;
    return {
      status: "needs_human",
      reason: "Jev found that the synthesized workflow needs independent review; the plan remains suspended and no browser effect was dispatched.",
      workflowReview: suspended?.review ?? null,
      suspendedPlan: suspended ? {
        planHash: suspended.plan.planHash,
        observationId: suspended.observationId,
        decisionId: suspended.plan.decisionId ?? null,
        eventId: suspended.plan.eventId ?? null
      } : null
    };
  }

  async #resolveTarget(next, capability, observation) {
    if (next.binding) {
      const target = rebindWorkflowTarget(next.binding, observation);
      return this.#targetAllowed(capability, target, observation) ? target : null;
    }
    if (typeof capability.resolveTarget !== "function") return null;
    let identities;
    try { identities = await capability.resolveTarget(observation); }
    catch { return null; }
    if (!Array.isArray(identities) || identities.length !== 1 || typeof identities[0] !== "string") return null;
    const matches = (observation.candidates ?? []).filter(candidate => candidate.identity === identities[0]);
    return matches.length === 1 && this.#targetAllowed(capability, matches[0], observation) ? matches[0] : null;
  }

  #targetAllowed(capability, target, observation) {
    if (!target) return false;
    if (typeof capability.validateTarget !== "function") return true;
    try { return capability.validateTarget(target, observation) === true; }
    catch { return false; }
  }
}
