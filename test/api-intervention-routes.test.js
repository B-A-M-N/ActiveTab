import test from "node:test";
import assert from "node:assert/strict";
import { createInterventionRoutes } from "../src/api/routes/interventions.js";

function createHarness({ authorize = true, operator = "operator-1", body = {}, tools = {} } = {}) {
  const calls = [];
  const responses = [];
  const route = createInterventionRoutes({
    authorizeMutation: request => { calls.push(["api-auth", request]); return authorize; },
    authenticateOperator: async request => { calls.push(["operator-auth", request]); return operator; },
    interventionTools: tools,
    readBody: async request => { calls.push(["read-body", request]); return body; },
    sendJson: (_response, status, value) => responses.push({ status, value }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message })
  });
  return { route, calls, responses };
}

test("intervention routes keep ordinary API authorization for status endpoints", async () => {
  const request = {};
  const harness = createHarness({ authorize: false });
  const handled = await harness.route(request, {}, { method: "GET", path: "/v1/interventions" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["api-auth", request]]);
  assert.deepEqual(harness.responses, [{ status: 401, code: 99401, message: "Authentication required." }]);
});

test("approval resolution checks the independent operator before parsing caller input", async () => {
  const request = {};
  const harness = createHarness({ operator: null });
  const handled = await harness.route(request, {}, { method: "POST", path: "/v1/interventions/int-1/resolve" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["operator-auth", request]]);
  assert.deepEqual(harness.responses, [{ status: 403, code: 99403, message: "Independent operator authentication required." }]);
});

test("approval resolution rejects request-supplied operator identity without using API auth", async () => {
  const request = {};
  const harness = createHarness({ body: { authenticatedOperator: "forged", expectedRevision: 1 } });
  const handled = await harness.route(request, {}, { method: "POST", path: "/v1/interventions/int-1/resolve" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls.map(([name]) => name), ["operator-auth", "read-body"]);
  assert.deepEqual(harness.responses, [{
    status: 400,
    code: 99001,
    message: "Operator identity is derived from the authenticated operator session."
  }]);
});

test("unmatched intervention actions preserve the family 404 response", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, {
    method: "POST",
    path: "/v1/interventions/int-1/unknown"
  });

  assert.equal(handled, true);
  assert.deepEqual(harness.responses, [{ status: 404, code: 99404, message: "No such intervention resource." }]);
});

test("run-state endpoint is matched before the generic intervention identifier route", async () => {
  const harness = createHarness({
    tools: { async get_run_state(input) { return { runId: input.runId }; } }
  });
  const handled = await harness.route({}, {}, {
    method: "GET",
    path: "/v1/interventions/run-state",
    query: { runId: "run-7" }
  });

  assert.equal(handled, true);
  assert.deepEqual(harness.responses, [{ status: 200, value: { runId: "run-7" } }]);
});

test("non-intervention routes are left to the API composition layer", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, { method: "GET", path: "/v1/evidence/releases/audit" });

  assert.equal(handled, false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, []);
});
