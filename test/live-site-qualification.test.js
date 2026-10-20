import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPublicSearchScenarios, loadPublicSearchScenario, validatePublicSearchScenario, chooseNeutralTopic, publicSearchGoals, buildPublicSearchUrl } from "../src/qualification/live/publicSearchScenario.js";
import { createPublicSearchAuthorizer, publicSearchOutcome, summarizePublicQualificationEvents, verifyPublicSearchResult } from "../src/qualification/live/publicSearchRunDriver.js";
import { LiveSiteRequestBudget } from "../src/qualification/live/liveSiteRequestBudget.js";
import { aggregateLiveSiteResults } from "../src/qualification/live/liveBenchmarkAggregator.js";
import { liveQualificationReceiptPath, writeLiveQualificationReceipt } from "../src/qualification/live/liveEvidenceRecorder.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { buildEpisode } from "../src/telemetry/episodeBuilder.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";

test("live public-search scenario is registered, bounded, and selects a neutral random topic", async () => {
  const scenarios = await listPublicSearchScenarios();
  assert.equal(scenarios.length, 1);
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  assert.equal(validatePublicSearchScenario(scenario).scenarioId, scenario.scenarioId);
  assert.equal(scenario.qualificationTier, "public_live_readonly");
  assert.deepEqual(scenario.allowedEffects, ["read", "navigate", "search_query", "scroll"]);
  assert.equal(scenario.limits.maxModelAttempts, 4);
  const manifestShape = { ...scenario };
  delete manifestShape.entryOrigin;
  assert.throws(() => validatePublicSearchScenario({ ...manifestShape, destinationOrigin: scenario.entryOrigin }), /distinct origin/);
  assert.throws(() => validatePublicSearchScenario({ ...manifestShape, destinationPathPrefixes: ["/wiki/", "/../admin/"] }), /traversal/);
  assert.throws(() => validatePublicSearchScenario({ ...manifestShape, cleanup: { kind: "delete_learning_history" } }), /preserve durable ActiveTab history/);
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 2);
  assert.equal(topic.code, "basalt-columns");
  assert.match(topic.query, /site:en\.wikipedia\.org$/u);
  const searchUrl = new URL(buildPublicSearchUrl(scenario, topic));
  assert.equal(searchUrl.origin, scenario.entryOrigin);
  assert.equal(searchUrl.pathname, scenario.searchPath);
  assert.equal(searchUrl.searchParams.get(scenario.searchQueryParameter), topic.query);
  assert.equal(publicSearchGoals(topic).search, `Search for ${topic.query}`);
  assert.equal(publicSearchGoals(topic).browse, "Open the basalt page on Wikipedia");
});

test("live qualification diagnostics preserve reconciliation codes without copying provider or page text", () => {
  const summary = summarizePublicQualificationEvents([
    {
      eventType: "execution.reconciliation_required",
      payload: {
        operation: "click",
        dispatchStatus: "dispatched",
        reasonCode: "post_action_observation_unavailable",
        observationErrorClass: "target_detached",
        observationAttempts: 2,
        reattachFailureCode: "target_not_found",
        providerMessage: "do not expose this",
        pageText: "private page details"
      }
    }
  ]);
  assert.deepEqual(summary.executionReconciliations, [{
    operation: "click",
    dispatchStatus: "dispatched",
    reasonCode: "post_action_observation_unavailable",
    observationErrorClass: "target_detached",
    observationAttempts: 2,
    reattachFailureCode: "target_not_found"
  }]);
  assert.equal(JSON.stringify(summary).includes("private page details"), false);
  assert.equal(JSON.stringify(summary).includes("do not expose this"), false);
});

test("read-only search authorizer permits only a real Wikipedia result from the admitted engine", async () => {
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 2);
  const authorizer = createPublicSearchAuthorizer(scenario, { searchQuery: topic.query });
  assert.equal(authorizer.authorizeSearchQuery({ query: topic.query, url: buildPublicSearchUrl(scenario, topic) }).allowed, true);
  assert.equal(authorizer.authorizeSearchQuery({ query: "other query", url: buildPublicSearchUrl(scenario, { query: "other query" }) }).allowed, false);
  const observation = { page: { url: scenario.entryUrl } };
  const directCandidate = { identity: "wikipedia-direct", role: "link", href: "https://en.wikipedia.org/wiki/Basalt" };
  const direct = authorizer.authorize({
    operationId: authorizer.operationId,
    action: "click",
    candidate: directCandidate,
    observation
  });
  assert.equal(direct.allowed, true);
  assert.equal(authorizer.authorize({
    operationId: authorizer.operationId,
    action: "click",
    candidate: directCandidate,
    observation
  }).allowed, true);
  const redirect = authorizer.authorize({
    operationId: authorizer.operationId,
    action: "click",
    candidate: { role: "link", href: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FBasalt" },
    observation
  });
  assert.equal(redirect.allowed, true);
  assert.equal(authorizer.authorize({ operationId: authorizer.operationId, action: "click", candidate: { role: "link", href: "https://example.com/" }, observation }).allowed, false);
  assert.equal(authorizer.authorize({ operationId: authorizer.operationId, action: "click", candidate: { role: "button", href: "https://en.wikipedia.org/wiki/Basalt" }, observation }).allowed, false);
  assert.equal(authorizer.authorize({ operationId: authorizer.operationId, action: "submit", candidate: {}, observation }).allowed, false);
  authorizer.recordDispatch({ operationId: authorizer.operationId, action: "click", dispatchResult: { navigationMode: "same_target" }, dispatchStatus: "dispatched" });
  assert.deepEqual(authorizer.state, { actions: 3, scrolls: 0, navigations: 2, sameTargetNavigations: 1, searchQueries: 1 });
});

test("search result outcome is independently checked against the fetched public page and random topic", async () => {
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 2);
  const observation = {
    page: { url: "https://en.wikipedia.org/wiki/Basalt" },
    headings: [{ level: 1, text: "Basalt" }],
    reportedStatus: "succeeded"
  };
  const verified = await verifyPublicSearchResult(scenario, topic, observation, {
    fetchImpl: async () => new Response("<html><title>Basalt - Wikipedia</title><h1>Basalt</h1></html>", {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" }
    })
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.verificationLevel, "cross_source_verified");
  assert.equal(verified.topicMatch, true);
  assert.match(verified.documentFingerprint, /^[a-f0-9]{64}$/u);

  const wrongTopic = await verifyPublicSearchResult(scenario, { ...topic, goalTarget: "jupiter", terms: ["jupiter"] }, observation, {
    fetchImpl: async () => new Response("<h1>Basalt</h1>", { status: 200, headers: { "content-type": "text/html" } })
  });
  assert.equal(wrongTopic.status, "agent_error");
  assert.equal(wrongTopic.falseSuccess, true);

  const oversized = await verifyPublicSearchResult(scenario, topic, observation, {
    fetchImpl: async () => new Response("x".repeat(1_000_001), { status: 200, headers: { "content-type": "text/html" } })
  });
  assert.equal(oversized.status, "evaluator_error");
  assert.equal(oversized.reasonCode, "independent_result_too_large");
});

test("independent verifier refuses out-of-scope URLs and exhausted request budgets before fetching", async () => {
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 2);
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount++;
    return new Response("<h1>Basalt</h1>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const outOfScope = await verifyPublicSearchResult(scenario, topic, {
    page: { url: "https://en.wikipedia.org/outside" },
    headings: [{ level: 1, text: "Basalt" }]
  }, { fetchImpl });
  assert.equal(outOfScope.status, "agent_error");
  assert.equal(outOfScope.reasonCode, "result_destination_outside_scope");
  assert.equal(fetchCount, 0);

  const exhaustedBudget = await verifyPublicSearchResult(scenario, topic, {
    page: { url: "https://en.wikipedia.org/wiki/Basalt" },
    headings: [{ level: 1, text: "Basalt" }]
  }, {
    fetchImpl,
    consumeRequest: () => ({ allowed: false, reasonCode: "live_site_request_rate_limited" })
  });
  assert.equal(exhaustedBudget.status, "site_access_error");
  assert.equal(exhaustedBudget.reasonCode, "live_site_request_rate_limited");
  assert.equal(fetchCount, 0);
});

test("honeybee search verification accepts its declared waggle-dance article title", async () => {
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 3);
  const observation = {
    page: { url: "https://en.wikipedia.org/wiki/Waggle_dance" },
    headings: [{ level: 1, text: "Waggle dance" }]
  };
  const verified = await verifyPublicSearchResult(scenario, topic, observation, {
    fetchImpl: async () => new Response("<title>Waggle dance</title><h1>Waggle dance</h1>", {
      status: 200, headers: { "content-type": "text/html" }
    })
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.topicMatch, true);
});

test("independent topic verification rejects a generic keyword without the full target phrase", async () => {
  const scenario = await loadPublicSearchScenario("public-search-wikipedia-001");
  const topic = chooseNeutralTopic(scenario.queryPoolId, () => 3);
  const observation = {
    page: { url: "https://en.wikipedia.org/wiki/Dance" },
    headings: [{ level: 1, text: "Dance" }],
    reportedStatus: "succeeded"
  };
  const result = await verifyPublicSearchResult(scenario, topic, observation, {
    fetchImpl: async () => new Response("<title>Dance</title><h1>Dance</h1>", {
      status: 200, headers: { "content-type": "text/html" }
    })
  });
  assert.equal(result.status, "agent_error");
  assert.equal(result.reasonCode, "result_does_not_match_search_topic");
  assert.equal(result.topicMatch, false);
  assert.equal(result.falseSuccess, true);
});

test("public search outcome never reports verified success when owned cleanup is unverified", () => {
  assert.deepEqual(publicSearchOutcome({
    verification: { status: "verified", verificationLevel: "cross_source_verified" },
    cleanupStatus: "unverified"
  }), {
    succeeded: false,
    outcomeStatus: "evaluator_error",
    failureCode: "owned_cleanup_unverified",
    failureClass: "evaluator_error"
  });
  assert.equal(publicSearchOutcome({
    verification: { status: "verified" }, cleanupStatus: "verified"
  }).outcomeStatus, "verified_success");
});

test("request budget persists across browser runs and applies a rolling limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-live-budget-"));
  const path = join(directory, "rate.sqlite");
  const first = await new LiveSiteRequestBudget(path).init();
  const now = 1_800_000_000_000;
  try {
    assert.equal(first.consume("duckduckgo-wikipedia", { kind: "browser_run", limit: 1, now }).allowed, true);
    const second = await new LiveSiteRequestBudget(path).init();
    try {
      assert.equal(second.consume("duckduckgo-wikipedia", { kind: "verification", limit: 1, now: now + 1 }).allowed, false);
      assert.equal(second.consume("duckduckgo-wikipedia", { kind: "verification", limit: 1, now: now + 60_001 }).allowed, true);
    } finally { second.close(); }
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("model planner predictions survive profile cleanup as durable, non-training-qualified experience", () => {
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore, maxInferenceAttempts: 1, jevClient: { async decide() { throw new Error("not used"); } }, semanticAnalyzer: null });
  const runId = "public_search_experience_test";
  const episode = runtime.startEpisode({ runId, workflowId: "public_search_test", applicationId: "duckduckgo_wikipedia", executionMode: "standalone" });
  try {
    assert.deepEqual(runtime.inferenceBudgetSnapshot(runId), { attempts: 0, maxAttempts: 1 });
    runtime.recordPlannerFailure({
      episodeId: episode.episodeId,
      runId,
      stepId: "failed_model_decision",
      decisionId: "failed_model_decision_1",
      observationId: "observation_1",
      model: "glm-5.3-flash",
      goal: "Open the Wikipedia result about auroras",
      failureCode: "http",
      inputModality: "text_plus_visual",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
      providerLatencyMs: 30000
    });
    runtime.recordPlannerPrediction({
      episodeId: episode.episodeId,
      runId,
      stepId: "browse_result",
      decisionId: "model_decision_1",
      observationId: "observation_1",
      model: "glm-5.3-flash",
      goal: "Open the Wikipedia result about basalt columns",
      candidateIdentity: "candidate-1",
      resultCode: "planned",
      actionType: "click",
      inputModality: "text_plus_visual",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174001",
      providerLatencyMs: 1450,
      usage: { prompt_tokens: 500, completion_tokens: 24, total_tokens: 524 }
    });
    const plannerEvents = eventStore.getEvents(episode.episodeId).filter(event => ["planner.failed", "planner.predicted"].includes(event.eventType));
    assert.equal(plannerEvents[0].payload.clientRequestId, "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(plannerEvents[0].payload.providerLatencyMs, 30000);
    assert.equal(plannerEvents[1].payload.clientRequestId, "123e4567-e89b-42d3-a456-426614174001");
    assert.equal(plannerEvents[1].payload.providerLatencyMs, 1450);
    assert.throws(() => runtime.recordPlannerFailure({
      episodeId: episode.episodeId,
      runId,
      stepId: "invalid_request_correlation",
      decisionId: "invalid_request_correlation_1",
      observationId: "observation_1",
      model: "glm-5.3-flash",
      goal: "Open the Wikipedia result about auroras",
      failureCode: "timeout",
      clientRequestId: "provider response text is not an id"
    }), /generated UUID/);
    const episodeData = buildEpisode(eventStore, episode.episodeId);
    assert.equal(episodeData.decisions.length, 1);
    assert.equal(episodeData.decisions[0].sourceType, "planner");
    assert.equal(episodeData.decisions[0].model.model, "glm-5.3-flash");
    assert.equal(episodeData.decisions[0].prediction.resultCode, "planned");
    assert.equal(episodeData.decisions[0].inputModality, "text_plus_visual");
    assert.equal(episodeData.decisions[0].trainingEligible, false);
    assert.equal(episodeData.decisions[0].inputLineageComplete, false);
    assert.deepEqual(episodeData.modelFailures.map(({ failureCode, inputModality }) => ({ failureCode, inputModality })), [{ failureCode: "http", inputModality: "text_plus_visual" }]);
  } finally { runtime.close(); }
});

test("live search receipts are owner-only, persistent, and aggregate outcomes separately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-live-receipt-"));
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const result = {
    schemaVersion: 1, scenarioId: "public-search-wikipedia-001", siteId: "duckduckgo-wikipedia", runId,
    qualificationTier: "public_live_readonly", outcomeStatus: "verified_success", verificationLevel: "cross_source_verified",
    learningHistory: { persistent: true, ephemeralBrowserProfile: "removed" }
  };
  try {
    const path = liveQualificationReceiptPath(directory, runId);
    await writeLiveQualificationReceipt(result, { path });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), result);
    const summary = aggregateLiveSiteResults([
      result,
      { ...result, runId: "223e4567-e89b-42d3-a456-426614174000", outcomeStatus: "site_access_error" },
      { ...result, runId: "323e4567-e89b-42d3-a456-426614174000", outcomeStatus: "agent_error" }
    ]);
    assert.equal(summary.counts.verified_success, 1);
    assert.equal(summary.counts.site_access_error, 1);
    assert.equal(summary.agentEligible, 2);
    assert.equal(summary.agentSuccessRate, 0.5);
    assert.equal(summary.coverageLimitations, 1);
    const withHumanHandoff = aggregateLiveSiteResults([{ ...result, outcomeStatus: "needs_human" }]);
    assert.equal(withHumanHandoff.counts.needs_human, 1);
    assert.equal(withHumanHandoff.agentEligible, 0);
    assert.equal(withHumanHandoff.coverageLimitations, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
