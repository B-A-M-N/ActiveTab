import test from "node:test";
import assert from "node:assert/strict";
import { selectAuthorizedStagingTarget } from "../src/testing/qualifyTarget.js";

const environment = {
  environmentId: "freeinference-staging",
  authorizedOrigins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"]
};

test("attached qualification selects the exact authorized target before checking its staging identity", () => {
  const targets = [
    { id: "other-staging-tab", url: "https://staging.freeinference.org/dashboard" },
    { id: "authorized-tab", url: "https://agents-staging.freeinference.org/runs" }
  ];

  const selected = selectAuthorizedStagingTarget(targets, "authorized-tab", environment);

  assert.equal(selected.ok, true);
  assert.equal(selected.target.id, "authorized-tab");
  assert.equal(selected.identity.origin, "https://agents-staging.freeinference.org");
});

test("an authorized target on production is refused even when another staging tab exists", () => {
  const targets = [
    { id: "staging-tab", url: "https://staging.freeinference.org/dashboard" },
    { id: "authorized-tab", url: "https://freeinference.org/dashboard" }
  ];

  const selected = selectAuthorizedStagingTarget(targets, "authorized-tab", environment);

  assert.equal(selected.ok, false);
  assert.equal(selected.target.id, "authorized-tab");
  assert.match(selected.reason, /not authorized/);
});

test("a missing exact target is refused instead of adopting another staging tab", () => {
  const selected = selectAuthorizedStagingTarget([
    { id: "staging-tab", url: "https://staging.freeinference.org/dashboard" }
  ], "authorized-tab", environment);

  assert.equal(selected.ok, false);
  assert.match(selected.reason, /not currently available/);
});
