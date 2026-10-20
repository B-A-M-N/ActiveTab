import test from "node:test";
import assert from "node:assert/strict";
import { createTestRunRoutes } from "../src/api/routes/testRuns.js";

function createHarness({ authorized = true } = {}) {
  const calls = [];
  const responses = [];
  const handlers = Object.fromEntries([
    "handleStartTestRun", "handleGetTestRun", "handleResumeTestRun", "handleCancelTestRun",
    "handleCollectTestRunDiagnostics", "handleGetTestReport"
  ].map(name => [name, async (...args) => calls.push([name, ...args])]));
  const route = createTestRunRoutes({
    authorizeMutation: request => { calls.push(["auth", request]); return authorized; },
    ...handlers,
    sendError: (_response, status, code, message) => responses.push({ status, code, message })
  });
  return { route, calls, responses };
}

test("test-run route leaves unrelated paths to API composition", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, { method: "GET", path: "/v1/evidence/releases/audit" });

  assert.equal(handled, false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, []);
});

test("test-run creation requires API authentication before lifecycle dispatch", async () => {
  const request = {};
  const harness = createHarness({ authorized: false });
  const handled = await harness.route(request, {}, { method: "POST", path: "/v1/test/runs" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["auth", request]]);
  assert.deepEqual(harness.responses, [{ status: 401, code: 99401, message: "Authentication required." }]);
});

test("test-run resume dispatch keeps the matched run ID", async () => {
  const request = {};
  const harness = createHarness();
  const handled = await harness.route(request, {}, { method: "POST", path: "/v1/test/runs/run-7/resume" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["auth", request], ["handleResumeTestRun", request, {}, "run-7"]]);
  assert.deepEqual(harness.responses, []);
});

test("unsupported methods on recognized test-run resources keep the 405 response", async () => {
  const request = {};
  const harness = createHarness();
  const handled = await harness.route(request, {}, { method: "DELETE", path: "/v1/test/runs/run-7/report" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["auth", request]]);
  assert.deepEqual(harness.responses, [{
    status: 405,
    code: 99405,
    message: "Method not allowed for this test-run resource."
  }]);
});
