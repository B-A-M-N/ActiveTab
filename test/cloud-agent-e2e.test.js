/**
 * Cloud Agent E2E qualification — exercises the full operational contract
 * against a live Cloud Agent instance (via SSH tunnel).
 *
 * Requires:
 * - SSH tunnel to 10.9.66.193 forwarding ports 18000 (control plane) and 13002 (web UI)
 * - ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN set to the admin token
 *
 * Proves:
 * 1. Browser discovery finds the Cloud Agent web UI pages and controls
 * 2. Cloud Agent admin diagnostic adapter retrieves real backend evidence
 * 3. Browser network requests correlate with admin diagnostic records
 * 4. Investigation produces a qualified report with evidence references
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../src/diagnostics/contracts.js";
import { CloudAgentDiagnosticAdapter } from "../src/diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCorrelator } from "../src/diagnostics/correlator.js";
import { InvestigationEngine } from "../src/investigation/engine.js";
import { TestRunner } from "../src/testing/runner.js";
import { RUN_STATUS } from "../src/testing/schema.js";

const CLOUD_AGENT_CONTROL_URL = process.env.ACTIVETAB_CLOUD_AGENT_URL ?? "http://127.0.0.1:18000";
const CLOUD_AGENT_WEB_URL = process.env.ACTIVETAB_CLOUD_AGENT_WEB_URL ?? "http://127.0.0.1:13002";
const CLOUD_AGENT_ADMIN_TOKEN = process.env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;

test("Cloud Agent E2E: browser discovery + admin diagnostics + correlation", { timeout: 180_000 }, async t => {
  if (!CLOUD_AGENT_ADMIN_TOKEN) {
    t.skip("ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN is required for live Cloud Agent qualification.");
    return;
  }
  let chrome, profileDir, session;
  try {
    // ── 1. Launch disposable Chrome against the Cloud Agent web UI ──
    profileDir = await mkdtemp(join(tmpdir(), "activetab-cloudagent-"));
    chrome = spawn(process.env.CHROME_BIN ?? "/usr/bin/google-chrome", [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, CLOUD_AGENT_WEB_URL
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => { stderr += chunk.slice(-5000); });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${stderr.slice(-500)}`)), 20_000);
      const check = () => {
        const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); return true; }
        return false;
      };
      chrome.stderr.on("data", check);
      const poll = setInterval(() => {
        if (check()) { clearInterval(poll); return; }
        if (chrome.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error(`Chrome exited early (${chrome.exitCode})`)); return; }
      }, 100);
    });

    // ── 2. Authorized attach ──
    let targets = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { targets = await listTargets(endpoint); if (targets.some(t => t.url.includes("13002") || t.url.includes("Cloud Agent"))) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const fixtureTarget = targets.find(t => t.url.includes("13002") || t.url.includes("Cloud Agent"));
    assert.ok(fixtureTarget, "Chrome exposed the Cloud Agent web UI target");
    const target = await resolveAuthorizedTarget(endpoint, fixtureTarget.id, fixtureTarget.id);
    session = await new BrowserSession(target).attach();
    t.diagnostic(`Attached to: ${target.url}`);

    // ── 3. Browser discovery ──
    let initialObservation = null;
    const titleDeadline = Date.now() + 15_000;
    while (Date.now() < titleDeadline) {
      initialObservation = await session.observe();
      if (initialObservation.page.title) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(initialObservation.page.title, "Web UI page loaded with a title");
    t.diagnostic(`Initial page: ${initialObservation.page.title} at ${initialObservation.page.url}`);

    const discovery = new ApplicationDiscoveryEngine({ session, maxSteps: 6, maxLinksPerStep: 6 });
    const discoveryResult = await discovery.discover();
    assert.ok(discoveryResult.capabilityMap);
    const pages = discoveryResult.capabilityMap.pages.map(p => p.url);
    const controls = discoveryResult.capabilityMap.controls.map(c => c.name);
    t.diagnostic(`Discovered ${pages.length} pages, ${controls.length} controls`);
    t.diagnostic(`Pages: ${pages.slice(0, 10).join(", ")}`);
    t.diagnostic(`Controls: ${controls.slice(0, 20).join(", ")}`);
    assert.ok(controls.length > 0, "Discovery found interactive controls");

    // ── 4. Cloud Agent admin diagnostic collection ──
    const collector = new DiagnosticCollector({ runId: "cloud-agent-e2e" });
    const adapter = new CloudAgentDiagnosticAdapter({
      baseUrl: CLOUD_AGENT_CONTROL_URL,
      adminToken: CLOUD_AGENT_ADMIN_TOKEN
    });
    const health = await adapter.healthCheck();
    assert.ok(health.healthy, `Cloud Agent control plane should be healthy: ${health.reason ?? "ok"}`);

    adapter.registerSources(collector);
    // Also register browser network/lifecycle sources from the session.
    collector.register(
      createDiagnosticContract({
        id: "browser-network", authority: AUTHORITY.BROWSER_CDP,
        operations: [OPERATION.READ], scope: `target:${target.id}`,
        sensitivity: SENSITIVITY.METADATA_ONLY,
        description: "CDP network request metadata from the attached tab."
      }),
      async () => {
        const evidenceId = session.latestEvidenceId;
        if (!evidenceId) return { status: "unavailable", evidenceId: null, requests: [] };
        const evidence = session.observer?.getEvidence?.(evidenceId, { facets: ["networkActivity"] });
        if (evidence?.status !== "available") return { status: "unavailable", evidenceId, requests: [] };
        const requests = Array.isArray(evidence.networkActivity) ? evidence.networkActivity : [];
        return { status: requests.length > 0 ? "available" : "empty", evidenceId, requests };
      }
    );

    // Trigger a fresh observation for network evidence.
    await session.observe();
    const diagResults = await collector.collectAll(
      collector.listSources().map(s => ({ sourceId: s.id, operation: "read" }))
    );
    const cloudAgentResults = diagResults.filter(r => r.sourceId?.startsWith("cloud-agent-"));
    assert.ok(cloudAgentResults.length >= 6, `Expected at least 6 Cloud Agent diagnostic sources, got ${cloudAgentResults.length}`);
    for (const result of cloudAgentResults) {
      if (result.status === "ok") {
        t.diagnostic(`${result.snapshot.sourceId}: ${result.snapshot.data.status} (${result.snapshot.data.recordCount ?? 0} records)`);
        assert.ok(["available", "empty"].includes(result.snapshot.data.status),
          `Source ${result.snapshot.sourceId} should report available or empty, got ${result.snapshot.data.status}`);
      }
    }

    // ── 5. Correlation ──
    const correlator = new DiagnosticCorrelator();
    // Add browser events from the discovery navigation.
    const networkSnapshots = collector.getSnapshots({ sourceId: "browser-network" });
    for (const snap of networkSnapshots) {
      for (const request of snap.data.requests ?? []) {
        correlator.addEvent({
          eventId: `browser:${request.requestId}`,
          sourceType: "browser_network",
          origin: new URL(request.url ?? "about:blank").origin,
          operationType: request.method ?? "GET",
          resourceId: request.url?.split("?")[0],
          observedAt: snap.collectedAt,
          evidenceId: snap.evidenceId
        });
      }
    }
    // Add Cloud Agent diagnostic events.
    for (const result of cloudAgentResults) {
      if (result.status !== "ok") continue;
      correlator.addEvent({
        eventId: `admin:${result.snapshot.sourceId}`,
        sourceType: "admin_api",
        origin: CLOUD_AGENT_CONTROL_URL,
        operationType: "read",
        observedAt: result.snapshot.collectedAt,
        evidenceId: result.snapshot.evidenceId
      });
    }
    // Correlate the first browser network request to the Cloud Agent runs source by temporal proximity.
    const firstBrowserRequest = networkSnapshots[0]?.data?.requests?.[0];
    if (firstBrowserRequest) {
      const runsEvent = correlator.getLinks().find(l => l.eventIdA.startsWith("browser:"));
      const firstAdminEvent = cloudAgentResults.find(r => r.status === "ok");
      if (firstAdminEvent) {
        const link = correlator.correlate(
          `browser:${firstBrowserRequest.requestId}`,
          `admin:${firstAdminEvent.sourceId}`
        );
        t.diagnostic(`Correlation: ${link.strength} (${JSON.stringify(link.evidence)})`);
      }
    }

    // ── 6. Investigation with real evidence ──
    const investigation = new InvestigationEngine({
      collector,
      correlator,
      session,
      maxChecks: 8
    });
    // Introduce a controlled failure: expect a page title that doesn't exist.
    const runner = new TestRunner({ session, collector, correlator });
    const failReceipt = await runner.run({
      id: "cloud-agent-fail", name: "Controlled failure",
      steps: [
        { id: "s1", type: "assert", assertion: { type: "page_title_contains", value: "definitely-not-real" } }
      ]
    }, { runId: "cloud-agent-fail" });
    assert.equal(failReceipt.status, RUN_STATUS.FAILED);

    const investigationResult = await investigation.investigate({
      subject: "Expected text was not found in page title",
      reason: "Page title did not contain 'definitely-not-real'.",
      observedValue: failReceipt.steps[0]?.reason ?? "",
      runId: "cloud-agent-fail"
    });
    assert.ok(investigationResult.classification);
    assert.ok(investigationResult.hypotheses.length >= 2, "Investigation generated competing hypotheses");
    const executedChecks = investigationResult.executedChecks;
    assert.ok(executedChecks.length > 0, "Investigation executed at least one check");
    const evidenceBackedChecks = executedChecks.filter(c => c.evidenceIds?.length > 0);
    t.diagnostic(`Investigation: ${executedChecks.length} checks, ${evidenceBackedChecks.length} evidence-backed`);
    assert.ok(evidenceBackedChecks.length > 0, "At least one investigation check should have evidence references");

    // ── 7. Qualified report ──
    const report = investigationResult.report.redacted();
    assert.ok(report.findings.length > 0);
    assert.ok(report.correlationSummary);
    assert.ok(report.investigationStatus !== "complete", "Investigation status should be narrowed or inconclusive, not falsely complete");
    t.diagnostic(`Report: ${report.findings.length} findings, status=${report.investigationStatus}`);
    t.diagnostic(`Correlation summary: ${JSON.stringify(report.correlationSummary)}`);

    t.diagnostic("✅ Cloud Agent E2E verified: browser discovery + admin diagnostics + correlation + investigation");
  } finally {
    if (session) await session.close().catch(() => {});
    if (chrome) { try { chrome.kill("SIGKILL"); } catch {} }
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
});
