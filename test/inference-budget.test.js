import test from "node:test";
import assert from "node:assert/strict";
import { InferenceAttemptBudget } from "../src/decisions/inferenceBudget.js";
import { OpenAICompatibleProvider } from "../src/navigation/modelProvider.js";
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
      assert.equal(physicalCalls, 3, "the provider's two retries count as physical calls");
      const partial = store.getEvents(episode.episodeId).filter(event => event.eventType === "inference.attempted");
      assert.equal(partial.length, 3);
      assert.deepEqual(partial.map(event => event.payload.attemptNumber), [1, 2, 3]);
      await fetchImpl("https://model.example/v1/chat/completions");
      assert.equal(physicalCalls, 4, "the fourth physical request is admitted");
      await assert.rejects(Promise.resolve().then(() => fetchImpl("https://model.example/v1/chat/completions")), error => error.kind === "budget_exhausted");
      assert.equal(physicalCalls, 4, "budget refusal occurs before transport dispatch");
    });
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
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
