import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReleaseRoutes } from "../src/api/routes/evidenceReleases.js";

function createHarness({ operator = "operator-1", body = {}, store = {} } = {}) {
  const calls = [];
  const responses = [];
  const route = createEvidenceReleaseRoutes({
    authenticateOperator: async request => { calls.push(["operator-auth", request]); return operator; },
    getEvidenceReleaseStore: () => { calls.push(["get-store"]); return store; },
    readBody: async request => { calls.push(["read-body", request]); return body; },
    sendJson: (_response, status, value) => responses.push({ status, value }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message })
  });
  return { route, calls, responses };
}

test("non-evidence-release paths are left to API composition", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, { method: "GET", path: "/v1/test/runs/run-1/status" });

  assert.equal(handled, false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, []);
});

test("operator authentication happens before release-store access", async () => {
  const harness = createHarness({ operator: null });
  const handled = await harness.route({}, {}, { method: "GET", path: "/v1/evidence/releases/requests" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls.map(([name]) => name), ["operator-auth"]);
  assert.deepEqual(harness.responses, [{
    status: 403,
    code: 99403,
    message: "Independent operator authentication required."
  }]);
});

test("audit reads clamp limits to the bounded maximum", async () => {
  const harness = createHarness({ store: { audit: options => { harness.calls.push(["audit", options]); return []; } } });
  const handled = await harness.route({}, {}, {
    method: "GET",
    path: "/v1/evidence/releases/audit",
    query: { limit: "5000" }
  });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls.at(-1), ["audit", { limit: 1_000 }]);
  assert.deepEqual(harness.responses, [{ status: 200, value: { events: [] } }]);
});

test("approval rejects caller-supplied release scope", async () => {
  const harness = createHarness({ body: { expectedRevision: 1, operatorId: "forged" } });
  const handled = await harness.route({}, {}, {
    method: "POST",
    path: "/v1/evidence/releases/requests/request-1/approve"
  });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls.map(([name]) => name), ["operator-auth", "get-store", "read-body"]);
  assert.deepEqual(harness.responses, [{
    status: 400,
    code: 99001,
    message: "expectedRevision is required; request scope is fixed and cannot be changed during review."
  }]);
});
