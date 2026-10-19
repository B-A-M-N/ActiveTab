/**
 * Mandatory end-to-end qualification (file 2 section 10).
 * Demonstrates the full flow against a representative isolated local application:
 *   1. Authorized attach to a disposable Chrome + fixture
 *   2. Verified identity via passive observation
 *   3. Bounded autonomous discovery
 *   4. Declarative test workflow execution
 *   5. Diagnostic collection and correlation
 *   6. Controlled failure and investigation
 *   7. Qualified diagnostic report
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { TestRunner } from "../src/testing/runner.js";
import { RUN_STATUS } from "../src/testing/schema.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../src/diagnostics/contracts.js";
import { DiagnosticCorrelator } from "../src/diagnostics/correlator.js";
import { InvestigationEngine } from "../src/investigation/engine.js";
import { FINDING_LEVEL, INVESTIGATION_STATUS } from "../src/diagnostics/report.js";
import { RunStateStore, withTargetExecutionLease } from "../src/testing/runState.js";
import { chromeWindowPositionArgs } from "../src/browser/chromeWindowPlacement.js";

const chromePath = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const fixture = await readFile(new URL("./fixtures/navigation.html", import.meta.url));
const sameFrameFixture = await readFile(new URL("./fixtures/same-frame.html", import.meta.url));

test("E2E vertical: attach → discover → test → collect → investigate → report", { timeout: 120_000 }, async t => {
  let server, crossOriginServer, chrome, profileDir, runStateDir, session, runStateStore;
  try {
    // ── Fixture servers ──
    crossOriginServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(sameFrameFixture);
    });
    crossOriginServer.listen(0, "127.0.0.1");
    await once(crossOriginServer, "listening");
    const crossOriginPort = crossOriginServer.address().port;

    const resources = new Map();
    let resourceCounter = 0;
    server = createServer((req, res) => {
      if (req.url?.startsWith("/same-frame.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(sameFrameFixture);
        return;
      }
      if (req.url?.startsWith("/api/account?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ loaded: true }));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/api/resources")) {
        const id = `res-${++resourceCounter}`;
        resources.set(id, { id, createdAt: new Date().toISOString() });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
        return;
      }
      if (req.method === "DELETE" && req.url?.match(/^\/api\/resources\/([\w-]+)$/)) {
        const id = req.url.match(/^\/api\/resources\/([\w-]+)$/)[1];
        const deleted = resources.delete(id);
        res.writeHead(deleted ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ deleted }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/resources")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ resources: [...resources.keys()] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixture.toString().replace("CROSS_ORIGIN_FRAME_URL", `http://127.0.0.1:${crossOriginPort}/same-frame.html`));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const siteUrl = `http://127.0.0.1:${server.address().port}/`;
    // Expose for independent server-side confirmation in the test.
    t.context = { resources };

    // ── Disposable Chrome (headed by default) ──
    profileDir = await mkdtemp(join(tmpdir(), "activetab-e2e-"));
    runStateDir = await mkdtemp(join(tmpdir(), "activetab-e2e-runstate-"));
    runStateStore = new RunStateStore(runStateDir);
    await runStateStore.init();
    chrome = spawn(chromePath, [
      ...(process.env.ACTIVETAB_HEADLESS === "1" ? ["--headless=new"] : []),
      ...chromeWindowPositionArgs(),
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, siteUrl
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    if (process.env.ACTIVETAB_HEADLESS === "1") {
      assert.ok(chrome.spawnargs.includes("--headless=new"), "the explicit headless opt-in reaches the vertical test browser");
    }
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

    // ── 1. Authorized attach ──
    let targets = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { targets = await listTargets(endpoint); if (targets.some(t => t.url.includes("127.0.0.1"))) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const fixtureTarget = targets.find(t => t.url.includes("127.0.0.1"));
    assert.ok(fixtureTarget, "Chrome exposed the fixture page target");
    const target = await resolveAuthorizedTarget(endpoint, fixtureTarget.id, fixtureTarget.id);
    session = await new BrowserSession(target).attach();
    const userAgentResult = await session.client.send("Runtime.evaluate", {
      expression: "navigator.userAgent",
      returnByValue: true
    });
    const browserUserAgent = userAgentResult?.result?.value ?? "";
    if (process.env.ACTIVETAB_HEADLESS === "1") {
      assert.match(browserUserAgent, /HeadlessChrome\//u, "CDP runtime identifies the launched browser as headless");
      t.diagnostic(`Headless attested: --headless=new; CDP navigator.userAgent=${browserUserAgent}`);
    } else {
      assert.doesNotMatch(browserUserAgent, /HeadlessChrome\//u, "headed mode must not silently become headless");
      t.diagnostic(`Headed attested: CDP navigator.userAgent=${browserUserAgent}`);
    }
    t.diagnostic(`Attached: ${target.url}`);

    // ── 2. Verified identity via passive observation ──
    let initialObservation = null;
    const titleDeadline = Date.now() + 10_000;
    while (Date.now() < titleDeadline) {
      initialObservation = await session.observe();
      if (initialObservation.page.title === "Demo shop") break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(initialObservation.page.title, "Demo shop");
    assert.ok(initialObservation.candidates.length > 0, "Observation captured interactable candidates");

    // ── 3. Bounded autonomous discovery ──
    const discoveryResult = await withTargetExecutionLease(runStateStore, session, "e2e-discovery", lease =>
      new ApplicationDiscoveryEngine({ session, maxSteps: 4, maxLinksPerStep: 4, assertExecutionLease: lease.assertCurrent }).discover());
    assert.ok(discoveryResult.capabilityMap);
    assert.ok(discoveryResult.discoveries.some(d => d.type === "initial_observation"));
    t.diagnostic(`Discovery: ${discoveryResult.visitedCount} pages, ${discoveryResult.capabilityMap.controls.length} controls`);

    // ── 4. Declarative test workflow ──
    const collector = new DiagnosticCollector({ runId: "e2e-run" });
    collector.register(
      createDiagnosticContract({ id: "browser-network", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ], scope: `target:${target.id}`, sensitivity: SENSITIVITY.METADATA_ONLY }),
      async () => {
        const evidenceId = session.latestEvidenceId;
        assert.ok(evidenceId, "No browser observation evidence id was exposed");
        const evidence = session.observer?.getEvidence?.(evidenceId, { facets: ["networkActivity"] });
        assert.equal(evidence?.status, "available");
        const requests = Array.isArray(evidence.networkActivity) ? evidence.networkActivity : [];
        assert.ok(requests.length > 0, "Network diagnostic evidence must contain at least one request");
        return {
          status: "available", evidenceId, capturedAt: evidence.capturedAt,
          coverage: evidence.networkActivityCoverage ?? null, requests
        };
      }
    );
    collector.register(
      createDiagnosticContract({ id: "browser-lifecycle", authority: AUTHORITY.BROWSER_CDP, operations: [OPERATION.READ], scope: `target:${target.id}`, sensitivity: SENSITIVITY.METADATA_ONLY }),
      async () => {
        const evidenceId = session.latestEvidenceId;
        assert.ok(evidenceId, "No browser observation evidence id was exposed");
        const evidence = session.observer?.getEvidence?.(evidenceId, { facets: ["lifecycleEvents"] });
        assert.equal(evidence?.status, "available");
        const events = Array.isArray(evidence.lifecycleEvents) ? evidence.lifecycleEvents : [];
        assert.ok(events.length > 0, "Lifecycle diagnostic evidence must contain at least one event");
        return {
          status: "available", evidenceId, capturedAt: evidence.capturedAt,
          coverage: evidence.lifecycleEventCoverage ?? null, events
        };
      });
    const correlator = new DiagnosticCorrelator();
    const runner = new TestRunner({ session, collector, correlator, localFixture: true, runStateStore });
    const receipt = await runner.run({
      id: "e2e-smoke", name: "E2E smoke",
      steps: [
        { id: "s1", type: "navigate", url: siteUrl, waitMs: 500 },
        { id: "s2", type: "assert", assertion: { type: "page_title_contains", value: "demo" } },
        { id: "s3", type: "diagnostic_snapshot" },
        { id: "s4", type: "cleanup" }
      ]
    }, { runId: "e2e-run" });
    assert.equal(receipt.status, RUN_STATUS.PASSED);
    t.diagnostic(`Test workflow: ${receipt.steps.map(s => `${s.stepId}=${s.status}`).join(", ")}`);

    // ── 5. Diagnostic collection ──
    const diagResults = await collector.collectAll([
      { sourceId: "browser-network", operation: OPERATION.READ },
      { sourceId: "browser-lifecycle", operation: OPERATION.READ }
    ]);
    assert.ok(diagResults.length >= 2);
    assert.ok(diagResults.every(r => r.status === "ok" || r.status === "error"));

    // ── 5a. Multi-step resource lifecycle (P2-B) ──
    // Create a test-owned resource through the browser and verify it on the server.
    const resourceObservation = await session.observe();
    const createButton = resourceObservation.candidates.find(c => c.name === "Create resource" && c.visible === true);
    assert.ok(createButton, "Create resource button found in observation");
    await session.click(createButton);
    await session.waitForChange(3_000);
    const afterCreateObservation = await session.observe();
    const resourceSpan = afterCreateObservation.candidates.find(c => c.name === "Create resource" && c.disabled === true);
    assert.ok(resourceSpan, "Create button should be disabled after resource creation");

    // Independent server-side confirmation.
    let serverResources = null;
    const confirmResponse = await fetch(`${siteUrl}api/resources`);
    serverResources = (await confirmResponse.json()).resources;
    assert.equal(serverResources.length, 1, `Server should confirm 1 resource, got ${serverResources.length}`);
    t.diagnostic(`Server confirmed resource: ${serverResources[0]}`);

    // ── 6. Controlled failure + investigation ──
    const failRunner = new TestRunner({ session, collector, correlator });
    const failReceipt = await failRunner.run({
      id: "e2e-fail", name: "Controlled failure",
      steps: [
        { id: "s1", type: "assert", assertion: { type: "page_title_contains", value: "definitely-not-present" } }
      ]
    }, { runId: "e2e-fail" });
    assert.equal(failReceipt.status, RUN_STATUS.FAILED);

    const investigation = new InvestigationEngine({ collector, correlator });
    const investigationResult = await investigation.investigate({
      subject: "Expected text was not found",
      reason: "Page title did not contain 'definitely-not-present'."
    });
    assert.ok(investigationResult.classification);
    assert.ok(investigationResult.hypotheses.length >= 2);
    assert.ok(investigationResult.report.findings.length >= 2);

    // ── 6a. Cleanup: delete the test-owned resource and verify server-side ──
    const cleanupObservation = await session.observe();
    const deleteButton = cleanupObservation.candidates.find(c => c.name === "Delete resource" && c.visible === true && c.disabled !== true);
    assert.ok(deleteButton, "Delete resource button should be enabled before cleanup");
    await session.click(deleteButton);
    await session.waitForChange(3_000);
    const afterCleanupObservation = await session.observe();
    const cleanupConfirm = afterCleanupObservation.candidates.find(c => c.name === "Delete resource" && c.disabled === true);
    assert.ok(cleanupConfirm, "Delete button should be disabled after cleanup");

    // Independent server-side confirmation that the resource is gone.
    const cleanupResponse = await fetch(`${siteUrl}api/resources`);
    const remainingResources = (await cleanupResponse.json()).resources;
    assert.equal(remainingResources.length, 0, `Server should confirm 0 resources after cleanup, got ${remainingResources.length}`);
    t.diagnostic(`Server confirmed cleanup: ${remainingResources.length} resources remain`);

    // ── 7. Qualified diagnostic report ──
    const report = investigationResult.report.redacted();
    assert.ok(report.findings.length > 0);
    assert.ok(report.correlationSummary);
    t.diagnostic(`Report: ${report.findings.length} findings, ${report.correlationSummary.totalLinks} links`);

    t.diagnostic("✅ E2E vertical verified: attach → observe → discover → test → collect → investigate → report");
  } finally {
    if (session) await session.close().catch(() => {});
    runStateStore?.close();
    if (chrome) { try { chrome.kill("SIGKILL"); } catch {} }
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (runStateDir) await rm(runStateDir, { recursive: true, force: true }).catch(() => {});
    if (server) server.close();
    if (crossOriginServer) crossOriginServer.close();
  }
});
