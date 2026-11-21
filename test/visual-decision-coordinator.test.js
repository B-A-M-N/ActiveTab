import test from "node:test";
import assert from "node:assert/strict";
import { createVisualDecisionCoordinator } from "../src/navigation/visualDecisionCoordinator.js";

function createHarness({ allowImages = false, visualDecisionService = {} } = {}) {
  const calls = [];
  const decisionRuntime = {
    jevClient: { allowImages },
    visualDecisionService,
    recordInferenceRoute: event => calls.push(["route", event]),
    recordReviewSkipped: event => calls.push(["skipped", event])
  };
  const session = {
    async observe(options) { calls.push(["observe", options]); return { evidenceId: "visual-1" }; },
    async probeVisualCandidateAtPoint() { calls.push(["probe"]); return { status: "unavailable" }; }
  };
  return {
    calls,
    coordinator: createVisualDecisionCoordinator({
      decisionRuntime,
      session,
      deterministicPlanner: { async plan() { calls.push(["plan"]); return { status: "ambiguous", candidates: [] }; } },
      goal: "open the reports page",
      episodeId: "episode-1",
      runId: "run-1",
      decisionStepId: () => "step-1",
      signal: undefined
    })
  };
}

test("visual page classification stays skipped when screenshot permission is absent", async () => {
  let classifications = 0;
  const harness = createHarness({
    visualDecisionService: { async classifyPage() { classifications += 1; } }
  });
  const observation = { evidenceId: "observed-1" };
  const result = await harness.coordinator.classifyAmbiguousPage(observation);

  assert.equal(classifications, 0);
  assert.equal(result.assessment.status, "skipped");
  assert.equal(result.assessment.failureCode, "image_permission_denied");
  assert.equal(result.assessment.authorizesOperation, false);
  assert.equal(result.observation, observation);
  assert.deepEqual(harness.calls.map(([name]) => name), ["route", "skipped"]);
});

test("visual target grounding requires multiple deterministic candidates", async () => {
  let groundings = 0;
  const harness = createHarness({
    allowImages: true,
    visualDecisionService: { async groundTarget() { groundings += 1; } }
  });
  const result = await harness.coordinator.groundAmbiguousTarget({ evidenceId: "observed-1" }, {
    candidates: [{ identity: "candidate-1" }]
  }, "reports_link");

  assert.equal(result, null);
  assert.equal(groundings, 0);
  assert.deepEqual(harness.calls, []);
});

test("visual assessment resolves the current session after a same-target reattachment", async () => {
  const calls = [];
  const retired = {
    attached: false,
    target: { id: "visual-retired" },
    documentGeneration: 1,
    async observe() { calls.push("retired"); throw new Error("retired session used"); }
  };
  const replacement = {
    attached: true,
    target: { id: "visual-replacement" },
    documentGeneration: 2
  };
  let current = replacement;
  const observation = {
    evidenceId: "visual-after-reattach",
    targetId: "visual-replacement",
    documentGeneration: 2,
    visualEvidence: { evidenceId: "visual-after-reattach", targetId: "visual-replacement", documentGeneration: 2,
      viewport: { width: 1280, height: 720 }, screenshotBase64: "fixture" }
  };
  let classifications = 0;
  const coordinator = createVisualDecisionCoordinator({
    decisionRuntime: {
      jevClient: { allowImages: true },
      recordInferenceRoute() {},
      recordReviewSkipped() {},
      visualDecisionService: { async classifyPage(input) {
        classifications++;
        assert.equal(input.targetId, "visual-replacement");
        return { status: "reviewed" };
      } }
    },
    session: retired,
    getSession: () => current,
    goal: "inspect this page",
    episodeId: "visual-reattach-episode",
    runId: "visual-reattach-run",
    decisionStepId: () => "step-1"
  });

  const result = await coordinator.classifyAmbiguousPage(observation);
  assert.equal(result.assessment.status, "reviewed");
  assert.equal(classifications, 1);
  assert.deepEqual(calls, []);

  current = { ...replacement, target: { id: "other-target" } };
  const stale = await coordinator.classifyAmbiguousPage(observation);
  assert.equal(stale.assessment.failureCode, "visual_evidence_unavailable");
  assert.equal(classifications, 1);
});
