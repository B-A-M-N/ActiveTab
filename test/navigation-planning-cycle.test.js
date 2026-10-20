import test from "node:test";
import assert from "node:assert/strict";
import { createPlanningOptions, filterPlanningObservation } from "../src/navigation/planningCycle.js";
import { targetSignature } from "../src/state/workflows.js";

test("planning observation applies candidate, signature, search-field, and scroll exclusions without mutating evidence", () => {
  const excludedTarget = { identity: "failed-target", name: "Save", visible: true };
  const matchingSignatureTarget = { identity: "same-signature", name: "Save", visible: true, tag: "button" };
  const searchInput = { identity: "search-input", name: "Search", role: "searchbox", tag: "input", type: "search", visible: true };
  const retainedCandidate = { identity: "keep", name: "Continue", visible: true };
  const observation = {
    candidates: [excludedTarget, matchingSignatureTarget, searchInput, retainedCandidate],
    scrollTargets: [{ identity: "failed-scroll" }, { identity: "keep-scroll" }]
  };
  const projected = filterPlanningObservation(observation, {
    excludedIdentities: new Set(["failed-target", "search-input"]),
    excludedTargetSignatures: [targetSignature(matchingSignatureTarget)],
    excludedScrollIdentities: new Set(["failed-scroll"]),
    searchPhrase: "report",
    searchObservation: { page: { url: "https://example.test/search" } }
  });

  assert.deepEqual(projected.candidates.map(candidate => candidate.identity), ["search-input", "keep"]);
  assert.deepEqual(projected.scrollTargets.map(target => target.identity), ["keep-scroll"]);
  assert.deepEqual(observation.candidates, [excludedTarget, matchingSignatureTarget, searchInput, retainedCandidate]);
  assert.deepEqual(observation.scrollTargets.map(target => target.identity), ["failed-scroll", "keep-scroll"]);
});

test("planning options snapshot exclusions and scroll convergence while preserving run-owned bindings", () => {
  const signal = new AbortController().signal;
  const inputBindings = Object.freeze({ query: "quarterly report" });
  const options = createPlanningOptions({
    excludedIdentities: new Set(["target-a", "target-b"]),
    excludedScrollIdentities: new Set(["scroll-a"]),
    maxScrolls: 4,
    scrollActionsUsed: 2,
    scrollConvergenceStates: new Map([
      ["scroll-a", { matchingCandidateCount: 3, scrollActionsUsed: 1 }]
    ]),
    signal,
    inputBindings
  });

  assert.deepEqual(options, {
    excludedIdentities: ["target-a", "target-b"],
    excludedScrollIdentities: ["scroll-a"],
    maxScrolls: 4,
    scrollActionsUsed: 2,
    previousScrollStates: [{ identity: "scroll-a", matchingCandidateCount: 3, scrollActionsUsed: 1 }],
    signal,
    inputBindings
  });
  assert.equal(options.inputBindings, inputBindings);
});
