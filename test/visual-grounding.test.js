import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicPlanner } from "../src/navigation/planner.js";

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
