import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NavigationEngine } from "../src/navigation/engine.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { TestRunner } from "../src/testing/runner.js";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { clickObservedElement } from "../src/navigation/observedAction.js";
import { createRunStateFixture } from "./runStateFixture.js";

const fixtureLease = async () => {};
const visualFixtureBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

function fixtureSession({ includeVisualEvidence = false } = {}) {
  const candidate = { identity: "open-account", targetId: "telemetry-test-target", documentGeneration: 1, backendNodeId: 1, name: "Open account", role: "link", tag: "a", href: "/account", visible: true };
  return {
    target: { id: "telemetry-test-target", endpoint: "local-cdp", url: "https://shop.example.test/" },
    attached: true,
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [candidate],
      pageChangeFingerprint: "shop"
    },
    observations: 0,
    clicks: 0,
    async observe() {
      const evidenceId = `observation_${++this.observations}`;
      return {
        evidenceId,
        targetId: this.target.id,
        documentGeneration: 1,
        viewport: { width: 780, height: 437 },
        ...structuredClone(this.current),
        ...(includeVisualEvidence ? { visualEvidence: {
          evidenceId,
          targetId: this.target.id,
          documentGeneration: 1,
          viewport: { width: 780, height: 437 },
          screenshotBase64: visualFixtureBase64
        } } : {})
      };
    },
    async click() {
      this.clicks++;
      this.current = { page: { url: "https://shop.example.test/error", title: "Error" }, headings: [{ level: 1, text: "Error" }], candidates: [], pageChangeFingerprint: "error" };
    },
    async waitForChange() {}
  };
}

function planner() {
  let called = false;
  return {
    async plan(_goal, observation) {
      if (called) return { status: "ambiguous", reason: "fixture limit" };
      called = true;
      return { status: "planned", action: { type: "click", target: observation.candidates[0] } };
    }
  };
}

function successfulJev() {
  return {
    async decide() {
      return {
        model: JEV_MODEL_ID,
        answers: {
          intent_alignment: { type: "noul", probabilityYes: 0.94 },
          target_clarity: { type: "choice", choice: "clear", probabilities: { clear: 0.9, ambiguous: 0.08, insufficient: 0.02 } }
        },
        usage: { inputTokens: 90, outputTokens: 14 }
      };
    }
  };
}

function reviewRequiredJev({ allowImages = false } = {}) {
  return {
    allowImages,
    async decide() {
      return {
        model: JEV_MODEL_ID,
        answers: {
          intent_alignment: { type: "noul", probabilityYes: 0.42 },
          target_clarity: { type: "choice", choice: "ambiguous", probabilities: { clear: 0.18, ambiguous: 0.72, insufficient: 0.1 } }
        },
        usage: { inputTokens: 90, outputTokens: 14 }
      };
    }
  };
}

test("an unambiguous navigation skips model inference and records its policy and execution lineage", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let calls = 0;
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: { async decide() { calls++; return successfulJev().decide(); } }, semanticAnalyzer: null });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime, assertExecutionLease: fixtureLease }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const events = store.getEvents(episode.episode_id);
    const lifecycle = events.filter(event => [
      "decision.input_captured", "decision.predicted", "policy.adjudicated",
      "execution.reserved", "execution.dispatched", "execution.observed"
    ].includes(event.eventType));
    assert.deepEqual(lifecycle.map(event => event.eventType), [
      "policy.adjudicated",
      "execution.reserved", "execution.dispatched", "execution.observed"
    ]);
    assert.equal(calls, 0);
    assert.ok(events.some(event => event.eventType === "decision.skipped" && event.payload.reasonCode === "fresh_target_and_local_policy_sufficient"));
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.route === "deterministic"));
    assert.ok(lifecycle.every(event => event.decisionId === lifecycle[0].decisionId));
    assert.equal(lifecycle.at(-1).payload.changed, true);
    assert.equal(store.verifyEpisodeChain(episode.episode_id).ok, true);
  } finally {
    runtime.close();
  }
});

test("an unrecoverable post-action observation records typed reconciliation and never repeats the action", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  const observe = session.observe.bind(session);
  let postDispatchObservations = 0;
  session.observe = async (...args) => {
    if (session.clicks > 0) {
      postDispatchObservations++;
      throw new Error("CDP transport failed while reading https://private.example/account?token=do-not-record");
    }
    return await observe(...args);
  };
  session.navigateObservedLinkInSameTarget = async (target, { beforeDispatch } = {}) => {
    await beforeDispatch?.({ candidate: target, href: new URL(target.href, session.current.page.url).href, sameTargetNavigation: true });
    return await session.click(target);
  };
  try {
    const result = await new NavigationEngine(session, {
      planner: planner(),
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease,
      sameTargetNavigation: true,
      maxActions: 1,
      maxRecoveries: 0
    }).run("Open the account page");

    const episode = store.listEpisodes()[0];
    const events = store.getEvents(episode.episode_id);
    const reconciliation = events.find(event => event.eventType === "execution.reconciliation_required");
    assert.equal(result.status, "unresolved");
    assert.equal(result.attempts, 1);
    assert.equal(session.clicks, 1, JSON.stringify({ result, planner: session.clicks }));
    assert.equal(postDispatchObservations, 2);
    assert.deepEqual({
      reasonCode: reconciliation?.payload.reasonCode,
      dispatchStatus: reconciliation?.payload.dispatchStatus,
      observationErrorClass: reconciliation?.payload.observationErrorClass,
      observationAttempts: reconciliation?.payload.observationAttempts
    }, {
      reasonCode: "post_action_observation_unavailable",
      dispatchStatus: "dispatched",
      observationErrorClass: "cdp_transport",
      observationAttempts: 2
    });
    assert.equal(JSON.stringify(reconciliation.payload).includes("private.example"), false);
    assert.equal(JSON.stringify(reconciliation.payload).includes("do-not-record"), false);
    assert.equal(events.at(-1).eventType, "episode.completed");
    assert.equal(events.at(-1).payload.status, "uncertain");
  } finally {
    runtime.close();
  }
});

test("deterministic ambiguity requests one fresh visual classification but never acts on its answer", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  let calls = 0;
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: null,
    jevClient: {
      allowImages: true,
      async decide({ questions, imageEvidence }) {
        calls++;
        assert.ok(imageEvidence?.screenshotBase64);
        return {
          model: JEV_MODEL_ID,
          answers: {
            page_state: {
              type: "choice", choice: "loading",
              probabilities: { login: 0.01, authenticated_app: 0.01, loading: 0.92, error: 0.01, challenge: 0.01, modal: 0.01, unknown: 0.01 }
            },
            obstruction_present: { type: "noul", probabilityYes: 0.12 }
          }
        };
      }
    }
  });
  const session = {
    target: { id: "visual-ambiguity-target", endpoint: "local-cdp" },
    attached: true,
    observer: {
      getEvidence(evidenceId) {
        return {
          status: "available", evidenceId, targetId: "visual-ambiguity-target", documentGeneration: 2,
          viewport: { width: 780, height: 437 }, deviceScaleFactor: 1,
          coverage: { screenshot: true }, screenshotBase64
        };
      }
    },
    async observe(options = {}) {
      if (options.profile === "visual") {
        return {
          evidenceId: "visual_ambiguity_evidence", targetId: this.target.id, documentGeneration: 2,
          viewport: { width: 780, height: 437 }, page: { url: "https://shop.example.test/", title: "Shop", readyState: "complete" },
          candidates: [], candidateCount: 0, headings: []
        };
      }
      return {
        evidenceId: "structural_ambiguity_evidence", targetId: this.target.id, documentGeneration: 1,
        viewport: { width: 780, height: 437 }, page: { url: "https://shop.example.test/", title: "Shop", readyState: "complete" },
        candidates: [], candidateCount: 0, headings: []
      };
    },
    async click() { throw new Error("visual classification cannot authorize a click"); },
    async waitForChange() {}
  };
  try {
    const result = await new NavigationEngine(session, {
      decisionRuntime: runtime,
      planner: { async plan() { return { status: "ambiguous", reason: "No unique local target." }; } }
    }).run("Open the account page");
    assert.equal(result.status, "unresolved");
    assert.equal(result.visualAssessment.status, "reviewed");
    assert.equal(result.visualAssessment.pageState, "loading");
    assert.equal(result.visualAssessment.authorizesOperation, false);
    assert.equal(calls, 1);
    assert.equal(store.getEvents(store.listEpisodes()[0].episode_id).some(event => event.eventType === "verification.completed"), false);
  } finally { runtime.close(); }
});

test("automatic mode skips secondary inference for a unique match", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, semanticAnalyzer: null, jevClient: { async decide() { throw new Error("Jev should not be called"); } } });
  const session = fixtureSession();
  let secondaryCalls = 0;
  try {
    await new NavigationEngine(session, {
      plannerMode: "auto",
      workflowIntent: { cardinality: "atomic" },
      planner: { async plan() { secondaryCalls++; return { status: "ambiguous", reason: "should not run" }; } },
      maxActions: 1,
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease
    }).run("Open the account page");
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const route = store.getEvents(episode.episode_id).find(event => event.eventType === "inference.route_selected");
    assert.equal(secondaryCalls, 0);
    assert.equal(route.payload.route, "deterministic");
    assert.equal(route.payload.reasonCode, "unique_fresh_candidate");
    assert.equal(session.clicks, 1);
  } finally { runtime.close(); }
});

test("automatic mode calls the secondary model for unresolved candidate identity", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, semanticAnalyzer: null, jevClient: { async decide() { throw new Error("page-state Jev should not run for a candidate tie"); } } });
  let secondaryCalls = 0;
  const session = {
    target: { id: "auto-routing-target", endpoint: "local-cdp", url: "https://shop.example.test/" },
    attached: true,
    async observe() {
      return {
        evidenceId: "auto_candidate_ambiguity", targetId: this.target.id, documentGeneration: 1,
        viewport: { width: 1280, height: 720 },
        page: { url: this.target.url, title: "Shop" },
        headings: [{ level: 1, text: "Shop" }], scrollTargets: [],
        candidates: ["save_first", "save_second"].map(identity => ({
          identity, backendNodeId: identity === "save_first" ? 1 : 2,
          name: "Save", role: "button", tag: "button", visible: true, disabled: false
        }))
      };
    }
  };
  try {
    const result = await new NavigationEngine(session, {
      plannerMode: "auto",
      workflowIntent: { cardinality: "atomic" },
      planner: { async plan() { secondaryCalls++; return { status: "ambiguous", reason: "Need semantic context to choose" }; } },
      decisionRuntime: runtime
    }).run("Click Save");
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const routes = store.getEvents(episode.episode_id).filter(event => event.eventType === "inference.route_selected");
    assert.equal(result.status, "unresolved");
    assert.equal(secondaryCalls, 1);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].payload.route, "semantic_only");
    assert.equal(routes[0].payload.reasonCode, "deterministic_resolution_insufficient");
    assert.equal(routes[0].payload.visualEvidenceUsed, false);
  } finally { runtime.close(); }
});

test("secondary planner transport metadata is linked to the exact failed decision without storing provider text", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, semanticAnalyzer: null, jevClient: { async decide() { throw new Error("Jev should not run"); } } });
  const session = fixtureSession();
  const clientRequestId = "123e4567-e89b-42d3-a456-426614174000";
  const providerError = Object.assign(new Error("provider body and credential text must not be retained"), {
    kind: "timeout",
    clientRequestId,
    providerLatencyMs: 30000
  });
  try {
    const engine = new NavigationEngine(session, {
      executionMode: "standalone",
      plannerMode: "model",
      planner: {
        plannerRole: "standalone_action_proposer",
        model: "glm-5.3-flash",
        requiresScreenshot: false,
        async plan() { throw providerError; }
      },
      maxActions: 1,
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease
    });
    await assert.rejects(engine.run("Open the account page"), error => error === providerError);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    const failure = events.find(event => event.eventType === "planner.failed");
    assert.equal(failure.payload.clientRequestId, clientRequestId);
    assert.equal(failure.payload.providerLatencyMs, 30000);
    assert.equal(failure.payload.failureCode, "timeout");
    assert.equal(events.some(event => JSON.stringify(event).includes("provider body and credential text")), false);
    assert.equal(session.clicks, 0);
  } finally { runtime.close(); }
});

test("auto mode uses Jev Box grounding for a candidate tie, then re-resolves before authorized dispatch", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  let jevCalls = 0;
  const runtime = createDecisionRuntime({
    eventStore: store,
    semanticAnalyzer: null,
    jevClient: {
      allowImages: true,
      async decide({ state, questions, imageEvidence }) {
        jevCalls++;
        assert.equal(state.task_code, "target_grounding");
        assert.equal(state.target_role_code, "save");
        assert.ok(imageEvidence?.screenshotBase64);
        assert.equal(questions.target_box.type, "box");
        return {
          model: JEV_MODEL_ID,
          answers: {
            target_present: { type: "noul", probabilityYes: 0.96 },
            target_box: { type: "box", confidence: 0.93, box: { left: 0.18, top: 0.18, right: 0.42, bottom: 0.42 } }
          }
        };
      }
    }
  });
  const targetId = "visual_auto_target";
  let observations = 0;
  let clickedIdentity = null;
  let observationsAtClick = 0;
  const candidate = (identity, backendNodeId, x, y) => ({
    identity, targetId, documentGeneration: 1, backendNodeId, frameTargetId: null,
    name: "Save", role: "link", tag: "a", href: "/save", visible: true, disabled: false,
    bounds: { x, y, width: 100, height: 45 }
  });
  const session = {
    target: { id: targetId, endpoint: "local-cdp", url: "https://shop.example.test/" },
    attached: true,
    observer: {
      getEvidence(evidenceId) {
        return {
          status: "available", evidenceId, targetId, documentGeneration: 1,
          viewport: { width: 780, height: 437 }, deviceScaleFactor: 1,
          coverage: { screenshot: true }, screenshotBase64
        };
      }
    },
    async observe() {
      observations++;
      return {
        evidenceId: `visual_auto_observation_${observations}`,
        targetId,
        documentGeneration: 1,
        viewport: { width: 780, height: 437 },
        page: { url: this.target.url, title: "Shop", readyState: "complete" },
        headings: [{ level: 1, text: "Shop" }],
        scrollTargets: [],
        candidates: [candidate("save_first", 1, 170, 100), candidate("save_second", 2, 520, 300)]
      };
    },
    async click(selected) { clickedIdentity = selected.identity; observationsAtClick = observations; return { dispatched: true }; },
    async waitForChange() {}
  };
  try {
    const result = await new NavigationEngine(session, {
      plannerMode: "auto",
      workflowIntent: { cardinality: "atomic" },
      planner: { async plan() { throw new Error("GLM should not run after a uniquely grounded Jev result"); } },
      maxActions: 1,
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease
    }).run("Click Save");
    assert.equal(jevCalls, 1);
    assert.equal(clickedIdentity, "save_first", JSON.stringify({ result, observations, routeEvents: store.getEvents(store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id).episode_id).filter(event => event.eventType === "inference.route_selected").map(event => event.payload) }));
    assert.ok(observationsAtClick >= 4, "inference is followed by an explicit fresh observation before dispatch");
    assert.ok(observations > observationsAtClick, "the result is observed again after dispatch");
    assert.equal(result.attempts, 1);
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const events = store.getEvents(episode.episode_id);
    assert.ok(events.some(event => event.eventType === "target.resolved" && event.payload.resolver === "jev_box_candidate_intersection"));
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.reasonCode === "ambiguous_visual_target_grounding"));
    assert.equal(store.verifyEpisodeChain(episode.episode_id).ok, true);
  } finally { runtime.close(); }
});

test("automatic navigation invokes the configured secondary client after recording its route", async () => {
  const names = [
    "ACTIVETAB_MODEL_ENDPOINT", "ACTIVETAB_MODEL", "ACTIVETAB_MODEL_API_KEY",
    "ACTIVETAB_SEMANTIC_ENDPOINT", "ACTIVETAB_SEMANTIC_MODEL", "ACTIVETAB_SEMANTIC_API_KEY",
    "FREEINFERENCE_API_KEY", "ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT"
  ];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, semanticAnalyzer: null, jevClient: { async decide() { throw new Error("Jev should not handle candidate identity"); } } });
  const session = fixtureSession();
  session.current.candidates = [
    { ...session.current.candidates[0], identity: "account-one", name: "Account", contextName: null },
    { ...session.current.candidates[0], identity: "account-two", name: "Account", contextName: null }
  ];
  let calls = 0;
  try {
    for (const name of names) delete process.env[name];
    process.env.ACTIVETAB_SEMANTIC_ENDPOINT = "https://freeinference.example.test/v1";
    process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = "1";
    globalThis.fetch = async (url, options) => {
      calls++;
      const episodeId = store.listEpisodes()[0]?.episode_id;
      const events = store.getEvents(episodeId);
      const route = events.find(event => event.eventType === "inference.route_selected" && event.payload.route === "semantic_only");
      assert.ok(route, "selected secondary route is durable before the provider call");
      assert.equal(route.payload.reasonCode, "deterministic_resolution_insufficient");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "glm-5.3-flash");
      assert.equal(url, "https://freeinference.example.test/v1/chat/completions");
      const userPayload = JSON.parse(body.messages.find(message => message.role === "user").content);
      const observationId = userPayload.input.observationId;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        version: 1,
        observationId,
        decision: "select_candidate",
        candidateRef: "candidate_2",
        scrollRef: "",
        reasonCode: "selected_candidate"
      }) } }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const result = await new NavigationEngine(session, {
      executionMode: "standalone",
      plannerMode: "auto",
      workflowIntent: { cardinality: "atomic" },
      maxActions: 1,
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease
    }).run("Open the account page");
    assert.equal(calls, 1);
    assert.equal(session.clicks, 1);
    assert.equal(result.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("ordinary navigation does not require a Jev credential", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevOptions: { apiKey: "", apiKeyFile: "/__activetab_test_missing_jev_key__" },
    semanticAnalyzer: null
  });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime, assertExecutionLease: fixtureLease }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.equal(events.filter(event => event.eventType === "decision.failed").length, 0);
    assert.ok(events.some(event => event.eventType === "decision.skipped"));
    assert.equal(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"), true);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("ordinary navigation remains deterministic even when the Jev provider would refuse", async () => {
  let calls = 0;
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevClient: { async decide() { calls++; throw Object.assign(new Error("review declined"), { kind: "refusal" }); } },
    semanticAnalyzer: null
  });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime, assertExecutionLease: fixtureLease }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.equal(calls, 0);
    assert.equal(events.filter(event => event.eventType === "decision.failed" && event.payload.failureCode === "refusal").length, 0);
    assert.equal(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"), true);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("Jev disagreement suspends navigation before dispatch and cannot authorize the action", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev({ allowImages: true }), semanticAnalyzer: null });
  const session = fixtureSession({ includeVisualEvidence: true });
  session.current.candidates[0].submitsForm = true;
  try {
    const result = await new NavigationEngine(session, {
      planner: planner(), maxActions: 1, decisionRuntime: runtime, assertExecutionLease: fixtureLease,
      operationAuthorizer: {
        operationId: "qualified_submit",
        decisionContext: () => ({ operationClass: "test_owned_mutation", targetRole: "submit_button", reviewRequired: true }),
        async authorize() { return { allowed: true, category: "fixture_submit" }; }
      }
    }).run("Open the account page");
    assert.equal(result.status, "needs_human");
    assert.equal(result.authorizationRequired.category, "independent_review_required");
    assert.equal(session.clicks, 0);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.ok(events.some(event => event.eventType === "policy.adjudicated" && event.payload.reasonCode === "jev_review_required" && event.payload.disposition === "deny"));
    assert.equal(events.some(event => event.eventType === "execution.reserved" || event.eventType === "execution.dispatched"), false);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("declarative ordinary navigation records execution without duplicate model inference", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  try {
    const receipt = await new TestRunner({ session, decisionRuntime: runtime, runStateStore: runState.store }).run({
      id: "workflow_telemetry",
      name: "Telemetry interaction",
      steps: [{ id: "open_account", type: "interact", goal: "Open the account page", action: { type: "click", target: { backendNodeId: 1 }, postcondition: { type: "page_title_contains", value: "Error" } } }]
    }, { runId: "test_run_telemetry" });
    assert.equal(receipt.status, "PASSED");
    assert.equal(session.clicks, 1);
    const episodes = store.listEpisodes();
    assert.equal(episodes.length, 1);
    const events = store.getEvents(episodes[0].episode_id);
    assert.equal(events.some(event => event.eventType === "decision.predicted" && event.payload.model === JEV_MODEL_ID), false);
    assert.ok(events.some(event => event.eventType === "decision.skipped" && event.payload.reasonCode === "fresh_target_and_local_policy_sufficient"));
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.route === "deterministic"));
    assert.ok(events.some(event => event.eventType === "execution.reserved"));
    assert.ok(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"));
    assert.ok(events.some(event => event.eventType === "execution.observed"));
    assert.equal(events.at(-1).eventType, "episode.completed");
    assert.equal(store.verifyEpisodeChain(episodes[0].episode_id).ok, true);
  } finally {
    runtime.close();
  }
});

test("untyped declarative submission is refused before review or dispatch", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  session.current.candidates[0] = {
    ...session.current.candidates[0],
    role: "button",
    tag: "button",
    href: undefined,
    submitsForm: true,
    formIdentity: "task_form"
  };
  try {
    const receipt = await new TestRunner({ session, decisionRuntime: runtime }).run({
      id: "workflow_jev_hold",
      name: "Jev review hold",
      steps: [{ id: "open_account", type: "interact", goal: "Open the account page", action: { type: "click", operationId: "typed_submit", target: { backendNodeId: 1 } } }]
    }, { runId: "test_run_jev_hold" });
    assert.equal(receipt.status, "BLOCKED");
    assert.equal(session.clicks, 0);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.ok(events.some(event => event.eventType === "policy.adjudicated" && event.payload.disposition === "deny"));
    assert.equal(events.some(event => event.eventType === "execution.dispatched"), false);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("declarative submission with Jev review requires a trusted operation capability", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  session.current.candidates[0] = {
    ...session.current.candidates[0], role: "button", tag: "button", href: undefined,
    submitsForm: true, formIdentity: "task_form"
  };
  try {
    const receipt = await new TestRunner({
      session,
      decisionRuntime: runtime,
      operationAuthorizer: { authorize() { return { allowed: true }; } }
    }).run({
      id: "workflow_jev_hold",
      name: "Jev review hold",
      steps: [{ id: "open_account", type: "interact", goal: "Open the account page", action: { type: "click", operationId: "typed_submit", target: { backendNodeId: 1 } } }]
    }, { runId: "test_run_jev_hold" });
    assert.equal(receipt.status, "BLOCKED");
    assert.equal(session.clicks, 0);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.ok(events.some(event => event.eventType === "policy.adjudicated" && event.payload.disposition === "deny"));
    assert.equal(events.some(event => event.eventType === "execution.dispatched"), false);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("direct observed-element unique link skips a redundant Jev review", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev(), semanticAnalyzer: null });
  const candidate = { identity: "open-account", backendNodeId: 1, name: "Open account", role: "link", tag: "a", href: "/account", visible: true, targetId: "observed-target" };
  const session = {
    target: { id: "observed-target", url: "https://shop.example.test/" },
    attached: true,
    observer: { getEvidence: () => ({ status: "available", selectedElement: candidate }) },
    clicks: 0,
    async observe() { return { evidenceId: "observed_action_fresh", targetId: "observed-target", page: { url: "https://shop.example.test/", title: "Shop" }, candidates: [candidate] }; },
    async click() { this.clicks++; }
  };
  try {
    const result = await clickObservedElement(session, {
      goal: "Open the account page",
      evidenceId: "observed_action_old",
      backendNodeId: 1,
      decisionRuntime: runtime,
      assertExecutionLease: fixtureLease
    });
    assert.equal(result.status, "action_dispatched");
    assert.equal(session.clicks, 1);
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const events = store.getEvents(episode.episode_id);
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.route === "deterministic"));
    assert.equal(events.some(event => event.eventType === "decision.predicted"), false);
  } finally {
    runtime.close();
  }
});

test("goal substeps share their declarative workflow episode and run identity", async () => {
  const plannerVars = ["ACTIVETAB_MODEL_ENDPOINT", "ACTIVETAB_MODEL", "ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT"];
  const saved = Object.fromEntries(plannerVars.map(name => [name, process.env[name]]));
  for (const name of plannerVars) delete process.env[name];
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  try {
    await new TestRunner({ session: fixtureSession(), decisionRuntime: runtime }).run({
      id: "workflow_goal_telemetry",
      name: "Goal telemetry",
      steps: [{ id: "discover_account", type: "goal", goal: "Open the account page", maxActions: 1 }]
    }, { runId: "test_run_goal_telemetry" });
    const episodes = store.listEpisodes();
    assert.equal(episodes.length, 1);
    const events = store.getEvents(episodes[0].episode_id);
    assert.ok(events.length > 5);
    assert.ok(events.every(event => event.runId === "test_run_goal_telemetry"));
    assert.equal(events.filter(event => event.eventType === "episode.started").length, 1);
    assert.equal(events.some(event => event.eventType === "episode.completed"), false);
    assert.equal(episodes[0].status, "active");
    assert.equal(store.verifyEpisodeChain(episodes[0].episode_id).ok, true);
  } finally {
    runtime.close();
    for (const name of plannerVars) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("application discovery records bounded action lineage without persisting destination URLs", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  const candidate = { identity: "about-link", backendNodeId: 2, href: "https://shop.example.test/about?private=value", name: "About", role: "link", tag: "a", visible: true };
  const session = {
    current: { page: { url: "https://shop.example.test/", title: "Shop" }, candidates: [candidate], headings: [] },
    observations: 0,
    async observe() { return { evidenceId: `discovery_observation_${++this.observations}`, ...structuredClone(this.current) }; },
    async click(selected) { this.current = { page: { url: selected.href, title: "About" }, candidates: [], headings: [] }; },
    async waitForChange() {},
    client: { async send() { throw new Error("Discovery must dispatch through the observed link, not direct Page.navigate."); } }
  };
  try {
    const result = await new ApplicationDiscoveryEngine({
      session,
      environment: { authorizedOrigins: ["https://shop.example.test"] },
      maxSteps: 1,
      decisionRuntime: runtime
    }).discover();
    assert.ok(result.decisionEpisodeId);
    const events = store.getEvents(result.decisionEpisodeId);
    assert.equal(events.some(event => event.eventType === "decision.predicted"), false, "a fresh safe link does not need Jev");
    assert.ok(events.some(event => event.eventType === "decision.skipped" && event.payload.reasonCode === "fresh_target_and_local_policy_sufficient"));
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.route === "deterministic"));
    assert.ok(events.some(event => event.eventType === "execution.dispatched"));
    assert.ok(events.some(event => event.eventType === "execution.observed"));
    assert.equal(JSON.stringify(events).includes("private=value"), false);
    assert.equal(events.at(-1).eventType, "episode.completed");
  } finally {
    runtime.close();
  }
});

test("discovery keeps a fresh safe same-origin link deterministic even when Jev would refuse", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let jevCalls = 0;
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevClient: { async decide() { jevCalls++; throw Object.assign(new Error("provider refusal"), { kind: "refusal" }); } },
    semanticAnalyzer: null
  });
  const candidate = { identity: "about-link", backendNodeId: 2, href: "https://shop.example.test/about", name: "About", role: "link", tag: "a", visible: true };
  const session = {
    current: { page: { url: "https://shop.example.test/", title: "Shop" }, candidates: [candidate], headings: [] },
    navigations: 0,
    async observe() { return { evidenceId: "discovery_review_observation", ...structuredClone(this.current) }; },
    async waitForChange() {},
    async click() {
      this.navigations++;
      this.current = { page: { url: "https://shop.example.test/about", title: "About" }, candidates: [], headings: [] };
    },
    client: { async send() { throw new Error("Discovery should click the observed link through the authorized executor."); } }
  };
  try {
    const result = await new ApplicationDiscoveryEngine({
      session,
      environment: { authorizedOrigins: ["https://shop.example.test"] },
      maxSteps: 1,
      decisionRuntime: runtime
    }).discover();
    assert.equal(session.navigations, 1);
    assert.equal(jevCalls, 0);
    assert.ok(result.discoveries.some(item => item.type === "application_identity_changed"));
    const events = store.getEvents(result.decisionEpisodeId);
    assert.equal(events.some(event => event.eventType === "decision.predicted"), false);
    assert.ok(events.some(event => event.eventType === "inference.route_selected" && event.payload.route === "deterministic"));
    assert.ok(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"));
  } finally {
    runtime.close();
  }
});
