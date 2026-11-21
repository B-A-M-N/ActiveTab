import { createHash, randomUUID } from "node:crypto";
import { configuredPlanner, DeterministicPlanner, goalExpectation } from "./planner.js";
import { isSearchFieldCandidate, SEARCH_SUBMIT_OPERATION_ID } from "./search.js";
import { authorizePlannedAction } from "./actionPolicy.js";
import { classifyHumanHandoff } from "./handoff.js";
import { newTaskState, taskGoalFingerprint, updateTaskJournal } from "../state/journal.js";
import { normalizeOrigin, resolveObservedApplication } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "../runtime/controlRestrictions.js";
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import {
  DISPATCH_DISPOSITION,
  dispatchStatusForDisposition,
  isDispatchDisposition,
  normalizeDispatchOutcome
} from "../runtime/dispatchDisposition.js";
import { adjudicatePreActionReview } from "../decisions/adjudication.js";
import { hasReviewIntent, selectPreActionDecisionRoute } from "../decisions/callPolicy.js";
import { matchesScrollTargetSignature, observationSemanticFingerprint, observationStateFingerprint, routeFingerprint, scrollPositionFraction, scrollPositionMatches, scrollTargetSignature, targetSignature, visibleCandidatesFingerprint } from "../state/workflows.js";
import { createConfiguredWorkflowSynthesizer } from "./workflowSynthesizer.js";
import { createExtractionWorkflowCapabilities, createGenericWorkflowCapabilities, createObservedSearchWorkflowCapabilities, createProfileFormWorkflowCapabilities } from "./workflowCapabilities.js";
import { WorkflowGraphPlanner } from "./workflowPlanner.js";
import { requiresCompositeReadWorkflow, resolveTaskIntent } from "./taskIntentResolver.js";
import { hasVerifiedOutcome, pageLabelHashes } from "./outcomeVerifier.js";
import { bindVisualEvidence, isBoundVisualEvidence } from "./visualEvidence.js";
import { createNavigationRunContext } from "./runContext.js";
import { RecoveryCoordinator } from "./recoveryCoordinator.js";
import { ReplayCoordinator } from "./replayCoordinator.js";
import { ActionAttemptCoordinator } from "./actionAttemptCoordinator.js";
import { filterPlanningObservation } from "./planningCycle.js";
import { expandTaskScopeObservation, shouldExpandTaskScope } from "./planningEvidence.js";
import { createWorkflowRoutePlanner } from "./workflowRoutePlanner.js";
import { createVisualDecisionCoordinator } from "./visualDecisionCoordinator.js";
import { advanceRegisteredPagination, createRegisteredPaginationButtonAuthorizer } from "./registeredPagination.js";
import { createNavigationRunIntent } from "./runIntent.js";
import { coordinateProviderPlan } from "./providerPlanCoordinator.js";

export { advanceRegisteredPagination };

function pageChangeWaitBaseline(observation, scrollTarget) {
  return {
    pageChangeFingerprint: observation.pageChangeFingerprint,
    domMutationCount: observation.domMutationCount,
    lifecycleEventCount: observation.lifecycleEventCount,
    ...(scrollTarget ? { scrollTarget } : {})
  };
}

function availableSearchInputRef(inputs) {
  const existing = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
  let candidate = "activetab_search_query";
  let suffix = 2;
  while (Object.hasOwn(existing, candidate)) candidate = `activetab_search_query_${suffix++}`;
  return candidate;
}

export function environmentBindingFingerprint(environment) {
  if (!environment) return null;
  const origins = [...new Set((environment.authorizedOrigins ?? []).map(normalizeOrigin).filter(Boolean))].sort();
  const applications = (environment.applications ?? [])
    .map(application => ({
      applicationId: String(application.applicationId ?? ""),
      authenticationRealm: String(application.authenticationRealm ?? ""),
      candidateEntry: String(application.candidateEntry ?? ""),
      finalOrigin: String(application.finalOrigin ?? ""),
      status: String(application.status ?? ""),
      ...(Object.keys(application.workflowOperations ?? {}).length
        ? { workflowOperations: Object.fromEntries(Object.entries(application.workflowOperations).sort(([left], [right]) => left.localeCompare(right))) }
        : {})
    }))
    .sort((left, right) => left.applicationId.localeCompare(right.applicationId));
  const authenticationRealms = (environment.authenticationRealms ?? [])
    .map(realm => ({
      realmId: String(realm.realmId ?? ""),
      scope: [...new Set(realm.scope ?? [])].map(String).sort(),
      separateCredentials: realm.separateCredentials === true
    }))
    .sort((left, right) => left.realmId.localeCompare(right.realmId));
  return createHash("sha256")
    .update(JSON.stringify({
      profileId: String(environment.profileId ?? ""),
      environmentId: String(environment.environmentId ?? ""),
      applicationEntryUrl: String(environment.applicationEntryUrl ?? ""),
      origins,
      applications,
      authenticationRealms
    }))
    .digest("hex");
}

function handoffResult(goal, reason, authorizationRequired, attempts, recoveries, evidenceId) {
  return { status: "needs_human", goal, reason, authorizationRequired, attempts, recoveries, evidenceId };
}

async function dispatchThroughAuthorizedExecutor(session, options) {
  const result = await executeAuthorizedAction({ session, ...options });
  const outcome = normalizeDispatchOutcome(result);
  if (outcome.dispatchDisposition === DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED) return outcome;
  const error = outcome.error ?? new Error(result.reason ?? "The authorized executor did not confirm a complete dispatch.");
  error.kind = outcome.browserEffectPossible ? "dispatch_uncertain" : "authorization_refused";
  error.dispatchStatus = dispatchStatusForDisposition(outcome.dispatchDisposition);
  error.dispatchDisposition = outcome.dispatchDisposition;
  error.browserEffectPossible = outcome.browserEffectPossible;
  error.reasonCode = outcome.reasonCode;
  error.authorizationCategory = result.category ?? null;
  error.observation = result.observation ?? null;
  throw error;
}

const REATTACH_FAILURE_CODES = new Set([
  "not_attempted", "owned_browser_stopped", "target_not_found", "target_scope_rejected",
  "reattach_attach_failed", "reattach_observation_failed", "reattach_identity_mismatch",
  "lease_rebind_failed", "unknown"
]);

export class NavigationEngine {
  constructor(session, { planner = null, executionMode = "agent_directed", plannerMode = "deterministic", workflowSynthesizer = null, workflowCapabilities = [], workflowKnowledge = [], workflowInputs = {}, workflowIntent = null, workflowScope = null, capabilityRegistry = null, capabilityService = null, principalId = null, authorizeExtractionField = null, authorizeExtractionRelease = null, persistWorkflowOutputs = null, resumeWorkflowCheckpoint = null, persistWorkflowCheckpoint = null, clearWorkflowCheckpoint = null, journal, workflowStore, decisionRuntime = null, decisionContext = null, operationAuthorizer = null, assertExecutionLease = null, reattachSameTarget = null, maxActions = 8, maxRecoveries = 1, maxScrolls = 5, signal, environment = null, localFixture = false, sameTargetNavigation = false } = {}) {
    this.signal = signal;
    this.session = session;
    if (!["agent_directed", "agent_assisted", "standalone"].includes(executionMode)) throw new Error("Execution mode must be agent_directed, agent_assisted, or standalone.");
    if (!["deterministic", "auto", "model", "workflow"].includes(plannerMode)) throw new Error("Planner mode must be deterministic, auto, model, or workflow.");
    if (planner?.plannerRole === "standalone_action_proposer" && executionMode !== "standalone") throw new Error("The model action planner is available only in explicit standalone mode.");
    this.executionMode = executionMode;
    this.plannerMode = plannerMode;
    this.planner = planner ?? configuredPlanner({ executionMode, plannerMode, decisionRuntime });
    this.deterministicPlanner = plannerMode === "auto" ? new DeterministicPlanner() : null;
    this.secondaryPlannerAvailable = plannerMode === "auto" && !(this.planner instanceof DeterministicPlanner);
    this.workflowSynthesizer = workflowSynthesizer;
    this.workflowCapabilities = workflowCapabilities;
    this.workflowKnowledge = workflowKnowledge;
    this.workflowInputs = workflowInputs;
    this.workflowIntent = workflowIntent;
    this.workflowScope = workflowScope;
    this.capabilityRegistry = capabilityRegistry;
    this.capabilityService = capabilityService;
    this.principalId = principalId;
    this.authorizeExtractionField = authorizeExtractionField;
    this.authorizeExtractionRelease = authorizeExtractionRelease;
    this.persistWorkflowOutputs = persistWorkflowOutputs;
    this.resumeWorkflowCheckpoint = resumeWorkflowCheckpoint;
    this.persistWorkflowCheckpoint = persistWorkflowCheckpoint;
    this.clearWorkflowCheckpoint = clearWorkflowCheckpoint;
    // Optional verified environment binding. When present, the engine refuses
    // to count a navigation onto a non-authorized origin as goal progress.
    this.environment = environment;
    this.localFixture = localFixture === true;
    this.sameTargetNavigation = sameTargetNavigation === true;
    this.journal = journal;
    this.workflowStore = workflowStore;
    this.decisionRuntime = decisionRuntime;
    this.decisionContext = decisionContext;
    this.operationAuthorizer = operationAuthorizer;
    this.assertExecutionLease = assertExecutionLease;
    this.reattachSameTarget = reattachSameTarget;
    this.maxActions = Math.max(1, Math.min(maxActions, 10));
    this.maxRecoveries = Math.max(0, Math.min(maxRecoveries, 3));
    this.maxScrolls = Math.max(0, Math.min(maxScrolls, 8));
  }

  async run(goal, { resumeState, signal, workflowInputs = this.workflowInputs, workflowIntent = this.workflowIntent, inputBindings = {} } = {}) {
    const abortSignal = signal ?? this.signal;
    const throwIfAborted = () => {
      if (abortSignal?.aborted) {
        const error = new Error("The navigation run was canceled.");
        error.name = "AbortError";
        error.code = 20;
        throw error;
      }
    };
    throwIfAborted();
    const {
      searchReadRequest,
      searchPhrase,
      taskRequest,
      explicitReadWorkflowRequest,
      workflowModeActive,
      searchSubmitAuthorizer
    } = createNavigationRunIntent({
      goal,
      suppliedIntent: workflowIntent,
      plannerMode: this.plannerMode,
      resumeState,
      canResumeWorkflowCheckpoint: Boolean(this.resumeWorkflowCheckpoint)
    });
    const state = resumeState ?? newTaskState(
      goal,
      this.session.target,
      this.session.target.journalEndpoint ?? this.session.target.endpoint ?? "local-cdp"
    );
    const runPrepared = () => this.#runPrepared(goal, {
      resumeState,
      workflowInputs,
      workflowIntent,
      inputBindings,
      abortSignal,
      searchReadRequest,
      searchPhrase,
      taskRequest,
      explicitReadWorkflowRequest,
      workflowModeActive,
      searchSubmitAuthorizer,
      state
    });
    if (typeof this.decisionRuntime?.withInferenceBudget === "function") {
      const runId = this.decisionContext?.runId ?? state.taskId;
      return this.decisionRuntime.withInferenceBudget({ runId }, runPrepared);
    }
    return runPrepared();
  }

  async #runPrepared(goal, {
    resumeState,
    workflowInputs,
    workflowIntent,
    inputBindings,
    abortSignal,
    searchReadRequest,
    searchPhrase,
    taskRequest,
    explicitReadWorkflowRequest,
    workflowModeActive,
    searchSubmitAuthorizer,
    state
  }) {
    const getCurrentSession = () => this.session;
    const throwIfAborted = () => {
      if (abortSignal?.aborted) {
        const error = new Error("The navigation run was canceled.");
        error.name = "AbortError";
        error.code = 20;
        throw error;
      }
    };
    throwIfAborted();
    let effectiveWorkflowIntent = workflowIntent;
    const currentEnvironmentFingerprint = environmentBindingFingerprint(this.environment);
    if (resumeState && (resumeState.environmentFingerprint ?? null) !== currentEnvironmentFingerprint) {
      throw new Error("Resume state environment binding does not match the current authorized profile.");
    }
    state.environmentFingerprint = currentEnvironmentFingerprint;
    const resumedHandoff = resumeState?.status === "needs_human" ? resumeState.interventionRequired : undefined;
    if (resumeState?.requiresGoalInput && !resumeState.goalFingerprint) {
      throw new Error("This legacy task journal redacts its goal without a fingerprint and cannot safely resume; start a new task.");
    }
    const resumeGoalMatches = resumeState?.goalFingerprint
      ? resumeState.goalFingerprint === taskGoalFingerprint(goal)
      : resumeState?.requiresGoalInput
        ? false
        : resumeState?.goal === goal;
    if (resumeState && (resumeState.targetId !== this.session.target.id || !resumeGoalMatches || (resumeState.endpoint && this.session.target.endpoint && resumeState.endpoint !== this.session.target.endpoint))) {
      throw new Error("Resume state goal fingerprint or target does not match the current authorized session.");
    }
    let latest = await this.session.observe({ profile: taskRequest.observationProfile, selectionGoal: goal });
    const initialApplication = this.environment ? resolveObservedApplication(this.environment, latest.page.url) : { status: "unmatched" };
    const observedApplicationId = initialApplication.status === "matched" ? initialApplication.applicationId : "unknown";
    state.initialUrl ??= latest.page.url;
    state.initialUrlFingerprint ??= routeFingerprint(latest.page.url);
    state.initialPageLabelHashes ??= pageLabelHashes(latest);
    state.status = "running";
    if (this.journal) await updateTaskJournal(this.journal, state);
    const runContext = createNavigationRunContext({
      taskState: state,
      observation: latest,
      limits: { actions: this.maxActions, recoveries: this.maxRecoveries, scrolls: this.maxScrolls },
      executionBinding: {
        targetId: this.session.target.id,
        endpoint: state.endpoint ?? this.session.target.journalEndpoint ?? this.session.target.endpoint ?? "local-cdp",
        environmentFingerprint: currentEnvironmentFingerprint,
        applicationId: observedApplicationId,
        principalId: this.principalId
      }
    });
    const scrollConvergenceStates = runContext.scrollConvergenceStates;
    const { candidateIdentities: excludedIdentities, targetSignatures: excludedTargetSignatures, scrollIdentities: excludedScrollIdentities } = runContext.exclusions;
    const { counters } = runContext;
    let recoveries = counters.recoveries;
    let scrollActionsUsed = counters.scrolls;
    const setLatestObservation = observation => {
      latest = runContext.setLatestObservation(observation);
      return latest;
    };
    const observeAfterPreDispatchRefusal = async outcome => {
      return setLatestObservation(await this.session.observe({ selectionGoal: goal }));
    };
    const incrementRecoveries = () => { recoveries = ++counters.recoveries; return recoveries; };
    const incrementScrolls = () => { scrollActionsUsed = ++counters.scrolls; return scrollActionsUsed; };
    const excludeFailedAttempt = attempt => runContext.excludeFailedAttempt(attempt);
    const recordFailedTargetPresence = (attempt, observation) => {
      if (attempt?.action !== "click" || !attempt.error) return;
      attempt.sameTargetRemained = (observation.candidates ?? []).some(candidate => candidate.identity === attempt.targetIdentity);
    };
    const workflowReplay = {
      status: this.workflowStore
        ? explicitReadWorkflowRequest ? "skipped_read_workflow" : searchPhrase ? "skipped_form_input" : "miss"
        : "disabled",
      actions: 0
    };
    const replayCoordinator = this.workflowStore
      ? new ReplayCoordinator({ workflowStore: this.workflowStore, goal, initialRouteFingerprint: state.initialUrlFingerprint })
      : null;
    const workflowTraceAttempts = [];
    let workflowTraceSafe = true;
    let planner = searchPhrase ? new DeterministicPlanner() : this.planner;

    const updateJournal = async () => { if (this.journal) await updateTaskJournal(this.journal, state); };
    let decisionEpisodeId = null;
    const decisionRunId = this.decisionContext?.runId ?? state.taskId;
    if (this.decisionRuntime) {
      const envId = String(this.environment?.environmentId ?? "").toLowerCase();
      const environmentClass = this.environment?.environmentClass
        ?? (envId.includes("production") ? "production" : envId.includes("staging") ? "staging" : envId ? "local" : "unknown");
      const episode = this.decisionRuntime.startEpisode({
        episodeId: this.decisionContext?.episodeId ?? state.decisionEpisodeId,
        runId: decisionRunId,
        workflowId: this.decisionContext?.workflowId ?? "navigation_goal",
        applicationId: observedApplicationId,
        environmentClass,
        executionMode: this.executionMode,
        policyVersion: "active_policy_v1",
        workflowKind: "browser_workflow"
      });
      decisionEpisodeId = episode.episodeId;
      state.decisionEpisodeId = decisionEpisodeId;
      await updateJournal();
    }
    if (workflowModeActive) {
      const synthesizer = this.workflowSynthesizer ?? createConfiguredWorkflowSynthesizer({
        eventStore: this.decisionRuntime?.eventStore,
        ...(typeof this.decisionRuntime?.budgetedFetch === "function" ? { fetchImpl: this.decisionRuntime.budgetedFetch("workflow_synthesis") } : {})
      });
      const environmentId = String(this.environment?.environmentId ?? "").toLowerCase();
      const environmentClass = this.workflowScope?.environmentClass
        ?? this.environment?.environmentClass
        ?? (environmentId.includes("production") ? "production" : environmentId.includes("staging") ? "staging" : environmentId ? "local" : "unknown");
      const applicationId = this.workflowScope?.applicationId ?? observedApplicationId;
      const profileFormCapabilities = createProfileFormWorkflowCapabilities({ session: this.session, getSession: getCurrentSession, environment: this.environment, applicationId });
      const callerCapabilities = Array.isArray(this.workflowCapabilities) ? this.workflowCapabilities : [];
      const searchInputRef = searchReadRequest ? availableSearchInputRef(workflowInputs) : null;
      const searchWorkflowCapabilities = searchReadRequest
        ? createObservedSearchWorkflowCapabilities({ observation: latest, session: this.session, getSession: getCurrentSession, inputRef: searchInputRef, query: searchReadRequest.query })
        : [];
      const effectiveWorkflowInputs = workflowInputs && typeof workflowInputs === "object" && !Array.isArray(workflowInputs)
        ? { ...workflowInputs }
        : {};
      if (searchWorkflowCapabilities.length === 2) effectiveWorkflowInputs[searchInputRef] = searchReadRequest.query;
      const configuredCapabilities = [
        ...createGenericWorkflowCapabilities({ environment: this.environment }),
        ...profileFormCapabilities,
        ...searchWorkflowCapabilities,
        ...callerCapabilities
      ];
      const extractionCapabilities = createExtractionWorkflowCapabilities({
        registry: this.capabilityRegistry,
        session: this.session,
        getSession: getCurrentSession,
        environment: this.environment,
        principalId: this.principalId,
        authorizeField: this.authorizeExtractionField,
        authorizeRelease: this.authorizeExtractionRelease,
        assertExecutionLease: this.assertExecutionLease,
        resumeCheckpoint: this.resumeWorkflowCheckpoint,
        persistCheckpoint: typeof this.persistWorkflowCheckpoint === "function"
          ? checkpoint => this.persistWorkflowCheckpoint({
            ...checkpoint,
            taskId: state.taskId,
            environmentFingerprint: currentEnvironmentFingerprint,
            principalId: this.principalId
          })
          : null,
      advancePage: details => advanceRegisteredPagination({
          session: this.session,
          environment: this.environment,
          assertExecutionLease: this.assertExecutionLease,
          ...details,
          ...(details.nextPage?.action === "click" ? {
            paginationOperationId: `registered-pagination:${details.capabilityId}@${details.capabilityVersion}`,
            paginationOperationAuthorizer: createRegisteredPaginationButtonAuthorizer({
              registry: this.capabilityRegistry,
              environment: this.environment,
              principalId: this.principalId,
              session: this.session,
              getSession: getCurrentSession,
              details
            })
          } : {})
        })
      });
      const observedReadCapabilities = explicitReadWorkflowRequest
        && (typeof this.capabilityService?.createObservedReadWorkflowCapabilities === "function"
          || typeof this.capabilityService?.createDeferredObservedReadWorkflowCapabilities === "function")
        ? requiresCompositeReadWorkflow(goal)
          ? (await this.capabilityService.createDeferredObservedReadWorkflowCapabilities?.({
            session: this.session,
            getSession: getCurrentSession,
            environment: this.environment,
            principalId: this.principalId,
            goal: searchReadRequest?.resultRequest ?? goal
          })) ?? []
          : await this.capabilityService.createObservedReadWorkflowCapabilities?.({
          session: this.session,
          getSession: getCurrentSession,
          environment: this.environment,
          principalId: this.principalId,
          observation: latest,
          goal
        })
        : [];
      const verifiedSearchCapability = searchWorkflowCapabilities.find(capability => capability.id === "observed_public_search_submit");
      const deferredReadCapabilities = observedReadCapabilities.map(capability => {
        if (!searchReadRequest || capability.outputCompleteness !== "observed_partial") return capability;
        return Object.freeze({
          ...capability,
          async execute(args = {}) {
            if (verifiedSearchCapability?.hasVerifiedSearchSubmission?.() !== true) return {
              status: "failed",
              reasonCode: "search_submission_not_verified_before_extraction",
              evidenceRefs: [args.observation?.evidenceId].filter(Boolean)
            };
            const searchVerified = await getCurrentSession()?.verifySearchOutcome(searchReadRequest.query).catch(() => false);
            if (!searchVerified) return {
              status: "failed",
              reasonCode: "search_results_not_verified_before_extraction",
              evidenceRefs: [args.observation?.evidenceId].filter(Boolean)
            };
            return capability.execute(args);
          }
        });
      });
      const configuredIds = new Set(configuredCapabilities.map(capability => capability?.id));
      const workflowCapabilities = [
        ...configuredCapabilities,
        ...extractionCapabilities.filter(capability => !configuredIds.has(capability.id)),
        ...deferredReadCapabilities.filter(capability => !configuredIds.has(capability.id))
      ];
      const taskResolution = resolveTaskIntent({
        goal,
        suppliedIntent: workflowIntent,
        capabilities: workflowCapabilities,
        observedReadCapabilityIds: deferredReadCapabilities.map(capability => capability.id),
        searchCapabilityIds: searchWorkflowCapabilities.map(capability => capability.id)
      });
      ({ planner, effectiveWorkflowIntent } = createWorkflowRoutePlanner({
        requestedPlannerMode: this.plannerMode,
        classifiedTask: taskRequest,
        trustedCapabilities: workflowCapabilities,
        taskResolution,
        workflowIntent: effectiveWorkflowIntent,
        searchReadRequest,
        synthesizer,
        knowledge: this.workflowKnowledge,
        inputs: effectiveWorkflowInputs,
        decisionRuntime: this.decisionRuntime,
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        scope: { applicationId, environmentClass, principalId: this.workflowScope?.principalId ?? this.environment?.principalId ?? "unknown" },
        allowDeterministicShortcut: !taskRequest.explicitReadRequest && !taskRequest.compoundRequest && !taskRequest.typedWorkflowIntent
          && profileFormCapabilities.length === 0 && callerCapabilities.length === 0 && extractionCapabilities.length === 0,
        allowAtomicFallback: !taskRequest.explicitReadRequest && !taskRequest.compoundRequest && !taskRequest.typedWorkflowIntent
      }));
    }
    const decisionStepId = () => this.decisionContext?.stepPrefix
      ? `${this.decisionContext.stepPrefix}_a${Math.min(999, state.attempts.length + 1)}`
      : `step_${Math.min(999, state.attempts.length + 1)}`;
    const prepareTelemetryDecision = async (attempt, actionType, target, authorized = true, operationId = null, workflowCapability = null, workflowReview = null) => {
      if (!this.decisionRuntime || !decisionEpisodeId) return { allowed: true, grantsAuthority: false };
      attempt.decisionId ??= randomUUID();
      attempt.decisionStepId ??= decisionStepId();
      attempt.operationId ??= randomUUID();
      const operationContext = this.operationAuthorizer?.decisionContext?.(operationId ?? attempt.operationId) ?? null;
      const targetIsLink = actionType === "click" && (target?.tag === "a" || target?.role === "link") && typeof target?.href === "string";
      const reviewRequired = operationContext?.reviewRequired === true
        || workflowCapability?.requiresApproval === true
        || ["shared_mutation", "security_change"].includes(workflowCapability?.effectClass)
        || target?.submitsForm === true;
      const reviewTargetRole = operationContext?.targetRole ?? workflowCapability?.targetRole ?? (targetIsLink ? "navigation_link" : "browser_control");
      const reviewPurposeCode = workflowCapability?.purposeCodes?.[0] ?? operationContext?.purposeCode ?? null;
      const reviewInput = {
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observation: latest,
        operation: actionType,
        operationClass: operationContext?.operationClass ?? workflowCapability?.effectClass ?? (targetIsLink ? "navigation" : "unknown"),
        targetRole: reviewTargetRole,
        ...(reviewPurposeCode ? { purposeCode: reviewPurposeCode } : {}),
        expectedOutcomeClass: workflowCapability?.postconditionCodes?.[0] ?? (targetIsLink ? "destination_observed" : "browser_state_change"),
        candidate: target,
        ...(operationContext?.semanticAnnotation ? { semanticAnnotation: operationContext.semanticAnnotation } : {}),
        ...(operationContext?.semanticEventIds?.length ? { semanticEventIds: operationContext.semanticEventIds } : {}),
        signal: abortSignal
      };
      let review;
      const equivalentVisibleCandidates = (latest.candidates ?? []).filter(candidate =>
        candidate.identity !== target?.identity
        && candidate.visible === true
        && candidate.role === target?.role
        && String(candidate.name ?? "").trim().toLowerCase() === String(target?.name ?? "").trim().toLowerCase()
      );
      const visualEvidenceAvailable = this.decisionRuntime.jevClient?.allowImages === true
        && isBoundVisualEvidence(latest, latest.visualEvidence);
      const workflowPlanStatus = planner?.getStatus?.();
      const workflowReviewBound = workflowReview?.status === "reviewed"
        && workflowReview?.reviewOutcome === "supported"
        && workflowReview?.disposition === "supported"
        && workflowReview?.planHash === workflowPlanStatus?.planHash
        && workflowReview?.observationId === workflowPlanStatus?.observationId
        && workflowReview?.reviewBindingHash === workflowPlanStatus?.reviewBindingHash
        && workflowReview?.taskContractHash === workflowPlanStatus?.taskContractHash
        && workflowReview?.capabilityCatalogHash === workflowPlanStatus?.capabilityCatalogHash
        && workflowReview?.targetId === latest.targetId
        && workflowReview?.targetId === workflowPlanStatus?.targetId
        && workflowReview?.documentGeneration === latest.documentGeneration
        && workflowReview?.documentGeneration === workflowPlanStatus?.documentGeneration
        && workflowReview?.reviewPolicyVersion === "workflow_plan_review_v1"
        && workflowReview?.bindingStatus === "bound";
      const route = selectPreActionDecisionRoute({
        actionAdmitted: authorized,
        workflowReview,
        workflowReviewBound,
        reviewRequired,
        riskClass: workflowCapability?.effectClass ?? operationContext?.operationClass ?? "unknown",
        uncertaintyClass: equivalentVisibleCandidates.length ? "ambiguous" : "resolved",
        visualEvidenceAvailable,
        reviewIntentAvailable: hasReviewIntent({ targetRole: reviewTargetRole, purposeCode: reviewPurposeCode })
      });
      this.decisionRuntime.recordInferenceRoute({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: latest.evidenceId,
        route: route.route,
        reasonCode: route.reasonCode,
        providers: route.providers,
        visualEvidenceUsed: route.visualEvidenceUsed
      });
      if (route.route === "jev_only") {
        review = await this.decisionRuntime.reviewBeforeAction(reviewInput);
      } else {
        await this.decisionRuntime.recordReviewSkipped({
          ...reviewInput,
          reasonCode: route.reasonCode
        });
        review = {
          decisionId: attempt.decisionId,
          authorizesOperation: false,
          coveredByWorkflowReview: route.reasonCode === "covered_by_batched_workflow_review",
          ...(route.reasonCode === "review_insufficient_evidence" ? { evidenceStatus: "insufficient_evidence", reasonCode: route.reasonCode } : {})
        };
      }
      const adjudication = adjudicatePreActionReview(review);
      await this.decisionRuntime.recordPolicy({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: latest.evidenceId,
        disposition: authorized && adjudication.allowed ? "allow" : "deny",
        reasonCode: !authorized ? "action_policy_refused"
          : adjudication.category === "insufficient_review_evidence" ? "review_insufficient_evidence"
            : adjudication.allowed ? "action_policy_admitted" : "jev_review_required",
        policyVersion: "active_policy_v1"
      });
      return adjudication;
    };
    const suspendForDecisionReview = async (attempt, adjudication) => {
      state.status = "needs_human";
      state.terminationReason = adjudication.reason ?? "Independent review requested additional agent review; no browser effect was dispatched.";
      state.authorizationRequired = {
        category: adjudication.category ?? "independent_review_required",
        targetIdentity: attempt.targetIdentity ?? null,
        evidenceId: attempt.beforeEvidenceId ?? latest.evidenceId
      };
      await updateJournal();
      return resultWithWorkflow(handoffResult(goal, state.terminationReason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId));
    };
    const reserveTelemetryOperation = async (attempt, actionType) => {
      if (!this.decisionRuntime || !decisionEpisodeId || !attempt.decisionId) return;
      await this.decisionRuntime.reserveExecution({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: attempt.beforeEvidenceId,
        operation: actionType,
        targetRole: "browser_target",
        operationId: attempt.operationId
      });
    };
    const recordTelemetryDispatchEvent = async (attempt, actionType, dispatchStatus) => {
      if (!this.decisionRuntime || !decisionEpisodeId || !attempt.decisionId) return;
      await this.decisionRuntime.recordDispatch({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: attempt.beforeEvidenceId,
        operation: actionType,
        targetRole: "browser_target",
        operationId: attempt.operationId,
        dispatchStatus
      });
    };
    const recordTelemetryObservation = async (attempt, changed, outcomeClass = "browser_state_observed") => {
      if (!this.decisionRuntime || !decisionEpisodeId || !attempt.decisionId || !attempt.afterEvidenceId) return;
      await this.decisionRuntime.recordObserved({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: attempt.afterEvidenceId,
        outcomeClass,
        changed,
        evidenceRefs: [attempt.beforeEvidenceId, attempt.afterEvidenceId]
      });
    };
    const recordWorkflowVerification = async (attempt, verification) => {
      if (!this.decisionRuntime || !decisionEpisodeId || !attempt.decisionId || !attempt.afterEvidenceId || !verification) return;
      await this.decisionRuntime.recordVerification({
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: attempt.decisionStepId,
        decisionId: attempt.decisionId,
        observationId: attempt.afterEvidenceId,
        status: verification.status,
        oracleType: "workflow_capability",
        reasonCode: verification.reasonCode,
        ...(verification.verifiedCode ? { verifiedCode: verification.verifiedCode } : {}),
        evidenceRefs: verification.evidenceRefs ?? [attempt.beforeEvidenceId, attempt.afterEvidenceId].filter(Boolean)
      });
    };
    const completeDecisionEpisode = status => {
      if (!this.decisionRuntime || !decisionEpisodeId || this.decisionContext?.sharedEpisode || state.decisionEpisodeCompleted === true) return;
      const normalized = status === "succeeded" ? "passed"
        : status === "canceled" ? "canceled"
          : status === "needs_human" ? "suspended"
            : status === "unresolved" ? "uncertain"
              : "failed";
      if (normalized === "suspended") return;
      this.decisionRuntime.completeEpisode({ episodeId: decisionEpisodeId, runId: decisionRunId, status: normalized, cleanupStatus: "not_required" });
      state.decisionEpisodeCompleted = true;
    };
    const isAbortError = error => error?.name === "AbortError" || error?.code === 20;
    // Cancellation after input dispatch keeps the action uncertain: the
    // dispatch receipt exists but the outcome was never observed, so the
    // task can never be reported as a success and must not be replayed
    // blindly on resume.
    const canceledWithPendingAction = async attempt => {
      attempt.error ??= { name: "AbortError", message: "The navigation run was canceled after dispatch; the action outcome is unknown." };
      attempt.uncertainOutcome = true;
      attempt.canceled = true;
      attempt.completedAt = new Date().toISOString();
      await recordTelemetryDispatch(attempt, attempt.action, "uncertain");
      if (attempt.action === "click") recordFailedTargetPresence(attempt, latest);
      finishAction(attempt);
      state.status = "canceled";
      state.terminationReason = "The run was canceled; the last dispatched action has an unknown outcome and is preserved as uncertain.";
      await updateJournal();
      return resultWithWorkflow({
        status: "canceled", goal, reason: state.terminationReason,
        attempts: state.attempts.length, recoveries, uncertain: true,
        dispatchDisposition: attempt.dispatchDisposition ?? DISPATCH_DISPOSITION.UNCERTAIN,
        evidenceId: latest.evidenceId
      });
    };
    const canceledBeforeDispatch = async attempt => {
      if (attempt && state.pendingAction === attempt) {
        attempt.canceled = true;
        attempt.completedAt = new Date().toISOString();
        finishAction(attempt);
      }
      state.status = "canceled";
      state.terminationReason = "The run was canceled before the pending action was dispatched; no browser input was sent.";
      await updateJournal();
      return resultWithWorkflow({
        status: "canceled", goal, reason: state.terminationReason,
        attempts: state.attempts.length, recoveries, uncertain: false,
        dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
        evidenceId: latest.evidenceId
      });
    };
    const actionAttemptCoordinator = new ActionAttemptCoordinator({
      taskState: state,
      runContext,
      updateJournal,
      reserveOperation: reserveTelemetryOperation,
      onDispatch: recordTelemetryDispatchEvent
    });
    const recordTelemetryDispatch = (attempt, actionType, dispatchStatus) =>
      actionAttemptCoordinator.recordDispatch(attempt, actionType, dispatchStatus);
    const finishAction = attempt => actionAttemptCoordinator.finish(attempt);
    const executeActionDispatch = async (execute, preflight = null) => {
      try {
        throwIfAborted();
      } catch (error) {
        return normalizeDispatchOutcome({
          cancelled: isAbortError(error),
          dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
          reasonCode: isAbortError(error) ? "canceled_before_dispatch" : "pre_dispatch_check_failed",
          observation: latest
        }, { error });
      }
      try {
        const refusal = preflight?.();
        if (refusal) {
          return normalizeDispatchOutcome({
            dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
            reasonCode: refusal.reasonCode ?? "action_preflight_refused",
            observation: latest
          }, { error: new Error(refusal.reason ?? "The action was refused before browser dispatch.") });
        }
      } catch (error) {
        return normalizeDispatchOutcome({
          dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
          reasonCode: "action_preflight_failed",
          observation: latest
        }, { error });
      }
      try {
        return normalizeDispatchOutcome(await execute());
      } catch (error) {
        const dispatchDisposition = isDispatchDisposition(error?.dispatchDisposition)
          ? error.dispatchDisposition
          : DISPATCH_DISPOSITION.UNCERTAIN;
        return normalizeDispatchOutcome({
          cancelled: isAbortError(error),
          dispatchDisposition,
          reasonCode: error?.reasonCode ?? "dispatch_callback_exception",
          observation: error?.observation ?? null
        }, { error });
      }
    };
    const resultWithWorkflow = result => {
      completeDecisionEpisode(result.status);
      const workflowPlanStatus = planner?.getStatus?.();
      return {
        ...result,
        goal: "[redacted task goal]",
        ...(this.decisionRuntime?.inferenceBudgetSnapshot ? { inferenceBudget: this.decisionRuntime.inferenceBudgetSnapshot(decisionRunId) } : {}),
        ...(workflowPlanStatus ? { workflowPlan: workflowPlanStatus } : {}),
        ...(planner?.isComplete?.() && Object.keys(planner?.getOutputs?.() ?? {}).length
          ? { workflowOutputs: planner.getOutputs() } : {}),
        ...(this.workflowStore ? { workflowReplay: { ...workflowReplay } } : {}),
        ...(state.reconciliation ? { reconciliation: state.reconciliation } : {})
      };
    };
    const stopAfterObservationLoss = async (attempt, error) => {
      const effectPossible = attempt.dispatchDisposition !== DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH;
      const observationError = { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
      const observationAttempts = Number.isInteger(error?.observationAttempts) && error.observationAttempts >= 1 && error.observationAttempts <= 2
        ? error.observationAttempts : 1;
      const failureName = String(error?.name ?? "").toLocaleLowerCase();
      const failureCode = String(error?.code ?? "").toLocaleUpperCase();
      const failureMessage = String(error?.message ?? error).toLocaleLowerCase();
      const targetDetached = this.session.attached === false || ["detached", "closed"].includes(this.session.targetLifecycle)
        || /target.{0,24}(detached|closed)|(?:detached|closed).{0,24}target/u.test(failureMessage);
      const observationErrorClass = targetDetached ? "target_detached"
        : error?.name === "TimeoutError" || ["ETIMEDOUT", "ERR_TIMED_OUT"].includes(failureCode) || /timed?\s*out|timeout/u.test(`${failureName} ${failureMessage}`)
          ? "timeout"
          : ["ECONNRESET", "EPIPE", "ECONNREFUSED", "ERR_STREAM_PREMATURE_CLOSE"].includes(failureCode)
            || /protocol|websocket|cdp|transport|socket/u.test(`${failureName} ${failureMessage}`)
            ? "cdp_transport" : "unknown";
      attempt.error ??= observationError;
      attempt.observationUnavailable = true;
      attempt.observationError = observationError;
      attempt.observationAttemptCount = observationAttempts;
      if (effectPossible) attempt.uncertainOutcome = true;
      attempt.completedAt = new Date().toISOString();
      finishAction(attempt);
      state.status = "unresolved";
      state.terminationReason = effectPossible
        ? "The browser target or observation connection could not be re-established after one bounded read retry; the effect remains uncertain and no browser action was repeated. Reattach and reconcile from fresh evidence."
        : "A pre-dispatch refusal was recorded, but fresh browser evidence could not be obtained for replanning. Reattach and resume from fresh evidence.";
      if (effectPossible) {
        state.reconciliation = Object.freeze({
          reasonCode: "post_action_observation_unavailable",
          dispatchDisposition: attempt.dispatchDisposition ?? DISPATCH_DISPOSITION.UNCERTAIN,
          errorClass: observationErrorClass,
          observationAttempts,
          reattachFailureCode: REATTACH_FAILURE_CODES.has(error?.reattachFailureCode)
            ? error.reattachFailureCode : "not_attempted"
        });
      }
      if (effectPossible && this.decisionRuntime?.recordReconciliationRequired && decisionEpisodeId && attempt.decisionId && attempt.operationId) {
        this.decisionRuntime.recordReconciliationRequired({
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          stepId: attempt.decisionStepId,
          decisionId: attempt.decisionId,
          observationId: attempt.beforeEvidenceId,
          operation: attempt.action,
          targetRole: "browser_target",
          operationId: attempt.operationId,
          dispatchStatus: attempt.dispatchStatus ?? "uncertain",
          reasonCode: "post_action_observation_unavailable",
          observationErrorClass,
          observationAttempts,
          evidenceRefs: [attempt.beforeEvidenceId].filter(Boolean)
        });
      }
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: attempt.beforeEvidenceId });
    };
    const stopAfterUncertainDispatch = async attempt => {
      attempt.uncertainOutcome = true;
      attempt.afterStateFingerprint = observationStateFingerprint(latest);
      attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
      attempt.afterEvidenceId = latest.evidenceId;
      attempt.completedAt = new Date().toISOString();
      workflowTraceSafe = false;
      recordFailedTargetPresence(attempt, latest);
      excludeFailedAttempt(attempt);
      await recordTelemetryObservation(attempt, attempt.afterStateFingerprint !== attempt.beforeStateFingerprint,
        "uncertain_dispatch_state_observed");
      finishAction(attempt);
      state.reconciliation = Object.freeze({
        reasonCode: "browser_dispatch_uncertain",
        dispatchDisposition: attempt.dispatchDisposition ?? DISPATCH_DISPOSITION.UNCERTAIN,
        dispatchReasonCode: attempt.dispatchReasonCode ?? "dispatch_outcome_unknown",
        evidenceId: latest.evidenceId ?? null
      });
      state.status = "unresolved";
      state.terminationReason = "The browser operation may have taken effect, so no further action was dispatched. Reconcile the observed state before resuming.";
      if (this.decisionRuntime?.recordReconciliationRequired && decisionEpisodeId && attempt.decisionId && attempt.operationId) {
        try {
          await this.decisionRuntime.recordReconciliationRequired({
            episodeId: decisionEpisodeId,
            runId: decisionRunId,
            stepId: attempt.decisionStepId,
            decisionId: attempt.decisionId,
            observationId: latest.evidenceId ?? attempt.beforeEvidenceId,
            operation: attempt.action,
            targetRole: "browser_target",
            operationId: attempt.operationId,
            dispatchStatus: attempt.dispatchStatus ?? "uncertain",
            reasonCode: attempt.dispatchReasonCode ?? "dispatch_outcome_unknown",
            evidenceRefs: [attempt.beforeEvidenceId, latest.evidenceId].filter(Boolean)
          });
        } catch {
          attempt.telemetryIncomplete = true;
        }
      }
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    };
    const recoveryCoordinator = new RecoveryCoordinator({
      getSession: () => this.session,
      setSession: session => { this.session = session; },
      getLatestObservation: () => latest,
      reattachSameTarget: this.reattachSameTarget
        ? (...args) => this.reattachSameTarget(...args)
        : null,
      environment: this.environment,
      assertExecutionLease: (...args) => this.assertExecutionLease?.(...args),
      selectionGoal: goal,
      isAbortError,
      throwIfAborted
    });
    const observeAfterChange = (timeoutMs, baseline, attempt = null) =>
      recoveryCoordinator.observeAfterChange(timeoutMs, baseline, attempt);
    const outcomeVerified = async () => {
      if (!hasVerifiedOutcome(latest, goal, state.initialPageLabelHashes, this.environment)) return false;
      return !searchPhrase || await this.session.verifySearchOutcome(searchPhrase);
    };
    const workflowPlanCanFinish = () => {
      const activeIntent = planner?.getTaskIntent?.() ?? effectiveWorkflowIntent;
      if (resumeState && activeIntent?.requiredCapabilityIds?.length && !this.resumeWorkflowCheckpoint) return false;
      if (explicitReadWorkflowRequest) {
        return workflowModeActive && typeof planner?.canFinishWithVisibleOutcome === "function"
          ? planner.canFinishWithVisibleOutcome()
          : false;
      }
      if (!workflowModeActive || resumeState) return true;
      return typeof planner?.canFinishWithVisibleOutcome === "function"
        ? planner.canFinishWithVisibleOutcome()
        : false;
    };
    const { captureVisualObservation, classifyAmbiguousPage, groundAmbiguousTarget } = createVisualDecisionCoordinator({
      decisionRuntime: this.decisionRuntime,
      session: this.session,
      getSession: getCurrentSession,
      deterministicPlanner: this.deterministicPlanner,
      goal,
      episodeId: decisionEpisodeId,
      runId: decisionRunId,
      decisionStepId,
      signal: abortSignal,
      excludedIdentities,
      excludedTargetSignatures,
      excludedScrollIdentities,
      searchPhrase,
      getLatestObservation: () => latest
    });
    const handoffIfNeeded = async observation => {
      const handoff = classifyHumanHandoff(observation);
      if (!handoff) return undefined;
      state.status = "needs_human";
      state.terminationReason = handoff.reason;
      state.interventionRequired = { category: handoff.category, evidenceId: observation.evidenceId };
      await updateJournal();
      return resultWithWorkflow({ status: "needs_human", goal, reason: handoff.reason, interventionRequired: state.interventionRequired, attempts: state.attempts.length, recoveries, evidenceId: observation.evidenceId });
    };
    const succeed = async () => {
      const activeIntent = planner?.getTaskIntent?.() ?? effectiveWorkflowIntent;
      const completedOutputs = planner?.isComplete?.() ? planner.getOutputs?.() ?? {} : {};
      if ((activeIntent?.requiredCapabilityIds ?? []).some(id => !Object.hasOwn(completedOutputs, id))) {
        state.status = "unresolved";
        state.terminationReason = "A caller-required workflow capability has no complete verified output; the task cannot be reported as successful.";
        await updateJournal();
        return resultWithWorkflow({ status: "unresolved", goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      if (Object.keys(completedOutputs).length && typeof this.persistWorkflowOutputs === "function"
        && planner?.hasObservedPartialOutput?.() !== true) {
        await this.persistWorkflowOutputs({
          taskId: state.taskId,
          environmentFingerprint: currentEnvironmentFingerprint,
          principalId: this.principalId,
          outputs: completedOutputs
        });
      }
      if (this.resumeWorkflowCheckpoint && typeof this.clearWorkflowCheckpoint === "function") {
        await this.clearWorkflowCheckpoint();
      }
      state.status = "succeeded";
      state.resultEvidenceId = latest.evidenceId;
      if (this.workflowStore && !searchPhrase && workflowReplay.status !== "replayed" && !activeIntent?.requiredCapabilityIds?.length) {
        try {
          const saved = workflowTraceSafe && workflowTraceAttempts.length
            ? await this.workflowStore.record(goal, state.initialUrlFingerprint, workflowTraceAttempts)
            : false;
          if (saved) workflowReplay.status = workflowReplay.status === "repairing" ? "repaired-and-recorded" : "recorded";
          else if (workflowReplay.status === "repairing") {
            workflowReplay.status = "repaired-not-recorded";
            workflowReplay.reason = workflowTraceSafe
              ? "No complete successful action trace was available for persistence."
              : "A failed action changed observable state, so workflow persistence was skipped.";
          }
        } catch (error) {
          workflowReplay.persistenceError = String(error.message).slice(0, 200);
        }
      }
      await updateJournal();
      return resultWithWorkflow({ status: "succeeded", goal, evidenceId: latest.evidenceId, attempts: state.attempts.length, recoveries, page: latest.page });
    };

    let recoveredPendingAction = false;
    if (state.pendingAction) {
      const pending = state.pendingAction;
      const interrupted = {
        ...pending,
        error: { name: "InterruptedAction", message: "The process ended while the browser action outcome was unknown." },
        dispatchDisposition: DISPATCH_DISPOSITION.UNCERTAIN,
        dispatchStatus: "uncertain",
        browserEffectPossible: true,
        retryWithoutReconciliation: false,
        dispatchReasonCode: "process_interrupted_during_action",
        uncertainOutcome: true,
        afterStateFingerprint: observationStateFingerprint(latest),
        afterRouteFingerprint: routeFingerprint(latest.page.url),
        afterEvidenceId: latest.evidenceId,
        completedAt: new Date().toISOString()
      };
      if (pending.operationId && pending.decisionId) {
        await recordTelemetryDispatch(interrupted, interrupted.action, "uncertain");
        await recordTelemetryObservation(interrupted,
          observationStateFingerprint(latest) !== pending.beforeStateFingerprint,
          "interrupted_action_reconciled_from_browser_state");
      }
      if (pending.action === "click") recordFailedTargetPresence(interrupted, latest);
      if (pending.action === "scroll") {
        const currentTarget = (latest.scrollTargets ?? []).find(target => target.identity === pending.targetIdentity);
        const moved = Boolean(currentTarget && currentTarget.scrollTop > Number(pending.scrollTopBefore ?? 0) + 2);
        interrupted.scrollTopAfter = currentTarget?.scrollTop ?? null;
        interrupted.scrollProgressObserved = moved;
        incrementScrolls();
        if (!moved) {
          state.scrollRecoveryBlocked = true;
          for (const target of latest.scrollTargets ?? []) excludedScrollIdentities.add(target.identity);
        }
      }
      finishAction(interrupted);
      excludeFailedAttempt(interrupted);
      await updateJournal();
      recoveredPendingAction = true;
    }

    const initialHandoff = await handoffIfNeeded(latest);
    if (initialHandoff) return initialHandoff;
    if (resumedHandoff) {
      state.interventionContinuation = {
        category: resumedHandoff.category,
        handoffEvidenceId: resumedHandoff.evidenceId,
        observedEvidenceId: latest.evidenceId,
        resumedAt: new Date().toISOString()
      };
      delete state.interventionRequired;
      await updateJournal();
    }
    if (await outcomeVerified() && workflowPlanCanFinish()) return await succeed();
    if (recoveredPendingAction) {
      if (recoveries >= this.maxRecoveries) {
        state.status = "unresolved";
        state.terminationReason = "An interrupted action could not be verified and the configured recovery bound is exhausted.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      incrementRecoveries();
      state.recoveryCount = recoveries;
      await updateJournal();
    }
    if (resumeState && (planner?.getTaskIntent?.() ?? effectiveWorkflowIntent)?.requiredCapabilityIds?.length
      && !this.resumeWorkflowCheckpoint) {
      state.status = "unresolved";
      state.terminationReason = "Required extraction output is not retained across task continuation; start a new task to rebuild it from fresh browser evidence.";
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    }

    // Replay only verified traces. Each step resolves a fresh, visible candidate from the current observation.
    // Candidate identities, raw labels, form values, and URL query data are never stored in the workflow file.
    if (this.workflowStore && !resumeState && !searchPhrase && !explicitReadWorkflowRequest && !(planner?.getTaskIntent?.() ?? effectiveWorkflowIntent)?.requiredCapabilityIds?.length) {
      const replay = await replayCoordinator.load({
        observation: latest,
        remainingActions: this.maxActions - state.attempts.length,
        remainingScrolls: this.maxScrolls - scrollActionsUsed
      });
      if (replay.status === "budget-skipped") workflowReplay.status = "budget-skipped";
      if (replay.workflow) {
        const workflow = replay.workflow;
        workflowReplay.status = "replaying";
        let stale = false;
        for (const step of workflow.steps) {
          const resolvedStep = replayCoordinator.resolveStep(step, latest);
          if (resolvedStep.status !== "ready") { stale = true; break; }
          if (step.action === "scroll") {
            const { target } = resolvedStep;
            const beforeStateFingerprint = observationStateFingerprint(latest);
            const waitBaseline = pageChangeWaitBaseline(latest, target);
            const attempt = {
              action: "scroll",
              targetIdentity: target.identity,
              scrollTopBefore: target.scrollTop,
              beforeStateFingerprint,
              beforeRouteFingerprint: routeFingerprint(latest.page.url),
              beforeEvidenceId: latest.evidenceId,
              startedAt: new Date().toISOString()
            };
            const review = await prepareTelemetryDecision(attempt, "scroll", target, true);
            if (!review.allowed) return await suspendForDecisionReview(attempt, review);
            const dispatchResult = await actionAttemptCoordinator.coordinateDispatch(attempt, "scroll", () => executeActionDispatch(async () =>
              dispatchThroughAuthorizedExecutor(this.session, {
                environment: this.environment,
                localFixture: this.localFixture,
                assertExecutionLease: this.assertExecutionLease,
                sameTargetNavigation: this.sameTargetNavigation,
                goal,
                action: "scroll",
                candidate: target
              })
            ));
            if (dispatchResult.cancelled) {
              return dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH
                ? await canceledBeforeDispatch(attempt)
                : await canceledWithPendingAction(attempt);
            }
            if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH) {
              try {
                await observeAfterPreDispatchRefusal(dispatchResult);
              } catch (error) {
                if (isAbortError(error)) return await canceledBeforeDispatch(attempt);
                workflowReplay.status = "interrupted";
                return await stopAfterObservationLoss(attempt, error);
              }
              attempt.afterStateFingerprint = observationStateFingerprint(latest);
              attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
              attempt.afterEvidenceId = latest.evidenceId;
              attempt.completedAt = new Date().toISOString();
              recordFailedTargetPresence(attempt, latest);
              excludeFailedAttempt(attempt);
              finishAction(attempt);
              workflowReplay.status = "stale";
              stale = true;
              await updateJournal();
              break;
            }
            if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN
              || dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.UNCERTAIN) {
              try {
                setLatestObservation(await observeAfterChange(1_500, waitBaseline, attempt));
              } catch (error) {
                workflowReplay.actions++;
                if (isAbortError(error)) return await canceledWithPendingAction(attempt);
                workflowReplay.status = "interrupted";
                return await stopAfterObservationLoss(attempt, error);
              }
              workflowReplay.actions++;
              workflowReplay.status = "interrupted";
              return await stopAfterUncertainDispatch(attempt);
            }
            try {
              setLatestObservation(await observeAfterChange(1_500, waitBaseline));
            } catch (error) {
              workflowReplay.actions++;
              if (isAbortError(error)) return await canceledWithPendingAction(attempt);
              workflowReplay.status = "interrupted";
              return await stopAfterObservationLoss(attempt, error);
            }
            throwIfAborted();
            const afterStateFingerprint = observationStateFingerprint(latest);
            const scrollEvaluation = replayCoordinator.evaluateScrollStep(step, target, attempt, latest);
            const { afterTarget, afterPositionFraction, afterCandidatesFingerprint, moved } = scrollEvaluation;
            attempt.afterStateFingerprint = afterStateFingerprint;
            attempt.scrollTopAfter = afterTarget?.scrollTop ?? null;
            attempt.scrollProgressObserved = moved;
            attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
            attempt.afterEvidenceId = latest.evidenceId;
            attempt.completedAt = new Date().toISOString();
            await recordTelemetryObservation(attempt, moved, attempt.error ? "scroll_failed_state_observed" : moved ? "scroll_progress_observed" : "scroll_no_progress_observed");
            finishAction(attempt);
            workflowReplay.actions++;
            incrementScrolls();
            excludeFailedAttempt(attempt);
            if (attempt.error || !moved) {
              workflowTraceSafe = false;
              if (!moved) {
                state.scrollRecoveryBlocked = true;
                for (const item of latest.scrollTargets ?? []) excludedScrollIdentities.add(item.identity);
              }
            }
            await updateJournal();
            const replayHandoff = await handoffIfNeeded(latest);
            if (replayHandoff) return replayHandoff;
            if (await outcomeVerified()) {
              workflowReplay.status = "replayed";
              return await succeed();
            }
            if (!scrollEvaluation.matchesTrace) {
              workflowTraceSafe = false;
              stale = true;
              break;
            }
            workflowTraceAttempts.push({
              ...attempt,
              scrollTargetSignature: step.scrollTarget,
              beforePositionFraction: step.beforePositionFraction,
              afterPositionFraction,
              beforeCandidatesFingerprint: step.beforeCandidatesFingerprint,
              afterCandidatesFingerprint
            });
            continue;
          }
          const target = resolvedStep.target;
          const authorization = authorizePlannedAction(goal, target);
          if (!authorization.authorized) {
            state.status = "needs_human";
            state.terminationReason = authorization.reason;
            state.authorizationRequired = { category: authorization.category, targetIdentity: target.identity, evidenceId: latest.evidenceId };
            await updateJournal();
            return resultWithWorkflow(handoffResult(goal, state.terminationReason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId));
          }
          const beforeStateFingerprint = observationStateFingerprint(latest);
          const beforeSemanticFingerprint = observationSemanticFingerprint(latest);
          const waitBaseline = pageChangeWaitBaseline(latest);
          const attempt = {
            action: "click",
            targetIdentity: target.identity,
            targetSignature: targetSignature(target),
            beforeStateFingerprint,
            beforeRouteFingerprint: routeFingerprint(latest.page.url),
            beforeEvidenceId: latest.evidenceId,
            startedAt: new Date().toISOString()
          };
          const review = await prepareTelemetryDecision(attempt, "click", target, true);
          if (!review.allowed) return await suspendForDecisionReview(attempt, review);
          const dispatchResult = await actionAttemptCoordinator.coordinateDispatch(attempt, "click", () => executeActionDispatch(async () =>
            dispatchThroughAuthorizedExecutor(this.session, {
              environment: this.environment,
              localFixture: this.localFixture,
              assertExecutionLease: this.assertExecutionLease,
              sameTargetNavigation: this.sameTargetNavigation,
              goal,
              action: "click",
              candidate: target
            })
          ));
          if (dispatchResult.cancelled) {
            return dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH
              ? await canceledBeforeDispatch(attempt)
              : await canceledWithPendingAction(attempt);
          }
          if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH) {
            try {
              await observeAfterPreDispatchRefusal(dispatchResult);
            } catch (error) {
              if (isAbortError(error)) return await canceledBeforeDispatch(attempt);
              workflowReplay.status = "interrupted";
              return await stopAfterObservationLoss(attempt, error);
            }
            attempt.afterStateFingerprint = observationStateFingerprint(latest);
            attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
            attempt.afterEvidenceId = latest.evidenceId;
            attempt.completedAt = new Date().toISOString();
            recordFailedTargetPresence(attempt, latest);
            excludeFailedAttempt(attempt);
            finishAction(attempt);
            workflowReplay.status = "stale";
            stale = true;
            await updateJournal();
            break;
          }
          if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN
            || dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.UNCERTAIN) {
            try {
              setLatestObservation(await observeAfterChange(2_000, waitBaseline, attempt));
            } catch (error) {
              workflowReplay.actions++;
              if (isAbortError(error)) return await canceledWithPendingAction(attempt);
              workflowReplay.status = "interrupted";
              return await stopAfterObservationLoss(attempt, error);
            }
            workflowReplay.actions++;
            workflowReplay.status = "interrupted";
            return await stopAfterUncertainDispatch(attempt);
          }
          excludedIdentities.add(target.identity);
          try {
            setLatestObservation(await observeAfterChange(2_000, waitBaseline, attempt));
          } catch (error) {
            workflowReplay.actions++;
            if (isAbortError(error)) return await canceledWithPendingAction(attempt);
            workflowReplay.status = "interrupted";
            return await stopAfterObservationLoss(attempt, error);
          }
          throwIfAborted();
          const afterStateFingerprint = observationStateFingerprint(latest);
          const afterSemanticFingerprint = observationSemanticFingerprint(latest);
          attempt.afterStateFingerprint = afterStateFingerprint;
          recordFailedTargetPresence(attempt, latest);
          excludeFailedAttempt(attempt);
          if (attempt.error) {
            if (afterSemanticFingerprint !== beforeSemanticFingerprint) workflowTraceSafe = false;
          } else if (afterStateFingerprint !== beforeStateFingerprint) {
            workflowTraceAttempts.push(attempt);
          }
          attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
          attempt.afterEvidenceId = latest.evidenceId;
          attempt.completedAt = new Date().toISOString();
          await recordTelemetryObservation(attempt, afterStateFingerprint !== beforeStateFingerprint,
            attempt.error ? "click_failed_state_observed" : "click_state_observed");
          finishAction(attempt);
          workflowReplay.actions++;
          await updateJournal();
          const replayHandoff = await handoffIfNeeded(latest);
          if (replayHandoff) return replayHandoff;
          if (await outcomeVerified()) {
            workflowReplay.status = "replayed";
            return await succeed();
          }
          if (attempt.error || !replayCoordinator.clickChanged(beforeStateFingerprint, latest)) { stale = true; break; }
        }
        if (workflowReplay.actions === workflow.steps.length && !await outcomeVerified()) stale = true;
        if (stale) {
          await replayCoordinator.invalidate();
          if (workflowReplay.actions > 0) {
            incrementRecoveries();
            state.recoveryCount = recoveries;
            workflowReplay.status = "repairing";
            await updateJournal();
          } else workflowReplay.status = "stale";
        } else if (workflowReplay.actions === workflow.steps.length) {
          workflowReplay.status = "replayed";
          return await succeed();
        }
      }
    }

    if (recoveries > this.maxRecoveries) {
      state.status = "unresolved";
      state.terminationReason = "Workflow replay failed and the configured recovery bound is exhausted.";
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    }

    let candidateExpansionAttempted = false;
    while (state.attempts.length < this.maxActions) {
      if (await outcomeVerified() && workflowPlanCanFinish()) return await succeed();
      const filterPlanning = (observation, searchObservation = latest) => filterPlanningObservation(observation, {
        excludedIdentities,
        excludedTargetSignatures,
        excludedScrollIdentities,
        searchPhrase,
        searchObservation
      });
      let planningObservation = filterPlanning(latest);
      if (shouldExpandTaskScope(latest, {
        workflowModeActive,
        expansionAttempted: candidateExpansionAttempted
      })) {
        candidateExpansionAttempted = true;
        const expansion = await expandTaskScopeObservation({
          session: this.session,
          observation: latest,
          goal,
          acceptObservation: setLatestObservation,
          filterObservation: filterPlanning
        });
        if (expansion.expanded) {
          planningObservation = expansion.planningObservation;
        }
      }
      if ((this.plannerMode !== "auto" && planner?.requiresScreenshot === true) || this.decisionRuntime?.requiresScreenshot === true) {
        setLatestObservation(await this.session.observe({
          profile: "visual",
          prepareForJev: true,
          selectionGoal: goal,
          candidateLimit: candidateExpansionAttempted ? 384 : 200
        }));
        planningObservation = filterPlanning(latest);
        const visualEvidence = this.session.observer?.getEvidence?.(latest.evidenceId, {
          facets: ["page"],
          includeScreenshot: true
        });
        const boundVisualEvidence = bindVisualEvidence(latest, visualEvidence);
        if (boundVisualEvidence) {
          planningObservation.visualEvidence = boundVisualEvidence;
          planningObservation.screenshotBase64 = boundVisualEvidence.screenshotBase64;
        }
      }
      let plan;
      let modelPlannerDecisionId = null;
      let routedVisualReview = null;
      let visualHandoffSuggested = false;
      const providerPlanState = {
        planningObservation,
        candidateExpansionAttempted,
        plan,
        modelPlannerDecisionId,
        routedVisualReview,
        visualHandoffSuggested
      };
      const syncProviderPlanState = () => {
        planningObservation = providerPlanState.planningObservation;
        candidateExpansionAttempted = providerPlanState.candidateExpansionAttempted;
        plan = providerPlanState.plan;
        modelPlannerDecisionId = providerPlanState.modelPlannerDecisionId;
        routedVisualReview = providerPlanState.routedVisualReview;
        visualHandoffSuggested = providerPlanState.visualHandoffSuggested;
      };
      try {
        await coordinateProviderPlan({
          goal,
          planner,
          configuredPlanner: this.planner,
          plannerMode: this.plannerMode,
          workflowModeActive,
          explicitReadWorkflowRequest,
          resumeState,
          effectiveWorkflowIntent,
          deterministicPlanner: this.deterministicPlanner,
          secondaryPlannerAvailable: this.secondaryPlannerAvailable,
          decisionRuntime: this.decisionRuntime,
          decisionEpisodeId,
          decisionRunId,
          decisionStepId,
          session: this.session,
          state: providerPlanState,
          excludedIdentities,
          excludedScrollIdentities,
          scrollActionsUsed,
          scrollConvergenceStates,
          maxScrolls: this.maxScrolls,
          signal: abortSignal,
          inputBindings,
          searchPhrase,
          getLatestObservation: () => latest,
          setLatestObservation,
          filterPlanning,
          captureVisualObservation,
          classifyAmbiguousPage,
          groundAmbiguousTarget
        });
        syncProviderPlanState();
      } catch (error) {
        syncProviderPlanState();
        if (isAbortError(error)) return await canceledBeforeDispatch();
        if (modelPlannerDecisionId && this.decisionRuntime?.recordPlannerFailure) {
          const failureCode = ["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted"].includes(error?.kind)
            ? error.kind : "unknown";
          const inputModality = planner?.requiresScreenshot === true && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
            ? "text_plus_visual" : "text_only";
          try {
            this.decisionRuntime.recordPlannerFailure({
              episodeId: decisionEpisodeId,
              runId: decisionRunId,
              stepId: decisionStepId(),
              decisionId: modelPlannerDecisionId,
              observationId: planningObservation.evidenceId,
              model: planner.model ?? "unknown",
              goal,
              failureCode,
              inputModality,
              clientRequestId: error?.clientRequestId,
              providerLatencyMs: error?.providerLatencyMs
            });
          } catch { /* preserve the original provider failure */ }
        }
        throw error;
      }
      if (modelPlannerDecisionId && this.decisionRuntime?.recordPlannerPrediction) {
        const selected = plan.status === "planned" ? plan.action?.target : null;
        this.decisionRuntime.recordPlannerPrediction({
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          stepId: decisionStepId(),
          decisionId: modelPlannerDecisionId,
          observationId: planningObservation.evidenceId,
          model: planner.model ?? "unknown",
          goal,
          candidateIdentity: selected?.identity ?? null,
          resultCode: plan.status === "planned" ? "planned" : "ambiguous",
          reasonCode: plan.status === "ambiguous" ? "model_abstained_or_unusable" : null,
          actionType: plan.status === "planned" ? String(plan.action?.type ?? "click") : null,
          inputModality: planner.requiresScreenshot && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
            ? "text_plus_visual" : "text_only",
          usage: plan.modelUsage,
          clientRequestId: plan.clientRequestId,
          providerLatencyMs: plan.providerLatencyMs
        });
      }
      try { throwIfAborted(); }
      catch (error) {
        if (isAbortError(error)) return await canceledBeforeDispatch();
        throw error;
      }
      if (plan.status !== "planned") {
        if (plan.status === "completed" && planner?.isComplete?.()) return await succeed();
        const workflowReviewHandoff = plan.status === "needs_human";
        state.status = workflowReviewHandoff || visualHandoffSuggested || recoveries ? "needs_human" : "unresolved";
        state.terminationReason = plan.reason;
        if (workflowReviewHandoff) state.authorizationRequired = {
          category: "workflow_review_required",
          targetIdentity: null,
          evidenceId: latest.evidenceId
        };
        const visualReview = routedVisualReview ?? (plan.status === "ambiguous" && this.plannerMode === "deterministic"
          ? await classifyAmbiguousPage(latest)
          : null);
        const visualAssessment = visualReview?.assessment ?? null;
        await updateJournal();
        const observedCandidates = new Map((latest.candidates ?? []).map(candidate => [candidate.identity, candidate]));
        const resolutionCandidates = (plan.candidates ?? []).flatMap(candidate => {
          const observed = observedCandidates.get(candidate.identity);
          if (!observed || !Number.isInteger(observed.backendNodeId)) return [];
          return [{
            backendNodeId: observed.backendNodeId,
            ...(observed.frameTargetId ? { frameTargetId: observed.frameTargetId } : {}),
            tag: observed.tag,
            role: observed.role,
            name: observed.name,
            contextName: observed.contextName ?? null,
            bounds: observed.bounds ?? null
          }];
        });
        const unresolvedResult = {
          status: state.status,
          goal,
          reason: plan.reason,
          attempts: state.attempts.length,
          recoveries,
          evidenceId: latest.evidenceId,
          ...(plan.workflowReview ? { workflowReview: plan.workflowReview } : {}),
          ...(visualAssessment ? { visualAssessment: {
            status: visualAssessment.status,
            ...(visualAssessment.observationId ? { evidenceId: visualAssessment.observationId } : {}),
            ...(visualAssessment.failureCode ? { failureCode: visualAssessment.failureCode } : {}),
            ...(visualAssessment.answers?.page_state?.choice ? { pageState: visualAssessment.answers.page_state.choice } : {}),
            ...(visualAssessment.answers?.obstruction_present?.probabilityYes !== undefined
              ? { obstructionProbability: visualAssessment.answers.obstruction_present.probabilityYes } : {}),
            authorizesOperation: false
          } } : {}),
          ...(resolutionCandidates.length ? {
            targetResolution: {
              evidenceId: latest.evidenceId,
              candidates: resolutionCandidates,
              nextStep: "Inspect retained evidence for these candidates, then submit the selected backendNodeId to click_observed_element. ActiveTab will revalidate it against a fresh observation."
            }
          } : {})
        };
        return resultWithWorkflow(workflowReviewHandoff
          ? { ...handoffResult(goal, plan.reason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId), workflowReview: plan.workflowReview }
          : unresolvedResult);
      }
      const actionType = plan.action.type ?? "click";
      const plannedIdentity = plan.action.target?.identity;
      let selectedTarget = actionType === "scroll"
        ? planningObservation.scrollTargets.find(target => target.identity === plannedIdentity)
        : planningObservation.candidates.find(candidate => candidate.identity === plannedIdentity);
      if (!selectedTarget || selectedTarget.visible !== true || (actionType !== "scroll" && selectedTarget.disabled === true)) {
        state.status = recoveries ? "needs_human" : "unresolved";
        state.terminationReason = "The planner selected a target that is not present and interactable in the fresh observation; no action was dispatched.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      const workflowCapability = plan.workflowCapability ?? null;
      let operationId = workflowCapability?.operationId ?? this.operationAuthorizer?.operationId ?? null;
      let operationAuthorizer = this.operationAuthorizer;
      if (searchPhrase && searchSubmitAuthorizer && (
        ((actionType === "type" || actionType === "fill") && isSearchFieldCandidate(selectedTarget, latest))
        || (actionType === "click" && selectedTarget.submitsForm === true)
      )) {
        operationId = SEARCH_SUBMIT_OPERATION_ID;
        operationAuthorizer = searchSubmitAuthorizer;
      }
      let authorization = authorizePlannedAction(goal, selectedTarget, actionType);
      const workflowNeedsScopedAuthorization = workflowCapability && (
        workflowCapability.requiresApproval === true
        || ["test_owned_mutation", "shared_mutation", "security_change"].includes(workflowCapability.effectClass)
      );
      if (workflowCapability?.effectClass === "unknown") {
        authorization = { authorized: false, category: "unknown_effect_denied", reason: "The trusted workflow capability classifies this operation as unknown; no effect was dispatched." };
      } else if (workflowNeedsScopedAuthorization) {
        if (!operationAuthorizer || typeof operationAuthorizer.authorize !== "function" || !operationId) {
          authorization = { authorized: false, category: "scoped_operation_authorizer_required", reason: "This workflow capability requires its registered scoped operation authorizer." };
        } else {
          // The central executor consumes the scoped grant exactly once and
          // rechecks it against the fresh target immediately before dispatch.
          // Do not pre-consume a single-use grant here.
          authorization = { authorized: true, category: "deferred_to_authorized_executor" };
        }
      } else if (!authorization.authorized
        && ["unsupported_action", "unsupported_text_entry", "unclassified_form_submission", "unknown_control_effect"].includes(authorization.category)
        && operationAuthorizer && typeof operationId === "string" && operationId) {
        const typedOperation = await operationAuthorizer.authorize({
          operationId, action: actionType, candidate: selectedTarget, value: plan.action.value ?? null, observation: latest
        });
        if (typedOperation?.allowed === true) {
          authorization = { authorized: true, category: typedOperation.category ?? "typed_operation" };
        }
      }
      if (!authorization.authorized) {
        const deniedAttempt = {
          action: actionType,
          targetIdentity: selectedTarget.identity,
          beforeEvidenceId: latest.evidenceId,
          startedAt: new Date().toISOString()
        };
        await prepareTelemetryDecision(deniedAttempt, actionType, selectedTarget, false, operationId, workflowCapability, plan.workflowReview);
        state.status = "needs_human";
        state.terminationReason = authorization.reason;
        state.authorizationRequired = {
          category: authorization.category,
          targetIdentity: selectedTarget.identity,
          evidenceId: latest.evidenceId
        };
        await updateJournal();
        return resultWithWorkflow(handoffResult(goal, state.terminationReason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId));
      }
      const beforeObservation = latest;
      const beforeStateFingerprint = observationStateFingerprint(latest);
      const beforeSemanticFingerprint = observationSemanticFingerprint(latest);
      const waitBaseline = pageChangeWaitBaseline(latest, actionType === "scroll" ? selectedTarget : undefined);
      const scrollTraceContext = actionType === "scroll" && this.workflowStore ? {
        scrollTargetSignature: scrollTargetSignature(selectedTarget),
        beforePositionFraction: scrollPositionFraction(selectedTarget),
        beforeCandidatesFingerprint: visibleCandidatesFingerprint(latest)
      } : null;
      const attempt = {
        action: actionType,
        targetIdentity: selectedTarget.identity,
        ...(actionType === "scroll" ? { scrollTopBefore: selectedTarget.scrollTop } : { targetSignature: targetSignature(selectedTarget) }),
        beforeStateFingerprint,
        beforeRouteFingerprint: routeFingerprint(latest.page.url),
        beforeEvidenceId: latest.evidenceId,
        startedAt: new Date().toISOString()
      };
      const review = await prepareTelemetryDecision(attempt, actionType, selectedTarget, authorization.authorized, operationId, workflowCapability, plan.workflowReview);
      if (authorization.authorized && !review.allowed) return await suspendForDecisionReview(attempt, review);
      const dispatchResult = await actionAttemptCoordinator.coordinateDispatch(attempt, actionType, () => executeActionDispatch(
        () => dispatchThroughAuthorizedExecutor(this.session, {
          environment: this.environment,
          localFixture: this.localFixture,
          assertExecutionLease: this.assertExecutionLease,
          sameTargetNavigation: this.sameTargetNavigation,
          goal,
          action: actionType,
          candidate: selectedTarget,
          value: plan.action.value ?? null,
          filePaths: plan.action.filePaths ?? null,
          operationId,
          operationAuthorizer,
          validateActionTarget: workflowCapability?.validateTarget ?? null
        }),
        () => actionType === "scroll" && plan.action.direction !== "down"
          ? { reasonCode: "unsupported_scroll_direction", reason: "Only downward scroll actions are supported." }
          : null
      ));
      if (dispatchResult.cancelled) {
        return dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH
          ? await canceledBeforeDispatch(attempt)
          : await canceledWithPendingAction(attempt);
      }
      const dispatchOutcome = dispatchResult.dispatchStatus;
      if (actionType !== "scroll" || attempt.error) excludedIdentities.add(selectedTarget.identity);
      try {
        if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH) {
          await observeAfterPreDispatchRefusal(dispatchResult);
        } else {
          setLatestObservation(await observeAfterChange(actionType === "type" ? 500 : actionType === "scroll" ? 1_500 : 2_000, waitBaseline, attempt));
        }
      } catch (error) {
        if (isAbortError(error)) {
          return attempt.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH
            ? await canceledBeforeDispatch(attempt)
            : await canceledWithPendingAction(attempt);
        }
        return await stopAfterObservationLoss(attempt, error);
      }
      try { throwIfAborted(); }
      catch (error) {
        if (isAbortError(error)) {
          return attempt.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH
            ? await canceledBeforeDispatch(attempt)
            : await canceledWithPendingAction(attempt);
        }
        throw error;
      }
      const afterStateFingerprint = observationStateFingerprint(latest);
      const afterSemanticFingerprint = observationSemanticFingerprint(latest);
      attempt.afterStateFingerprint = afterStateFingerprint;
      if (dispatchOutcome === "dispatched") attempt.dispatched = true;
      recordFailedTargetPresence(attempt, latest);
      excludeFailedAttempt(attempt);
      if (dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN
        || dispatchResult.dispatchDisposition === DISPATCH_DISPOSITION.UNCERTAIN) {
        return await stopAfterUncertainDispatch(attempt);
      }
      if (actionType === "scroll") {
        incrementScrolls();
        // Record convergence state for infinite-scroll detection.
        if (attempt.scrollProgressObserved === true) {
          const scrollIdentity = selectedTarget.identity;
          const candidateTexts = (latest.candidates ?? []).filter(c => c.visible === true).map(c => c.name ?? "");
          const matchingCount = candidateTexts.filter(text =>
            goalExpectation(goal).targetTokens.some(token => text.toLowerCase().includes(token))
          ).length;
          const previous = scrollConvergenceStates.get(scrollIdentity);
          scrollConvergenceStates.set(scrollIdentity, {
            matchingCandidateCount: matchingCount,
            scrollActionsUsed: scrollActionsUsed,
            previousMatchingCandidateCount: previous?.matchingCandidateCount ?? -1
          });
        }
        const observedScrollMatches = (latest.scrollTargets ?? []).filter(target =>
          scrollTraceContext?.scrollTargetSignature && matchesScrollTargetSignature(target, scrollTraceContext.scrollTargetSignature)
        );
        const movedTarget = observedScrollMatches.length === 1
          ? observedScrollMatches[0]
          : latest.scrollTargets?.find(target => target.identity === selectedTarget.identity);
        const moved = Boolean(movedTarget && movedTarget.scrollTop > Number(selectedTarget.scrollTop ?? 0) + 2);
        attempt.scrollTopAfter = movedTarget?.scrollTop ?? null;
        attempt.scrollProgressObserved = moved;
        attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
        attempt.afterEvidenceId = latest.evidenceId;
        attempt.completedAt = new Date().toISOString();
        if (plan.workflowStepId && typeof planner.recordOutcome === "function") {
          const verification = await planner.recordOutcome({
            action: plan.action,
            beforeObservation,
            afterObservation: latest,
            dispatchStatus: dispatchOutcome,
            error: attempt.error,
            signal: abortSignal
          });
          await recordWorkflowVerification(attempt, verification);
        }
        finishAction(attempt);
        if (this.workflowStore && !attempt.error && moved && scrollTraceContext?.scrollTargetSignature && Number.isFinite(scrollTraceContext.beforePositionFraction)) {
          const matchingAfterTargets = (latest.scrollTargets ?? []).filter(target => matchesScrollTargetSignature(target, scrollTraceContext.scrollTargetSignature));
          const afterTarget = matchingAfterTargets.length === 1 ? matchingAfterTargets[0] : undefined;
          const afterPositionFraction = scrollPositionFraction(afterTarget);
          const afterCandidatesFingerprint = visibleCandidatesFingerprint(latest);
          if (afterTarget && Number.isFinite(afterPositionFraction) && afterPositionFraction > scrollTraceContext.beforePositionFraction) {
            Object.assign(attempt, {
              scrollTargetSignature: scrollTraceContext.scrollTargetSignature,
              beforePositionFraction: scrollTraceContext.beforePositionFraction,
              afterPositionFraction,
              beforeCandidatesFingerprint: scrollTraceContext.beforeCandidatesFingerprint,
              afterCandidatesFingerprint
            });
            workflowTraceAttempts.push(attempt);
          } else {
            workflowTraceSafe = false;
            workflowReplay.status = "skipped_scroll";
            workflowReplay.reason = "The scroll transition could not be tied to one fresh region and position; it was not saved for replay.";
          }
        } else if (this.workflowStore) {
          workflowTraceSafe = false;
          workflowReplay.status = "skipped_scroll";
          workflowReplay.reason = "The scroll transition did not produce enough fresh evidence to validate replay.";
        }
        await updateJournal();
        const scrollHandoff = await handoffIfNeeded(latest);
        if (scrollHandoff) return scrollHandoff;
        if (planner instanceof WorkflowGraphPlanner && planner.isComplete()) return await succeed();
        if (await outcomeVerified() && workflowPlanCanFinish()) return await succeed();
        if (attempt.error || !moved) {
          if (!moved) state.scrollRecoveryBlocked = true;
          state.status = "unresolved";
          state.terminationReason = attempt.error
            ? "Native scrolling failed; no repeat was attempted. Observe the current page and continue with a fresh plan."
            : "The selected scroll region did not move; no repeat was attempted. Observe the current page and choose another region.";
          await updateJournal();
          return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
        }
        continue;
      }
      // Off-environment navigation guard: a click that carries the page onto
      // an origin not authorized by the environment binding is a misstep,
      // never goal progress. Record it, navigate back to the authorized
      // page, exclude the offending candidate, and recover.
      if (actionType === "click" && !attempt.error && this.environment?.authorizedOrigins?.length && typeof this.session.client?.send === "function") {
        const observed = normalizeOrigin(latest.page.url);
        if (observed && !this.environment.authorizedOrigins.includes(observed)) {
          const recoveryUrl = state.initialUrl ?? "";
          if (isOperatorProhibitedNavigation(recoveryUrl)) {
            attempt.error = {
              name: "OperatorProhibitedNavigation",
              message: "Automatic recovery would reopen the operator-prohibited Admin Console Audit Log; execution stopped for an operator."
            };
            excludedIdentities.add(selectedTarget.identity);
            state.status = "needs_human";
            state.authorizationRequired = true;
            state.terminationReason = attempt.error.message;
            attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
            attempt.afterEvidenceId = latest.evidenceId;
            attempt.completedAt = new Date().toISOString();
            finishAction(attempt);
            await updateJournal();
            return resultWithWorkflow(handoffResult(goal, state.terminationReason, true, state.attempts.length, recoveries, latest.evidenceId));
          }
          attempt.error = {
            name: "OffEnvironmentNavigation",
            message: `Click navigated to non-authorized origin '${observed}'; returning to the authorized environment page.`
          };
          attempt.recoveredOffEnvironment = true;
          excludedIdentities.add(selectedTarget.identity);
          if (workflowTraceSafe) workflowTraceSafe = false;
          try {
          await dispatchThroughAuthorizedExecutor(this.session, {
            environment: this.environment,
            localFixture: this.localFixture,
            assertExecutionLease: this.assertExecutionLease,
            recovery: true,
            goal,
            action: "navigate",
            url: recoveryUrl
          });
            setLatestObservation(await observeAfterChange(2_500, waitBaseline));
          } catch (error) {
            if (isAbortError(error)) return await canceledWithPendingAction(attempt);
            return await stopAfterObservationLoss(attempt, error);
          }
        }
      }
      if (attempt.error) {
        if (afterSemanticFingerprint !== beforeSemanticFingerprint) workflowTraceSafe = false;
      } else if (afterStateFingerprint !== beforeStateFingerprint) {
        workflowTraceAttempts.push(attempt);
      }
      attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
      attempt.afterEvidenceId = latest.evidenceId;
      attempt.completedAt = new Date().toISOString();
      if (plan.workflowStepId && typeof planner.recordOutcome === "function") {
        const verification = await planner.recordOutcome({
          action: plan.action,
          beforeObservation,
          afterObservation: latest,
          dispatchStatus: dispatchOutcome,
          error: attempt.error,
          signal: abortSignal
        });
        await recordWorkflowVerification(attempt, verification);
      }
      await recordTelemetryObservation(attempt, afterStateFingerprint !== beforeStateFingerprint,
        attempt.reconnectedObservation === true ? "same_target_reconnected_observation"
          : dispatchOutcome === "dispatched" ? "browser_state_observed" : "dispatch_failed_state_observed");
      finishAction(attempt);
      await updateJournal();
      const actionHandoff = await handoffIfNeeded(latest);
      if (actionHandoff) return actionHandoff;
      if (attempt.dispatchReasonCode === "target_occluded") {
        const interventionRequired = { category: "target_occluded", targetIdentity: attempt.targetIdentity, evidenceId: latest.evidenceId };
        state.status = "needs_human";
        state.interventionRequired = interventionRequired;
        state.terminationReason = "The selected browser control is covered. Clear the obstruction or select a different observed target before continuing.";
        await updateJournal();
        return resultWithWorkflow({ status: "needs_human", goal, reason: state.terminationReason, interventionRequired, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      if (planner instanceof WorkflowGraphPlanner && planner.isComplete()) return await succeed();
      if (await outcomeVerified() && workflowPlanCanFinish()) return await succeed();
      if (actionType === "type") {
        if (attempt.error) {
          state.status = "unresolved";
          state.terminationReason = "Search text entry failed; no sensitive input was saved. Resume with a fresh authorized observation.";
          await updateJournal();
          return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
        }
        continue;
      }
      if (plan.workflowStepId && planner instanceof WorkflowGraphPlanner) {
        const stepStatus = planner.getStatus()?.stepStatuses?.[plan.workflowStepId];
        if (stepStatus !== "passed") {
          state.status = "unresolved";
          state.terminationReason = "The workflow step did not pass its registered postcondition; no dependent step or retry was attempted.";
          await updateJournal();
          return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
        }
        continue;
      }
      if (recoveries >= this.maxRecoveries) {
        state.status = "unresolved";
        state.terminationReason = "Outcome was not verified within the configured recovery bound.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      incrementRecoveries();
      state.recoveryCount = recoveries;
      if (this.workflowStore && workflowReplay.status === "repairing") workflowReplay.status = "repairing";
      await updateJournal();
      // Reobserve and replan; never repeat the stale element identity.
    }
    state.status = "unresolved";
    state.terminationReason = "Action budget exhausted before the requested outcome was verified.";
    await updateJournal();
    return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
  }
}
