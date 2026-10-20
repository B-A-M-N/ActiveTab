import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowObservation } from "../src/navigation/workflowObservationProjection.js";

function observation(overrides = {}) {
  return {
    evidenceId: "observation_projection",
    targetId: "target_projection",
    documentGeneration: 4,
    page: { url: "https://records.example/list?session=private-token", title: "Private account records" },
    headings: [{ level: 1, text: "Private account records" }],
    candidates: [{
      identity: "candidate_private_record",
      tag: "a",
      role: "link",
      name: "Open private account record",
      contextName: "Account 123",
      href: "https://records.example/records/123?secret=private-token",
      type: "",
      visible: true,
      disabled: false
    }],
    scrollTargets: [],
    ...overrides
  };
}

test("workflow observation projection withholds labels and URLs while retaining local target bindings", () => {
  const observed = observation();
  const compiled = compileWorkflowObservation(observed);
  const projection = compiled.projection;
  const serialized = JSON.stringify(projection);

  assert.equal(compiled.coverageComplete, true);
  assert.equal(projection.observationId, observed.evidenceId);
  assert.equal(projection.pageOrigin, "https://records.example");
  assert.equal(projection.title, "");
  assert.deepEqual(projection.headings, []);
  assert.equal(serialized.includes("Private account"), false);
  assert.equal(serialized.includes("private-token"), false);
  assert.equal(serialized.includes("/records/123"), false);
  assert.equal(compiled.bindings.get("candidate_1").identity, "candidate_private_record");
  assert.equal(compiled.bindings.get("candidate_1").signature.name, "Open private account record");
});

test("workflow observation projection exposes labels only on opt-in and reports candidate truncation", () => {
  const observed = observation({
    candidates: [
      ...observation().candidates,
      { ...observation().candidates[0], identity: "candidate_second", name: "Open second record" }
    ],
    scrollTargets: [{ identity: "scroll_records", name: "Records list", role: "container", tag: "div", visible: true }]
  });
  const compiled = compileWorkflowObservation(observed, { includeLabels: true, maxCandidates: 1 });

  assert.equal(compiled.projection.candidates.length, 1);
  assert.equal(compiled.projection.candidates[0].label, "Open private account record");
  assert.equal(compiled.projection.candidates[0].context, "Account 123");
  assert.equal(compiled.projection.candidates[0].href, "https://records.example/records/123?secret=private-token");
  assert.equal(compiled.coverageComplete, false);
  assert.equal(compiled.projection.candidateCoverage.disposition, "incomplete");
});
