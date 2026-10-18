import test from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine } from "../src/navigation/engine.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { TestRunner } from "../src/testing/runner.js";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { clickObservedElement } from "../src/navigation/observedAction.js";

function fixtureSession() {
  const candidate = { identity: "open-account", backendNodeId: 1, name: "Open account", role: "link", tag: "a", href: "/account", visible: true };
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
      return { evidenceId: `observation_${++this.observations}`, ...structuredClone(this.current) };
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

function reviewRequiredJev() {
  return {
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

test("live navigation records Jev, policy, dispatch and observed events on one decision", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episode = store.getLatestEpisodeForRun(store.listEpisodes()[0].run_id);
    const events = store.getEvents(episode.episode_id);
    const lifecycle = events.filter(event => [
      "decision.input_captured", "decision.predicted", "policy.adjudicated",
      "execution.reserved", "execution.dispatched", "execution.observed"
    ].includes(event.eventType));
    assert.deepEqual(lifecycle.map(event => event.eventType), [
      "decision.input_captured", "decision.predicted", "decision.predicted",
      "policy.adjudicated", "execution.reserved", "execution.dispatched", "execution.observed"
    ]);
    assert.ok(lifecycle.every(event => event.decisionId === lifecycle[0].decisionId));
    assert.equal(lifecycle.at(-1).payload.changed, true);
    assert.equal(lifecycle.find(event => event.eventType === "decision.input_captured").payload.inputProjection.state.proposed_control.candidate_ref, "open-account");
    assert.equal(store.verifyEpisodeChain(episode.episode_id).ok, true);
  } finally {
    runtime.close();
  }
});

test("navigation remains usable without Jev credentials and records reviewer unavailability", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevOptions: { apiKey: null, apiKeyFile: "/__activetab_test_missing_jev_key__" },
    semanticAnalyzer: null
  });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.equal(events.filter(event => event.eventType === "decision.failed" && event.payload.failureCode === "configuration").length, 2);
    assert.equal(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"), true);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("a Jev refusal is recorded and does not block deterministic local navigation", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({
    eventStore: store,
    jevClient: { async decide() { throw Object.assign(new Error("review declined"), { kind: "refusal" }); } },
    semanticAnalyzer: null
  });
  const session = fixtureSession();
  try {
    await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime }).run("Open the account page");
    assert.equal(session.clicks, 1);
    const episodeId = store.listEpisodes()[0].episode_id;
    const events = store.getEvents(episodeId);
    assert.equal(events.filter(event => event.eventType === "decision.failed" && event.payload.failureCode === "refusal").length, 2);
    assert.equal(events.some(event => event.eventType === "execution.dispatched" && event.payload.dispatchStatus === "dispatched"), true);
    assert.equal(store.verifyEpisodeChain(episodeId).ok, true);
  } finally {
    runtime.close();
  }
});

test("Jev disagreement suspends navigation before dispatch and cannot authorize the action", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  try {
    const result = await new NavigationEngine(session, { planner: planner(), maxActions: 1, decisionRuntime: runtime }).run("Open the account page");
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

test("declarative test actions record the full lifecycle in the run episode", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: successfulJev(), semanticAnalyzer: null });
  const session = fixtureSession();
  try {
    const receipt = await new TestRunner({ session, decisionRuntime: runtime }).run({
      id: "workflow_telemetry",
      name: "Telemetry interaction",
      steps: [{ id: "open_account", type: "interact", goal: "Open the account page", action: { type: "click", target: { backendNodeId: 1 }, postcondition: { type: "page_title_contains", value: "Error" } } }]
    }, { runId: "test_run_telemetry" });
    assert.equal(receipt.status, "PASSED");
    assert.equal(session.clicks, 1);
    const episodes = store.listEpisodes();
    assert.equal(episodes.length, 1);
    const events = store.getEvents(episodes[0].episode_id);
    assert.ok(events.some(event => event.eventType === "decision.predicted" && event.payload.model === JEV_MODEL_ID));
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

test("direct observed-element action stops on Jev disagreement", async () => {
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
      decisionRuntime: runtime
    });
    assert.equal(result.status, "needs_human");
    assert.equal(result.category, "independent_review_required");
    assert.equal(session.clicks, 0);
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
    assert.equal(events.at(-1).eventType, "episode.completed");
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
    assert.ok(events.some(event => event.eventType === "decision.predicted"));
    assert.ok(events.some(event => event.eventType === "execution.dispatched"));
    assert.ok(events.some(event => event.eventType === "execution.observed"));
    assert.equal(JSON.stringify(events).includes("private=value"), false);
    assert.equal(events.at(-1).eventType, "episode.completed");
  } finally {
    runtime.close();
  }
});

test("discovery skips a destination when Jev requests agent review", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore: store, jevClient: reviewRequiredJev(), semanticAnalyzer: null });
  const candidate = { identity: "about-link", backendNodeId: 2, href: "https://shop.example.test/about", name: "About", role: "link", tag: "a", visible: true };
  const session = {
    current: { page: { url: "https://shop.example.test/", title: "Shop" }, candidates: [candidate], headings: [] },
    navigations: 0,
    async observe() { return { evidenceId: "discovery_review_observation", ...structuredClone(this.current) }; },
    async waitForChange() {},
    client: { async send() { this.session.navigations++; } }
  };
  session.client.session = session;
  try {
    const result = await new ApplicationDiscoveryEngine({
      session,
      environment: { authorizedOrigins: ["https://shop.example.test"] },
      maxSteps: 1,
      decisionRuntime: runtime
    }).discover();
    assert.equal(session.navigations, 0);
    assert.ok(result.discoveries.some(item => item.type === "decision_review_required"));
    const events = store.getEvents(result.decisionEpisodeId);
    assert.ok(events.some(event => event.eventType === "policy.adjudicated" && event.payload.reasonCode === "jev_review_required"));
    assert.equal(events.some(event => event.eventType === "execution.reserved" || event.eventType === "execution.dispatched"), false);
  } finally {
    runtime.close();
  }
});
