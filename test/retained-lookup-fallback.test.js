import test from "node:test";
import assert from "node:assert/strict";
import { reobserveFromRetainedLookup } from "../src/navigation/retainedLookupFallback.js";

const target = { id: "tab-1" };
const firstObservation = {
  evidenceId: "obs-1",
  targetId: "tab-1",
  documentGeneration: 7,
  candidateCoverage: { pageCoverage: "partial" }
};
const candidate = { identity: "candidate-1", targetId: "tab-1", documentGeneration: 7 };

function makeSession({ lookupResult, refreshed, lookupError, observeError } = {}) {
  const calls = { lookup: [], observe: [] };
  const session = {
    target,
    documentGeneration: 7,
    observer: {
      async lookupRetainedCandidates(...args) {
        calls.lookup.push(args);
        if (lookupError) throw lookupError;
        return lookupResult ?? {
          status: "unique", matchCount: 1,
          evidenceId: "obs-1", targetId: "tab-1", documentGeneration: 7,
          matches: [{ identity: "candidate-1", frameId: "frame-root", frameTargetId: null, actionAuthorized: false }],
          visitedNodeCount: 250, stopReason: "node_budget"
        };
      }
    },
    async observe(...args) {
      calls.observe.push(args);
      if (observeError) throw observeError;
      return refreshed ?? {
        evidenceId: "obs-2", targetId: "tab-1", documentGeneration: 7,
        candidates: [candidate]
      };
    }
  };
  return { session, calls };
}

test("retained identity only triggers fresh observation and must be rederived", async () => {
  const { session, calls } = makeSession();
  const result = await reobserveFromRetainedLookup({
    session, observation: firstObservation, goal: "save the profile", targetTokens: ["profile"]
  });

  assert.equal(result.status, "refreshed");
  assert.equal(result.observation.evidenceId, "obs-2");
  assert.equal(result.reasonCode, "retained_match_rederived");
  assert.equal(calls.lookup.length, 1);
  assert.deepEqual(calls.lookup[0], ["obs-1", { targetTokens: ["profile"], maxNodes: 500, maxResults: 20, timeoutMs: 1_500 }]);
  assert.deepEqual(calls.observe[0], [{ profile: "interaction", selectionGoal: "save the profile", candidateLimit: 384 }]);
  assert.equal("actionAuthorized" in result, false);
  assert.deepEqual({
    mode: result.lookupTelemetry.lookupMode,
    status: result.lookupTelemetry.lookupStatus,
    targetId: result.lookupTelemetry.targetId,
    frameScope: result.lookupTelemetry.frameScope,
    frameId: result.lookupTelemetry.frameId,
    returnedCount: result.lookupTelemetry.returnedCount,
    visitedNodeCount: result.lookupTelemetry.visitedNodeCount,
    stopReason: result.lookupTelemetry.stopReason,
    nextActionDisposition: result.lookupTelemetry.nextActionDisposition
  }, {
    mode: "retained_snapshot", status: "refreshed", targetId: "tab-1", frameScope: "page",
    frameId: "frame-root", returnedCount: 1, visitedNodeCount: 250,
    stopReason: "retained_match_rederived", nextActionDisposition: "deferred"
  });
  assert.ok(Number.isInteger(result.lookupTelemetry.elapsedMs));
});

test("an advisory identity omitted from the fresh ordinary observation stays unusable", async () => {
  const { session } = makeSession({ refreshed: {
    evidenceId: "obs-2", targetId: "tab-1", documentGeneration: 7, candidates: []
  } });
  const result = await reobserveFromRetainedLookup({ session, observation: firstObservation, targetTokens: ["profile"] });
  assert.equal(result.status, "no_hint");
  assert.equal(result.reasonCode, "retained_match_not_rederived");
});

test("stale evidence, mismatched lookup bindings, and failed refresh cannot supply a hint", async t => {
  await t.test("initial observation is stale", async () => {
    const { session, calls } = makeSession();
    const result = await reobserveFromRetainedLookup({
      session, observation: { ...firstObservation, documentGeneration: 6 }, targetTokens: ["profile"]
    });
    assert.equal(result.status, "stale");
    assert.equal(calls.lookup.length, 0);
  });

  await t.test("retained result is bound to another observation", async () => {
    const { session, calls } = makeSession({ lookupResult: {
      evidenceId: "obs-other", targetId: "tab-1", documentGeneration: 7,
      matches: [{ identity: "candidate-1" }]
    } });
    const result = await reobserveFromRetainedLookup({ session, observation: firstObservation, targetTokens: ["profile"] });
    assert.equal(result.status, "stale");
    assert.equal(result.reasonCode, "retained_lookup_binding_mismatch");
    assert.equal(calls.observe.length, 0);
  });

  await t.test("fresh observation changes generation", async () => {
    const { session } = makeSession({ refreshed: {
      evidenceId: "obs-2", targetId: "tab-1", documentGeneration: 8, candidates: [candidate]
    } });
    const result = await reobserveFromRetainedLookup({ session, observation: firstObservation, targetTokens: ["profile"] });
    assert.equal(result.status, "stale");
    assert.equal(result.reasonCode, "fresh_observation_binding_mismatch");
  });

  await t.test("lookup and reobservation errors are contained", async () => {
    const failedLookup = makeSession({ lookupError: new Error("unavailable") });
    const lookupResult = await reobserveFromRetainedLookup({
      session: failedLookup.session, observation: firstObservation, targetTokens: ["profile"]
    });
    assert.equal(lookupResult.status, "unavailable");
    assert.equal(lookupResult.reasonCode, "retained_lookup_failed");

    const failedObserve = makeSession({ observeError: new Error("unavailable") });
    const observeResult = await reobserveFromRetainedLookup({
      session: failedObserve.session, observation: firstObservation, targetTokens: ["profile"]
    });
    assert.equal(observeResult.status, "unavailable");
    assert.equal(observeResult.reasonCode, "fresh_observation_failed");
  });
});
