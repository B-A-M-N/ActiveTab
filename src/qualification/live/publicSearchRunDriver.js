import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchOwnedChrome } from "../../browser/ownedChrome.js";
import { BrowserSession } from "../../browser/session.js";
import { resolveAuthorizedTarget } from "../../browser/targets.js";
import { NavigationEngine } from "../../navigation/engine.js";
import { bindVisualEvidence } from "../../navigation/visualEvidence.js";
import { RunStateStore, acquireBrowserTargetLease } from "../../testing/runState.js";
import { buildEnvironmentBinding, normalizeOrigin } from "../../environments/model.js";
import { stateDirectory } from "../../extension/paths.js";
import { DecisionEventStore } from "../../telemetry/eventStore.js";
import { createDecisionRuntime } from "../../decisions/runtime.js";
import { preflightModelCapabilities, writeModelPreflightSummary } from "../../navigation/modelPreflight.js";
import { LiveSiteRequestBudget } from "./liveSiteRequestBudget.js";
import { liveQualificationReceiptPath, writeLiveQualificationReceipt } from "./liveEvidenceRecorder.js";
import { buildPublicSearchUrl, chooseNeutralTopic, publicSearchGoals, validatePublicSearchScenario } from "./publicSearchScenario.js";
import { verifyPublicSearchResult } from "./publicSearchResultVerifier.js";

export { verifyPublicSearchResult };

function sha256(value) { return createHash("sha256").update(String(value ?? "")).digest("hex"); }

function insidePath(pathname, prefixes) {
  return prefixes.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function resolvedResultHref(href, baseUrl) {
  let destination;
  try { destination = new URL(href, baseUrl); } catch { return null; }
  if (destination.origin === "https://duckduckgo.com" && destination.pathname === "/l/") {
    const encoded = destination.searchParams.get("uddg");
    if (!encoded) return null;
    try { destination = new URL(encoded); } catch { return null; }
  }
  return destination;
}

export function createPublicSearchAuthorizer(scenario, { maxActions = scenario.limits.maxActions, searchQuery = null } = {}) {
  const state = { actions: 0, scrolls: 0, navigations: 0, sameTargetNavigations: 0, searchQueries: 0 };
  const entryOrigin = scenario.entryOrigin;
  const admittedActions = new Set();
  return Object.freeze({
    operationId: "public_search_readonly_browse",
    state,
    authorizeSearchQuery({ query, url } = {}) {
      if (state.searchQueries !== 0 || typeof query !== "string" || query !== searchQuery || state.actions >= maxActions) {
        return { allowed: false, category: "public_search_query_denied" };
      }
      let expected;
      try { expected = buildPublicSearchUrl(scenario, { query }); } catch { return { allowed: false, category: "public_search_url_invalid" }; }
      if (url !== expected) return { allowed: false, category: "public_search_url_denied" };
      state.actions++;
      state.searchQueries++;
      return { allowed: true, category: "public_search_query" };
    },
    authorize({ operationId, action, candidate, observation } = {}) {
      if (operationId !== this.operationId) return { allowed: false, category: "public_search_operation_mismatch" };
      let current;
      try { current = new URL(observation?.page?.url ?? ""); } catch { return { allowed: false, category: "public_search_current_url_invalid" }; }
      if (action === "scroll") {
        const key = `scroll:${candidate?.identity ?? "unknown"}`;
        if (admittedActions.has(key)) return { allowed: true, category: "public_search_scroll" };
        if (state.actions >= maxActions) return { allowed: false, category: "public_search_action_limit" };
        admittedActions.add(key);
        state.actions++;
        state.scrolls++;
        return { allowed: true, category: "public_search_scroll" };
      }
      if (action !== "click" || String(candidate?.role ?? "").toLowerCase() !== "link" || typeof candidate.href !== "string") {
        return { allowed: false, category: "public_search_effect_denied" };
      }
      if (normalizeOrigin(current.href) !== entryOrigin || !insidePath(current.pathname, scenario.entryPathPrefixes)) {
        return { allowed: false, category: "public_search_source_scope_denied" };
      }
      const destination = resolvedResultHref(candidate.href, current.href);
      if (!destination || destination.protocol !== "https:" || destination.username || destination.password
        || destination.origin !== scenario.destinationOrigin
        || !insidePath(destination.pathname, scenario.destinationPathPrefixes)) {
        return { allowed: false, category: "public_search_destination_scope_denied" };
      }
      const key = `click:${candidate.identity ?? "unknown"}:${destination.origin}${destination.pathname}`;
      if (admittedActions.has(key)) return { allowed: true, category: "public_search_result_navigation" };
      if (state.actions >= maxActions) return { allowed: false, category: "public_search_action_limit" };
      admittedActions.add(key);
      state.actions++;
      state.navigations++;
      return { allowed: true, category: "public_search_result_navigation" };
    },
    recordDispatch({ operationId, action, dispatchResult, dispatchStatus } = {}) {
      if (operationId === this.operationId && action === "click" && dispatchResult?.navigationMode === "same_target" && dispatchStatus === "dispatched") {
        state.sameTargetNavigations++;
      }
    }
  });
}

function hasAdmittedWikipediaResult(observation, scenario) {
  return (observation?.candidates ?? []).some(candidate => {
    if (candidate?.visible !== true || String(candidate.role ?? "").toLowerCase() !== "link" || typeof candidate.href !== "string") return false;
    const destination = resolvedResultHref(candidate.href, observation?.page?.url);
    return destination?.origin === scenario.destinationOrigin && insidePath(destination.pathname, scenario.destinationPathPrefixes);
  });
}

async function waitForPublicSearchResult(session, scenario, { signal, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let observation = null;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error("The public search run was canceled.");
    observation = await session.observe({ profile: "interaction" });
    if (hasAdmittedWikipediaResult(observation, scenario)) return observation;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  return observation;
}

function buildSearchEnvironment(scenario) {
  return buildEnvironmentBinding({
    profile_id: scenario.authorizationProfileId,
    environment: {
      environment_id: `${scenario.siteId}-public-readonly`,
      application_entry_url: scenario.entryUrl,
      authorized_origins: [scenario.entryOrigin, scenario.destinationOrigin],
      applications: [{ application_id: scenario.siteId, authentication_realm: null, candidate_entry: new URL(scenario.entryUrl).pathname }]
    }
  });
}

export function summarizePublicQualificationEvents(events) {
  if (!Array.isArray(events)) throw new Error("Public qualification event summary requires an event list.");
  const routes = events.filter(event => event.eventType === "inference.route_selected");
  const attempts = events.filter(event => event.eventType === "inference.attempted");
  const plannerPredictions = events.filter(event => event.eventType === "planner.predicted");
  const plannerFailures = events.filter(event => event.eventType === "planner.failed");
  const jevPredictions = events.filter(event => event.eventType === "decision.predicted" && event.payload.provider === "openrouter");
  const reconciliations = events.filter(event => event.eventType === "execution.reconciliation_required");
  const verifications = events.filter(event => event.eventType === "verification.completed");
  return Object.freeze({
    eventCount: events.length,
    modelRoutes: routes.map(event => ({ route: event.payload.route, reasonCode: event.payload.reasonCode, providers: event.payload.providers, inputModality: event.payload.inputModality, visualEvidenceUsed: event.payload.visualEvidenceUsed })),
    physicalInferenceAttempts: attempts.length,
    inferenceTasks: attempts.map(event => ({ taskCode: event.payload.taskCode, attemptNumber: event.payload.attemptNumber })),
    plannerPredictions: plannerPredictions.map(event => ({ model: event.payload.model, resultCode: event.payload.resultCode, reasonCode: event.payload.reasonCode ?? null, actionType: event.payload.actionType ?? null, selectedCandidateFingerprint: event.payload.selectedCandidateFingerprint ?? null, inputModality: event.payload.inputModality, clientRequestId: event.payload.clientRequestId ?? null, providerLatencyMs: event.payload.providerLatencyMs ?? null, usage: event.payload.usage ?? null })),
    plannerFailures: plannerFailures.map(event => ({ model: event.payload.model, failureCode: event.payload.failureCode, inputModality: event.payload.inputModality, clientRequestId: event.payload.clientRequestId ?? null, providerLatencyMs: event.payload.providerLatencyMs ?? null })),
    jevPredictions: jevPredictions.map(event => ({ model: event.payload.model, rubricId: event.payload.rubricId, answer: event.payload.answer, usage: event.payload.usage ?? null })),
    executionReconciliations: reconciliations.map(event => ({
      operation: event.payload.operation,
      dispatchStatus: event.payload.dispatchStatus,
      reasonCode: event.payload.reasonCode,
      observationErrorClass: event.payload.observationErrorClass ?? null,
      observationAttempts: event.payload.observationAttempts ?? null,
      reattachFailureCode: event.payload.reattachFailureCode ?? null
    })),
    verificationResults: verifications.map(event => ({
      status: event.payload.status,
      oracleType: event.payload.oracleType,
      reasonCode: event.payload.reasonCode ?? null,
      verifiedCode: event.payload.verifiedCode ?? null
    }))
  });
}

function eventSummary(store, episodeId) {
  return summarizePublicQualificationEvents(store.getEvents(episodeId));
}

/** Keep task verification distinct from test-owned browser cleanup. */
export function publicSearchOutcome({ runtimeFailure = null, verification = null, cleanupStatus = "not_required" } = {}) {
  const succeeded = !runtimeFailure && verification?.status === "verified" && cleanupStatus === "verified";
  const outcomeStatus = succeeded ? "verified_success"
    : runtimeFailure?.code === "manual_intervention_required" ? "needs_human"
      : runtimeFailure?.code?.includes("access") || runtimeFailure?.code?.includes("rate") ? "site_access_error"
        : runtimeFailure ? "agent_error"
          : cleanupStatus !== "verified" ? "evaluator_error"
            : ["agent_error", "site_access_error", "evaluator_error", "needs_human", "inconclusive"].includes(verification?.status)
              ? verification.status : "inconclusive";
  const failureCode = succeeded ? null
    : runtimeFailure?.code ?? (cleanupStatus !== "verified" ? "owned_cleanup_unverified" : verification?.reasonCode ?? "live_search_unresolved");
  return Object.freeze({
    succeeded,
    outcomeStatus,
    failureCode,
    failureClass: succeeded ? "none" : outcomeStatus
  });
}

/** Runs a neutral, random public-web search through owned headed Chrome and the real configured inference routes. */
export async function runPublicSearchBrowseQualification(manifest, {
  explicitReadOnlyConfirmation = false,
  enableJevVisual = false,
  headed = true,
  launchBrowser = launchOwnedChrome,
  fetchImpl = globalThis.fetch,
  randomIntImpl,
  receiptDirectory = join(stateDirectory(), "live-site-qualification", "receipts"),
  rateBudgetPath = join(stateDirectory(), "live-site-qualification", "rate-limit.sqlite"),
  eventDatabasePath = join(stateDirectory(), "live-site-qualification", "decision-events.sqlite"),
  clock = () => Date.now()
} = {}) {
  const scenario = validatePublicSearchScenario(manifest);
  if (explicitReadOnlyConfirmation !== true) throw new Error("Public-web qualification requires explicit --confirm-readonly authorization.");
  if (headed !== true || process.env.ACTIVETAB_HEADLESS === "1") throw new Error("Public-web qualification requires headed Chrome; headless is limited to isolated pretests.");
  if (!process.env.ACTIVETAB_MODEL_ENDPOINT && process.env.ACTIVETAB_SEMANTIC_ENDPOINT) process.env.ACTIVETAB_MODEL_ENDPOINT = process.env.ACTIVETAB_SEMANTIC_ENDPOINT;
  if (!process.env.ACTIVETAB_MODEL_ENDPOINT || process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT !== "1") {
    throw new Error("Live AI qualification requires the configured inference gateway and ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1.");
  }
  if (enableJevVisual) process.env.ACTIVETAB_JEV_ALLOW_IMAGES = "1";
  const topic = chooseNeutralTopic(scenario.queryPoolId, randomIntImpl);
  const searchUrl = buildPublicSearchUrl(scenario, topic);
  const goals = publicSearchGoals(topic);
  const runId = randomUUID();
  const startedAt = clock();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), scenario.limits.maxDurationSeconds * 1_000);
  deadline.unref?.();
  let memoryPeak = process.memoryUsage().rss;
  const sampler = setInterval(() => { memoryPeak = Math.max(memoryPeak, process.memoryUsage().rss); }, 100);
  sampler.unref?.();
  const modelPreflight = await preflightModelCapabilities({ databasePath: eventDatabasePath });
  writeModelPreflightSummary(modelPreflight);
  const plannerConfig = modelPreflight.routes?.find(route => route.role === "planner")
    ?? modelPreflight.routes?.find(route => route.role === "semantic");
  if (!plannerConfig || plannerConfig.status === "unavailable") throw new Error("The configured secondary model route is unavailable according to launch preflight.");
  if (enableJevVisual && process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS !== "1") throw new Error("Jev visual qualification requires the separate screenshot privacy opt-in.");

  let budget;
  let owned;
  let runStore;
  let lease;
  let tempRunState;
  let eventStore;
  let runtime;
  let episodeId = null;
  let searchResult = null;
  let browseResult = null;
  let finalObservation = null;
  let verification = null;
  let jevAssessment = null;
  let documentRequestCount = 0;
  let observationCount = 0;
  let screenshotCount = 0;
  const cleanupDetails = { browserStopped: false, profileRemoved: false, leaseReleased: false, runStateRemoved: false, learningHistoryPreserved: true };
  let cleanupStatus = "not_required";
  let browserVersion = null;
  let environment = buildSearchEnvironment(scenario);
  const operationAuthorizer = createPublicSearchAuthorizer(scenario, { searchQuery: topic.query });
  let runtimeFailure = null;
  const trackedSessions = new WeakSet();
  const reattachedSessions = new Set();
  const trackSessionObservations = session => {
    if (!session || trackedSessions.has(session)) return;
    const originalObserve = session.observe.bind(session);
    session.observe = async options => {
      observationCount++;
      if (options?.profile === "visual" || options?.includeScreenshot === true || options?.prepareForJev === true) screenshotCount++;
      return await originalObserve(options);
    };
    trackedSessions.add(session);
  };
  const isAdmittedPageUrl = value => {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return (url.origin === scenario.entryOrigin && insidePath(url.pathname, scenario.entryPathPrefixes))
      || (url.origin === scenario.destinationOrigin && insidePath(url.pathname, scenario.destinationPathPrefixes));
  };

  try {
    budget = await new LiveSiteRequestBudget(rateBudgetPath).init();
    const browserSlot = budget.consume(scenario.siteId, { kind: "headed_browser_run", limit: scenario.limits.maxRequestsPerMinute, now: clock() });
    if (!browserSlot.allowed) throw Object.assign(new Error("The public search request budget is exhausted."), { code: browserSlot.reasonCode });
    const searchAdmission = operationAuthorizer.authorizeSearchQuery({ query: topic.query, url: searchUrl });
    if (!searchAdmission.allowed) throw Object.assign(new Error("The generated public search request was outside the scenario contract."), { code: searchAdmission.category });
    tempRunState = await mkdtemp(join(tmpdir(), "activetab-public-search-run-"));
    owned = await launchBrowser({ initialUrl: searchUrl, headed: true, displayMode: "current-display", signal: controller.signal, preserveProfile: false, reuseExisting: false });
    browserVersion = owned.browserVersion ?? null;
    if (!owned.session?.attached || !owned.session.target?.id) throw Object.assign(new Error("Owned headed Chrome did not produce an attached target."), { code: "live_target_unavailable" });
    trackSessionObservations(owned.session);
    const initial = await owned.session.observe({ profile: "interaction" });
    if (new URL(initial.page.url).origin !== scenario.entryOrigin || !insidePath(new URL(initial.page.url).pathname, scenario.entryPathPrefixes)) {
      throw Object.assign(new Error("The search engine redirected outside the explicitly admitted search origin."), { code: "search_engine_redirect_outside_scope" });
    }
    searchResult = { status: "succeeded", attempts: 1 };
    let resultsObservation = await waitForPublicSearchResult(owned.session, scenario, { signal: controller.signal });
    if (!hasAdmittedWikipediaResult(resultsObservation, scenario)) {
      searchResult = { status: "unresolved", attempts: 1 };
      throw Object.assign(new Error("The live search page did not expose an observed result in the admitted Wikipedia scope."), { code: "public_search_result_unavailable" });
    }
    runStore = new RunStateStore(tempRunState);
    await runStore.init();
    lease = await acquireBrowserTargetLease(runStore, owned.session, runId);
    eventStore = new DecisionEventStore({ databasePath: eventDatabasePath });
    runtime = createDecisionRuntime({ eventStore, maxInferenceAttempts: scenario.limits.maxModelAttempts });
    const episode = runtime.startEpisode({
      runId,
      workflowId: scenario.scenarioId,
      applicationId: scenario.siteId,
      environmentClass: "unknown",
      executionMode: "standalone",
      policyVersion: "public_search_readonly_v1"
    });
    episodeId = episode.episodeId;
    const sharedDecisionContext = { runId, episodeId, workflowId: scenario.scenarioId, sharedEpisode: true, stepPrefix: "public_search" };
    const reattachSameTarget = async ({ targetId, endpoint } = {}) => {
      const canonicalEndpoint = value => { try { return new URL(value).origin; } catch { return value; } };
      if (!owned?.chromeProcess || owned.chromeProcess.exitCode !== null) {
        throw Object.assign(new Error("The owned Chrome process stopped before target reattachment."), { reattachFailureCode: "owned_browser_stopped" });
      }
      if (targetId !== owned.targetId || targetId !== owned.session?.target?.id
        || canonicalEndpoint(endpoint) !== canonicalEndpoint(owned.endpoint)) {
        throw Object.assign(new Error("Public qualification may reattach only its original target and endpoint."), { reattachFailureCode: "target_scope_rejected" });
      }
      let session = null;
      let reattachFailureCode = "target_not_found";
      try {
        const target = await resolveAuthorizedTarget(owned.endpoint, targetId, targetId);
        if (!isAdmittedPageUrl(target.url)) {
          reattachFailureCode = "target_scope_rejected";
          throw new Error("The exact target is no longer on an admitted public search or Wikipedia route.");
        }
        session = new BrowserSession(target);
        trackSessionObservations(session);
        reattachedSessions.add(session);
        reattachFailureCode = "reattach_attach_failed";
        await session.attach();
        reattachFailureCode = "reattach_observation_failed";
        const observation = await session.observe({ profile: "interaction" });
        if (observation.targetId !== targetId || !isAdmittedPageUrl(observation.page?.url)) {
          reattachFailureCode = "reattach_identity_mismatch";
          throw new Error("The target changed identity or left the admitted public route during reattachment.");
        }
        return {
          session,
          observation,
          async commit() {
            try {
              await lease.bindSession(session);
              owned.session = session;
            } catch (error) {
              error.reattachFailureCode ??= "lease_rebind_failed";
              throw error;
            }
          }
        };
      } catch (error) {
        error.reattachFailureCode ??= reattachFailureCode;
        if (session) {
          reattachedSessions.delete(session);
          await session.close().catch(() => {});
        }
        throw error;
      }
    };
    const common = {
      environment,
      executionMode: "standalone",
      decisionRuntime: runtime,
      decisionContext: sharedDecisionContext,
      operationAuthorizer,
      assertExecutionLease: () => lease.assertCurrent(),
      reattachSameTarget,
      sameTargetNavigation: true,
      signal: controller.signal,
      maxRecoveries: 0,
      maxScrolls: 1
    };

    const jevImageEnabled = enableJevVisual && runtime.jevClient?.allowImages === true;
    if (enableJevVisual && jevImageEnabled) {
      const visualObservation = await owned.session.observe({ profile: "visual", prepareForJev: true });
      const retained = owned.session.observer?.getEvidence?.(visualObservation.evidenceId, { facets: ["page"], includeScreenshot: true });
      const imageEvidence = bindVisualEvidence(visualObservation, retained);
      resultsObservation = { ...visualObservation, ...(imageEvidence ? { visualEvidence: imageEvidence } : {}) };
      if (imageEvidence) {
        jevAssessment = await runtime.withInferenceBudget({ runId }, () => runtime.visualDecisionService.detectObstructions(resultsObservation, {
          episodeId, runId, stepId: "search_results_visual_gate", decisionId: randomUUID(), imageEvidence, signal: controller.signal
        }));
        const typeAnswer = jevAssessment?.answers?.obstruction_type;
        const obstructed = jevAssessment?.answers?.obstruction_present?.probabilityYes ?? 0;
        const stopForHuman = (typeAnswer?.choice === "challenge" || typeAnswer?.choice === "consent" || typeAnswer?.choice === "modal")
          && Math.max(obstructed, typeAnswer?.probabilities?.[typeAnswer.choice] ?? 0) >= 0.8;
        if (stopForHuman) throw Object.assign(new Error("Jev identified a likely challenge or blocking consent surface; the live run stopped without attempting to bypass it."), { code: "manual_intervention_required" });
      }
    } else if (enableJevVisual) {
      jevAssessment = { status: "skipped", failureCode: "jev_image_route_unavailable" };
    }
    await lease.assertCurrent();
    const modelPlanner = new NavigationEngine(owned.session, { ...common, plannerMode: "auto", maxActions: 2 });
    browseResult = await modelPlanner.run(goals.browse);
    if (browseResult.status !== "succeeded") throw Object.assign(new Error("The secondary model did not complete a fresh candidate-bound result selection."), { code: "model_browse_unresolved" });
    const inferenceEvents = eventStore.getEvents(episodeId);
    const successfulPlannerPrediction = inferenceEvents.find(event => event.eventType === "planner.predicted"
      && event.payload.provider === "secondary"
      && event.payload.resultCode === "planned");
    if (!successfulPlannerPrediction) throw Object.assign(new Error("The secondary model route returned no recorded, schema-validated candidate prediction."), { code: "secondary_model_prediction_missing" });
    const automaticSecondaryRoute = inferenceEvents.find(event => event.eventType === "inference.route_selected"
      && event.payload.route === "semantic_only"
      && event.payload.reasonCode === "intent_cardinality_unclassified"
      && event.payload.providers?.includes("secondary"));
    if (!automaticSecondaryRoute) throw Object.assign(new Error("The normal automatic router did not select the secondary model for the unclassified live task."), { code: "automatic_secondary_route_missing" });
    finalObservation = await owned.session.observe({ profile: "interaction" });
    documentRequestCount = owned.session.activity.snapshot().networkRequests.filter(request => request.resourceType === "Document").length;
    const attemptsBeforeVerify = inferenceEvents.filter(event => event.eventType === "inference.attempted").length;
    if (attemptsBeforeVerify < 1) throw Object.assign(new Error("No model invocation was recorded for the real search-results navigation."), { code: "model_not_invoked" });
    const verificationSlot = budget.consume(scenario.siteId, { kind: "independent_result_verification", limit: scenario.limits.maxRequestsPerMinute, now: clock() });
    verification = await verifyPublicSearchResult(scenario, topic, { ...finalObservation, reportedStatus: browseResult.status }, {
      fetchImpl,
      consumeRequest: () => verificationSlot,
      signal: controller.signal
    });
    if (verification.status !== "verified") throw Object.assign(new Error("The browser result did not match the independent public-page identity and search topic."), { code: verification.reasonCode ?? "result_verification_failed" });
    if (enableJevVisual && runtime.jevClient?.allowImages === true && !jevAssessment) jevAssessment = { status: "unavailable", failureCode: "visual_evidence_unavailable" };
  } catch (error) {
    runtimeFailure = error;
    if (owned?.session) {
      finalObservation = await owned.session.observe({ profile: "lightweight" }).catch(() => null);
      documentRequestCount = owned.session.activity.snapshot().networkRequests.filter(request => request.resourceType === "Document").length;
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(sampler);
    try {
      for (const session of reattachedSessions) await session.close().catch(() => {});
      if (owned) {
        const closeResult = await owned.close();
        cleanupDetails.browserStopped = closeResult?.browserPreserved === true
          || closeResult?.processStopped === true && closeResult?.error == null;
        cleanupDetails.profileRemoved = closeResult?.profileRemoved === true;
      }
    } catch { cleanupDetails.browserStopped = false; }
    try { await lease?.release(); cleanupDetails.leaseReleased = true; } catch { cleanupDetails.leaseReleased = false; }
    runStore?.close();
    try { if (tempRunState) { await rm(tempRunState, { recursive: true, force: true }); cleanupDetails.runStateRemoved = true; } } catch { cleanupDetails.runStateRemoved = false; }
    cleanupStatus = (!owned || cleanupDetails.browserStopped && cleanupDetails.profileRemoved)
      && (!lease || cleanupDetails.leaseReleased) && (!tempRunState || cleanupDetails.runStateRemoved) ? "verified" : "unverified";
  }

  const succeeded = !runtimeFailure && verification?.status === "verified" && cleanupStatus === "verified";
  if (runtime && episodeId) {
    const status = succeeded ? "passed" : runtimeFailure?.code === "manual_intervention_required" ? "suspended"
      : runtimeFailure?.code?.includes("access") || runtimeFailure?.code?.includes("rate") ? "blocked" : "uncertain";
    try { runtime.completeEpisode({ episodeId, runId, status, cleanupStatus: cleanupStatus === "verified" ? "verified" : "unknown" }); } catch { /* the primary receipt retains cleanup failure */ }
  }
  const modelHistory = eventStore && episodeId ? eventSummary(eventStore, episodeId) : {
    eventCount: 0, modelRoutes: [], physicalInferenceAttempts: 0, inferenceTasks: [], plannerPredictions: [], plannerFailures: [], jevPredictions: []
  };
  runtime?.close();
  const outcome = publicSearchOutcome({ runtimeFailure, verification, cleanupStatus });
  const result = Object.freeze({
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    siteId: scenario.siteId,
    runId,
    qualificationTier: scenario.qualificationTier,
    topicCode: topic.code,
    topicQuery: topic.query,
    topicFingerprint: sha256(topic.query),
    browserVersion,
    browserMode: { headed: true, displayMode: "current-display", linkDispatch: "same_target_navigation_inside_leased_target" },
    permissionScope: {
      origins: [scenario.entryOrigin, scenario.destinationOrigin],
      entryPathPrefixes: [...scenario.entryPathPrefixes],
      destinationPathPrefixes: [...scenario.destinationPathPrefixes],
      allowedEffects: [...scenario.allowedEffects],
      authentication: "anonymous",
      mutation: false
    },
    modelPreflight: modelPreflight.routes.map(route => ({ role: route.role, model: route.model, status: route.status, inputModalities: route.inputModalities, imageCapability: route.imageCapability })),
    ...modelHistory,
    jevVisualAssessment: jevAssessment ? { status: jevAssessment.status, failureCode: jevAssessment.failureCode ?? null, advisoryOnly: jevAssessment.authorizesOperation === false } : { status: "not_requested" },
    searchPhaseStatus: searchResult?.status ?? "not_started",
    browsePhaseStatus: browseResult?.status ?? "not_started",
    reconciliation: browseResult?.reconciliation ?? null,
    finalOrigin: finalObservation?.page?.url ? new URL(finalObservation.page.url).origin : null,
    finalPathFingerprint: finalObservation?.page?.url ? sha256(new URL(finalObservation.page.url).pathname) : null,
    verificationLevel: succeeded ? "cross_source_verified" : verification?.verificationLevel ?? "inconclusive",
    outcomeStatus: outcome.outcomeStatus,
    failureCode: outcome.failureCode,
    failureClass: outcome.failureClass,
    actionCount: operationAuthorizer.state.actions,
    actionDisposition: { ...operationAuthorizer.state, searchPhaseAttempts: searchResult?.attempts ?? 0, browsePhaseAttempts: browseResult?.attempts ?? 0 },
    observationCount,
    screenshotCount,
    observedDocumentRequestCount: documentRequestCount,
    elapsedMs: Math.max(0, clock() - startedAt),
    peakMemoryBytes: memoryPeak,
    cleanupStatus,
    cleanupDetails,
    cleanupVerified: cleanupStatus === "verified",
    learningHistory: {
      persistent: true,
      decisionEventDatabase: eventDatabasePath,
      episodeId,
      eventCount: modelHistory.eventCount,
      ephemeralBrowserProfile: cleanupDetails.profileRemoved ? "removed" : "not_removed"
    },
    ...(runtimeFailure ? { errorType: runtimeFailure.name ?? "Error" } : {}),
    ...(verification?.status === "verified" ? { independentVerification: verification } : {})
  });
  try {
    const path = liveQualificationReceiptPath(receiptDirectory, runId);
    const receipt = Object.freeze({ ...result, receiptPath: path });
    await writeLiveQualificationReceipt(receipt, { path });
    return receipt;
  } catch {
    return Object.freeze({ ...result, outcomeStatus: "evaluator_error", failureCode: "receipt_persistence_failed", failureClass: "evaluator_error" });
  }
}
