import test from "node:test";
import assert from "node:assert/strict";
import { expandTaskScopeObservation, shouldExpandTaskScope } from "../src/navigation/planningEvidence.js";

function incompleteTaskObservation(overrides = {}) {
  return {
    evidenceId: "evidence-1",
    targetId: "target-1",
    observationProfile: "interaction",
    candidateCoverage: {
      selectionScope: "task_relevant_region",
      scopeCoverage: "incomplete",
      scopeCandidateCount: 220,
      returnedScopeCandidateCount: 200
    },
    ...overrides
  };
}

test("task-scope expansion is limited to one incomplete bounded interaction observation", () => {
  const observation = incompleteTaskObservation();
  assert.equal(shouldExpandTaskScope(observation, { workflowModeActive: true }), true);
  assert.equal(shouldExpandTaskScope(observation, { workflowModeActive: false }), false);
  assert.equal(shouldExpandTaskScope(observation, { workflowModeActive: true, expansionAttempted: true }), false);
  assert.equal(shouldExpandTaskScope({ ...observation, observationProfile: "structural" }, { workflowModeActive: true }), false);
  assert.equal(shouldExpandTaskScope({ ...observation, candidateCoverage: { ...observation.candidateCoverage, scopeCoverage: "complete" } }, { workflowModeActive: true }), false);
  assert.equal(shouldExpandTaskScope({ ...observation, candidateCoverage: { ...observation.candidateCoverage, scopeCandidateCount: 385 } }, { workflowModeActive: true }), false);
  assert.equal(shouldExpandTaskScope({ ...observation, candidateCoverage: { ...observation.candidateCoverage, scopeCandidateCount: 200 } }, { workflowModeActive: true }), false);
  assert.equal(shouldExpandTaskScope({ ...observation, candidateCoverage: { ...observation.candidateCoverage, scopeCandidateCount: 201.5 } }, { workflowModeActive: true }), false);
});

test("task-scope expansion requests the fixed limit and filters only fresh same-target evidence", async () => {
  const observation = incompleteTaskObservation();
  const expandedObservation = { ...observation, evidenceId: "evidence-2", candidates: [{ identity: "fresh" }] };
  const calls = [];
  const accepted = [];
  const result = await expandTaskScopeObservation({
    session: {
      target: { id: "target-1" },
      async observe(options) {
        calls.push(options);
        return expandedObservation;
      }
    },
    observation,
    goal: "choose the matching record",
    acceptObservation: source => accepted.push(source),
    filterObservation(source, searchObservation) {
      assert.equal(source, expandedObservation);
      assert.equal(searchObservation, expandedObservation);
      assert.deepEqual(accepted, [expandedObservation], "the run state accepts fresh evidence before the planning projection is built");
      return { evidenceId: source.evidenceId, candidateIds: source.candidates.map(candidate => candidate.identity) };
    }
  });

  assert.deepEqual(calls, [{ profile: "interaction", selectionGoal: "choose the matching record", candidateLimit: 384 }]);
  assert.deepEqual(accepted, [expandedObservation]);
  assert.equal(result.expanded, true);
  assert.equal(result.observation, expandedObservation);
  assert.deepEqual(result.planningObservation, { evidenceId: "evidence-2", candidateIds: ["fresh"] });
});

test("stale, cross-target, and failed expansion retain the prior observation", async t => {
  const observation = incompleteTaskObservation();
  const cases = [
    ["same evidence", { ...observation }],
    ["different target", { ...observation, evidenceId: "evidence-2", targetId: "target-2" }],
    ["observation failure", new Error("observation unavailable")]
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      let accepted = false;
      const result = await expandTaskScopeObservation({
        session: {
          target: { id: "target-1" },
          async observe() {
            if (response instanceof Error) throw response;
            return response;
          }
        },
        observation,
        acceptObservation: () => { accepted = true; },
        filterObservation: () => assert.fail("unusable evidence must not be projected")
      });
      assert.equal(result.expanded, false);
      assert.equal(result.observation, observation);
      assert.equal(accepted, false);
    });
  }
});
