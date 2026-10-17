import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow, STEP_STATUS, STEP_TYPES } from "../src/testing/schema.js";
import { evaluateAssertion } from "../src/testing/assertions.js";
import { TestReceipt, deriveRunStatus } from "../src/testing/receipts.js";
import { RUN_STATUS } from "../src/testing/schema.js";
import { TestRunner } from "../src/testing/runner.js";

test("schema validates workflow structure", () => {
  assert.equal(validateWorkflow(null).valid, false);
  assert.equal(validateWorkflow({}).valid, false);
  assert.equal(validateWorkflow({ id: "x", name: "x", steps: [] }).valid, false);
  assert.equal(validateWorkflow({ id: "x", name: "x", steps: [{ id: "s1", type: "navigate" }] }).valid, false);
  const good = validateWorkflow({
    id: "wf-1", name: "Test workflow",
    steps: [
      { id: "s1", type: "navigate", url: "http://example.com" },
      { id: "s2", type: "assert", assertion: { type: "page_title_contains", value: "example" } },
      { id: "s3", type: "cleanup" }
    ]
  });
  assert.equal(good.valid, true);
  assert.deepEqual(good.errors, []);
});

test("schema rejects unknown step types", () => {
  const bad = validateWorkflow({
    id: "x", name: "x",
    steps: [{ id: "s1", type: "destroy_everything" }]
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => e.includes("not a recognized step type")));
});

test("assertions: page_title_contains", () => {
  const ctx = { observation: { page: { title: "Demo shop" } } };
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "demo" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "missing" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "x" }, {}).status, "UNCERTAIN");
});

test("assertions: candidate_name_contains requires a visible fresh UI control", () => {
  const ctx = { observation: {
    evidenceId: "agent-composer-1",
    candidates: [
      { name: "New task", visible: true },
      { name: "Hidden New task", visible: false }
    ]
  } };
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "new task" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "run" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "new task" }, {}).status, "UNCERTAIN");
});

test("assertions: url_matches", () => {
  const ctx = { observation: { page: { url: "http://127.0.0.1:3000/archive" } } };
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "/archive" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "/missing" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "[bad" }, ctx).status, "UNCERTAIN");
});

test("assertions: network_request_seen", () => {
  const mockCollector = {
    getSnapshots() {
      return [{ sourceId: "net", data: { requests: [{ url: "http://api.example.com/data" }] } }];
    }
  };
  const ctx = { collector: mockCollector };
  const pass = evaluateAssertion({ type: "network_request_seen", urlPattern: "api\\.example\\.com" }, ctx);
  assert.equal(pass.status, "PASS");
  const fail = evaluateAssertion({ type: "network_request_seen", urlPattern: "other\\.com" }, ctx);
  assert.equal(fail.status, "FAIL");
});

test("assertions: diagnostic_source_available requires collected evidence", () => {
  const registeredOnly = { hasSource: id => id === "src-1", getSnapshots: () => [] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: registeredOnly }).status, "UNCERTAIN");
  const notRegistered = { hasSource: () => false, getSnapshots: () => [] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-2" }, { collector: notRegistered }).status, "FAIL");
  const withEvidence = { hasSource: () => true, getSnapshots: () => [{ sourceId: "src-1", data: { status: "available", requests: [] } }] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: withEvidence }).status, "PASS");
  const emptyEvidence = { hasSource: () => true, getSnapshots: () => [{ sourceId: "src-1", data: { status: "empty", requests: [] } }] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: emptyEvidence }).status, "UNCERTAIN");
});

test("receipts record steps and derive status", () => {
  const receipt = new TestReceipt({ runId: "r1", workflowId: "w1", workflowName: "Test" });
  receipt.recordStep({ stepId: "s1", type: "navigate", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.recordStep({ stepId: "s2", type: "assert", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.recordStep({ stepId: "s3", type: "cleanup", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.finish(deriveRunStatus(receipt.steps));
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(receipt.toObject().steps.length, 3);
});

test("deriveRunStatus handles mixed statuses", () => {
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "PASS" }]), "PASSED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "FAIL" }]), "FAILED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "BLOCKED" }]), "BLOCKED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "CANCELED" }]), "CANCELED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "UNCERTAIN" }]), "FAILED");
});

test("runner executes navigate + assert + cleanup", async t => {
  let navigateCalled = false;
  const mockSession = {
    async observe() {
      return { page: { title: "Archive", url: navigateCalled ? "http://fixture.local/archive" : "http://fixture.local/" }, candidates: [], evidenceId: "ev-1", pageChangeFingerprint: navigateCalled ? "changed" : "initial" };
    },
    async waitForChange() {},
    client: {
      async send(method, params) {
        if (method === "Page.navigate") { navigateCalled = true; return { frameId: "f1", loaderId: "l1" }; }
        throw new Error(`Unexpected CDP call ${method}`);
      }
    }
  };
  const runner = new TestRunner({ session: mockSession });
  const receipt = await runner.run({
    id: "wf-e2e", name: "Navigate to archive",
    steps: [
      { id: "nav-1", type: "navigate", url: "http://fixture.local/", waitMs: 10 },
      { id: "assert-1", type: "assert", assertion: { type: "page_title_contains", value: "archive" } },
      { id: "cleanup-1", type: "cleanup" }
    ]
  }, { runId: "run-t1" });

  // Cleanup with no action and no test-owned resources is a valid declaration.
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(receipt.steps.length, 3);
  assert.equal(receipt.steps[0].status, "PASS");
  assert.equal(receipt.steps[1].status, "PASS");
  assert.equal(receipt.steps[2].status, "PASS");
});

test("runner blocks unsupported step types and records reason", async () => {
  const runner = new TestRunner({ session: null });
  const receipt = await runner.run({
    id: "wf-block", name: "Blocked",
    steps: [{ id: "s1", type: "interact", action: { type: "click" } }]
  }, { runId: "run-t2" });
  assert.equal(receipt.status, RUN_STATUS.BLOCKED);
  assert.equal(receipt.steps[0].status, "BLOCKED");
});

test("runner validates workflow before executing", async () => {
  const runner = new TestRunner({ session: null });
  await assert.rejects(() => runner.run({ id: "bad" }), /Invalid workflow/);
});
