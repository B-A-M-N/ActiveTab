import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicPlanner } from "../src/navigation/planner.js";
import { jpegDimensions } from "../src/decisions/imagePreparation.js";
import { groundVisualTarget, mapCandidateBoundsToRoot, revalidateVisualGrounding } from "../src/navigation/visualGrounder.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
const screenshotDimensions = jpegDimensions(Buffer.from(screenshotBase64, "base64"));

function visualObservation({ evidenceId = "visual_obs_1", generation = 3, targetId = "target_visual", candidates } = {}) {
  const viewport = { width: screenshotDimensions.width * 2, height: screenshotDimensions.height * 2 };
  return {
    evidenceId,
    targetId,
    documentGeneration: generation,
    viewport,
    candidates,
    visualEvidence: { evidenceId, targetId, documentGeneration: generation, viewport, screenshotBase64 }
  };
}

function visualCandidate(identity, x, y, { targetId = "target_visual", generation = 3, frameTargetId = null, visible = true, disabled = false } = {}) {
  return {
    identity, targetId, documentGeneration: generation, frameTargetId,
    backendNodeId: 17, tag: "button", role: "button", name: "Continue", visible, disabled,
    bounds: { x, y, width: 160, height: 80 }
  };
}

test("visual grounding returns position/size scores for ambiguous candidates", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    page: { url: "http://app.local/", title: "App", viewportWidth: 1280, viewportHeight: 720 },
    candidates: [
      { identity: "btn-a", tag: "button", role: "button", name: "Continue", visible: true, disabled: false, bounds: { x: 100, y: 50, width: 120, height: 40 } },
      { identity: "btn-b", tag: "button", role: "button", name: "Continue", visible: true, disabled: false, bounds: { x: 800, y: 500, width: 80, height: 30 } },
      { identity: "btn-c", tag: "link", role: "link", name: "Continue to next", visible: true, disabled: false, bounds: { x: 300, y: 200, width: 200, height: 30 } }
    ],
    headings: [], frames: [], scrollTargets: []
  };
  const plan = await planner.plan("Continue", observation);
  assert.equal(plan.status, "ambiguous");
  assert.ok(Array.isArray(plan.candidates), "Ambiguous plan includes candidates");
  assert.ok(Array.isArray(plan.visualContext), "Ambiguous plan includes visual context");
  assert.equal(plan.visualContext.length, plan.candidates.length);
  for (const vc of plan.visualContext) {
    assert.ok(typeof vc.positionScore === "number" && vc.positionScore >= 0 && vc.positionScore <= 1, `Position score in range: ${vc.positionScore}`);
    assert.ok(typeof vc.sizeScore === "number" && vc.sizeScore >= 0 && vc.sizeScore <= 1, `Size score in range: ${vc.sizeScore}`);
    assert.ok(typeof vc.visualScore === "number", `Visual score computed: ${vc.visualScore}`);
    assert.ok(vc.bounds.x !== null, "Bounds x is present");
    assert.ok(vc.relativePosition.y !== null, "Relative y is present");
  }
  // The first candidate (upper-left, larger) should have a higher positionScore than the second (lower-right, smaller).
  const first = plan.visualContext.find(vc => vc.identity === "btn-a");
  const second = plan.visualContext.find(vc => vc.identity === "btn-b");
  assert.ok(first.positionScore > second.positionScore, `Upper-left should score higher: ${first.positionScore} > ${second.positionScore}`);
});

test("visual grounding is not returned for unambiguous plans", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    page: { url: "http://app.local/", title: "App", viewportWidth: 1280, viewportHeight: 720 },
    candidates: [
      { identity: "btn-unique", tag: "button", role: "button", name: "Submit form", visible: true, disabled: false, bounds: { x: 100, y: 50, width: 120, height: 40 } }
    ],
    headings: [], frames: [], scrollTargets: []
  };
  const plan = await planner.plan("Submit form", observation);
  assert.equal(plan.status, "planned");
  assert.equal(plan.visualContext, undefined);
});

test("JeV Box grounding maps image coordinates to one exact fresh DOM candidate", () => {
  const observation = visualObservation({ candidates: [
    visualCandidate("button_target", 350, 220),
    visualCandidate("button_other", 1_000, 600)
  ] });
  const grounding = groundVisualTarget({
    observation,
    imageEvidence: observation.visualEvidence,
    allowedCandidateIds: ["button_target", "button_other"],
    answers: {
      target_present: { type: "noul", probabilityYes: 0.94 },
      target_box: { type: "box", confidence: 0.91, box: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 } }
    }
  });
  assert.equal(grounding.status, "grounded");
  assert.equal(grounding.candidate.identity, "button_target");
  assert.equal(grounding.candidate.backendNodeId, 17);
  assert.equal(grounding.advisoryOnly, true);
  assert.equal(grounding.authorizesOperation, false);
  assert.equal(grounding.requiresFreshResolutionBeforeDispatch, true);
  assert.ok(Math.abs(grounding.evidence.sourceBox.left - observation.viewport.width * 0.2) < 0.01);
  assert.ok(grounding.scores.candidateCoverage >= 0.99);

  const fresh = visualObservation({ evidenceId: "visual_obs_2", candidates: [
    visualCandidate("button_target", 350, 220),
    visualCandidate("button_other", 1_000, 600)
  ] });
  assert.equal(revalidateVisualGrounding(grounding, fresh)?.identity, "button_target");
  assert.equal(revalidateVisualGrounding(grounding, { ...fresh, documentGeneration: 4 }), null);
});

test("visual grounding abstains for low presence, ambiguous geometry, and unmapped frames", () => {
  const observation = visualObservation({ candidates: [
    visualCandidate("button_a", 350, 220),
    visualCandidate("button_b", 360, 225)
  ] });
  const common = {
    observation,
    imageEvidence: observation.visualEvidence,
    answers: {
      target_present: { type: "noul", probabilityYes: 0.94 },
      target_box: { type: "box", confidence: 0.91, box: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 } }
    }
  };
  assert.equal(groundVisualTarget({ ...common, answers: { ...common.answers, target_present: { type: "noul", probabilityYes: 0.4 } } }).reasonCode, "target_not_confirmed_present");
  assert.equal(groundVisualTarget(common).reasonCode, "multiple_candidates_match_box");

  const frameOnly = visualObservation({ candidates: [
    visualCandidate("frame_button", 350, 220, { frameTargetId: "oopif_target" })
  ] });
  const frameResult = groundVisualTarget({ ...common, observation: frameOnly, imageEvidence: frameOnly.visualEvidence });
  assert.equal(frameResult.reasonCode, "cross_frame_bounds_unmapped");
  assert.equal(frameResult.authorizesOperation, false);
});

test("visual grounding maps OOPIF candidates through captured owner geometry and revalidates the frame identity", () => {
  const viewport = { width: screenshotDimensions.width * 2, height: screenshotDimensions.height * 2 };
  const geometry = [{
    status: "available",
    frameTargetId: "oopif_target",
    parentTargetId: null,
    viewport: { width: 100, height: 100 },
    ownerContentQuad: [viewport.width * 0.1, viewport.height * 0.1, viewport.width * 0.7, viewport.height * 0.1,
      viewport.width * 0.7, viewport.height * 0.7, viewport.width * 0.1, viewport.height * 0.7]
  }];
  const candidate = visualCandidate("frame_button", 20, 20, { frameTargetId: "oopif_target" });
  candidate.bounds = { x: 20, y: 20, width: 20, height: 20 };
  const observation = visualObservation({ candidates: [candidate] });
  observation.outOfProcessFrameGeometry = geometry;
  const grounding = groundVisualTarget({
    observation,
    imageEvidence: observation.visualEvidence,
    answers: {
      target_present: { type: "noul", probabilityYes: 0.94 },
      target_box: { type: "box", confidence: 0.91, box: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 } }
    }
  });
  assert.equal(grounding.status, "grounded");
  assert.equal(grounding.candidate.frameTargetId, "oopif_target");
  assert.equal(grounding.evidence.frameTargetId, "oopif_target");
  assert.equal(revalidateVisualGrounding(grounding, observation)?.identity, "frame_button");

  const nested = [
    { ...geometry[0], frameTargetId: "parent_frame", viewport: { width: 100, height: 100 } },
    { status: "available", frameTargetId: "nested_frame", parentTargetId: "parent_frame", viewport: { width: 100, height: 100 },
      ownerContentQuad: [20, 20, 80, 20, 80, 80, 20, 80] }
  ];
  const nestedBounds = mapCandidateBoundsToRoot({ frameTargetId: "nested_frame", bounds: { x: 20, y: 20, width: 20, height: 20 } }, {
    outOfProcessFrameGeometry: nested
  });
  assert.ok(nestedBounds && nestedBounds.x > viewport.width * 0.2 && nestedBounds.x < viewport.width * 0.4);
});

test("visual grounding rejects missing, stale, disabled, and disallowed candidates", () => {
  const observation = visualObservation({ candidates: [visualCandidate("button_target", 350, 220)] });
  const args = {
    observation,
    imageEvidence: observation.visualEvidence,
    answers: {
      target_present: { type: "noul", probabilityYes: 0.94 },
      target_box: { type: "box", confidence: 0.91, box: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 } }
    }
  };
  assert.equal(groundVisualTarget({ ...args, imageEvidence: { ...observation.visualEvidence, documentGeneration: 2 } }).reasonCode, "stale_or_unbound_visual_evidence");
  assert.equal(groundVisualTarget({ ...args, allowedCandidateIds: ["different_id"] }).reasonCode, "no_fresh_visible_candidates");
  const disabled = visualObservation({ candidates: [visualCandidate("button_target", 350, 220, { disabled: true })] });
  assert.equal(groundVisualTarget({ ...args, observation: disabled, imageEvidence: disabled.visualEvidence }).reasonCode, "no_fresh_visible_candidates");
});
