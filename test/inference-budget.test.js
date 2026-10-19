import test from "node:test";
import assert from "node:assert/strict";
import { InferenceAttemptBudget } from "../src/decisions/inferenceBudget.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { OpenAICompatibleProvider } from "../src/navigation/modelProvider.js";
import { configuredPlanner } from "../src/navigation/planner.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";

test("physical model retries reserve durable inference attempts and exhaust before sending another request", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const episode = store.startEpisode({ runId: "budget_run_retry", workflowId: "budget_retry", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
  const budget = new InferenceAttemptBudget({ eventStore: store });
  let physicalCalls = 0;
  const fetchImpl = budget.wrapFetch("workflow_synthesis", async () => {
    physicalCalls++;
    return new Response("", { status: 503 });
  });
  const provider = new OpenAICompatibleProvider({ endpoint: "https://model.example/v1", model: "test-model", fetchImpl, timeoutMs: 5_000 });
  try {
    await budget.run({ runId: episode.runId }, async () => {
      await assert.rejects(provider.requestStructured({ task: "test", instructions: "Return JSON", input: {}, schema: { type: "object" } }), error => error.kind === "transport");
      assert.equal(physicalCalls, 2, "the provider's single retry counts as a physical call");
      const partial = store.getEvents(episode.episodeId).filter(event => event.eventType === "inference.attempted");
      assert.equal(partial.length, 2);
      assert.deepEqual(partial.map(event => event.payload.attemptNumber), [1, 2]);
      await fetchImpl("https://model.example/v1/chat/completions");
      assert.equal(physicalCalls, 3, "the third physical request is admitted");
      await fetchImpl("https://model.example/v1/chat/completions");
      assert.equal(physicalCalls, 4, "the run retains two attempts for a later model or retry");
      await assert.rejects(Promise.resolve().then(() => fetchImpl("https://model.example/v1/chat/completions")), error => error.kind === "budget_exhausted");
      assert.equal(physicalCalls, 4, "budget refusal occurs before transport dispatch");
    });
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("automatic secondary planner charges every physical retry to the shared run budget", async () => {
  const names = ["ACTIVETAB_MODEL_ENDPOINT", "ACTIVETAB_MODEL", "ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT", "ACTIVETAB_MODEL_MAX_RETRIES"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.ACTIVETAB_MODEL_ENDPOINT = "https://model.example/v1";
  process.env.ACTIVETAB_MODEL = "budget-test-model";
  process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = "1";
  process.env.ACTIVETAB_MODEL_MAX_RETRIES = "1";

  const store = new DecisionEventStore({ databasePath: ":memory:" });
  let physicalCalls = 0;
  const runtime = createDecisionRuntime({ eventStore: store, semanticAnalyzer: null });
  const originalFetch = async () => {
    physicalCalls++;
    return new Response("", { status: 503 });
  };
  try {
    const episode = runtime.startEpisode({
      runId: "secondary_planner_budget",
      workflowId: "secondary_planner_budget",
      applicationId: "fixture_app",
      environmentClass: "local",
      executionMode: "standalone"
    });
    const planner = configuredPlanner({
      executionMode: "standalone",
      plannerMode: "auto",
      decisionRuntime: runtime,
      fetchImpl: originalFetch
    });
    await runtime.withInferenceBudget({ runId: episode.runId }, async () => {
      await assert.rejects(planner.plan("Click Save", {
        evidenceId: "secondary_budget_observation",
        targetId: "secondary_budget_target",
        documentGeneration: 1,
        viewport: { width: 1280, height: 720 },
        page: { url: "https://fixture.example/settings", title: "Settings" },
        headings: [],
        candidates: [{ identity: "save", tag: "button", role: "button", name: "Save", visible: true, disabled: false }],
        scrollTargets: []
      }), error => error.kind === "transport");
    });
    assert.equal(physicalCalls, 2);
    const attempts = store.getEvents(episode.episodeId).filter(event => event.eventType === "inference.attempted");
    assert.deepEqual(attempts.map(event => event.payload.taskCode), ["secondary_planning", "secondary_planning"]);
    assert.deepEqual(attempts.map(event => event.payload.attemptNumber), [1, 2]);
  } finally {
    runtime.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("attempt reservations remain charged after a run resumes and serialize concurrent callers", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  const episode = store.startEpisode({ runId: "budget_run_resume", workflowId: "budget_resume", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
  const firstBudget = new InferenceAttemptBudget({ eventStore: store });
  const secondBudget = new InferenceAttemptBudget({ eventStore: store });
  let physicalCalls = 0;
  const wrapped = firstBudget.wrapFetch("jev_review", async () => { physicalCalls++; return new Response("ok"); });
  try {
    await firstBudget.run({ runId: episode.runId }, async () => {
      await wrapped("https://review.example");
      await wrapped("https://review.example");
    });
    await secondBudget.run({ runId: episode.runId }, async () => {
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => Promise.resolve().then(() => secondBudget.wrapFetch("semantic_inference", async () => { physicalCalls++; await Promise.resolve(); return new Response("ok"); })("https://semantic.example"))));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
      assert.equal(results.filter(result => result.status === "rejected" && result.reason.kind === "budget_exhausted").length, 2);
    });
    assert.equal(physicalCalls, 4);
    assert.equal(store.getEvents(episode.episodeId).filter(event => event.eventType === "inference.attempted").length, 4);
    assert.deepEqual(secondBudget.snapshot(episode.runId), { attempts: 4, maxAttempts: 4 });
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});
