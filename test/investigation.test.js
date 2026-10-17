import test from "node:test";
import assert from "node:assert/strict";
import { InvestigationEngine, FAILURE_CLASSIFICATION, CAUSAL_CONFIDENCE } from "../src/investigation/engine.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../src/diagnostics/contracts.js";
import { DiagnosticCorrelator } from "../src/diagnostics/correlator.js";
import { FINDING_LEVEL } from "../src/diagnostics/report.js";

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

test("investigation report includes findings and correlation summary", async () => {
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
  assert.equal(report.correlationSummary.counts.direct, 1);
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
