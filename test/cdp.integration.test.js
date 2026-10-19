import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "../src/browser/chrome-autoconnect.js";
import { BrowserSession } from "../src/browser/session.js";
import { executeAuthorizedAction } from "../src/runtime/authorizedExecutor.js";
import { FixtureNavigationEngine as NavigationEngine } from "../test-support/fixtureNavigationEngine.js";
import { clickObservedElement } from "../src/navigation/observedAction.js";
import { TaskJournal } from "../src/state/journal.js";
import { CapabilityService } from "../src/capabilities/capabilityService.js";
import { runApiShapeFixtureQualification } from "../test-lab/fixtures/api-shape-twin/oracle.js";
import { jpegDimensions, isJevImageSizeSupported } from "../src/decisions/imagePreparation.js";
import { chromeWindowPositionArgs, resolveChromeWindowPosition } from "../src/browser/chromeWindowPlacement.js";

const fixtureLease = async () => {};

function isolatedModelEnvironment(overrides, guardDirectory) {
  const env = { ...process.env, ...overrides };
  for (const name of [
    "ACTIVETAB_MODEL_ENDPOINT", "ACTIVETAB_SEMANTIC_ENDPOINT", "ACTIVETAB_WORKFLOW_ENDPOINT",
    "ACTIVETAB_MODEL", "ACTIVETAB_SEMANTIC_MODEL", "ACTIVETAB_WORKFLOW_MODEL",
    "ACTIVETAB_MODEL_API_KEY", "ACTIVETAB_SEMANTIC_API_KEY", "ACTIVETAB_WORKFLOW_API_KEY",
    "ACTIVETAB_MODEL_IMAGE_INPUT", "ACTIVETAB_MODEL_ALLOW_SCREENSHOTS", "ACTIVETAB_JEV_ALLOW_IMAGES",
    "OPENROUTER_API_KEY", "JEV_API_KEY"
  ]) delete env[name];
  // The CLI child exercises local CDP recovery and must never inherit a
  // developer's model keys or discover the home JEV.txt credential.
  env.ACTIVETAB_JEV_KEY_FILE = join(guardDirectory, "missing-JEV.txt");
  return env;
}

const chromePath = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const fixture = await readFile(new URL("./fixtures/navigation.html", import.meta.url));
const sameFrameFixture = await readFile(new URL("./fixtures/same-frame.html", import.meta.url));
const crossFrameFixture = await readFile(new URL("./fixtures/cross-frame.html", import.meta.url));

function frameUrls(node, output = []) {
  if (node?.frame?.url) output.push(node.frame.url);
  for (const child of node?.childFrames ?? []) frameUrls(child, output);
  return output;
}

test("native CDP attaches to disposable Chrome, preserves evidence, recovers, verifies, and journals", { timeout: 90_000 }, async t => {
  let chrome;
  let session;
  let chromeConnection;
  let server;
  let crossOriginServer;
  let profileDir;
  let journalDir;
  let fixtureButtonAuthorizer;
  try {
    crossOriginServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(crossFrameFixture);
    });
    crossOriginServer.listen(0, "127.0.0.1");
    await once(crossOriginServer, "listening");
    const crossOriginPort = crossOriginServer.address().port;
    server = createServer((request, response) => {
      if (request.url?.startsWith("/same-frame.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(sameFrameFixture);
        return;
      }
      if (request.url?.startsWith("/api/account?")) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ loaded: true, access_token: "fixture-response-secret" }));
        return;
      }
      if (request.url === "/api/orders") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ orders: [
          { id: 101, total: 12.5, status: "open", api_token: "fixture-api-secret-alpha" },
          { id: 102, total: 20, status: "paid", api_token: "fixture-api-secret-beta" }
        ] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(fixture.toString().replace("CROSS_ORIGIN_FRAME_URL", `http://127.0.0.1:${crossOriginPort}/cross-frame.html`));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const sitePort = server.address().port;
    profileDir = await mkdtemp(join(tmpdir(), "activetab-chrome-"));
    journalDir = await mkdtemp(join(tmpdir(), "activetab-state-"));
    chrome = spawn(chromePath, [
      ...(process.env.ACTIVETAB_HEADLESS === "1" ? ["--headless=new"] : []),
      ...chromeWindowPositionArgs(),
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      `http://127.0.0.1:${sitePort}/`
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => { stderr += chunk.slice(-5000); });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome CDP startup timed out. ${stderr.slice(-1000)}`)), 15_000);
      const check = () => {
        const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); return true; }
        return false;
      };
      chrome.stderr.on("data", check);
      const poll = setInterval(async () => {
        if (check()) { clearInterval(poll); return; }
        if (chrome.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error(`Chrome exited early (${chrome.exitCode}).`)); return; }
        try { const targets = await listTargets(`http://127.0.0.1:${stderr.match(/127\.0\.0\.1:(\d+)/)?.[1]}`); if (targets.length) { clearInterval(poll); clearTimeout(timer); resolve(`http://127.0.0.1:${stderr.match(/127\.0\.0\.1:(\d+)/)[1]}`); } } catch { /* wait for Chrome's dynamically allocated endpoint */ }
      }, 100);
    });
    const deadline = Date.now() + 10_000;
    let targets = [];
    while (!targets.some(item => item.url.includes(`127.0.0.1:${sitePort}`)) && Date.now() < deadline) {
      try { targets = await listTargets(endpoint); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const fixtureTarget = targets.find(item => item.url.includes(`127.0.0.1:${sitePort}`));
    assert.ok(fixtureTarget, "Chrome exposed the fixture page target");
    const target = await resolveAuthorizedTarget(endpoint, fixtureTarget.id, fixtureTarget.id);
    session = await new BrowserSession(target).attach();
    let directObservation;
    const directDeadline = Date.now() + 5_000;
    while (Date.now() < directDeadline) {
      directObservation = await session.observe();
      const { frameTree } = await session.client.send("Page.getFrameTree");
      if (directObservation.page.title === "Demo shop" && directObservation.frames.some(frame => frame.url.endsWith("/same-frame.html")) && frameUrls(frameTree).some(url => url.startsWith(`http://127.0.0.1:${crossOriginPort}/cross-frame.html`))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(directObservation.page.title, "Demo shop", "direct page-level CDP remains supported");
    for (const viewport of [
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 280, height: 280 }
    ]) {
      await session.client.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
      const visualObservation = await session.observe({ profile: "visual", prepareForJev: true });
      const screenshot = session.observer.getEvidence(visualObservation.evidenceId, { includeScreenshot: true }).screenshotBase64;
      const dimensions = jpegDimensions(Buffer.from(screenshot, "base64"));
      assert.deepEqual(visualObservation.viewport, viewport);
      assert.equal(isJevImageSizeSupported(dimensions), true, `${viewport.width}x${viewport.height} is prepared within Jev's configured image bounds`);
    }
    await session.client.send("Emulation.clearDeviceMetricsOverride");
    await session.close();
    session = undefined;

    chromeConnection = await connectChromeAuto({ userDataDir: profileDir });
    const browserTargets = await listChromeTargets(chromeConnection);
    assert.ok(browserTargets.some(item => item.id === fixtureTarget.id), "browser-level CDP enumerates the same authorized Chrome page");
    const authorizedTarget = await resolveChromeTarget(chromeConnection, fixtureTarget.id, fixtureTarget.id);
    session = await new BrowserSession(authorizedTarget).attach();
    const requestedWindowPosition = resolveChromeWindowPosition();
    if (requestedWindowPosition && process.env.ACTIVETAB_HEADLESS !== "1") {
      const window = await chromeConnection.client.send("Browser.getWindowForTarget", { targetId: fixtureTarget.id });
      assert.equal(window.bounds.left, requestedWindowPosition.x);
      assert.equal(window.bounds.top, requestedWindowPosition.y);
      const viewport = await session.client.send("Runtime.evaluate", {
        expression: "({screenX,screenY,devicePixelRatio})", returnByValue: true
      });
      assert.equal(viewport.result.value.screenX, requestedWindowPosition.x);
      assert.equal(viewport.result.value.screenY, requestedWindowPosition.y);
      t.diagnostic(`Direct CDP test browser placed at ${window.bounds.left},${window.bounds.top}; device scale ${viewport.result.value.devicePixelRatio}`);
    }
    fixtureButtonAuthorizer = {
      operationId: "test.local_fixture_button",
      authorize({ action, candidate, observation }) {
        let localFixture = false;
        try { localFixture = new URL(observation?.page?.url).hostname === "127.0.0.1"; } catch {}
        const observedItems = action === "scroll" ? observation?.scrollTargets : observation?.candidates;
        const freshlyObserved = (observedItems ?? []).some(item =>
          item.identity === candidate?.identity && item.visible === true
          && (action === "scroll" || item.role === "button"));
        if (!localFixture || !freshlyObserved) {
          return { allowed: false, reason: "The test capability requires a fresh target on its loopback fixture." };
        }
        if (action === "scroll" && ["container", "viewport"].includes(candidate?.kind) && candidate.canScrollDown === true) {
          return { allowed: true, category: "test_local_fixture_scroll" };
        }
        return action === "click"
          ? { allowed: true, category: "test_local_fixture_button" }
          : { allowed: false, reason: "The test capability is limited to downward scroll or a fresh button on its loopback fixture." };
      }
    };
    let first;
    const loadDeadline = Date.now() + 10_000;
    while (Date.now() < loadDeadline) {
      first = await session.observe();
      const { frameTree } = await session.client.send("Page.getFrameTree");
      if (first.page.title === "Demo shop" && first.frames.some(frame => frame.url.endsWith("/same-frame.html")) && frameUrls(frameTree).some(url => url.startsWith(`http://127.0.0.1:${crossOriginPort}/cross-frame.html`))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(first.page.title, "Demo shop");
    assert.equal(first.targetId, session.target.id, "each real CDP observation is bound to its selected browser target");
    await session.client.send("Runtime.evaluate", {
      expression: "globalThis.__activetabGetterRuns = 0; globalThis.__activetabRuntimeState__ = { publicLabel: 'runtime fixture', nested: { apiToken: 'runtime-fixture-secret' }, largeValue: 'x'.repeat(4095) + '😀' + 'y'.repeat(1000) }; Object.defineProperty(globalThis.__activetabRuntimeState__, 'lazyValue', { enumerable: true, get() { globalThis.__activetabGetterRuns++; return 'getter-must-not-run'; } }); void 0;",
      returnByValue: true
    });
    const sectionChoices = first.candidates.filter(candidate => candidate.name === "Continue" && ["Billing history", "Shipping history"].includes(candidate.contextName));
    assert.deepEqual(sectionChoices.map(candidate => candidate.contextName).sort(), ["Billing history", "Shipping history"]);
    const safeEvidence = session.observer.getEvidence(first.evidenceId);
    const serializedSafe = JSON.stringify(safeEvidence);
    assert.equal(serializedSafe.includes("fixture-secret"), false, "form values are redacted on evidence retrieval");
    assert.ok(safeEvidence.domSnapshot.documents.length > 0, "the detailed DOMSnapshot remains retrievable");
    assert.equal((await session.client.send("Runtime.evaluate", { expression: "globalThis.__activetabGetterRuns", returnByValue: true })).result.value, 0, "ordinary observation does not inspect application getters");
    const runtimeInspection = await session.observer.inspectRuntimeState(first.evidenceId, { path: ["__activetabRuntimeState__", "publicLabel"] });
    assert.equal(runtimeInspection.status, "available", JSON.stringify(runtimeInspection));
    assert.equal(runtimeInspection.result.selected.valueRedacted, true, "selected JavaScript values remain redacted by default");
    assert.equal((await session.client.send("Runtime.evaluate", { expression: "globalThis.__activetabGetterRuns", returnByValue: true })).result.value, 0, "reading a data property does not run an unrelated accessor");
    const accessorInspection = await session.observer.inspectRuntimeState(first.evidenceId, { path: ["__activetabRuntimeState__", "lazyValue"] });
    assert.equal(accessorInspection.status, "accessor_not_read");
    assert.equal(accessorInspection.result.hasGetter, true);
    assert.equal((await session.client.send("Runtime.evaluate", { expression: "globalThis.__activetabGetterRuns", returnByValue: true })).result.value, 0, "runtime observation reports getters without invoking them");
    const runtimeSecret = await session.observer.inspectRuntimeState(first.evidenceId, { path: ["__activetabRuntimeState__", "nested", "apiToken"], includeSensitiveValues: true });
    assert.equal(runtimeSecret.result.selected.value, "runtime-fixture-secret", "a caller can explicitly request one selected runtime primitive");
    const largeRuntimeValue = await session.observer.inspectRuntimeState(first.evidenceId, { path: ["__activetabRuntimeState__", "largeValue"], includeSensitiveValues: true });
    assert.equal(largeRuntimeValue.result.selected.type, "string");
    assert.equal(largeRuntimeValue.result.selected.valueLength, 5097);
    assert.equal(largeRuntimeValue.result.selected.valueOffset, 0);
    assert.equal(largeRuntimeValue.result.selected.valueComplete, false, "long selected strings are paged instead of truncated or omitted");
    assert.equal(largeRuntimeValue.result.selected.valueRedacted, undefined, "explicit local inspection does not mislabel an available page as redacted");
    assert.equal(largeRuntimeValue.result.selected.value, "x".repeat(4095), "the first page ends before a split Unicode surrogate pair");
    const largeRuntimeValuePage2 = await session.observer.inspectRuntimeState(first.evidenceId, {
      path: ["__activetabRuntimeState__", "largeValue"],
      includeSensitiveValues: true,
      offset: largeRuntimeValue.result.selected.nextOffset
    });
    assert.equal(largeRuntimeValuePage2.result.selected.value, "😀" + "y".repeat(1000));
    assert.equal(largeRuntimeValuePage2.result.selected.valueComplete, true);
    assert.equal(largeRuntimeValue.result.selected.value + largeRuntimeValuePage2.result.selected.value, "x".repeat(4095) + "😀" + "y".repeat(1000), "the bounded pages reconstruct the complete original runtime value exactly");
    const safeRuntimeEvidence = session.observer.getEvidence(first.evidenceId, { facets: ["runtimeState"] });
    assert.equal(JSON.stringify(safeRuntimeEvidence).includes("runtime-fixture-secret"), false, "runtime values remain redacted when retained evidence is retrieved by default");
    const selectedRuntimeEvidence = session.observer.getEvidence(first.evidenceId, { facets: ["runtimeState"], includeSensitiveRuntimeValues: true });
    assert.ok(JSON.stringify(selectedRuntimeEvidence).includes("runtime-fixture-secret"), "retained selected values require a separate explicit retrieval opt-in");
    const targetCandidate = first.candidates.find(candidate => candidate.name === "Open account");
    const selectedDetail = session.observer.getEvidence(first.evidenceId, { facets: ["selectedElement"], backendNodeId: targetCandidate.backendNodeId });
    assert.equal(selectedDetail.domSnapshot, undefined, "callers can retrieve only a selected element facet");
    assert.equal(selectedDetail.selectedElement.name, "Open account");
    const selectedBillingControl = sectionChoices.find(candidate => candidate.contextName === "Billing history");
    const callerVisualObservation = await session.observe({ profile: "visual" });
    const callerScreenshot = session.observer.getEvidence(callerVisualObservation.evidenceId, { facets: ["page"], includeScreenshot: true });
    assert.equal(typeof callerScreenshot.screenshotBase64, "string", "the caller can retrieve visual evidence locally before choosing an identity");
    const callerAction = await clickObservedElement(session, { goal: "Open the billing history page", evidenceId: first.evidenceId, backendNodeId: selectedBillingControl.backendNodeId, assertExecutionLease: fixtureLease });
    assert.equal(callerAction.status, "action_dispatched");
    assert.equal(callerAction.verificationRequired, true);
    assert.equal(callerAction.observation.page.title, "Billing history", "a caller can verify the result from the fresh post-action observation");
    const ambiguousRun = await new NavigationEngine(session, { maxActions: 1, maxRecoveries: 0 }).run("Continue");
    assert.equal(ambiguousRun.status, "unresolved", "same-label, same-context controls do not trigger a guessed click");
    assert.equal(ambiguousRun.attempts, 0);
    const ambiguousChoices = ambiguousRun.targetResolution.candidates.filter(candidate => candidate.contextName === "Ambiguous route");
    assert.equal(ambiguousChoices.length, 2, "the unresolved result exposes both target-scoped handles from retained evidence");
    const ambiguityVisualObservation = await session.observe({ profile: "visual" });
    const ambiguityScreenshot = session.observer.getEvidence(ambiguityVisualObservation.evidenceId, { facets: ["page"], includeScreenshot: true });
    assert.equal(typeof ambiguityScreenshot.screenshotBase64, "string", "the caller can inspect the retained screenshot before selecting one candidate");
    const selectedAmbiguousCandidate = [...ambiguousChoices].sort((left, right) => left.bounds.x - right.bounds.x)[0];
    const selectedDetails = session.observer.getEvidence(ambiguousRun.targetResolution.evidenceId, {
      facets: ["selectedElement"],
      backendNodeId: selectedAmbiguousCandidate.backendNodeId,
      frameTargetId: selectedAmbiguousCandidate.frameTargetId ?? null
    });
    assert.equal(selectedDetails.selectedElement.contextName, "Ambiguous route");
    const resolvedCallerAction = await clickObservedElement(session, {
      goal: "Continue",
      evidenceId: ambiguousRun.targetResolution.evidenceId,
      backendNodeId: selectedAmbiguousCandidate.backendNodeId,
      frameTargetId: selectedAmbiguousCandidate.frameTargetId ?? null,
      assertExecutionLease: fixtureLease
    });
    assert.equal(resolvedCallerAction.status, "action_dispatched");
    assert.equal(resolvedCallerAction.observation.page.title, "Primary route", "the selected handle is revalidated and the caller can verify the resulting route");
    const observedScrollTargets = session.observer.getEvidence(first.evidenceId, { facets: ["scrollTargets"] }).scrollTargets;
    assert.ok(observedScrollTargets.some(target => target.kind === "container" && target.name === "Invoice list"), "native observation retains the virtualized inner list as a selectable scroll target");
    const observedFrameTree = session.observer.getEvidence(first.evidenceId, { facets: ["frameTree"] }).frameTree;
    assert.ok(frameUrls(observedFrameTree).some(url => url.startsWith(`http://127.0.0.1:${crossOriginPort}/cross-frame.html`)), "the detailed frame tree preserves the cross-origin child relationship");
    const capturedDom = session.observer.getEvidence(first.evidenceId, { facets: ["domSnapshot"] }).domSnapshot;
    const crossFrameDocument = capturedDom.documents.find(document => capturedDom.strings[document.documentURL]?.startsWith(`http://127.0.0.1:${crossOriginPort}/cross-frame.html`));
    const crossFrameSummary = first.frames.find(frame => frame.url.startsWith(`http://127.0.0.1:${crossOriginPort}/cross-frame.html`));
    t.diagnostic(`cross-origin observation: frame-tree-present=true DOMSnapshot-document=${Boolean(crossFrameDocument)} compact-frame-summary=${Boolean(crossFrameSummary)}`);
    assert.ok(crossFrameDocument, "the native DOMSnapshot captures the cross-origin child document in this Chrome session");
    assert.equal(crossFrameSummary?.controlSupported, true, "a frame present in this target's DOMSnapshot is offered for native CDP revalidation");
    const frameEvidence = session.observer.getEvidence(first.evidenceId, { facets: ["domSnapshot"] }).domSnapshot;
    const frameDocument = frameEvidence.documents.find(document => frameEvidence.strings[document.documentURL]?.endsWith("/same-frame.html"));
    assert.ok(frameDocument, "the native DOMSnapshot retains the same-origin iframe document");
    const frameButtonIndex = frameDocument.nodes.nodeName.findIndex(index => frameEvidence.strings[index] === "BUTTON");
    assert.ok(frameButtonIndex >= 0, "the iframe button is present in the native DOMSnapshot");
    const frameCandidate = first.candidates.find(candidate => candidate.name === "Open frame controls");
    assert.ok(frameCandidate, "the compact observation exposes a same-origin iframe candidate");
    assert.equal(frameCandidate.frameId, frameEvidence.strings[frameDocument.frameId]);
    const frameRun = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, maxActions: 2, maxRecoveries: 1 }).run("Open frame controls");
    assert.equal(frameRun.status, "succeeded", `goal-driven navigation can click and verify a same-origin iframe action: ${JSON.stringify(frameRun)}`);
    assert.equal(frameRun.page.title, "Frame controls");
    const crossFrameCandidate = first.candidates.find(candidate => candidate.name === "Open cross-origin controls");
    assert.ok(crossFrameCandidate, "a cross-origin button from the native snapshot becomes a frame-tagged candidate");
    assert.equal(crossFrameCandidate.frameId, capturedDom.strings[crossFrameDocument.frameId]);
    const crossFrameRun = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, maxActions: 2, maxRecoveries: 1 }).run("Open cross-origin controls");
    assert.equal(crossFrameRun.status, "succeeded", `a test-only scoped capability admits this exact loopback fixture action: ${JSON.stringify(crossFrameRun)}`);
    assert.equal(crossFrameRun.page.title, "Cross-origin controls");
    const shadowObservation = await session.observe();
    const shadowCandidate = shadowObservation.candidates.find(candidate => candidate.name === "Open shadow preferences");
    assert.ok(shadowCandidate, "the compact observation exposes an actionable control inside an open Shadow DOM");
    const shadowEvidence = session.observer.getEvidence(shadowObservation.evidenceId, { facets: ["domSnapshot"] }).domSnapshot;
    const shadowDocument = shadowEvidence.documents.find(document => document.nodes?.backendNodeId?.includes(shadowCandidate.backendNodeId));
    const shadowButtonIndex = shadowDocument?.nodes.backendNodeId.findIndex(id => id === shadowCandidate.backendNodeId) ?? -1;
    assert.ok(shadowDocument && shadowButtonIndex >= 0, "the native DOMSnapshot retains the open-shadow candidate's backend identity");
    assert.equal(shadowEvidence.strings[shadowDocument.nodes.nodeName[shadowButtonIndex]], "BUTTON");
    const shadowRun = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, maxActions: 2, maxRecoveries: 1 }).run("Open shadow preferences page");
    assert.equal(shadowRun.status, "succeeded", "goal-driven navigation can click and verify a control inside an open Shadow DOM");
    assert.equal(shadowRun.page.title, "Shadow preferences");
    await session.client.send("Runtime.evaluate", { expression: "document.querySelector('#cover').style.display='block'" });
    const coveredObservation = await session.observe();
    assert.ok(coveredObservation.candidates.some(candidate => candidate.name === "Open obstructed controls"), "the covered target remains observable for an explicit interaction check");
    const coveredJournal = new TaskJournal(join(journalDir, "covered-task.json"));
    const coveredRun = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, journal: coveredJournal, maxActions: 2, maxRecoveries: 1 }).run("Open obstructed controls");
    const coveredState = await coveredJournal.read();
    assert.equal(coveredRun.status, "needs_human", "the navigation engine hands off when an overlay blocks the selected target");
    assert.match(coveredState.attempts[0].error.message, /occluded/);
    assert.equal(coveredRun.page, undefined);
    const blockedTitle = await session.client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    assert.equal(blockedTitle.result.value, "Shadow preferences", "the blocked target's click handler did not run");
    await session.client.send("Runtime.evaluate", { expression: "document.querySelector('#cover').style.display='none'" });
    assert.ok(first.coverage.domSnapshot && first.coverage.accessibility);
    assert.equal(first.coverage.screenshot, false, "the default interaction profile does not capture a screenshot");
    assert.ok(first.candidates.some(candidate => candidate.name === "Open account"), JSON.stringify({ frames: first.frames, candidates: first.candidates, generation: first.documentGeneration }));
    const journal = new TaskJournal(join(journalDir, "task.json"));
    await session.close();
    session = undefined;
    await chromeConnection.close();
    chromeConnection = undefined;
    const crashTarget = await resolveAuthorizedTarget(endpoint, target.id, target.id);
    const engineModule = new URL("../src/navigation/engine.js", import.meta.url).href;
    const sessionModule = new URL("../src/browser/session.js", import.meta.url).href;
    const plannerModule = new URL("../src/navigation/planner.js", import.meta.url).href;
    const journalModule = new URL("../src/state/journal.js", import.meta.url).href;
    const terminateAfterDispatch = `
      import { BrowserSession } from ${JSON.stringify(sessionModule)};
      import { NavigationEngine } from ${JSON.stringify(engineModule)};
      import { DeterministicPlanner } from ${JSON.stringify(plannerModule)};
      import { TaskJournal } from ${JSON.stringify(journalModule)};
      const session = await new BrowserSession(JSON.parse(process.env.ACTIVETAB_CRASH_TARGET)).attach();
      const click = session.click.bind(session);
      session.click = async candidate => {
        await click(candidate);
        if (candidate.name === "Open account") process.exit(73);
      };
      await new NavigationEngine(session, { journal: new TaskJournal(process.env.ACTIVETAB_CRASH_JOURNAL), maxActions: 1, maxRecoveries: 1, planner: new DeterministicPlanner(), assertExecutionLease: async () => {} }).run("Open the account page");
      process.exit(74);
    `;
    const crashedProcess = spawnSync(process.execPath, ["--input-type=module", "-e", terminateAfterDispatch], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      env: isolatedModelEnvironment({ ACTIVETAB_CRASH_TARGET: JSON.stringify(crashTarget), ACTIVETAB_CRASH_JOURNAL: journal.path }, profileDir)
    });
    assert.equal(crashedProcess.status, 73, `the child process terminates after native click dispatch: ${crashedProcess.stderr}`);
    const interruptedState = await journal.read();
    assert.equal(interruptedState.attempts.length, 0, "a hard process exit occurs before the post-action attempt record is written");
    assert.equal(interruptedState.pendingAction.action, "click", "the write-ahead journal preserves the dispatched action intent");
    assert.equal(JSON.stringify(interruptedState.pendingAction).includes("Open account"), false, "pending action metadata contains no raw target label");
    assert.equal(interruptedState.recoveryCount ?? 0, 0, "recovery budget is charged only when resume confirms the task did not already succeed");
    assert.equal(interruptedState.goal, "[redacted task goal]", "the on-disk journal does not retain the original goal text");
    assert.match(interruptedState.goalFingerprint, /^[a-f0-9]{64}$/);
    const mismatchedResume = spawnSync(process.execPath, ["src/cli.js", "resume", "--journal", journal.path, "--goal", "Close the account", "--endpoint", endpoint], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: isolatedModelEnvironment({ ACTIVETAB_AUTHORIZED_TARGET_ID: target.id }, profileDir)
    });
    assert.notEqual(mismatchedResume.status, 0, "the CLI refuses a different goal before attaching to the browser");
    assert.match(mismatchedResume.stderr, /does not match the task journal's goal fingerprint/);
    const resumeProcess = spawn(process.execPath, ["src/cli.js", "resume", "--journal", journal.path, "--goal", "Open the account page", "--planner-mode", "deterministic", "--endpoint", endpoint], {
      cwd: process.cwd(),
      env: isolatedModelEnvironment({ ACTIVETAB_AUTHORIZED_TARGET_ID: target.id }, profileDir),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resumeStdout = "";
    let resumeStderr = "";
    resumeProcess.stdout.setEncoding("utf8");
    resumeProcess.stderr.setEncoding("utf8");
    resumeProcess.stdout.on("data", chunk => { resumeStdout += chunk; });
    resumeProcess.stderr.on("data", chunk => { resumeStderr += chunk.slice(-5000); });
    const resumeExit = await new Promise((resolve, reject) => {
      resumeProcess.once("error", reject);
      resumeProcess.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(resumeExit.code, 0, `a new CLI process resumes the interrupted task: ${resumeStderr}`);
    const result = JSON.parse(resumeStdout);
    session = await new BrowserSession(await resolveAuthorizedTarget(endpoint, target.id, target.id)).attach();
    const resumedObservation = await session.observe();
    assert.equal(result.status, "succeeded");
    assert.equal(result.page.title, "Account");
    assert.equal(result.attempts, 2, "the resumed task replans from fresh DOM evidence and completes using the refreshed account control");
    assert.equal(result.recoveries, 1);
    const resumedState = await journal.read();
    assert.equal(resumedState.attempts[0].error.name, "InterruptedAction");
    assert.equal(resumedState.pendingAction, undefined);
    assert.notEqual(resumedState.attempts[0].targetIdentity, resumedState.attempts[1].targetIdentity, "resume acts on the replacement node instead of reusing the target whose dispatch result was lost");
    await session.client.send("Runtime.evaluate", { expression: "fetch('/api/account?session=network-query-token').then(response=>response.json())", returnByValue: true, awaitPromise: true });
    await session.waitForChange();
    const archiveResult = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, maxActions: 2, maxRecoveries: 1 }).run("Open the archive page");
    assert.equal(archiveResult.status, "succeeded", "native CDP scrolls an off-screen target into view before clicking it");
    assert.equal(archiveResult.page.title, "Archive");
    const scrollState = await session.client.send("Runtime.evaluate", { expression: "window.scrollY", returnByValue: true });
    assert.ok(scrollState.result.value > 0, "the real Chrome viewport scrolled to the off-screen target");
    const activity = session.observer.getEvidence(archiveResult.evidenceId, { facets: ["networkActivity", "lifecycleEvents", "domMutations"] });
    const accountRequest = activity.networkActivity.find(request => request.url?.includes("/api/account"));
    assert.ok(accountRequest, "native CDP retained the fixture API request");
    assert.equal(JSON.stringify(activity).includes("network-query-token"), false, "default network evidence strips URL query data");
    const bodyHidden = await session.observer.inspectNetworkResponse(archiveResult.evidenceId, { requestId: accountRequest.requestId });
    assert.equal(bodyHidden.responseBody.status, "not_returned", "selected response content stays hidden by default");
    assert.equal(JSON.stringify(bodyHidden).includes("fixture-response-secret"), false);
    const bodySelected = await session.observer.inspectNetworkResponse(archiveResult.evidenceId, { requestId: accountRequest.requestId, includeSensitive: true });
    assert.equal(bodySelected.responseBody.status, "included", "CDP can retrieve one selected buffered application response");
    assert.equal(JSON.stringify(bodySelected).includes("fixture-response-secret"), false, "credential redaction applies to the complete selected response report");
    const bodyWithCredentials = await session.observer.inspectNetworkResponse(archiveResult.evidenceId, {
      requestId: accountRequest.requestId,
      includeSensitive: true,
      includeCredentialValues: true,
      view: "source"
    });
    assert.equal(bodyWithCredentials.responseBody.credentialValuesIncluded, true);
    assert.equal(bodyWithCredentials.responseBody.truncated, false);
    assert.ok(bodyWithCredentials.responseBody.data.includes("fixture-response-secret"), "the explicit local view exposes the complete credential value for diagnosis");
    assert.equal(bodyWithCredentials.responseBody.credentialDetails.items.some(item => Object.hasOwn(item, "value")), false, "credential metadata describes the value without duplicating it");
    await session.client.send("Runtime.evaluate", {
      expression: "fetch('/api/orders').then(response => response.json()).then(data => { document.body.dataset.apiRows = String(data.orders.length); })",
      returnByValue: true,
      awaitPromise: true
    });
    await session.waitForChange();
    const apiCapabilityService = new CapabilityService({ runApiQualification: runApiShapeFixtureQualification });
    const apiScope = {
      environment: {
        environmentId: "cdp-api-fixture",
        authorizedOrigins: [new URL(session.target.url).origin],
        applications: [{ applicationId: "orders-fixture", origin: new URL(session.target.url).origin }]
      },
      principalId: "cdp-api-test-principal"
    };
    const apiDiscovery = await apiCapabilityService.discoverObservedApis({
      session,
      ...apiScope
    });
    const orderRequest = apiDiscovery.candidates.find(candidate => candidate.endpointPath === "/api/orders");
    assert.ok(orderRequest, "discovery observes the page's completed same-origin JSON GET");
    assert.equal(JSON.stringify(apiDiscovery).includes("fixture-api-secret"), false, "discovery never reads or returns response values");
    const apiInspection = await apiCapabilityService.inspectObservedApi(orderRequest.candidateId, { session, ...apiScope });
    assert.equal(apiInspection.status, "candidate");
    const orderSchema = apiInspection.candidates.find(candidate => JSON.stringify(candidate.collectionPath) === JSON.stringify(["orders"]));
    assert.ok(orderSchema, "explicit response selection derives a record shape");
    assert.deepEqual(orderSchema.fields.map(field => [field.name, field.type, field.readEligible]), [
      ["id", "integer", true], ["total", "number", true], ["status", "string", true], ["api_token", "string", false]
    ]);
    assert.equal(JSON.stringify(orderSchema).includes("fixture-api-secret"), false, "schema evidence contains credential metadata without credential values");
    const apiQualification = await apiCapabilityService.qualifyObservedApi(orderSchema.candidateId, {
      variants: 30,
      principalId: apiScope.principalId
    });
    assert.equal(apiQualification.status, "qualified", JSON.stringify(apiQualification));
    assert.equal(apiQualification.candidate.qualification.variantCount, 30);
    assert.equal(apiQualification.candidate.qualification.evidenceRefs.length, 30);
    const privacyAdversary = structuredClone(orderSchema);
    privacyAdversary.fields.find(field => field.name === "api_token").readEligible = true;
    const rejectedShape = await runApiShapeFixtureQualification({ candidate: privacyAdversary, variants: 3 });
    assert.ok(rejectedShape.variants.every(variant => variant.schemaMatch === false && variant.privacyBoundaryPassed === false), "the independent oracle rejects credential-field eligibility drift");
    assert.ok(activity.lifecycleEvents.length > 0, "native CDP retained page and DOM lifecycle events");
    assert.ok(activity.domMutations.length > 0, "native CDP retained real DOM mutation events from the fixture navigation");
    assert.ok(activity.domMutations.some(mutation => mutation.event === "DOM.childNodeInserted" || mutation.event === "DOM.childNodeRemoved"), "the verified archive action changed the DOM and emitted structural mutation evidence");
    const searchResult = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1 }).run("Search for invoices");
    assert.equal(searchResult.status, "succeeded", `explicit search intent can submit the observed GET form: ${JSON.stringify(searchResult)}`);
    assert.equal(searchResult.page.title, "Search results");
    const customControls = await session.observe();
    const modelControl = customControls.candidates.find(candidate => candidate.role === "combobox" && candidate.name === "Model");
    const taskEditor = customControls.candidates.find(candidate => candidate.role === "textbox" && candidate.name === "Task instructions");
    assert.ok(modelControl, "the observer exposes the fixture's custom ARIA combobox");
    assert.ok(taskEditor, "the observer exposes the fixture's contenteditable textbox");
    await assert.rejects(() => session.selectOption(modelControl, "GLM5.3-flash"), /approved two-step action envelope/, "the composite control refuses direct session dispatch without executor admission");
    const modelSelection = await executeAuthorizedAction({
      session,
      localFixture: true,
      goal: "Select the requested model",
      action: "select",
      candidate: modelControl,
      value: "GLM5.3-flash",
      operationId: "test.local_fixture_model_select",
      operationAuthorizer: {
        authorize({ action, candidate, value, observation }) {
          const allowed = action === "select" && candidate?.identity === modelControl.identity
            && String(candidate?.role ?? "").toLowerCase() === "combobox"
            && value === "GLM5.3-flash" && observation?.page?.url?.startsWith("http://127.0.0.1:");
          return { allowed, category: "test_local_fixture_select", reason: "The test capability is limited to the observed model combobox and exact fixture option." };
        }
      },
      assertExecutionLease: fixtureLease
    });
    assert.equal(modelSelection.status, "dispatched", JSON.stringify(modelSelection));
    assert.equal(modelSelection.dispatchResult.selectionStatus, "selected", "the approved envelope opens the combobox and selects one exact related visible option");
    assert.equal((await session.verifyControlValue(modelControl, "GLM5.3-flash")).matches, true, "custom model selection is verified without returning the selected value");
    assert.equal((await session.client.send("Runtime.evaluate", { expression: "document.querySelector('#model-picker').dataset.unrelatedSelection ?? ''", returnByValue: true })).result.value, "", "an unrelated visible option with the same label is not clicked");
    await session.fillField(taskEditor, "caller-authored fixture task");
    assert.equal((await session.verifyControlValue(taskEditor, "caller-authored fixture task")).matches, true, "contenteditable text entry is verified in-process");
    await session.client.send("Page.reload", { ignoreCache: true });
    await session.waitForChange(5_000);
    const resetObservation = await session.observe();
    assert.equal(resetObservation.page.title, "Demo shop", "the next navigation task starts from the fixture's initial page state");
    const sectionRun = await new NavigationEngine(session, { maxActions: 1, maxRecoveries: 0 }).run("Open the billing history page");
    assert.equal(sectionRun.status, "succeeded", "native observations and deterministic planning resolve repeated labels from their section context");
    assert.equal(sectionRun.page.title, "Billing history");
    const virtualizedRun = await new NavigationEngine(session, { operationAuthorizer: fixtureButtonAuthorizer, maxActions: 10, maxScrolls: 8, maxRecoveries: 0 }).run("Open invoice 24 page");
    assert.equal(virtualizedRun.status, "succeeded", `native wheel input reveals and opens an item rendered only after scrolling: ${JSON.stringify(virtualizedRun)}`);
    assert.equal(virtualizedRun.page.title, "Invoice 24");
    assert.ok(virtualizedRun.attempts >= 2 && virtualizedRun.attempts <= 9, "the task uses bounded scrolls followed by a native click");
    const state = await journal.read();
    assert.equal(state.status, "succeeded");
    if (process.env.ACTIVETAB_SAVE_DEMO_SCREENSHOT) {
      const screenshotObservation = await session.observe({ profile: "visual" });
      const evidence = session.observer.getEvidence(screenshotObservation.evidenceId, { includeScreenshot: true });
      await writeFile(process.env.ACTIVETAB_SAVE_DEMO_SCREENSHOT, Buffer.from(evidence.screenshotBase64, "base64"));
    }
    assert.equal(state.attempts.length, 2);
    assert.equal(JSON.stringify(state).includes("fixture-secret"), false, "journal does not persist form values");
    const beforeTabClose = await session.observe();
    assert.ok(beforeTabClose.candidates.some(candidate => candidate.name === "Open account"));
    const nativeClickBeforeTabClose = session.click.bind(session);
    session.click = async candidate => {
      await nativeClickBeforeTabClose(candidate);
      await session.client.send("Page.close");
      throw new Error("Injected lost action result after tab close.");
    };
    const detachedJournal = { value: undefined, async write(value) { this.value = structuredClone(value); } };
    const detachPlanner = {
      async plan(_goal, observation) {
        const candidate = observation.candidates.find(item => item.name === "Open account");
        return candidate ? { status: "planned", action: { type: "click", target: candidate } } : { status: "ambiguous", reason: "No account control remains." };
      }
    };
    const detachedResult = await new NavigationEngine(session, { planner: detachPlanner, journal: detachedJournal, maxActions: 3, maxRecoveries: 2 }).run("Open the account page");
    assert.equal(detachedResult.status, "unresolved", "a closed authorized tab stops the task without retrying the action");
    assert.equal(detachedResult.attempts, 1);
    assert.equal(session.targetLifecycle, "detached");
    assert.equal(detachedJournal.value.attempts[0].observationUnavailable, true);
    assert.match(detachedJournal.value.attempts[0].observationError.message, /authorized browser target is detached/);
    assert.equal(detachedJournal.value.attempts[0].afterStateFingerprint, undefined);
    session.click = nativeClickBeforeTabClose;
    t.diagnostic(`real Chrome/CDP target ${target.id}: resumed to success after ${result.attempts} actions and ${result.recoveries} recovery`);
  } finally {
    if (session) await session.close().catch(() => {});
    if (chromeConnection) await chromeConnection.close().catch(() => {});
    if (chrome && chrome.exitCode === null) {
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill("SIGTERM"); }
      await Promise.race([once(chrome, "exit"), new Promise(resolve => setTimeout(resolve, 2_000))]);
      if (chrome.exitCode === null) {
        try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
      }
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (crossOriginServer) await new Promise(resolve => crossOriginServer.close(resolve));
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (journalDir) await rm(journalDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
