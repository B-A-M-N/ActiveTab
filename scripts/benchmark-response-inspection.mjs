#!/usr/bin/env node
import http from "node:http";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { launchOwnedChrome } from "../src/browser/ownedChrome.js";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const headless = process.env.ACTIVETAB_HEADLESS === "1";
const benchmarkViewport = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const benchmarkScreen = Object.freeze({ width: 1280, height: 1024 });
const memorySnapshot = () => {
  const memory = process.memoryUsage();
  return { nodeRssBytes: memory.rss, nodeHeapUsedBytes: memory.heapUsed };
};
const jsonOfSize = (targetBytes, value = "x") => {
  const prefix = '{"records":[{"payload":"';
  const suffix = '"}]}';
  return prefix + value.repeat(Math.max(0, targetBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))) + suffix;
};
const cases = new Map([
  ["json-64k", { mime: "application/json", body: jsonOfSize(64 * 1024) }],
  ["json-256k", { mime: "application/json", body: jsonOfSize(256 * 1024) }],
  ["json-near-cdp-buffer", { mime: "application/json", body: jsonOfSize(470 * 1024) }],
  ["json-many-tokens", { mime: "application/json", body: `{"records":[${Array(90_000).fill("0").join(",")}]}` }],
  ["json-deep-nesting", { mime: "application/json", body: `${"[".repeat(96)}0${"]".repeat(96)}` }],
  ["text-many-lines", { mime: "text/plain", body: `${"x\n".repeat(20_001)}` }],
  ["json-over-limit", { mime: "application/json", body: jsonOfSize(1_100 * 1024) }]
]);

const server = http.createServer((request, response) => {
  const route = new URL(request.url, "http://127.0.0.1");
  if (route.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>ActiveTab response benchmark</title><p>Local fixture.</p>");
    return;
  }
  const selected = cases.get(route.pathname.slice(1));
  if (!selected) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": `${selected.mime}; charset=utf-8`, "cache-control": "no-store" });
  response.end(selected.body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
let owned;
let nodeMonitorTimer;
let chromeMonitorTimer;
let baseline;
let peak;
let activeCaseMemory = null;
let browserStartupWallMs = null;
let browserSurface = null;

function chromeTreeRss(rootPid) {
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number))
      .filter(row => row.length === 3 && row.every(Number.isFinite));
    const parentByPid = new Map(rows.map(([pid, parent]) => [pid, parent]));
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of parentByPid) if (!descendants.has(pid) && descendants.has(parent)) {
        descendants.add(pid); changed = true;
      }
    }
    return rows.filter(([pid]) => descendants.has(pid)).reduce((sum, [, , rssKb]) => sum + rssKb * 1024, 0);
  } catch { return 0; }
}

try {
  process.stderr.write("Starting owned Chrome on the local response fixture.\n");
  const browserStartupStartedAt = process.hrtime.bigint();
  owned = await launchOwnedChrome({
    initialUrl: `http://127.0.0.1:${port}/`, headed: !headless, displayMode: "current-display",
    preserveProfile: false, reuseExisting: false,
    environmentProfile: { viewport: benchmarkViewport }
  });
  browserStartupWallMs = Number(process.hrtime.bigint() - browserStartupStartedAt) / 1e6;
  await owned.session.client.send("Emulation.setDeviceMetricsOverride", {
    width: benchmarkViewport.width,
    height: benchmarkViewport.height,
    deviceScaleFactor: benchmarkViewport.deviceScaleFactor,
    mobile: false,
    screenWidth: benchmarkScreen.width,
    screenHeight: benchmarkScreen.height
  });
  const surface = await owned.session.client.send("Runtime.evaluate", {
    expression: "({visibilityState:document.visibilityState,hidden:document.hidden,innerWidth,innerHeight,screenWidth:screen.width,screenHeight:screen.height,deviceScaleFactor:devicePixelRatio})",
    returnByValue: true
  });
  browserSurface = surface?.result?.value ?? null;
  process.stderr.write(`Owned Chrome ready (${owned.browserVersion}).\n`);
  baseline = {
    ...memorySnapshot(),
    chromeTreeRssBytes: chromeTreeRss(owned.chromeProcess.pid)
  };
  peak = { ...baseline };
  nodeMonitorTimer = setInterval(() => {
    const memory = memorySnapshot();
    peak.nodeRssBytes = Math.max(peak.nodeRssBytes, memory.nodeRssBytes);
    peak.nodeHeapUsedBytes = Math.max(peak.nodeHeapUsedBytes, memory.nodeHeapUsedBytes);
    if (activeCaseMemory) {
      activeCaseMemory.peakNodeRssBytes = Math.max(activeCaseMemory.peakNodeRssBytes, memory.nodeRssBytes);
      activeCaseMemory.peakNodeHeapUsedBytes = Math.max(activeCaseMemory.peakNodeHeapUsedBytes, memory.nodeHeapUsedBytes);
    }
  }, 25);
  chromeMonitorTimer = setInterval(() => {
    peak.chromeTreeRssBytes = Math.max(peak.chromeTreeRssBytes, chromeTreeRss(owned.chromeProcess.pid));
    if (activeCaseMemory) {
      activeCaseMemory.peakChromeTreeRssBytes = Math.max(
        activeCaseMemory.peakChromeTreeRssBytes,
        chromeTreeRss(owned.chromeProcess.pid)
      );
    }
  }, 500);

  const results = [];
  for (const [caseId, fixture] of cases) {
    process.stderr.write(`Measuring ${caseId}.\n`);
    const route = `/${caseId}`;
    const startedAt = process.hrtime.bigint();
    const cpuStarted = process.cpuUsage();
    await owned.session.client.send("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(`http://127.0.0.1:${port}${route}`)}).then(response => response.text()).then(() => true)`,
      awaitPromise: false, returnByValue: false
    });
    process.stderr.write(`Requested ${caseId}; waiting for Chrome network completion.\n`);
    let request;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      request = owned.session.activity.requests.find(item => item.url?.endsWith(route) && item.finishedAt !== null);
      if (request) break;
      await wait(10);
    }
    if (!request) throw new Error(`Fixture response '${caseId}' did not finish.`);
    process.stderr.write(`Captured ${caseId} network completion.\n`);
    process.stderr.write(`Capturing retained evidence for ${caseId}.\n`);
    const observation = await owned.session.observe({ profile: "lightweight" });
    process.stderr.write(`Inspecting ${caseId} body.\n`);
    const before = memorySnapshot();
    activeCaseMemory = {
      peakNodeRssBytes: before.nodeRssBytes,
      peakNodeHeapUsedBytes: before.nodeHeapUsedBytes,
      peakChromeTreeRssBytes: chromeTreeRss(owned.chromeProcess.pid)
    };
    const inspectStartedAt = process.hrtime.bigint();
    const result = await owned.session.observer.inspectNetworkResponse(observation.evidenceId, {
      requestId: request.requestId, includeSensitive: true, view: "markdown", maxBytes: 1_024
    });
    process.stderr.write(`Inspected ${caseId} response.\n`);
    const after = memorySnapshot();
    const responseBody = result.responseBody ?? {};
    results.push({
      caseId,
      expectedBytes: Buffer.byteLength(fixture.body),
      acquiredBytes: responseBody.inspectionMetrics?.sourceBytes ?? responseBody.analysis?.sourceBytes ?? null,
      httpEncodedBytes: request.encodedDataLength,
      decodedBytesReportedByChrome: request.decodedDataLength,
      networkChunks: request.dataChunkCount,
      status: responseBody.status ?? result.status,
      reasonCode: responseBody.reasonCode ?? null,
      inspectionMetrics: responseBody.inspectionMetrics ?? null,
      inspectWallMs: Number(process.hrtime.bigint() - inspectStartedAt) / 1e6,
      endToEndWallMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      nodeCpuMicros: process.cpuUsage(cpuStarted),
      nodeRssBeforeBytes: before.nodeRssBytes,
      nodeRssAfterBytes: after.nodeRssBytes,
      nodeHeapUsedBeforeBytes: before.nodeHeapUsedBytes,
      nodeHeapUsedAfterBytes: after.nodeHeapUsedBytes,
      sampledPeaksDuringInspection: activeCaseMemory
    });
    activeCaseMemory = null;
    process.stderr.write(`Finished ${caseId}: ${responseBody.status ?? result.status}.\n`);
  }

  // Cancellation is sampled while CDP is reading a completed response. The
  // command may still finish in Chrome; ActiveTab only stops waiting for it.
  const cancelId = "json-near-cdp-buffer";
  await owned.session.client.send("Runtime.evaluate", {
    expression: `fetch(${JSON.stringify(`http://127.0.0.1:${port}/${cancelId}?cancel=1`)}).then(response => response.text()).then(() => true)`,
    awaitPromise: false, returnByValue: false
  });
  await wait(25);
  const cancelRequest = [...owned.session.activity.requests].reverse().find(item => item.url?.includes(`/${cancelId}?cancel=1`) && item.finishedAt !== null);
  let cancellation = { status: "not_measured", note: "A completed response request was not retained." };
  if (cancelRequest) {
    const observation = await owned.session.observe({ profile: "lightweight" });
    const controller = new AbortController();
    const pending = owned.session.observer.inspectNetworkResponse(observation.evidenceId, {
      requestId: cancelRequest.requestId, includeSensitive: true, view: "markdown", signal: controller.signal
    });
    controller.abort();
    const cancelled = await pending;
    cancellation = {
      status: cancelled.responseBody?.status ?? cancelled.status,
      phase: cancelled.responseBody?.phase ?? null,
      note: "Cancellation ends ActiveTab's wait; the CDP body command itself is not abortable."
    };
  }
  process.stderr.write("Response inspection measurements complete.\n");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    mode: headless ? "owned_headless_chrome_loopback_fixture" : "owned_headed_chrome_loopback_fixture",
    browserVersion: owned.browserVersion,
    browserViewport: browserSurface ? {
      width: browserSurface.innerWidth,
      height: browserSurface.innerHeight,
      screenWidth: browserSurface.screenWidth,
      screenHeight: browserSurface.screenHeight,
      deviceScaleFactor: browserSurface.deviceScaleFactor
    } : null,
    browserSurface,
    browserStartupWallMs,
    chromePid: owned.chromeProcess.pid,
    measurement: "Node RSS and heapUsed sampled every 25 ms; Chrome RSS is the owned process tree sum sampled every 500 ms. Synchronous Node work can finish between samples; before/after snapshots are also reported.",
    baseline,
    peak,
    cancellation,
    cases: results
  }, null, 2)}\n`);
} finally {
  clearInterval(nodeMonitorTimer);
  clearInterval(chromeMonitorTimer);
  const cleanup = await owned?.close().catch(error => ({ error: String(error?.message ?? error) }));
  await new Promise(resolve => server.close(resolve));
  if (cleanup?.processStopped === false) process.exitCode = 1;
}
