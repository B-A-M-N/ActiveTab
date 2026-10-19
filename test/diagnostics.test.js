import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticContract, validateAccess, SENSITIVITY, AUTHORITY, OPERATION } from "../src/diagnostics/contracts.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";
import { DiagnosticCorrelator, CORRELATION_STRENGTH } from "../src/diagnostics/correlator.js";
import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS, deriveRunInvestigationStatus } from "../src/diagnostics/report.js";
import { assertRedactedEvidenceOnly } from "../src/diagnostics/evidenceReleasePolicy.js";

test("diagnostic contract requires id, authority, scope, sensitivity", () => {
  assert.throws(() => createDiagnosticContract({}), /requires an id/);
  assert.throws(() => createDiagnosticContract({ id: "x" }), /unknown authority/);
  assert.throws(() => createDiagnosticContract({ id: "x", authority: AUTHORITY.BROWSER_CDP }), /unknown operation/);
  assert.throws(() => createDiagnosticContract({ id: "x", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ] }), /scope is required/);
  assert.throws(() => createDiagnosticContract({ id: "x", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ], scope: "s", sensitivity: "bad" }), /unknown sensitivity/);
  const contract = createDiagnosticContract({
    id: "test", authority: AUTHORITY.APPLICATION_SESSION,
    operations: [OPERATION.READ], scope: "run-scoped", sensitivity: SENSITIVITY.METADATA_ONLY
  });
  assert.equal(contract.id, "test");
  assert.deepEqual(contract.operations, [OPERATION.READ]);
  assert.equal(Object.isFrozen(contract), true);
});

test("validateAccess denies operations not in the contract", () => {
  const contract = createDiagnosticContract({
    id: "ro", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ],
    scope: "test", sensitivity: SENSITIVITY.METADATA_ONLY
  });
  assert.equal(validateAccess(contract, OPERATION.READ), null);
  const denial = validateAccess(contract, OPERATION.READ_SCOPED);
  assert.match(denial, /does not permit/);
});

test("MCP evidence release rejects caller-set sensitive retrieval flags", () => {
  assert.doesNotThrow(() => assertRedactedEvidenceOnly({ includeSensitive: false }, ["includeSensitive"]));
  assert.throws(
    () => assertRedactedEvidenceOnly({ includeSensitive: true }, ["includeSensitive"]),
    error => error.message === "Sensitive browser evidence cannot be released through MCP without a separately authenticated evidence grant."
  );
});

test("collector registers sources and enforces contracts", async () => {
  const collector = new DiagnosticCollector({ runId: "run-1" });
  let calls = 0;
  collector.register(
    createDiagnosticContract({
      id: "browser-net", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ],
      scope: "network", sensitivity: SENSITIVITY.METADATA_ONLY, rateLimit: { maxCalls: 2 }
    }),
    async () => { calls++; return { requests: [] }; }
  );
  assert.equal(collector.hasSource("browser-net"), true);
  assert.equal(collector.listSources()[0].authority, "browser_cdp");

  const snap = await collector.collect("browser-net", OPERATION.READ);
  assert.equal(snap.sourceId, "browser-net");
  assert.equal(snap.runId, "run-1");
  assert.equal(calls, 1);
  // Rate limit enforced
  await collector.collect("browser-net", OPERATION.READ);
  await assert.rejects(() => collector.collect("browser-net", OPERATION.READ), /rate limit/);
  // Unknown source
  await assert.rejects(() => collector.collect("nope", OPERATION.READ), /not registered/);
  // Denied operation
  await assert.rejects(() => collector.collect("browser-net", OPERATION.READ_SCOPED), /does not permit/);
});

test("collector collectAll handles mixed success and failure", async () => {
  const collector = new DiagnosticCollector({ runId: "run-2" });
  collector.register(
    createDiagnosticContract({ id: "ok", authority: AUTHORITY.LOCAL_FIXTURE, operations: [OPERATION.READ], scope: "t", sensitivity: SENSITIVITY.METADATA_ONLY }),
    async () => ({ ok: true })
  );
  collector.register(
    createDiagnosticContract({ id: "fail", authority: AUTHORITY.LOCAL_FIXTURE, operations: [OPERATION.READ], scope: "t", sensitivity: SENSITIVITY.METADATA_ONLY }),
    async () => { throw new Error("boom"); }
  );
  const results = await collector.collectAll([
    { sourceId: "ok", operation: OPERATION.READ },
    { sourceId: "fail", operation: OPERATION.READ },
    { sourceId: "nope", operation: OPERATION.READ }
  ]);
  assert.equal(results[0].status, "ok");
  assert.equal(results[1].status, "error");
  assert.match(results[1].error, /boom/);
  assert.equal(results[2].status, "error");
  assert.match(results[2].error, /not registered/);
});

test("correlator requires scoped verified evidence and treats generic matches as weak", () => {
  const corr = new DiagnosticCorrelator({ temporalWindowMs: 1000 });
  const scope = { environmentId: "staging", targetId: "tab-1", runId: "run-1", principalId: "owner-1", operationNamespace: "cloud_agent.run" };
  const correlation = {
    namespace: "cloud-agent-run", value: "run-abc", pairKind: "freeinference_cloud_agent_run",
    provenance: "verified_in_browser_and_backend", scope, evidenceRefs: ["browser-evidence", "backend-evidence"]
  };
  corr.addEvent({ eventId: "a", evidenceId: "browser-evidence", traceId: "abc-123", correlation, observedAt: "2026-01-01T00:00:00.000Z", sourceType: "browser_ui" });
  corr.addEvent({ eventId: "b", evidenceId: "backend-evidence", traceId: "abc-123", correlation, observedAt: "2026-01-01T00:00:00.500Z", sourceType: "cloud_agent_backend" });
  corr.addEvent({ eventId: "c", observedAt: "2026-01-01T00:00:01.000Z", sourceType: "http", origin: "http://x", operationType: "navigate" });
  corr.addEvent({ eventId: "d", observedAt: "2026-01-01T00:00:01.200Z", sourceType: "http", origin: "http://x", operationType: "navigate" });
  corr.addEvent({ eventId: "e", observedAt: "2026-01-01T00:00:09.000Z" });

  // direct: shared traceId
  let link = corr.correlate("a", "b");
  assert.equal(link.strength, "direct");
  assert.deepEqual(link.evidence.evidenceRefs, ["backend-evidence", "browser-evidence"]);

  // Same source, origin, and operation are not causal proof.
  link = corr.correlate("c", "d");
  assert.equal(link.strength, "temporal");

  // Probable correlation requires an explicit, scoped pair-specific rule.
  const inferred = { ...correlation, value: "run-inferred", pairKind: "workflow_step_diagnostic", provenance: "pair_specific_inference", evidenceRefs: ["inferred-a", "inferred-b"] };
  corr.addEvent({ eventId: "inferred-a", evidenceId: "inferred-a", sourceType: "browser_action", correlation: inferred, observedAt: "2026-01-01T00:00:02.000Z" });
  corr.addEvent({ eventId: "inferred-b", evidenceId: "inferred-b", sourceType: "diagnostic_snapshot", correlation: inferred, observedAt: "2026-01-01T00:00:02.100Z" });
  link = corr.correlate("inferred-a", "inferred-b");
  assert.equal(link.strength, "probable");

  // temporal: near but no shared ids or ≥2 signals
  const corr2 = new DiagnosticCorrelator({ temporalWindowMs: 1000 });
  corr2.addEvent({ eventId: "x", observedAt: "2026-01-01T00:00:00.000Z" });
  corr2.addEvent({ eventId: "y", observedAt: "2026-01-01T00:00:00.500Z" });
  link = corr2.correlate("x", "y");
  assert.equal(link.strength, "temporal");

  // unknown: far apart, nothing shared
  const corr3 = new DiagnosticCorrelator({ temporalWindowMs: 1000 });
  corr3.addEvent({ eventId: "p", observedAt: "2026-01-01T00:00:00.000Z" });
  corr3.addEvent({ eventId: "q", observedAt: "2026-01-01T00:00:09.000Z" });
  link = corr3.correlate("p", "q");
  assert.equal(link.strength, "unknown");
});

test("same identifier with mismatched target scope cannot be direct", () => {
  const corr = new DiagnosticCorrelator({ temporalWindowMs: 1000 });
  const correlation = targetId => ({
    namespace: "cloud-agent-run", value: "same-id", pairKind: "freeinference_cloud_agent_run",
    provenance: "verified_in_browser_and_backend",
    scope: { environmentId: "staging", targetId, runId: "run-1", principalId: "owner-1", operationNamespace: "cloud_agent.run" },
    evidenceRefs: ["browser-evidence", "backend-evidence"]
  });
  corr.addEvent({ eventId: "browser", evidenceId: "browser-evidence", executionId: "same-id", sourceType: "browser_ui", correlation: correlation("tab-1"), observedAt: "2026-01-01T00:00:00.000Z" });
  corr.addEvent({ eventId: "backend", evidenceId: "backend-evidence", executionId: "same-id", sourceType: "cloud_agent_backend", correlation: correlation("tab-2"), observedAt: "2026-01-01T00:00:00.100Z" });
  assert.equal(corr.correlate("browser", "backend").strength, "temporal");
});

test("correlator summary reports only the established correlation strength", () => {
  const corr = new DiagnosticCorrelator();
  const correlation = {
    namespace: "cloud-agent-run", value: "t1", pairKind: "freeinference_cloud_agent_run",
    provenance: "verified_in_browser_and_backend",
    scope: { environmentId: "staging", targetId: "tab-1", runId: "run-1", principalId: "owner-1", operationNamespace: "cloud_agent.run" },
    evidenceRefs: ["browser-proof", "backend-proof"]
  };
  corr.addEvent({ eventId: "a", evidenceId: "browser-proof", sourceType: "browser_ui", correlation });
  corr.addEvent({ eventId: "b", evidenceId: "backend-proof", sourceType: "cloud_agent_backend", correlation });
  corr.correlate("a", "b");
  const summary = corr.summary();
  assert.equal(summary.totalLinks, 1);
  assert.equal(summary.counts.direct, 1);
});

test("report supports findings, limitations, and redaction", () => {
  const report = new DiagnosticReport({ runId: "run-9" });
  report.addFinding({
    level: FINDING_LEVEL.CONFIRMED, subject: "Login failure",
    description: "Server returned 401 after valid token.", evidenceIds: ["ev-1", "ev-2"]
  });
  report.addLimitation("Backend logs were not available.");
  report.setInvestigationStatus(INVESTIGATION_STATUS.BUDGET_EXHAUSTED);
  report.setCorrelationSummary({ totalLinks: 3, counts: { direct: 1, probable: 1, temporal: 1, unknown: 0 } });
  report.logSourceAccess({ sourceId: "browser-net", operation: "read", status: "ok" });
  report.logSourceAccess({ sourceId: "admin", operation: "read", status: "error", error: "Unauthorized" });

  const obj = report.toObject();
  assert.equal(obj.findings.length, 1);
  assert.equal(obj.findings[0].level, "confirmed");
  assert.equal(obj.investigationStatus, "budget_exhausted");
  assert.equal(obj.sourceAccessLog[1].error, "Unauthorized");

  const redacted = report.redacted();
  assert.equal(redacted.findings[0].level, "confirmed");
  assert.equal(redacted.sourceAccessLog[1].error, undefined);
});

test("run report status requires durable terminal state, reconciled effects, and verified cleanup", () => {
  const receipt = {
    status: "PASSED",
    finishedAt: "2026-10-17T12:00:00.000Z",
    steps: [{ stepId: "submit", status: "PASS" }],
    cleanup: []
  };
  assert.equal(deriveRunInvestigationStatus({
    receipt,
    durableRunStatus: "passed"
  }).status, INVESTIGATION_STATUS.COMPLETE);

  assert.equal(deriveRunInvestigationStatus({
    receipt: { ...receipt, status: "UNCERTAIN" },
    durableRunStatus: "reconciling"
  }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
  assert.equal(deriveRunInvestigationStatus({
    receipt: { ...receipt, status: "BLOCKED" },
    durableRunStatus: "blocked"
  }).status, INVESTIGATION_STATUS.BLOCKED);
  assert.equal(deriveRunInvestigationStatus({
    receipt,
    durableRunStatus: "resume_validation"
  }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
  assert.equal(deriveRunInvestigationStatus({
    receipt,
    durableRunStatus: "passed",
    testOwnedResources: [{ resourceId: "fixture-1", cleanupStatus: "observed" }]
  }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
});

test("Cloud Agent report remains inconclusive until exact backend correlation and requested sources are present", () => {
  const receipt = {
    status: "PASSED",
    finishedAt: "2026-10-17T12:00:00.000Z",
    steps: [{ stepId: "submit", status: "PASS" }],
    cleanup: []
  };
  const integration = {
    verificationRequired: true,
    outcomeStatus: "VERIFIED",
    correlationStrength: "direct",
    cloudAgentRunId: "agent-run-42",
    diagnosticSources: ["cloud-agent-steps", "cloud-agent-usage"]
  };
  const diagnosticResults = [
    { sourceId: "cloud-agent-runs", status: "ok", snapshot: { data: { status: "available", records: [{ id: "agent-run-42" }] } } },
    { sourceId: "cloud-agent-steps", status: "ok", snapshot: { data: { status: "available", records: [] } } },
    { sourceId: "cloud-agent-usage", status: "ok", snapshot: { data: { status: "available", records: [] } } }
  ];
  const assess = extra => deriveRunInvestigationStatus({
    receipt,
    durableRunStatus: "passed",
    integration,
    diagnosticResults,
    ...extra
  });

  assert.equal(assess({}).status, INVESTIGATION_STATUS.COMPLETE);
  assert.equal(assess({ diagnosticResults: diagnosticResults.slice(0, 2) }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
  assert.equal(assess({
    integration: { ...integration, diagnosticSources: [] },
    diagnosticResults: diagnosticResults.slice(0, 1)
  }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
  assert.equal(assess({ integration: { ...integration, correlationStrength: "temporal" } }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
  assert.equal(assess({ diagnosticResults: [
    { ...diagnosticResults[0], snapshot: { data: { status: "available", records: [{ id: "another-run" }] } } },
    ...diagnosticResults.slice(1)
  ] }).status, INVESTIGATION_STATUS.INCONCLUSIVE);
});

test("report rejects unknown finding levels", () => {
  const report = new DiagnosticReport({ runId: "r" });
  assert.throws(() => report.addFinding({ level: "bad", subject: "s", description: "d" }), /Unknown finding level/);
});
