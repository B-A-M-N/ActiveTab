import { createHash, randomUUID } from "node:crypto";
import { configuredPlanner, DeterministicPlanner, goalExpectation } from "./planner.js";
import { createSearchSubmitAuthorizer, isSearchFieldCandidate, searchPhraseFromGoal, searchReadRequestFromGoal, SEARCH_SUBMIT_OPERATION_ID } from "./search.js";
import { authorizePlannedAction } from "./actionPolicy.js";
import { classifyHumanHandoff } from "./handoff.js";
import { newTaskState, taskGoalFingerprint, updateTaskJournal } from "../state/journal.js";
import { normalizeOrigin, resolveObservedApplication } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "../runtime/controlRestrictions.js";
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import { adjudicatePreActionReview } from "../decisions/adjudication.js";
import { hasReviewIntent, selectAutomaticNavigationRoute, selectPreActionDecisionRoute } from "../decisions/callPolicy.js";
import { matchesScrollTargetSignature, matchesTargetSignature, observationSemanticFingerprint, observationStateFingerprint, routeFingerprint, scrollPositionFraction, scrollPositionMatches, scrollTargetSignature, targetSignature, visibleCandidatesFingerprint } from "../state/workflows.js";
import { createConfiguredWorkflowSynthesizer } from "./workflowSynthesizer.js";
import { WorkflowGraphPlanner } from "./workflowPlanner.js";
import { createExtractionWorkflowCapabilities, createGenericWorkflowCapabilities, createObservedSearchWorkflowCapabilities, createProfileFormWorkflowCapabilities } from "./workflowCapabilities.js";
import { classifyTaskRequest, requiresCompositeReadWorkflow, resolveTaskIntent, selectTaskExecutionRoute } from "./taskIntentResolver.js";
import { hasVerifiedOutcome, pageLabelHashes } from "./outcomeVerifier.js";
import { discoverVisibleNextPage } from "../extraction/recordResolver.js";
import { bindVisualEvidence, isBoundVisualEvidence } from "./visualEvidence.js";
import { revalidateVisualGrounding } from "./visualGrounder.js";

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
  if (result.dispatched) return result;
  const error = new Error(result.reason ?? "The authorized executor refused the browser operation.");
  error.kind = result.authorized ? "dispatch_uncertain" : "authorization_refused";
  error.dispatchStatus = result.authorized ? "uncertain" : "refused";
  error.authorizationCategory = result.category ?? null;
  throw error;
}

function unchangedAfterFailedClick(attempt) {
  return attempt?.action === "click" && Boolean(attempt.error) &&
    (attempt.sameTargetRemained === true || attempt.observationUnavailable === true ||
      /^[a-f0-9]{64}$/.test(attempt.beforeStateFingerprint ?? "") && attempt.beforeStateFingerprint === attempt.afterStateFingerprint);
}

class UnresolvedTaskRoutePlanner {
  constructor(reason) { this.reason = reason; }
  async plan() {
    return { status: "ambiguous", candidates: [], reason: this.reason };
  }
}

const REATTACH_FAILURE_CODES = new Set([
  "not_attempted", "owned_browser_stopped", "target_not_found", "target_scope_rejected",
  "reattach_attach_failed", "reattach_observation_failed", "reattach_identity_mismatch",
  "lease_rebind_failed", "unknown"
]);

function createRegisteredPaginationButtonAuthorizer({ registry, environment, principalId, session, details }) {
  return Object.freeze({
    authorize({ action, candidate, observation } = {}) {
      let page;
      try { page = new URL(details.fromPageUrl); } catch { return { allowed: false, reason: "The registered pagination source URL is invalid." }; }
      const application = resolveObservedApplication(environment, page.href);
      const manifest = application.status === "matched" ? registry?.resolve?.(details.capabilityId, {
        capabilityVersion: details.capabilityVersion,
        origin: page.origin,
        environmentId: environment?.environmentId ?? environment?.id,
        applicationId: application.applicationId,
        principalId
      }) : null;
      const locator = details.nextPage?.target;
      const allowed = action === "click" && Boolean(manifest)
        && manifest.extractionContract?.pagination?.kind === "explicit_next_same_path"
        && candidate?.targetId === session?.target?.id
        && candidate?.backendNodeId === locator?.backendNodeId
        && candidate?.frameId === locator?.frameId
        && candidate?.tag === locator?.tag
        && candidate?.visible === true && candidate?.disabled !== true
        && observation?.targetId === session?.target?.id
        && observation?.page?.url === details.fromPageUrl;
      return allowed
        ? { allowed: true, category: "registered_pagination_button" }
        : { allowed: false, reason: "The next-page button is outside the registered extraction capability." };
    }
  });
}

/** Advance only a freshly observed registered same-path pagination control. */
export async function advanceRegisteredPagination({ session, environment, assertExecutionLease, url, fromPageUrl, nextPage, kind = "rel_next_same_path", queryParameter = null, signal, paginationOperationId = null, paginationOperationAuthorizer = null } = {}) {
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_before_pagination" };
  if (!session || typeof session.observe !== "function") return { status: "blocked", reasonCode: "pagination_session_unavailable" };
  if (kind === "virtualized_list") {
    const before = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!before?.page?.url || before.targetId && before.targetId !== session.target?.id) return { status: "blocked", reasonCode: "pagination_observation_unavailable" };
    let current;
    try { current = new URL(before.page.url); } catch { return { status: "blocked", reasonCode: "pagination_url_invalid" }; }
    if (fromPageUrl !== before.page.url) return { status: "blocked", reasonCode: "pagination_source_changed" };
    const target = (before.scrollTargets ?? []).find(item => item.identity === nextPage?.identity
      && item.targetId === session.target?.id && item.documentGeneration === before.documentGeneration
      && item.visible === true && item.canScrollDown === true && item.frameTargetId == null);
    if (!target) return { status: "blocked", reasonCode: "pagination_scroll_target_stale" };
    const dispatch = await executeAuthorizedAction({
      session,
      environment,
      goal: "Scroll down to reveal the next visible records",
      action: "scroll",
      candidate: target,
      assertExecutionLease,
      validateActionTarget: (candidate, observation) => candidate?.identity === target.identity
        && candidate?.canScrollDown === true && candidate?.visible === true
        && candidate?.frameTargetId == null && observation?.page?.url === current.href
    });
    if (!dispatch.dispatched) return {
      status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
      reasonCode: dispatch.category ?? "pagination_scroll_refused"
    };
    if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_scroll" };
    await Promise.resolve(session.waitForChange?.(2_000, {
      pageChangeFingerprint: before.pageChangeFingerprint,
      domMutationCount: before.domMutationCount,
      lifecycleEventCount: before.lifecycleEventCount,
      scrollTarget: { identity: target.identity, scrollTop: target.scrollTop }
    })).catch(() => {});
    const after = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!after?.page?.url || after.targetId !== session.target?.id || after.page.url !== before.page.url) {
      return { status: "uncertain", reasonCode: "pagination_scroll_post_observation_unavailable" };
    }
    const afterTarget = (after.scrollTargets ?? []).find(item => item.identity === target.identity);
    if (!afterTarget || !(afterTarget.scrollTop > Number(target.scrollTop ?? 0) + 2)) {
      return { status: "failed", reasonCode: "pagination_scroll_stalled" };
    }
    return { status: "verified", reasonCode: "virtualized_list_scroll_progress_observed", progressVerified: true };
  }
  if (kind === "explicit_next_same_path" && nextPage?.action === "click") {
    const before = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!before?.page?.url || before.targetId !== session.target?.id || before.page.url !== fromPageUrl) {
      return { status: "blocked", reasonCode: "pagination_source_changed" };
    }
    const retained = session.observer?.getEvidence?.(before.evidenceId, { facets: ["domSnapshot"] });
    if (retained?.status !== "available" || !retained.domSnapshot) return { status: "blocked", reasonCode: "pagination_dom_evidence_unavailable" };
    const fresh = discoverVisibleNextPage(retained.domSnapshot, before.page.url, { kind });
    const target = fresh.status === "available" && fresh.action === "click"
      && fresh.target?.backendNodeId === nextPage.target?.backendNodeId
      && fresh.target?.frameId === nextPage.target?.frameId
      ? (before.candidates ?? []).filter(candidate => candidate.backendNodeId === fresh.target.backendNodeId
        && candidate.frameId === fresh.target.frameId && candidate.tag === fresh.target.tag
        && candidate.visible === true && candidate.disabled !== true)
      : [];
    if (target.length !== 1) return { status: "blocked", reasonCode: "pagination_control_not_current" };
    const dispatch = await executeAuthorizedAction({
      session,
      environment,
      goal: "Open the explicitly registered next collection page",
      action: "click",
      candidate: target[0],
      operationId: paginationOperationId,
      operationAuthorizer: paginationOperationAuthorizer,
      assertExecutionLease,
      validateActionTarget: (candidate, observation) => candidate?.identity === target[0].identity
        && candidate?.backendNodeId === fresh.target.backendNodeId
        && candidate?.frameId === fresh.target.frameId
        && candidate?.visible === true && candidate?.disabled !== true
        && observation?.page?.url === before.page.url
    });
    if (!dispatch.dispatched) return {
      status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
      reasonCode: dispatch.category ?? "pagination_button_refused"
    };
    if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_click" };
    await Promise.resolve(session.waitForChange?.(2_000, {
      pageChangeFingerprint: before.pageChangeFingerprint,
      domMutationCount: before.domMutationCount,
      lifecycleEventCount: before.lifecycleEventCount
    })).catch(() => {});
    const after = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!after?.page?.url || after.targetId !== session.target.id
      || after.pageChangeFingerprint === before.pageChangeFingerprint) {
      return { status: "uncertain", reasonCode: "pagination_button_progress_unconfirmed" };
    }
    try {
      const oldUrl = new URL(before.page.url);
      const newUrl = new URL(after.page.url);
      if (oldUrl.origin !== newUrl.origin || oldUrl.pathname !== newUrl.pathname) {
        return { status: "failed", reasonCode: "pagination_button_scope_changed" };
      }
    } catch { return { status: "uncertain", reasonCode: "pagination_button_post_url_invalid" }; }
    return { status: "verified", reasonCode: "explicit_pagination_button_progress_observed" };
  }
  const before = await Promise.resolve().then(() => session.observe()).catch(() => null);
  let current;
  let destination;
  try {
    current = new URL(before?.page?.url);
    destination = new URL(url, current);
  } catch { return { status: "blocked", reasonCode: "pagination_url_invalid" }; }
  if (!before?.page?.url || before.page.url !== fromPageUrl
    || destination.origin !== current.origin || destination.pathname !== current.pathname
    || destination.username || destination.password || !["http:", "https:"].includes(destination.protocol)) {
    return { status: "blocked", reasonCode: "pagination_scope_changed" };
  }
  destination.hash = "";
  const retained = session.observer?.getEvidence?.(before.evidenceId, { facets: ["domSnapshot"] });
  if (retained?.status !== "available" || !retained.domSnapshot) {
    return { status: "blocked", reasonCode: "pagination_dom_evidence_unavailable" };
  }
  const freshNextPage = discoverVisibleNextPage(retained.domSnapshot, current.href, { kind, queryParameter });
  if (freshNextPage.status !== "available" || freshNextPage.url !== destination.href) {
    return { status: "blocked", reasonCode: "pagination_control_not_current" };
  }
  let dispatch;
  try {
    dispatch = await executeAuthorizedAction({
      session,
      environment,
      action: "navigate",
      url: destination.href,
      assertExecutionLease
    });
  } catch { return { status: "uncertain", reasonCode: "pagination_navigation_result_unknown" }; }
  if (!dispatch.dispatched) return {
    status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
    reasonCode: dispatch.category ?? "pagination_navigation_refused"
  };
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_dispatch" };
  await Promise.resolve(session.waitForChange?.(2_000, {
    pageChangeFingerprint: before.pageChangeFingerprint,
    domMutationCount: before.domMutationCount,
    lifecycleEventCount: before.lifecycleEventCount
  })).catch(() => {});
  const after = await Promise.resolve().then(() => session.observe()).catch(() => null);
  if (!after?.page?.url || before.targetId && after.targetId !== before.targetId) {
    return { status: "uncertain", reasonCode: "pagination_post_observation_unavailable" };
  }
  let observed;
  try { observed = new URL(after.page.url); }
  catch { return { status: "uncertain", reasonCode: "pagination_post_url_invalid" }; }
  if (observed.origin !== destination.origin || observed.pathname !== destination.pathname || observed.search !== destination.search) {
    return { status: "failed", reasonCode: "pagination_destination_mismatch" };
  }
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_observation" };
  return { status: "verified", reasonCode: "registered_pagination_destination_observed" };
}

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

  async run(goal, { resumeState, signal, workflowInputs = this.workflowInputs, workflowIntent = this.workflowIntent, inputBindings = {}, _executionState = null, _inferenceBudgeted = false } = {}) {
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
    const searchReadRequest = searchReadRequestFromGoal(goal);
    const searchPhrase = searchReadRequest?.query ?? searchPhraseFromGoal(goal);
    const taskRequest = classifyTaskRequest(goal, { suppliedIntent: workflowIntent });
    const explicitReadWorkflowRequest = taskRequest.explicitReadRequest;
    const workflowModeActive = (!resumeState || Boolean(this.resumeWorkflowCheckpoint))
      && ((this.plannerMode === "workflow" && (!searchPhrase || Boolean(searchReadRequest)))
        || (this.plannerMode === "auto" && (explicitReadWorkflowRequest || taskRequest.compoundRequest || taskRequest.typedWorkflowIntent)));
    const searchSubmitAuthorizer = searchPhrase ? createSearchSubmitAuthorizer(searchPhrase) : null;
    const state = _executionState ?? resumeState ?? newTaskState(
      goal,
      this.session.target,
      this.session.target.journalEndpoint ?? this.session.target.endpoint ?? "local-cdp"
    );
    let effectiveWorkflowIntent = workflowIntent;
    if (!_inferenceBudgeted && typeof this.decisionRuntime?.withInferenceBudget === "function") {
      const runId = this.decisionContext?.runId ?? state.taskId;
      return this.decisionRuntime.withInferenceBudget({ runId }, () => this.run(goal, {
        resumeState, signal, workflowInputs, workflowIntent, inputBindings,
        _executionState: state, _inferenceBudgeted: true
      }));
    }
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
    let recoveries = state.recoveryCount ?? 0;
    let scrollActionsUsed = (state.attempts ?? []).filter(attempt => attempt.action === "scroll").length;
    // Track per-identity scroll convergence: { identity, matchingCandidateCount, scrollActionsUsed }
    const scrollConvergenceStates = new Map();
    const failedClicks = (state.attempts ?? []).filter(attempt => attempt.action === "click" && attempt.error);
    const failedTargets = (state.attempts ?? []).filter(attempt => attempt.error && attempt.action !== "scroll");
    const excludedIdentities = new Set(failedTargets.map(attempt => attempt.targetIdentity).filter(value => typeof value === "string" && value));
    const excludedTargetSignatures = failedClicks
      .filter(attempt => attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt))
      .map(attempt => attempt.targetSignature)
      .filter(Boolean);
    const excludedScrollIdentities = new Set((state.attempts ?? [])
      .filter(attempt => attempt.action === "scroll" && attempt.error && attempt.scrollProgressObserved !== true)
      .map(attempt => attempt.targetIdentity)
      .filter(value => typeof value === "string" && value));
    if (state.scrollRecoveryBlocked === true) {
      for (const target of latest.scrollTargets ?? []) excludedScrollIdentities.add(target.identity);
    }
    const excludeFailedAttempt = attempt => {
      if (!attempt?.error) return;
      if (attempt.action !== "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity) excludedIdentities.add(attempt.targetIdentity);
      if (attempt.action === "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity && attempt.scrollProgressObserved !== true) excludedScrollIdentities.add(attempt.targetIdentity);
      if (attempt.action === "click" && (attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt)) && attempt.targetSignature) excludedTargetSignatures.push(attempt.targetSignature);
    };
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
      const profileFormCapabilities = createProfileFormWorkflowCapabilities({ session: this.session, environment: this.environment, applicationId });
      const callerCapabilities = Array.isArray(this.workflowCapabilities) ? this.workflowCapabilities : [];
      const searchInputRef = searchReadRequest ? availableSearchInputRef(workflowInputs) : null;
      const searchWorkflowCapabilities = searchReadRequest
        ? createObservedSearchWorkflowCapabilities({ observation: latest, session: this.session, inputRef: searchInputRef, query: searchReadRequest.query })
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
            environment: this.environment,
            principalId: this.principalId,
            goal: searchReadRequest?.resultRequest ?? goal
          })) ?? []
          : await this.capabilityService.createObservedReadWorkflowCapabilities?.({
          session: this.session,
          environment: this.environment,
          principalId: this.principalId,
          observation: latest,
          goal
        })
        : [];
      const thisSession = this.session;
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
            const searchVerified = await thisSession.verifySearchOutcome(searchReadRequest.query).catch(() => false);
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
      const executionRoute = selectTaskExecutionRoute({
        requestedPlannerMode: this.plannerMode,
        classifiedTask: taskRequest,
        trustedCapabilities: workflowCapabilities,
        taskResolution
      });
      if (searchReadRequest) {
        effectiveWorkflowIntent = taskResolution.status === "resolved" ? taskResolution.intent : null;
      } else if (taskResolution.status === "resolved") effectiveWorkflowIntent = taskResolution.intent;
      if (executionRoute.kind === "unresolved") {
        planner = new UnresolvedTaskRoutePlanner(
          `No trusted execution route can establish the requested outcome (${executionRoute.reasonCode}); no browser action was selected.`
        );
      } else {
        planner = new WorkflowGraphPlanner({
          synthesizer,
          capabilities: workflowCapabilities,
          knowledge: this.workflowKnowledge,
          inputs: effectiveWorkflowInputs,
          taskIntent: effectiveWorkflowIntent,
          decisionRuntime: this.decisionRuntime,
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          scope: { applicationId, environmentClass, principalId: this.workflowScope?.principalId ?? this.environment?.principalId ?? "unknown" },
          allowDeterministicShortcut: !taskRequest.explicitReadRequest && !taskRequest.compoundRequest && !taskRequest.typedWorkflowIntent
            && profileFormCapabilities.length === 0 && callerCapabilities.length === 0 && extractionCapabilities.length === 0,
          allowAtomicFallback: !taskRequest.explicitReadRequest && !taskRequest.compoundRequest && !taskRequest.typedWorkflowIntent,
          fallbackPlanner: new DeterministicPlanner()
        });
      }
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
    const recordTelemetryDispatch = async (attempt, actionType, dispatchStatus) => {
      attempt.dispatchStatus = dispatchStatus;
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
      return resultWithWorkflow({ status: "canceled", goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, uncertain: true, evidenceId: latest.evidenceId });
    };
    const canceledBeforeDispatch = async () => {
      state.status = "canceled";
      state.terminationReason = "The run was canceled before the pending action was dispatched; no browser input was sent.";
      await updateJournal();
      return resultWithWorkflow({ status: "canceled", goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    };
    const beginAction = async attempt => {
      state.pendingAction = attempt;
      await updateJournal();
    };
    const finishAction = attempt => {
      delete state.pendingAction;
      state.attempts.push(attempt);
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
      attempt.uncertainOutcome = true;
      attempt.completedAt = new Date().toISOString();
      finishAction(attempt);
      state.reconciliation = Object.freeze({
        reasonCode: "post_action_observation_unavailable",
        errorClass: observationErrorClass,
        observationAttempts,
        reattachFailureCode: REATTACH_FAILURE_CODES.has(error?.reattachFailureCode)
          ? error.reattachFailureCode : "not_attempted"
      });
      state.status = "unresolved";
      state.terminationReason = "The browser target or observation connection could not be re-established after one bounded read retry; no browser action was repeated. Reattach and resume from fresh evidence.";
      if (this.decisionRuntime?.recordReconciliationRequired && decisionEpisodeId && attempt.decisionId && attempt.operationId) {
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
    const observeAfterChange = async (timeoutMs, baseline, attempt = null) => {
      const reattachToSameTarget = async error => {
        const errorText = String(error?.message ?? error).toLocaleLowerCase();
        const detached = this.session.attached === false || ["detached", "closed"].includes(this.session.targetLifecycle)
          || /target.{0,24}(detached|closed)|(?:detached|closed).{0,24}target/u.test(errorText);
        if (!detached || typeof this.reattachSameTarget !== "function"
          || attempt?.action !== "click" || attempt?.dispatchStatus !== "dispatched") {
          if (error && typeof error === "object") error.observationAttempts = 1;
          throw error;
        }

        let replacement;
        try {
          const originalTarget = this.session.target;
          replacement = await this.reattachSameTarget({
            targetId: originalTarget?.id,
            endpoint: originalTarget?.reattachEndpoint ?? originalTarget?.endpoint ?? "local-cdp",
            environment: this.environment,
            selectionGoal: goal
          });
          const nextSession = replacement?.session;
          const observation = replacement?.observation;
          const targetId = originalTarget?.id;
          const endpointValue = originalTarget?.reattachEndpoint ?? originalTarget?.endpoint ?? "local-cdp";
          const replacementEndpointValue = nextSession?.target?.reattachEndpoint ?? nextSession?.target?.endpoint ?? "local-cdp";
          const endpoint = (() => { try { return new URL(endpointValue).origin; } catch { return endpointValue; } })();
          const replacementEndpoint = (() => { try { return new URL(replacementEndpointValue).origin; } catch { return replacementEndpointValue; } })();
          if (!nextSession || nextSession.attached !== true || nextSession.target?.id !== targetId
            || replacementEndpoint !== endpoint || observation?.targetId !== targetId) {
            throw Object.assign(new Error("Same-target reattachment did not return a fresh observation from the exact leased target."), {
              reattachFailureCode: "reattach_identity_mismatch"
            });
          }
          let observedUrl;
          try { observedUrl = new URL(observation.page?.url ?? ""); }
          catch { throw Object.assign(new Error("Same-target reattachment returned an invalid observed page URL."), { reattachFailureCode: "target_scope_rejected" }); }
          const allowedOriginValues = Array.isArray(this.environment?.authorizedOrigins)
            ? this.environment.authorizedOrigins
            : [originalTarget?.url ?? latest?.page?.url];
          const allowedOrigins = allowedOriginValues.map(normalizeOrigin).filter(Boolean);
          if (!allowedOrigins.includes(normalizeOrigin(observedUrl.origin)) || observedUrl.username || observedUrl.password) {
            throw Object.assign(new Error("Same-target reattachment observed a page outside the authorized environment."), { reattachFailureCode: "target_scope_rejected" });
          }
          if (typeof replacement.commit === "function") await replacement.commit();
          this.session = nextSession;
          try { await this.assertExecutionLease?.(); }
          catch (leaseError) {
            if (leaseError && typeof leaseError === "object") leaseError.reattachFailureCode ??= "lease_rebind_failed";
            throw leaseError;
          }
          attempt.reconnectedObservation = true;
          return observation;
        } catch (reattachError) {
          await replacement?.session?.close?.().catch(() => {});
          if (reattachError && typeof reattachError === "object") {
            reattachError.observationAttempts = 2;
            reattachError.reattachFailureCode ??= "unknown";
          }
          throw reattachError;
        }
      };

      try {
        await this.session.waitForChange(timeoutMs, baseline);
        return await this.session.observe({ selectionGoal: goal });
      } catch (firstError) {
        if (isAbortError(firstError)) throw firstError;
        const stillAttached = this.session.attached !== false
          && !["detached", "closed"].includes(this.session.targetLifecycle);
        if (!stillAttached) return await reattachToSameTarget(firstError);
        await new Promise(resolve => setTimeout(resolve, 100));
        throwIfAborted();
        try {
          const observation = await this.session.observe({ selectionGoal: goal });
          return observation;
        } catch (secondError) {
          const secondErrorText = String(secondError?.message ?? secondError).toLocaleLowerCase();
          const detachedAfterRetry = this.session.attached === false
            || ["detached", "closed"].includes(this.session.targetLifecycle)
            || /target.{0,24}(detached|closed)|(?:detached|closed).{0,24}target/u.test(secondErrorText);
          if (detachedAfterRetry) return await reattachToSameTarget(secondError);
          if (secondError && typeof secondError === "object") secondError.observationAttempts = 2;
          throw secondError;
        }
      }
    };
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
    const captureVisualObservation = async observation => {
      let visualObservation = observation;
      let imageEvidence = visualObservation?.visualEvidence ?? null;
      if (!imageEvidence) {
        try {
          visualObservation = await this.session.observe({ profile: "visual", prepareForJev: true, selectionGoal: goal });
          const retained = this.session.observer?.getEvidence?.(visualObservation.evidenceId, {
            facets: ["page"], includeScreenshot: true
          });
          imageEvidence = bindVisualEvidence(visualObservation, retained);
        } catch {
          imageEvidence = null;
        }
      }
      return { observation: visualObservation, imageEvidence };
    };
    const classifyAmbiguousPage = async observation => {
      const service = this.decisionRuntime?.visualDecisionService;
      if (!service || typeof service.classifyPage !== "function") return null;
      const decisionId = randomUUID();
      if (this.decisionRuntime?.jevClient?.allowImages !== true) {
        this.decisionRuntime.recordInferenceRoute?.({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(), decisionId,
          observationId: observation?.evidenceId, route: "deterministic", reasonCode: "image_permission_denied",
          providers: ["deterministic"], visualEvidenceUsed: false
        });
        this.decisionRuntime.recordReviewSkipped({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(), decisionId,
          observation, operation: "visual_assessment", operationClass: "read", targetRole: "browser_page",
          expectedOutcomeClass: "page_classification", reasonCode: "image_permission_denied"
        });
        return { assessment: { status: "skipped", failureCode: "image_permission_denied", authorizesOperation: false }, observation, imageEvidence: null };
      }
      const captured = await captureVisualObservation(observation);
      if (!captured.imageEvidence) {
        this.decisionRuntime.recordInferenceRoute?.({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(), decisionId,
          observationId: captured.observation?.evidenceId, route: "deterministic", reasonCode: "visual_evidence_unavailable",
          providers: ["deterministic"], visualEvidenceUsed: false
        });
        this.decisionRuntime.recordReviewSkipped({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(), decisionId,
          observation: captured.observation ?? observation, operation: "visual_assessment", operationClass: "read",
          targetRole: "browser_page", expectedOutcomeClass: "page_classification", reasonCode: "visual_evidence_unavailable"
        });
        return { assessment: { status: "skipped", failureCode: "visual_evidence_unavailable", authorizesOperation: false }, ...captured };
      }
      const assessment = await service.classifyPage({ ...captured.observation, visualEvidence: captured.imageEvidence }, {
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId: decisionStepId(),
        decisionId,
        imageEvidence: captured.imageEvidence,
        signal: abortSignal
      });
      return { assessment, ...captured };
    };
    const groundAmbiguousTarget = async (observation, deterministicPlan, targetRoleCode) => {
      const service = this.decisionRuntime?.visualDecisionService;
      if (!service || typeof service.groundTarget !== "function") return null;
      const allowedCandidateIds = (deterministicPlan?.candidates ?? []).map(candidate => candidate.identity);
      if (allowedCandidateIds.length < 2 || !targetRoleCode) return null;
      const decisionId = randomUUID();
      const stepId = decisionStepId();
      const captured = await captureVisualObservation(observation);
      if (!captured.imageEvidence) {
        this.decisionRuntime?.recordInferenceRoute?.({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId, decisionId,
          observationId: captured.observation?.evidenceId ?? observation.evidenceId,
          route: "deterministic", reasonCode: "visual_evidence_unavailable",
          providers: ["deterministic"], visualEvidenceUsed: false
        });
        this.decisionRuntime?.recordReviewSkipped?.({
          episodeId: decisionEpisodeId, runId: decisionRunId, stepId, decisionId,
          observation: captured.observation ?? observation,
          operation: "visual_target_grounding", operationClass: "read", targetRole: "visual_target",
          expectedOutcomeClass: "target_grounding", reasonCode: "visual_evidence_unavailable"
        });
        return { assessment: { status: "skipped", failureCode: "visual_evidence_unavailable", authorizesOperation: false }, grounding: null, ...captured };
      }
      const assessment = await service.groundTarget({ ...captured.observation, visualEvidence: captured.imageEvidence }, {
        episodeId: decisionEpisodeId,
        runId: decisionRunId,
        stepId,
        decisionId,
        targetRoleCode,
        allowedCandidateIds,
        imageEvidence: captured.imageEvidence,
        signal: abortSignal
      });
      // Inference may take long enough for the page to change. Reobserve and
      // resolve the suggested identity again before offering it to the normal
      // policy and authorized-execution path. Reobserve after failed or
      // abstaining requests too, so a later GLM fallback sees current evidence.
      const freshObservation = await this.session.observe({ selectionGoal: goal });
      const candidate = assessment?.status === "reviewed" && assessment.grounding?.status === "grounded"
        ? revalidateVisualGrounding(assessment.grounding, freshObservation)
        : null;
      if (!candidate) return {
        assessment: assessment?.status === "reviewed" && assessment.grounding?.status === "grounded" ? {
          ...assessment,
          grounding: {
            status: "unavailable",
            reasonCode: "stale_after_inference",
            advisoryOnly: true,
            authorizesOperation: false
          }
        } : assessment,
        grounding: null,
        imageEvidence: captured.imageEvidence,
        observation: freshObservation
      };
      if (candidate) {
        this.decisionRuntime?.recordTargetResolution?.({
          episodeId: decisionEpisodeId,
          runId: decisionRunId,
          stepId,
          decisionId,
          observationId: freshObservation.evidenceId,
          resolver: "jev_box_candidate_intersection",
          roleMappings: [{ role: targetRoleCode, candidateRef: candidate.identity }],
          reasonCode: "advisory_box_matched_fresh_candidate",
          evidenceRefs: [captured.observation.evidenceId, freshObservation.evidenceId],
          inputEventIds: assessment.inputEventIds ?? []
        });
      }
      return {
        assessment,
        grounding: assessment.grounding,
        candidate,
        imageEvidence: captured.imageEvidence,
        observation: freshObservation
      };
    };
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
        scrollActionsUsed++;
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
      recoveries++;
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
      const workflow = await this.workflowStore.find(goal, latest);
      if (workflow) {
        const scrollSteps = workflow.steps.filter(step => step.action === "scroll").length;
        if (workflow.steps.length <= this.maxActions - state.attempts.length && scrollSteps <= this.maxScrolls - scrollActionsUsed) {
          workflowReplay.status = "replaying";
          let stale = false;
          for (const step of workflow.steps) {
            if (routeFingerprint(latest.page.url) !== step.routeFingerprint) { stale = true; break; }
            if (step.action === "scroll") {
              const beforePositionFraction = latest.scrollTargets
                ?.filter(target => matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true)
                .map(scrollPositionFraction)
                .find(Number.isFinite);
              if (!scrollPositionMatches(beforePositionFraction, step.beforePositionFraction) ||
                  visibleCandidatesFingerprint(latest) !== step.beforeCandidatesFingerprint) { stale = true; break; }
              const scrollMatches = (latest.scrollTargets ?? []).filter(target =>
                matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true
              );
              if (scrollMatches.length !== 1) { stale = true; break; }
              const target = scrollMatches[0];
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
              await beginAction(attempt);
              await reserveTelemetryOperation(attempt, "scroll");
              try {
                throwIfAborted();
                await dispatchThroughAuthorizedExecutor(this.session, {
                  environment: this.environment,
                  localFixture: this.localFixture,
                  assertExecutionLease: this.assertExecutionLease,
                  sameTargetNavigation: this.sameTargetNavigation,
                  goal,
                  action: "scroll",
                  candidate: target
                });
              }
              catch (error) {
                if (isAbortError(error)) return await canceledWithPendingAction(attempt);
                attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
                attempt.dispatchStatus = error.dispatchStatus ?? "failed";
              }
              await recordTelemetryDispatch(attempt, "scroll", attempt.error ? (attempt.dispatchStatus ?? "failed") : "dispatched");
              try {
                latest = await observeAfterChange(1_500, waitBaseline);
              } catch (error) {
                workflowReplay.actions++;
                if (isAbortError(error)) return await canceledWithPendingAction(attempt);
                workflowReplay.status = "interrupted";
                return await stopAfterObservationLoss(attempt, error);
              }
              throwIfAborted();
              const afterStateFingerprint = observationStateFingerprint(latest);
              const afterScrollMatches = (latest.scrollTargets ?? []).filter(item => matchesScrollTargetSignature(item, step.scrollTarget));
              const afterTarget = afterScrollMatches.length === 1 ? afterScrollMatches[0] : undefined;
              const afterPositionFraction = scrollPositionFraction(afterTarget);
              const afterCandidatesFingerprint = visibleCandidatesFingerprint(latest);
              const moved = Boolean(afterTarget && afterTarget.scrollTop > Number(target.scrollTop ?? 0) + 2);
              attempt.afterStateFingerprint = afterStateFingerprint;
              attempt.scrollTopAfter = afterTarget?.scrollTop ?? null;
              attempt.scrollProgressObserved = moved;
              attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
              attempt.afterEvidenceId = latest.evidenceId;
              attempt.completedAt = new Date().toISOString();
              await recordTelemetryObservation(attempt, moved, attempt.error ? "scroll_failed_state_observed" : moved ? "scroll_progress_observed" : "scroll_no_progress_observed");
              finishAction(attempt);
              workflowReplay.actions++;
              scrollActionsUsed++;
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
              const afterMatchesTrace = !attempt.error && moved &&
                afterCandidatesFingerprint === step.afterCandidatesFingerprint &&
                scrollPositionMatches(afterPositionFraction, step.afterPositionFraction);
              if (!afterMatchesTrace) {
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
            const matches = latest.candidates.filter(candidate => matchesTargetSignature(candidate, step.target));
            if (matches.length !== 1) { stale = true; break; }
            const target = matches[0];
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
            await beginAction(attempt);
            await reserveTelemetryOperation(attempt, "click");
            try {
              throwIfAborted();
              await dispatchThroughAuthorizedExecutor(this.session, {
                environment: this.environment,
                localFixture: this.localFixture,
                assertExecutionLease: this.assertExecutionLease,
                sameTargetNavigation: this.sameTargetNavigation,
                goal,
                action: "click",
                candidate: target
              });
            } catch (error) {
              if (isAbortError(error)) return await canceledWithPendingAction(attempt);
              attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
              attempt.dispatchStatus = error.dispatchStatus ?? "failed";
            }
            await recordTelemetryDispatch(attempt, "click", attempt.error ? (attempt.dispatchStatus ?? "failed") : "dispatched");
            excludedIdentities.add(target.identity);
            try {
              latest = await observeAfterChange(2_000, waitBaseline, attempt);
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
            if (attempt.error || afterStateFingerprint === beforeStateFingerprint) { stale = true; break; }
          }
          if (workflowReplay.actions === workflow.steps.length && !await outcomeVerified()) stale = true;
          if (stale) {
            await this.workflowStore.invalidate(goal, state.initialUrlFingerprint);
            if (workflowReplay.actions > 0) {
              recoveries++;
              state.recoveryCount = recoveries;
              workflowReplay.status = "repairing";
              await updateJournal();
            } else workflowReplay.status = "stale";
          } else if (workflowReplay.actions === workflow.steps.length) {
            workflowReplay.status = "replayed";
            return await succeed();
          }
        } else workflowReplay.status = "budget-skipped";
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
      const filterPlanningObservation = observation => ({
        ...observation,
        candidates: (observation.candidates ?? []).filter(candidate =>
          (!excludedIdentities.has(candidate.identity) || (searchPhrase && isSearchFieldCandidate(candidate, latest))) &&
          !excludedTargetSignatures.some(signature => matchesTargetSignature(candidate, signature))
        ),
        scrollTargets: (observation.scrollTargets ?? []).filter(target => !excludedScrollIdentities.has(target.identity))
      });
      let planningObservation = filterPlanningObservation(latest);
      const candidateCoverage = latest.candidateCoverage;
      const scopeNeedsExpansion = workflowModeActive
        && !candidateExpansionAttempted
        && latest.observationProfile === "interaction"
        && candidateCoverage?.selectionScope === "task_relevant_region"
        && candidateCoverage.scopeCoverage === "incomplete"
        && Number.isInteger(candidateCoverage.scopeCandidateCount)
        && candidateCoverage.scopeCandidateCount > (candidateCoverage.returnedScopeCandidateCount ?? 0)
        && candidateCoverage.scopeCandidateCount <= 384;
      if (scopeNeedsExpansion) {
        candidateExpansionAttempted = true;
        const previousEvidenceId = latest.evidenceId;
        try {
          const expandedObservation = await this.session.observe({
            profile: "interaction",
            selectionGoal: goal,
            candidateLimit: 384
          });
          if (expandedObservation?.evidenceId !== previousEvidenceId
            && expandedObservation?.targetId === this.session.target.id) {
            latest = expandedObservation;
            planningObservation = filterPlanningObservation(latest);
          }
        } catch {
          // Keep the incomplete evidence; synthesis will abstain before dispatch.
        }
      }
      if ((this.plannerMode !== "auto" && planner?.requiresScreenshot === true) || this.decisionRuntime?.requiresScreenshot === true) {
        latest = await this.session.observe({
          profile: "visual",
          prepareForJev: true,
          selectionGoal: goal,
          candidateLimit: candidateExpansionAttempted ? 384 : 200
        });
        planningObservation = {
          ...latest,
          candidates: (latest.candidates ?? []).filter(candidate =>
            (!excludedIdentities.has(candidate.identity) || (searchPhrase && isSearchFieldCandidate(candidate, latest))) &&
            !excludedTargetSignatures.some(signature => matchesTargetSignature(candidate, signature))
          ),
          scrollTargets: (latest.scrollTargets ?? []).filter(target => !excludedScrollIdentities.has(target.identity))
        };
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
      try {
        const previousScrollStates = [...scrollConvergenceStates.entries()].map(([identity, data]) => ({
          identity,
          matchingCandidateCount: data.matchingCandidateCount,
          scrollActionsUsed: data.scrollActionsUsed
        }));
        const planningOptions = { excludedIdentities: [...excludedIdentities], excludedScrollIdentities: [...excludedScrollIdentities], maxScrolls: this.maxScrolls, scrollActionsUsed, previousScrollStates, signal: abortSignal, inputBindings };
        if (workflowModeActive || this.plannerMode !== "auto") {
          if (this.plannerMode === "model" && planner?.plannerRole) {
            const visualEvidenceUsed = planner.requiresScreenshot === true
              && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence);
            modelPlannerDecisionId = randomUUID();
            this.decisionRuntime?.recordInferenceRoute?.({
              episodeId: decisionEpisodeId,
              runId: decisionRunId,
              stepId: decisionStepId(),
              decisionId: modelPlannerDecisionId,
              observationId: planningObservation.evidenceId,
              route: "semantic_only",
              reasonCode: "explicit_model_planner",
              providers: ["secondary"],
              visualEvidenceUsed
            });
          }
          plan = await planner.plan(goal, planningObservation, planningOptions);
        } else if (explicitReadWorkflowRequest && resumeState) {
          const decisionId = randomUUID();
          this.decisionRuntime?.recordInferenceRoute?.({
            episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
            decisionId, observationId: planningObservation.evidenceId,
            route: "abstain", reasonCode: "read_output_not_retained_for_resume",
            providers: ["deterministic"], visualEvidenceUsed: false
          });
          plan = {
            status: "ambiguous",
            candidates: [],
            reason: "Read-only extraction output is not retained in task continuation state; start a new task to rebuild it from fresh evidence. No browser action was selected."
          };
        } else {
          let localPlan = await this.deterministicPlanner.plan(goal, planningObservation, planningOptions);
          if (searchPhrase) {
            const routeDecisionId = randomUUID();
            this.decisionRuntime?.recordInferenceRoute?.({
              episodeId: decisionEpisodeId,
              runId: decisionRunId,
              stepId: decisionStepId(),
              decisionId: routeDecisionId,
              observationId: planningObservation.evidenceId,
              route: "deterministic",
              reasonCode: "caller_bound_search_primitive",
              providers: ["deterministic"],
              visualEvidenceUsed: false
            });
            plan = localPlan;
          } else {
          const rawTargetRoleCode = goalExpectation(goal).targetTokens.slice(0, 10).join("_");
          const targetRoleCode = /^[a-z0-9][a-z0-9_]{0,95}$/u.test(rawTargetRoleCode) ? rawTargetRoleCode : "";
          const visualAssessmentAvailable = this.decisionRuntime?.jevClient?.allowImages === true
            && typeof this.decisionRuntime?.visualDecisionService?.classifyPage === "function";
          const visualGroundingAvailable = this.decisionRuntime?.jevClient?.allowImages === true
            && typeof this.decisionRuntime?.visualDecisionService?.groundTarget === "function"
            && targetRoleCode.length > 0;
          const route = selectAutomaticNavigationRoute({
            goal,
            deterministicPlan: localPlan,
            intentShape: effectiveWorkflowIntent?.cardinality ?? "unknown",
            semanticAvailable: this.secondaryPlannerAvailable,
            visualAssessmentAvailable,
            visualGroundingAvailable
          });
          const routeDecisionId = randomUUID();
          if (route.route === "deterministic" || route.route === "abstain") {
            this.decisionRuntime?.recordInferenceRoute?.({
              episodeId: decisionEpisodeId,
              runId: decisionRunId,
              stepId: decisionStepId(),
              decisionId: routeDecisionId,
              observationId: planningObservation.evidenceId,
              route: route.route,
              reasonCode: route.reasonCode,
              providers: route.providers,
              visualEvidenceUsed: route.visualEvidenceUsed
            });
          }
          if (route.route === "deterministic") {
            plan = localPlan;
          } else if (route.route === "abstain") {
            plan = {
              status: "ambiguous",
              candidates: localPlan.candidates ?? [],
              expected: localPlan.expected,
              reason: "The task has no trusted atomicity contract and no configured secondary planner is available; no browser action was selected."
            };
          } else if (route.route === "jev_only") {
            routedVisualReview = route.reasonCode === "ambiguous_visual_target_grounding"
              ? await groundAmbiguousTarget(planningObservation, localPlan, targetRoleCode)
              : await classifyAmbiguousPage(planningObservation);
            if (routedVisualReview?.observation?.evidenceId) {
              latest = routedVisualReview.observation;
              planningObservation = filterPlanningObservation(latest);
              if (routedVisualReview.imageEvidence) {
                planningObservation.visualEvidence = routedVisualReview.imageEvidence;
                planningObservation.screenshotBase64 = routedVisualReview.imageEvidence.screenshotBase64;
              }
              localPlan = await this.deterministicPlanner.plan(goal, planningObservation, planningOptions);
            }
            if (routedVisualReview?.candidate && routedVisualReview.grounding?.status === "grounded") {
              plan = {
                status: "planned",
                action: { type: "click", target: routedVisualReview.candidate },
                expected: localPlan.expected,
                confidence: Math.min(0.95, routedVisualReview.grounding.scores.boxConfidence, routedVisualReview.grounding.scores.presenceProbability),
                reasoning: "Jev visually grounded one candidate already selected by deterministic matching; the exact identity was freshly re-resolved before policy admission."
              };
            }
            const pageAnswer = routedVisualReview?.assessment?.answers?.page_state;
            visualHandoffSuggested = ["login", "challenge"].includes(pageAnswer?.choice)
              && (pageAnswer.probabilities?.[pageAnswer.choice] ?? 0) >= 0.8;
            if (plan?.status === "planned") {
              // The advisory grounding selected only among current observed
              // candidates. The common action policy and executor still gate it.
            } else if (visualHandoffSuggested || !this.secondaryPlannerAvailable) {
              plan = {
                ...localPlan,
                status: "ambiguous",
                reason: visualHandoffSuggested
                  ? "Visual assessment recommends a manual handoff for the apparent authentication or challenge state; no action was dispatched."
                  : localPlan.reason
              };
            } else {
              const escalationId = randomUUID();
              this.decisionRuntime?.recordInferenceRoute?.({
                episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
                decisionId: escalationId, observationId: planningObservation.evidenceId,
                route: "semantic_only", reasonCode: "visual_state_did_not_resolve_navigation",
                providers: ["secondary"], visualEvidenceUsed: this.planner.requiresScreenshot === true && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
              });
              if (this.planner.requiresScreenshot === true && !isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)) {
                const captured = await captureVisualObservation(planningObservation);
                latest = captured.observation;
                planningObservation = filterPlanningObservation(latest);
                if (captured.imageEvidence) {
                  planningObservation.visualEvidence = captured.imageEvidence;
                  planningObservation.screenshotBase64 = captured.imageEvidence.screenshotBase64;
                }
              }
              modelPlannerDecisionId = escalationId;
              plan = await this.planner.plan(goal, planningObservation, planningOptions);
            }
          } else {
            if (this.planner.requiresScreenshot === true) {
              const captured = await captureVisualObservation(planningObservation);
              latest = captured.observation;
              planningObservation = filterPlanningObservation(latest);
              if (captured.imageEvidence) {
                planningObservation.visualEvidence = captured.imageEvidence;
                planningObservation.screenshotBase64 = captured.imageEvidence.screenshotBase64;
              }
            }
            this.decisionRuntime?.recordInferenceRoute?.({
              episodeId: decisionEpisodeId, runId: decisionRunId, stepId: decisionStepId(),
              decisionId: routeDecisionId, observationId: planningObservation.evidenceId,
              route: route.route, reasonCode: route.reasonCode, providers: route.providers,
              visualEvidenceUsed: this.planner.requiresScreenshot === true
                && isBoundVisualEvidence(planningObservation, planningObservation.visualEvidence)
            });
            modelPlannerDecisionId = routeDecisionId;
            plan = await this.planner.plan(goal, planningObservation, planningOptions);
          }
          }
        }
      } catch (error) {
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
      await beginAction(attempt);
      await reserveTelemetryOperation(attempt, actionType);
      let dispatchOutcome = "dispatched";
      try {
        throwIfAborted(); // canceled before dispatch: no browser input was sent
        if (actionType === "scroll" && plan.action.direction !== "down") throw new Error("Only downward scroll actions are supported.");
        await dispatchThroughAuthorizedExecutor(this.session, {
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
        });
        if (actionType !== "scroll") excludedIdentities.add(selectedTarget.identity);
      } catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        dispatchOutcome = error.dispatchStatus ?? "failed";
        // Stale element recovery: if the failure is specifically a staleness
        // error and recovery budget allows, reobserve and retry once with a
        // freshly resolved target. Do not count this against maxRecoveries.
        const isStaleError = /stale|no longer exists|no longer visible|changed since observation/.test(String(error?.message ?? ""));
        if (isStaleError && !attempt.retriedAfterStale && recoveries <= this.maxRecoveries) {
          attempt.retriedAfterStale = true;
          const freshObservation = await this.session.observe({ selectionGoal: goal });
          const freshMatches = (freshObservation.candidates ?? []).filter(candidate =>
            candidate.visible === true && candidate.disabled !== true &&
            (candidate.name === selectedTarget.name || candidate.identity === selectedTarget.identity)
          );
          if (freshMatches.length === 1) {
            selectedTarget = freshMatches[0];
            excludedIdentities.delete(selectedTarget.identity);
            try {
              throwIfAborted();
              if (actionType === "scroll" && plan.action.direction !== "down") throw new Error("Only downward scroll actions are supported.");
              await dispatchThroughAuthorizedExecutor(this.session, {
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
              });
              dispatchOutcome = "dispatched";
              delete attempt.error;
              attempt.recoveredFromStale = true;
            } catch (retryError) {
              if (isAbortError(retryError)) return await canceledWithPendingAction(attempt);
              dispatchOutcome = retryError.dispatchStatus ?? "failed";
              attempt.error = { name: retryError.name, message: String(retryError.message).slice(0, 400) };
              attempt.dispatchStatus = retryError.dispatchStatus ?? "failed";
            }
          } else {
            dispatchOutcome = "failed";
            attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
          }
        } else {
          dispatchOutcome = "failed";
          attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
        }
        excludedIdentities.add(selectedTarget.identity);
      }
      await recordTelemetryDispatch(attempt, actionType, dispatchOutcome);
      try {
        latest = await observeAfterChange(actionType === "type" ? 500 : actionType === "scroll" ? 1_500 : 2_000, waitBaseline, attempt);
      } catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        return await stopAfterObservationLoss(attempt, error);
      }
      try { throwIfAborted(); }
      catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        throw error;
      }
      const afterStateFingerprint = observationStateFingerprint(latest);
      const afterSemanticFingerprint = observationSemanticFingerprint(latest);
      attempt.afterStateFingerprint = afterStateFingerprint;
      if (dispatchOutcome === "dispatched") attempt.dispatched = true;
      recordFailedTargetPresence(attempt, latest);
      excludeFailedAttempt(attempt);
      if (actionType === "scroll") {
        scrollActionsUsed++;
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
            latest = await observeAfterChange(2_500, waitBaseline);
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
      recoveries++;
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
