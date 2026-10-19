import test from "node:test";
import assert from "node:assert/strict";
import { InvestigationEngine, FAILURE_CLASSIFICATION, CAUSAL_CONFIDENCE } from "../src/investigation/engine.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../src/diagnostics/contracts.js";
import { DiagnosticCorrelator } from "../src/diagnostics/correlator.js";
import { FINDING_LEVEL, INVESTIGATION_STATUS } from "../src/diagnostics/report.js";

function createMockCollector() {
  const collector = new DiagnosticCollector({ runId: "inv-test" });
  collector.register(
    createDiagnosticContract({ id: "browser-network", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ], scope: "t", sensitivity: SENSITIVITY.METADATA_ONLY }),
    async () => ({ requests: [{ method: "GET", url: "http://api.test/data", status: 500 }] })
  );
  collector.register(
    createDiagnosticContract({ id: "browser-lifecycle", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ], scope: "t", sensitivity: SENSITIVITY.METADATA_ONLY }),
    async () => ({ events: [{ event: "Page.frameNavigated", url: "http://app.test/login" }] })
  );
  return collector;
}

test("investigation classifies navigation failures", async () => {
  const collector = createMockCollector();
  const engine = new InvestigationEngine({ collector });
  const result = await engine.investigate({ subject: "Navigation failed", reason: "Page.navigate to /archive returned an unexpected URL." });
  assert.equal(result.classification, FAILURE_CLASSIFICATION.NAVIGATION);
  assert.ok(result.hypotheses.length >= 2);
  assert.ok(result.report.findings.length >= 2);
});

test("investigation classifies authorization failures", async () => {
  const collector = createMockCollector();
  const engine = new InvestigationEngine({ collector });
  const result = await engine.investigate({ subject: "Admin operation", reason: "403 Unauthorized for admin endpoint." });
  assert.equal(result.classification, FAILURE_CLASSIFICATION.AUTHORIZATION);
  assert.ok(result.hypotheses.some(h => h.confidence === CAUSAL_CONFIDENCE.LIKELY || h.confidence === CAUSAL_CONFIDENCE.BLOCKED));
});

test("stable reason codes take precedence over exception-like prose", async () => {
  const result = await new InvestigationEngine({}).investigate({
    subject: "Browser operation",
    reason: "The model endpoint returned an unrelated navigation timeout.",
    reasonCode: "authorization_denied"
  });
  assert.equal(result.classification, FAILURE_CLASSIFICATION.AUTHORIZATION);
  assert.equal(result.classificationBasis, "stable_reason_code");
  assert.equal(result.failureCode, "authorization_denied");
  assert.equal(result.automatedContinuationPermitted, false);

  const unknown = await new InvestigationEngine({}).investigate({
    subject: "Browser operation",
    reason: "403 Unauthorized",
    reasonCode: "unregistered_failure_code"
  });
  assert.equal(unknown.classification, FAILURE_CLASSIFICATION.UNKNOWN);
  assert.equal(unknown.classificationBasis, "unrecognized_reason_code");
});

test("investigation classifies network failures and inspects response status", async () => {
  const collector = createMockCollector();
  const engine = new InvestigationEngine({ collector });
  const result = await engine.investigate({ subject: "API request", reason: "Expected network request was not observed." });
  assert.equal(result.classification, FAILURE_CLASSIFICATION.NETWORK);
  assert.ok(result.executedChecks.length >= 2);
});

test("investigation generates hypotheses for unknown failures", async () => {
  const collector = createMockCollector();
  const engine = new InvestigationEngine({ collector });
  const result = await engine.investigate({ subject: "Something broke", reason: "Kaboom." });
  assert.equal(result.classification, FAILURE_CLASSIFICATION.UNKNOWN);
  assert.ok(result.hypotheses.length >= 2);
});

test("investigation report keeps unscoped shared identifiers below direct correlation", async () => {
  const collector = createMockCollector();
  const correlator = new DiagnosticCorrelator();
  correlator.addEvent({ eventId: "a", traceId: "t1" });
  correlator.addEvent({ eventId: "b", traceId: "t1" });
  correlator.correlate("a", "b");
  const engine = new InvestigationEngine({ collector, correlator });
  const result = await engine.investigate({ subject: "Test", reason: "Expected element was not visible." });
  const report = result.report.toObject();
  assert.ok(report.findings.length > 0);
  assert.ok(report.correlationSummary);
  assert.equal(report.correlationSummary.counts.direct, 0);
  assert.equal(report.correlationSummary.counts.temporal, 1);
});

test("investigation respects maxHypotheses and maxChecks", async () => {
  const collector = createMockCollector();
  const engine = new InvestigationEngine({ collector, maxHypotheses: 2, maxChecks: 2 });
  const result = await engine.investigate({ subject: "Nav", reason: "Page navigate error" });
  assert.ok(result.hypotheses.length <= 2);
  assert.ok(result.executedChecks.length <= 2);
});

test("investigation respects cancellation", async () => {
  const collector = createMockCollector();
  const controller = new AbortController();
  controller.abort();
  const engine = new InvestigationEngine({ collector, signal: controller.signal });
  const result = await engine.investigate({ subject: "Test", reason: "Page error" });
  assert.ok(result.executedChecks.length === 0);
});

test("investigating consequential or asynchronous effects inspects evidence and never replays them", async () => {
  let dispatches = 0;
  const scenarios = [
    { action: "submit", operationClass: "form_submission" },
    { action: "click", operationClass: "payment_like" },
    { action: "click", operationClass: "job_creation" },
    { action: "delete", operationClass: "deletion" },
    { action: "click", operationClass: "external_async" }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const runId = `uncertain-effect-${index}`;
    let runReads = 0;
    const runStateStore = {
      async getFresh(requestedRunId) {
        runReads++;
        assert.equal(requestedRunId, runId);
        return {
          runId,
          status: "uncertain",
          pendingOperations: [{
            operationId: `effect-operation-${index}`,
            stepId: "effect-step",
            action: scenario.action,
            operationClass: scenario.operationClass,
            status: "DISPATCHED",
            targetId: "target-a",
            reservedAt: "2026-10-18T12:00:00.000Z",
            dispatchedAt: "2026-10-18T12:00:01.000Z",
            receiptId: `dispatch-receipt-${index}`
          }],
          uncertainOperations: []
        };
      }
    };
    const engine = new InvestigationEngine({
      runStateStore,
      testRunner: { async run() { dispatches++; } }
    });
    const result = await engine.investigate({
      subject: `${scenario.operationClass} outcome`,
      reason: `Runtime issue after ${scenario.operationClass}`,
      runId,
      stepId: "effect-step",
      operationId: `effect-operation-${index}`,
      workflow: { steps: [{ id: "effect-step", type: "interact", action: scenario.action }] }
    });
    const check = result.executedChecks.find(item => item.check === "inspect prior dispatch evidence without replay");
    assert.ok(check, scenario.operationClass);
    assert.equal(check.status, "UNCERTAIN", scenario.operationClass);
    assert.equal(check.evidence.effectDisposition, "may_have_dispatched_or_still_be_in_flight");
    assert.deepEqual(check.evidence.operation.evidenceIds, [`dispatch-receipt-${index}`]);
    assert.equal(runReads, 1, scenario.operationClass);
    assert.equal(result.report.investigationStatus, INVESTIGATION_STATUS.INCONCLUSIVE);
  }
  assert.equal(dispatches, 0, "investigation must never execute the workflow again");
});

test("investigation reports observed-value structure without copying raw content", async () => {
  const secret = "caller-private-value-DO-NOT-REPORT";
  const engine = new InvestigationEngine({});
  const result = await engine.investigate({
    subject: "Assertion mismatch",
    reason: "Assertion did not match expected text.",
    observedValue: secret
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  const check = result.executedChecks.find(item => item.check === "log the actual observed value for the caller to evaluate");
  assert.deepEqual(check.evidence.observedValue, {
    redacted: true,
    valueType: "string",
    characterLength: secret.length,
    byteLength: Buffer.byteLength(secret)
  });
});

test("network investigation keeps full request URLs out of evidence projections", async () => {
  const secret = "fixture-access-secret-981";
  const beforeUrl = `https://api.example.test/users/alice?access_token=${secret}`;
  const afterUrl = `${beforeUrl}&email=alice%40example.test`;
  const collector = {
    getSnapshots() {
      return [
        { snapshotId: "before", sourceId: "browser-network", operation: "read", collectedAt: "2026-10-18T12:00:00.000Z", data: { requests: [{ method: "GET", url: beforeUrl, status: 200 }] } },
        { snapshotId: "after", sourceId: "browser-network", operation: "read", collectedAt: "2026-10-18T12:00:01.000Z", data: { requests: [{ method: "GET", url: afterUrl, status: 500 }] } }
      ];
    }
  };
  const result = await new InvestigationEngine({ collector }).investigate({ subject: "API request", reason: "Expected network request was not observed." });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("alice@example.test"), false);
  assert.equal(serialized.includes(afterUrl), false);
  const activityCheck = result.executedChecks.find(item => item.check === "compare network activity before and after the action");
  assert.equal(activityCheck.evidence.newRequests[0].url.queryParameterCount, 2);
  assert.equal(activityCheck.evidence.newRequests[0].url.pathDepth, 2);
  const statusCheck = result.executedChecks.find(item => item.check === "inspect the response status of matching requests");
  assert.equal(statusCheck.evidence.requests[0].status, 500);
});
