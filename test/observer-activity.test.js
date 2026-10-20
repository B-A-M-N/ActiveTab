import test from "node:test";
import assert from "node:assert/strict";
import { BrowserActivityRecorder } from "../src/browser/activity.js";
import { BrowserObserver } from "../src/observe/observer.js";
import { indexMarkdownDocument } from "../src/observe/responseBodyInspector.js";
import { MAX_RESPONSE_BODY_BYTES } from "../src/observe/responseBodyShared.js";
import { classifyHumanHandoff } from "../src/navigation/handoff.js";

const pageUrl = "https://page-user:page-pass@example.test/page?token=topsecret#section";
const linkUrl = "https://link-user:link-pass@destination.test/account?session=private#modal";

function fixtureSnapshot() {
  const strings = ["frame-main", pageUrl, "HTML", "A", "Account", "href", linkUrl, "FORM", "BUTTON", "Search", "INPUT", "password", "value", "form-secret", "input", "type", "target", "_blank"];
  return {
    strings,
    documents: [{
      frameId: 0,
      documentURL: 1,
      nodes: {
        nodeName: [2, 3, 7, 8, 10],
        nodeValue: [-1, -1, -1, -1, -1],
        textValue: [-1, 4, -1, 9, -1],
        parentIndex: [-1, 0, 0, 2, 2],
        attributes: [[], [5, 6, 16, 17], [], [], [15, 11, 12, 13]],
        backendNodeId: [1, 2, 4, 5, 3],
        inputValue: [-1, -1, -1, -1, 13]
      },
      layout: { nodeIndex: [1, 3, 4], bounds: [[0, 0, 120, 30], [0, 40, 150, 40], [0, 80, 200, 30]] }
    }]
  };
}

function fixtureActivity() {
  const activity = new BrowserActivityRecorder();
  activity.recordNetworkEvent("Network.requestWillBeSent", {
    requestId: "request-1",
    request: { url: "https://api-user:api-pass@api.test/v1/items?access=network-secret#fragment", method: "GET", headers: { authorization: "must-not-be-retained" }, postData: "must-not-be-retained" },
    type: "Fetch", frameId: "frame-main", loaderId: "loader-1", timestamp: 1.5, initiator: { type: "script" }
  });
  activity.recordNetworkEvent("Network.responseReceived", {
    requestId: "request-1", response: { status: 200, mimeType: "application/json", headers: { "set-cookie": "must-not-be-retained" } }
  });
  activity.recordNetworkEvent("Network.loadingFinished", { requestId: "request-1", timestamp: 1.8, encodedDataLength: 91 });
  activity.recordLifecycleEvent("Page.frameNavigated", { frame: { id: "frame-main", loaderId: "loader-1", url: pageUrl } });
  activity.recordDomMutation("DOM.attributeModified", { nodeId: 4, name: "value", value: "mutation-form-secret" });
  activity.recordDomMutation("DOM.characterDataModified", { nodeId: 5, characterData: "mutation-page-text-secret" });
  activity.recordDomMutation("DOM.attributeModified", { nodeId: 6, name: "href", value: "https://user:pass@mutation.test/path?token=mutation-url-secret#section" });
  activity.recordDomMutation("DOM.childNodeInserted", { node: { nodeId: 7, nodeType: 1, nodeName: "INPUT", attributes: ["placeholder", "sensitive-placeholder", "value", "child-form-secret"] } });
  return activity;
}

function fakeSession() {
  const frameTree = {
    frame: { id: "frame-main", url: pageUrl },
    childFrames: [{ frame: { id: "frame-child", url: "https://frame.test/child?token=frame-secret#x" } }]
  };
  const client = {
    async send(method) {
      if (method === "Page.getFrameTree") return { frameTree };
      if (method === "DOMSnapshot.captureSnapshot") return fixtureSnapshot();
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 2, ignored: false, role: { value: "link" }, name: { value: "Account" } }] };
      if (method === "Runtime.evaluate") return { result: { value: JSON.stringify({ url: pageUrl, title: "Fixture", readyState: "complete" }) } };
      if (method === "Page.captureScreenshot") return { data: "c2NyZWVu" };
      if (method === "Network.getResponseBody") return { body: JSON.stringify({ loaded: true, access_token: "fixture-response-secret" }), base64Encoded: false };
      throw new Error(`Unexpected CDP method: ${method}`);
    }
  };
  return {
    client,
    target: { id: "target-1" },
    documentGeneration: 7,
    activity: fixtureActivity(),
    networkObservationAvailable: true,
    networkClientForTarget(frameTargetId = null) { return frameTargetId ? null : this.client; },
    domObservationAvailable: true
  };
}

test("Markdown diagnostics decompose into nested sections and byte-addressable data blocks", () => {
  const markdown = [
    "# Run",
    "## Evidence",
    "### Parse details",
    "~~~json",
    '{"name":"🌳"}',
    "## A heading inside a code fence",
    "~~~",
    "### Table data",
    "| field | value |",
    "| --- | --- |",
    "| name | tree |",
    ""
  ].join("\r\n");
  const index = indexMarkdownDocument(markdown);
  const [run, evidence, parse, tableSection] = index.sections;
  assert.deepEqual(index.sections.map(section => section.title), ["Run", "Evidence", "Parse details", "Table data"]);
  assert.equal(run.parentId, null);
  assert.equal(evidence.parentId, run.id);
  assert.equal(parse.parentId, evidence.id);
  assert.equal(tableSection.parentId, evidence.id);
  assert.deepEqual(evidence.childIds, [parse.id, tableSection.id]);
  assert.equal(run.subtreeByteLength, Buffer.byteLength(markdown));

  const [fence, table] = index.blocks;
  assert.equal(fence.kind, "code_fence");
  assert.equal(fence.language, "json");
  assert.equal(fence.closed, true);
  assert.equal(fence.parentId, parse.id);
  const bytes = Buffer.from(markdown);
  assert.equal(bytes.subarray(fence.contentOffset, fence.contentOffset + fence.contentByteLength).toString("utf8"), '{"name":"🌳"}\r\n## A heading inside a code fence\r\n');
  assert.equal(bytes.subarray(fence.offset, fence.offset + fence.byteLength).toString("utf8"), "~~~json\r\n{\"name\":\"🌳\"}\r\n## A heading inside a code fence\r\n~~~\r\n");
  assert.equal(table.kind, "table");
  assert.equal(table.parentId, tableSection.id);
  assert.equal(table.rowCount, 2);
  assert.equal(table.columnCount, 2);
  assert.equal(table.inconsistentRowCount, 0);
  assert.equal(bytes.subarray(table.offset, table.offset + table.byteLength).toString("utf8"), "| field | value |\r\n| --- | --- |\r\n| name | tree |\r\n");
});

test("compact and default evidence redact URL secrets while detailed URL access is opt-in", async () => {
  const session = fakeSession();
  const observer = new BrowserObserver(session);
  const compact = await observer.capture({ profile: "visual" });
  assert.match(compact.pageChangeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(compact).includes("pageChangeFingerprint"), false, "the internal wait baseline is not returned as model evidence");
  assert.equal(JSON.stringify(compact).includes(compact.pageChangeFingerprint), false);
  assert.equal(compact.page.url, "https://example.test/page");
  assert.equal(compact.frames[0].url, "https://example.test/page");
  assert.equal(compact.candidates[0].href, "https://destination.test/account");
  assert.equal(compact.candidates[0].opensNewTarget, true);
  assert.equal(compact.candidates[0].target, undefined, "raw page target names are not projected into model-facing candidates");
  assert.equal("recordContext" in compact.candidates[0], false, "local ranking context is not included in the compact candidate projection");
  assert.equal(compact.candidates.find(candidate => candidate.name === "Search").submitsForm, true, "snapshot ancestry identifies a default submit button inside a form");
  assert.equal("attributes" in compact.candidates[0], false, "compact model evidence omits the full attribute map");
  assert.equal(compact.coverage.network, true);
  assert.equal(compact.networkRequestCount, 1);
  const visualEvidence = observer.getEvidence(compact.evidenceId, { facets: ["page"], includeScreenshot: true });
  assert.equal(visualEvidence.screenshotBase64, "c2NyZWVu", "a caller can selectively retrieve the retained screenshot");
  assert.ok(compact.lifecycleEventCount > 0);

  const selected = observer.getEvidence(compact.evidenceId, {
    facets: ["page", "domSnapshot", "frameTree", "selectedElement", "networkActivity", "lifecycleEvents", "domMutations"],
    backendNodeId: 2
  });
  assert.equal("screenshotBase64" in selected, false, "ordinary evidence facets do not include screenshot bytes");
  const safeJson = JSON.stringify(selected);
  for (const secret of ["page-user", "page-pass", "topsecret", "link-user", "link-pass", "private", "api-user", "api-pass", "network-secret", "frame-secret", "form-secret", "must-not-be-retained"]) {
    assert.equal(safeJson.includes(secret), false, `default evidence must omit ${secret}`);
  }
  assert.equal(selected.selectedElement.attributes.href, "https://destination.test/account");
  assert.equal(selected.networkActivity[0].status, 200);
  assert.equal(selected.networkActivityCoverage.headersCaptured, false);
  assert.equal(selected.networkActivityCoverage.bodiesCaptured, false);
  assert.equal(selected.networkActivityCoverage.responseBodyRetrieval, "selected_on_demand");
  assert.equal("protocolRequestId" in selected.networkActivity[0], false);
  assert.equal(selected.domMutations.length, 4);
  assert.equal(selected.domMutationCoverage.available, true);
  assert.equal(selected.domMutations[0].value, null);
  assert.equal(selected.domMutations[0].valueRedacted, true);
  assert.equal(selected.domMutations[1].characterData, null);
  assert.equal(selected.domMutations[1].characterDataRedacted, true);
  assert.equal(selected.domMutations[2].value, "https://mutation.test/path");
  assert.equal(selected.domMutations[3].attributes[0].value, null);
  assert.equal(safeJson.includes("mutation-form-secret"), false);
  assert.equal(safeJson.includes("mutation-page-text-secret"), false);
  assert.equal(safeJson.includes("mutation-url-secret"), false);
  assert.equal(safeJson.includes("child-form-secret"), false);

  const detailedUrls = observer.getEvidence(compact.evidenceId, {
    facets: ["page", "domSnapshot", "frameTree", "selectedElement", "networkActivity", "domMutations"],
    backendNodeId: 2,
    includeSensitiveUrlData: true
  });
  const urlJson = JSON.stringify(detailedUrls);
  assert.ok(urlJson.includes("page-user:page-pass@example.test/page?token=topsecret#section"));
  assert.ok(urlJson.includes("api-user:api-pass@api.test/v1/items?access=network-secret#fragment"));
  assert.ok(urlJson.includes("user:pass@mutation.test/path?token=mutation-url-secret#section"));
  assert.equal(urlJson.includes("form-secret"), false, "URL opt-in does not expose form values");

  const detailedPageText = observer.getEvidence(compact.evidenceId, {
    facets: ["domMutations"],
    includeSensitivePageText: true
  });
  assert.ok(JSON.stringify(detailedPageText).includes("mutation-page-text-secret"));
  assert.equal(JSON.stringify(detailedPageText).includes("mutation-form-secret"), false, "page-text opt-in does not expose form values");

  const detailedMutationForms = observer.getEvidence(compact.evidenceId, {
    facets: ["domMutations"],
    includeSensitiveFormValues: true
  });
  assert.ok(JSON.stringify(detailedMutationForms).includes("mutation-form-secret"));
  assert.equal(JSON.stringify(detailedMutationForms).includes("mutation-page-text-secret"), false, "form opt-in does not expose page text");

  const detailedForms = observer.getEvidence(compact.evidenceId, {
    facets: ["page", "domSnapshot"],
    includeSensitiveFormValues: true
  });
  assert.ok(JSON.stringify(detailedForms).includes("form-secret"));
  assert.equal(JSON.stringify(detailedForms).includes("topsecret"), false, "form opt-in does not expose URL secrets");
});

test("observation profiles make visual capture explicit and expose capture cost metrics", async () => {
  const session = fakeSession();
  const methods = [];
  const originalSend = session.client.send.bind(session.client);
  session.client.send = async (method, ...args) => {
    methods.push(method);
    return originalSend(method, ...args);
  };
  const observer = new BrowserObserver(session);

  const interaction = await observer.capture();
  assert.equal(interaction.observationProfile, "interaction");
  assert.equal(interaction.coverage.screenshot, false);
  assert.equal(interaction.coverage.interactionCandidates, true);
  assert.ok(interaction.candidateCount > 0);
  assert.equal(methods.includes("Page.captureScreenshot"), false, "ordinary interaction evidence avoids screenshot capture");
  assert.ok(interaction.captureMetrics.cdpRoundTrips > 0);
  assert.equal(interaction.captureMetrics.domSnapshotCount, 1);
  assert.ok(interaction.captureMetrics.cdpRoundTripP95Ms >= 0);
  assert.ok(interaction.captureMetrics.captureDurationMs >= 0);
  assert.ok(interaction.captureMetrics.retainedEvidenceBytes > 0);
  assert.ok(interaction.captureMetrics.peakRetainedEvidenceBytes >= interaction.captureMetrics.retainedEvidenceBytes);
  assert.equal(interaction.captureMetrics.documentIndexBuildCount, 1, "candidate discovery and semantic compilation share one root-document index");
  assert.ok(interaction.captureMetrics.documentIndexBuildMs >= 0);
  assert.ok(interaction.captureMetrics.candidateDerivationMs >= 0);
  assert.ok(interaction.captureMetrics.semanticCompilationMs >= 0);

  methods.length = 0;
  const structural = await observer.capture({ profile: "structural" });
  assert.equal(structural.coverage.domSnapshot, true);
  assert.equal(structural.coverage.accessibility, true);
  assert.equal(structural.coverage.interactionCandidates, false);
  assert.equal(structural.candidateCount, 0);
  assert.equal(structural.captureMetrics.domNodeCount > 0, true);
  assert.equal(structural.semanticPage.schemaVersion, 3, "structural reads still receive the semantic page model");
  assert.equal(structural.captureMetrics.documentIndexBuildCount, 1);
  assert.equal(structural.captureMetrics.semanticCompilationMs >= 0, true);
  assert.equal(methods.includes("Page.captureScreenshot"), false);

  methods.length = 0;
  const lightweight = await observer.capture({ profile: "lightweight" });
  assert.equal(lightweight.coverage.domSnapshot, false);
  assert.equal(lightweight.coverage.accessibility, false);
  assert.equal(lightweight.coverage.interactionCandidates, false);
  assert.equal(lightweight.candidateCount, 0);
  assert.equal(lightweight.captureMetrics.domNodeCount, 0);
  assert.equal(methods.includes("DOMSnapshot.captureSnapshot"), false);
  assert.equal(methods.includes("Accessibility.getFullAXTree"), false);
  assert.equal(methods.includes("Page.captureScreenshot"), false);
  const lightweightEvidence = observer.getEvidence(lightweight.evidenceId, { facets: ["page"] });
  assert.equal(lightweightEvidence.observationProfile, "lightweight");
  assert.equal(lightweightEvidence.coverage.domSnapshot, false);

  methods.length = 0;
  const visual = await observer.capture({ profile: "visual" });
  assert.equal(visual.coverage.screenshot, true);
  assert.equal(methods.includes("Page.captureScreenshot"), true);
});

test("root and OOPIF candidate discovery share one document index per captured snapshot", async () => {
  const session = fakeSession();
  const childClient = {
    async send(method) {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-child", url: "https://frame.test/child" } } };
      if (method === "DOMSnapshot.captureSnapshot") {
        const snapshot = fixtureSnapshot();
        snapshot.strings[0] = "frame-child";
        return snapshot;
      }
      if (method === "Accessibility.getFullAXTree") return {
        nodes: [{ backendDOMNodeId: 2, ignored: false, role: { value: "link" }, name: { value: "Account" } }]
      };
      if (method === "Runtime.evaluate") return {
        result: { value: JSON.stringify({ url: "https://frame.test/child", title: "Frame", readyState: "complete" }) }
      };
      throw new Error(`Unexpected frame CDP method: ${method}`);
    }
  };
  session.getOutOfProcessFrames = async () => [{
    targetId: "oopif-target",
    frameId: "frame-child",
    parentFrameId: "frame-main",
    client: childClient,
    domObservationAvailable: true,
    networkObservationAvailable: false
  }];

  const observation = await new BrowserObserver(session).capture({ selectionGoal: "account link" });
  assert.equal(observation.captureMetrics.documentIndexBuildCount, 2, "one index is built for the root and one for the captured OOPIF");
  assert.ok(observation.semanticPage.controls.some(control => control.frameTargetId === "oopif-target"
    && control.frameId === "frame-child"));
});

test("a fresh HTTP 429 is surfaced as a one-shot rate-limit handoff without request URLs", async () => {
  const session = fakeSession();
  session.activity.recordNetworkEvent("Network.requestWillBeSent", {
    requestId: "limited-request",
    request: { url: "https://api.example.test/items?token=must-not-appear", method: "GET" },
    type: "Fetch",
    timestamp: 5
  });
  session.activity.recordNetworkEvent("Network.responseReceived", {
    requestId: "limited-request",
    response: { status: 429, mimeType: "application/json" },
    timestamp: 5.1
  });
  const observer = new BrowserObserver(session);
  const pending = await observer.capture({ includeScreenshot: false });
  assert.deepEqual(pending.networkSignals, [], "an in-flight 429 is not presented as a completed server response");
  session.activity.recordNetworkEvent("Network.loadingFinished", { requestId: "limited-request", timestamp: 5.2 });
  const first = await observer.capture({ includeScreenshot: false });
  const handoff = classifyHumanHandoff(first);
  assert.equal(first.networkSignals.length, 1);
  assert.equal(handoff.category, "rate_limited");
  assert.match(handoff.reason, /stop requests/iu);
  assert.equal(JSON.stringify(first).includes("must-not-appear"), false);

  const next = await observer.capture({ includeScreenshot: false });
  assert.deepEqual(next.networkSignals, [], "the same old 429 cannot retrigger a handoff on a later observation");
});

test("a selected network response body is never fetched or returned without explicit sensitive-data opt-in", async () => {
  const session = fakeSession();
  const originalSend = session.client.send.bind(session.client);
  let bodyReads = 0;
  session.client.send = async (method, params = {}) => {
    if (method === "Network.getResponseBody") {
      bodyReads++;
      assert.equal(params.requestId, "request-1", "the internal protocol identity is used only for the selected request");
      return { body: JSON.stringify({ loaded: true, access_token: "fixture-response-secret" }), base64Encoded: false };
    }
    return originalSend(method, params);
  };
  const observer = new BrowserObserver(session);
  const compact = await observer.capture({ includeScreenshot: false });
  const hidden = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1" });
  assert.equal(bodyReads, 0, "metadata-only selection does not ask Chrome for the response body");
  assert.equal(hidden.responseBody.status, "not_returned");
  assert.equal(JSON.stringify(hidden).includes("fixture-response-secret"), false);

  const included = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeSensitive: true, view: "normalized" });
  assert.equal(bodyReads, 1);
  assert.equal(included.responseBody.status, "included");
  assert.equal(included.responseBody.data, JSON.stringify({ loaded: true, access_token: "[REDACTED]" }));
  assert.equal(included.responseBody.credentialDetails.items[0].kind, "access_token");
  assert.equal(included.responseBody.credentialDetails.items[0].characterLength, "fixture-response-secret".length);
  assert.equal(JSON.stringify(included).includes("fixture-response-secret"), false);
  const preCancelled = new AbortController();
  preCancelled.abort();
  const cancelledCacheRead = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "normalized", signal: preCancelled.signal
  });
  assert.equal(cancelledCacheRead.responseBody.status, "cancelled", "an aborted caller cannot receive a cached projection");
  assert.equal(bodyReads, 1);
  await assert.rejects(
    observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", offset: -1 }),
    /non-negative safe integer/u
  );
  await assert.rejects(
    observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", offset: Number.MAX_SAFE_INTEGER + 1 }),
    /non-negative safe integer/u
  );
  const revealed = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, includeCredentialValues: true, view: "normalized"
  });
  assert.equal(revealed.responseBody.data, JSON.stringify({ loaded: true, access_token: "fixture-response-secret" }));
  assert.equal(revealed.responseBody.credentialValuesIncluded, true);
  assert.equal(Object.hasOwn(revealed.responseBody.credentialDetails.items[0], "value"), false, "credential summaries identify values without duplicating them outside the paged source");
  assert.ok(JSON.stringify(revealed).includes("fixture-response-secret"));
  assert.equal(bodyReads, 2, "explicit full credential views bypass reusable redacted projections");
  await assert.rejects(
    observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeCredentialValues: true }),
    /requires includeSensitive:true/u
  );
  assert.equal(included.responseBody.hasMore, false);
  const page = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeSensitive: true, view: "normalized", maxBytes: 12 });
  assert.equal(page.responseBody.truncated, false);
  assert.equal(page.responseBody.returnedBytes, 12);
  assert.equal(page.responseBody.hasMore, true);
  assert.equal(bodyReads, 2, "redacted pages reuse the existing projection");

  const markdown = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeSensitive: true, view: "markdown" });
  assert.equal(markdown.responseBody.status, "included");
  assert.ok(markdown.responseBody.sections.some(section => section.title === "Response body: json"));
  assert.ok(markdown.responseBody.sections.some(section => section.parentId === "response-body-json"));
  assert.ok(markdown.responseBody.blocks.some(block => block.kind === "code_fence" && block.language === "json"));
  assert.equal(JSON.stringify(markdown).includes("fixture-response-secret"), false);
  const revealedMarkdown = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, includeCredentialValues: true, view: "markdown"
  });
  assert.ok(revealedMarkdown.responseBody.data.includes("fixture-response-secret"));
  assert.match(revealedMarkdown.responseBody.data, /Complete source \(credential values included\)/u);
  assert.equal(bodyReads, 4, "full credential Markdown is acquired directly and never stored in the redacted projection cache");
  assert.equal((await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "missing" })).status, "not_found");
});

test("response body acquisition enforces byte limits and reports timeout or cancellation", async () => {
  const reportedLargeSession = fakeSession();
  reportedLargeSession.activity.recordNetworkEvent("Network.dataReceived", {
    requestId: "request-1", dataLength: MAX_RESPONSE_BODY_BYTES + 1
  });
  let reportedLargeBodyReads = 0;
  const reportedLargeSend = reportedLargeSession.client.send.bind(reportedLargeSession.client);
  reportedLargeSession.client.send = async (method, params) => {
    if (method === "Network.getResponseBody") reportedLargeBodyReads++;
    return reportedLargeSend(method, params);
  };
  const reportedLargeObserver = new BrowserObserver(reportedLargeSession);
  const reportedLargeEvidence = await reportedLargeObserver.capture({ includeScreenshot: false });
  const preflight = await reportedLargeObserver.inspectNetworkResponse(reportedLargeEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true
  });
  assert.equal(preflight.responseBody.status, "over_limit");
  assert.equal(preflight.responseBody.reasonCode, "reported_decoded_body_bytes_limit");
  assert.equal(preflight.responseBody.bodyRetrieved, false);
  assert.equal(preflight.responseBody.acquisition.status, "over_limit");
  assert.equal(reportedLargeBodyReads, 0, "retained CDP byte counts reject oversized responses before retrieving the body");

  const encodedLargeSession = fakeSession();
  encodedLargeSession.activity.recordNetworkEvent("Network.loadingFinished", {
    requestId: "request-1", timestamp: 1.9, encodedDataLength: MAX_RESPONSE_BODY_BYTES + 1
  });
  let encodedLargeBodyReads = 0;
  const encodedLargeSend = encodedLargeSession.client.send.bind(encodedLargeSession.client);
  encodedLargeSession.client.send = async (method, params) => {
    if (method === "Network.getResponseBody") encodedLargeBodyReads++;
    return encodedLargeSend(method, params);
  };
  const encodedLargeObserver = new BrowserObserver(encodedLargeSession);
  const encodedLargeEvidence = await encodedLargeObserver.capture({ includeScreenshot: false });
  const encodedPreflight = await encodedLargeObserver.inspectNetworkResponse(encodedLargeEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true
  });
  assert.equal(encodedPreflight.responseBody.status, "over_limit");
  assert.equal(encodedPreflight.responseBody.reasonCode, "reported_encoded_body_bytes_limit");
  assert.equal(encodedPreflight.responseBody.bodyRetrieved, false);
  assert.equal(encodedLargeBodyReads, 0, "oversized transfer counts reject before the all-at-once CDP body result is requested");

  const actualLargeSession = fakeSession();
  const actualLargeSend = actualLargeSession.client.send.bind(actualLargeSession.client);
  actualLargeSession.client.send = async (method, params) => method === "Network.getResponseBody"
    ? { body: "x".repeat(MAX_RESPONSE_BODY_BYTES + 1), base64Encoded: false }
    : actualLargeSend(method, params);
  const actualLargeObserver = new BrowserObserver(actualLargeSession);
  const actualLargeEvidence = await actualLargeObserver.capture({ includeScreenshot: false });
  const actualLarge = await actualLargeObserver.inspectNetworkResponse(actualLargeEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true
  });
  assert.equal(actualLarge.responseBody.status, "over_limit");
  assert.equal(actualLarge.responseBody.reasonCode, "decoded_body_bytes_limit");
  assert.equal(actualLarge.responseBody.bodyRetrieved, true);
  assert.equal(actualLarge.responseBody.bodyDecoded, false);
  assert.equal(actualLarge.responseBody.acquisition.hardMemoryBound, false);

  const unknownSizeSession = fakeSession();
  const unknownSizeObserver = new BrowserObserver(unknownSizeSession);
  const unknownSizeEvidence = await unknownSizeObserver.capture({ includeScreenshot: false });
  const unknownRequest = unknownSizeObserver.evidence.get(unknownSizeEvidence.evidenceId).evidence.activity.networkRequests
    .find(item => item.requestId === "request-1");
  unknownRequest.encodedDataLength = null;
  unknownRequest.decodedDataLength = 0;
  unknownRequest.dataChunkCount = 0;
  const unknownSizeResult = await unknownSizeObserver.inspectNetworkResponse(unknownSizeEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "normalized"
  });
  assert.equal(unknownSizeResult.responseBody.status, "included");
  assert.equal(unknownSizeResult.responseBody.acquisition.status, "size_unknown");
  assert.equal(unknownSizeResult.responseBody.acquisition.contentTypeClass, "textual");
  assert.equal(unknownSizeResult.responseBody.acquisition.hardMemoryBound, false);
  assert.equal(unknownSizeResult.responseBody.acquisition.transportBehavior, "cdp_materializes_complete_body_result");

  const streamingSession = fakeSession();
  let streamingBodyReads = 0;
  const streamingSend = streamingSession.client.send.bind(streamingSession.client);
  streamingSession.client.send = async (method, params) => {
    if (method === "Network.getResponseBody") streamingBodyReads++;
    return streamingSend(method, params);
  };
  const streamingObserver = new BrowserObserver(streamingSession);
  const streamingEvidence = await streamingObserver.capture({ includeScreenshot: false });
  streamingObserver.evidence.get(streamingEvidence.evidenceId).evidence.activity.networkRequests
    .find(item => item.requestId === "request-1").resourceType = "WebSocket";
  const streamingResult = await streamingObserver.inspectNetworkResponse(streamingEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true
  });
  assert.equal(streamingResult.responseBody.status, "unsupported");
  assert.equal(streamingResult.responseBody.reasonCode, "streaming_request_type_unsupported");
  assert.equal(streamingBodyReads, 0);

  const concurrentSession = fakeSession();
  const concurrentSend = concurrentSession.client.send.bind(concurrentSession.client);
  let concurrentBodyReads = 0;
  let releaseFirstBody;
  concurrentSession.client.send = (method, params) => {
    if (method !== "Network.getResponseBody") return concurrentSend(method, params);
    concurrentBodyReads++;
    if (concurrentBodyReads === 1) return new Promise(resolve => { releaseFirstBody = resolve; });
    return Promise.resolve({ body: "{\"safe\":true}", base64Encoded: false });
  };
  const concurrentObserver = new BrowserObserver(concurrentSession);
  const concurrentEvidence = await concurrentObserver.capture({ includeScreenshot: false });
  const concurrentOptions = {
    requestId: "request-1", includeSensitive: true, includeCredentialValues: true, view: "normalized"
  };
  const firstAcquisition = concurrentObserver.inspectNetworkResponse(concurrentEvidence.evidenceId, concurrentOptions);
  await new Promise(resolve => setImmediate(resolve));
  const overlappingAcquisition = await concurrentObserver.inspectNetworkResponse(concurrentEvidence.evidenceId, concurrentOptions);
  assert.equal(overlappingAcquisition.responseBody.status, "busy");
  assert.equal(overlappingAcquisition.responseBody.reasonCode, "session_response_body_acquisition_in_progress");
  assert.equal(concurrentBodyReads, 1, "a second request cannot add another pending complete-body command to the same session");
  releaseFirstBody({ body: "{\"first\":true}", base64Encoded: false });
  assert.equal((await firstAcquisition).responseBody.status, "included");
  assert.equal((await concurrentObserver.inspectNetworkResponse(concurrentEvidence.evidenceId, concurrentOptions)).responseBody.status, "included");
  assert.equal(concurrentBodyReads, 2, "the session slot releases when the underlying CDP command settles");

  const pendingSession = fakeSession();
  const pendingSend = pendingSession.client.send.bind(pendingSession.client);
  let pendingBodyReads = 0;
  pendingSession.client.send = (method, params) => {
    if (method === "Network.getResponseBody") {
      pendingBodyReads++;
      return new Promise(() => {});
    }
    return pendingSend(method, params);
  };
  const pendingObserver = new BrowserObserver(pendingSession);
  const pendingEvidence = await pendingObserver.capture({ includeScreenshot: false });
  const timedOut = await pendingObserver.inspectNetworkResponse(pendingEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true, timeoutMs: 5
  });
  assert.equal(timedOut.responseBody.status, "timed_out");
  assert.equal(timedOut.responseBody.phase, "acquisition");
  const afterTimeout = await pendingObserver.inspectNetworkResponse(pendingEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true, timeoutMs: 5
  });
  assert.equal(afterTimeout.responseBody.status, "busy", "caller timeout leaves the unresolved CDP command slot held");
  assert.equal(pendingBodyReads, 1);

  const cancelledSession = fakeSession();
  const cancelledSend = cancelledSession.client.send.bind(cancelledSession.client);
  cancelledSession.client.send = (method, params) => method === "Network.getResponseBody"
    ? new Promise(() => {})
    : cancelledSend(method, params);
  const cancelledObserver = new BrowserObserver(cancelledSession);
  const cancelledEvidence = await cancelledObserver.capture({ includeScreenshot: false });
  const abortController = new AbortController();
  const cancelledPromise = cancelledObserver.inspectNetworkResponse(cancelledEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true, signal: abortController.signal
  });
  setImmediate(() => abortController.abort());
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.responseBody.status, "cancelled");
  assert.equal(cancelled.responseBody.phase, "acquisition");
  const afterCancellation = await cancelledObserver.inspectNetworkResponse(cancelledEvidence.evidenceId, {
    requestId: "request-1", includeSensitive: true
  });
  assert.equal(afterCancellation.responseBody.status, "busy", "caller cancellation cannot permit overlapping CDP body commands");
});

test("Markdown response diagnostics can drill into nested sections and page exact indexed blocks", async () => {
  const session = fakeSession();
  const source = JSON.stringify({
    result: { records: [{ id: 1, profile: { name: "A", email: "a@example.test" } }, { id: 2, profile: { name: "B", email: "b@example.test" } }] },
    access_token: "fixture-response-secret"
  });
  const originalSend = session.client.send.bind(session.client);
  let responseBodyReads = 0;
  session.client.send = async (method, params = {}) => {
    if (method === "Network.getResponseBody") {
      responseBodyReads++;
      return { body: source, base64Encoded: false };
    }
    return originalSend(method, params);
  };
  const observer = new BrowserObserver(session);
  const compact = await observer.capture({ includeScreenshot: false });
  const overview = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "markdown", maxBytes: 256 * 1024
  });
  const report = overview.responseBody;
  assert.equal(report.inspectionMetrics.projectionCacheHit, false);
  const records = report.sections.find(section => section.title.includes("$.result.records"));
  const result = report.sections.find(section => section.title.includes("$.result`"));
  const profile = report.sections.find(section => section.title.includes("$.result.records[].profile"));
  assert.ok(records, "the report indexes the nested records section");
  assert.ok(result, "object-only containers remain addressable in the section tree");
  assert.ok(profile, "nested object fields remain addressable in the section tree");
  assert.equal(records.parentId, result.id);
  assert.equal(profile.parentId, records.id);
  assert.ok(records.childIds.includes(profile.id));
  const sectionView = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "markdown", sectionId: records.id, maxBytes: 256 * 1024
  });
  assert.equal(sectionView.responseBody.selection.kind, "section");
  assert.equal(sectionView.responseBody.inspectionMetrics.projectionCacheHit, true);
  assert.equal(sectionView.responseBody.selection.id, records.id);
  assert.match(sectionView.responseBody.data, /\| id \| profile \|/u);
  assert.match(sectionView.responseBody.data, /#### `\$\.result\.records\[\]\.profile`/u);
  assert.equal(JSON.stringify(sectionView).includes("fixture-response-secret"), false);

  const normalizedJsonSection = report.sections.find(section => section.title === "Normalized, redacted JSON");
  const normalizedBlock = report.blocks.find(block => block.kind === "code_fence" && block.language === "json" && block.parentId === normalizedJsonSection.id);
  assert.ok(normalizedBlock);
  const firstPage = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "markdown", blockId: normalizedBlock.id, maxBytes: 32
  });
  assert.equal(firstPage.responseBody.selection.kind, "block");
  assert.equal(firstPage.responseBody.selection.id, normalizedBlock.id);
  assert.equal(firstPage.responseBody.offset, 0);
  assert.equal(firstPage.responseBody.documentOffset, normalizedBlock.offset);
  assert.equal(firstPage.responseBody.hasMore, true);
  assert.equal(firstPage.responseBody.inspectionMetrics.projectionCacheHit, true);
  let pages = [firstPage.responseBody.data];
  let finalPagingMetrics = firstPage.responseBody.inspectionMetrics.paging;
  let nextOffset = firstPage.responseBody.nextOffset;
  while (nextOffset < normalizedBlock.byteLength) {
    const next = await observer.inspectNetworkResponse(compact.evidenceId, {
      requestId: "request-1", includeSensitive: true, view: "markdown", blockId: normalizedBlock.id, offset: nextOffset, maxBytes: 32
    });
    pages.push(next.responseBody.data);
    finalPagingMetrics = next.responseBody.inspectionMetrics.paging;
    assert.equal(next.responseBody.documentOffset, normalizedBlock.offset + nextOffset);
    nextOffset = next.responseBody.nextOffset;
  }
  const fullBlock = Buffer.from(report.data).subarray(normalizedBlock.offset, normalizedBlock.offset + normalizedBlock.byteLength).toString("utf8");
  assert.equal(pages.join(""), fullBlock, "block paging reconstructs every byte of the complete redacted block");
  assert.equal(fullBlock.includes("fixture-response-secret"), false);
  assert.equal(responseBodyReads, 1, "section and page requests reuse the bounded redacted projection instead of reacquiring the CDP body");
  assert.ok(firstPage.responseBody.inspectionMetrics.paging.utf8IndexedLookups > 0);
  assert.ok(finalPagingMetrics.utf8CursorHits > 0, "sequential block pages reuse their prior UTF-8 character cursor");
  session.target.id = "target-2";
  const afterTargetChange = await observer.inspectNetworkResponse(compact.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "markdown"
  });
  assert.equal(afterTargetChange.status, "stale", "the old projection cannot be read or reacquired through a changed browser target");
  assert.equal(afterTargetChange.reasonCode, "evidence_target_changed");
  assert.equal(responseBodyReads, 1);
});

test("response projection cache entries are cleared when their evidence is evicted", async () => {
  const session = fakeSession();
  const originalSend = session.client.send.bind(session.client);
  let responseBodyReads = 0;
  session.client.send = async (method, params = {}) => {
    if (method === "Network.getResponseBody") {
      responseBodyReads++;
      return { body: JSON.stringify({ ok: true }), base64Encoded: false };
    }
    return originalSend(method, params);
  };
  const observer = new BrowserObserver(session, { evidenceLimit: 1 });
  const first = await observer.capture({ includeScreenshot: false });
  const inspected = await observer.inspectNetworkResponse(first.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "normalized"
  });
  assert.equal(inspected.responseBody.inspectionMetrics.projectionCacheHit, false);
  assert.equal(observer.responseProjectionCache.size, 1);

  await observer.capture({ includeScreenshot: false });
  assert.equal(observer.responseProjectionCache.size, 0, "evicting evidence also releases its cached projection");
  assert.equal((await observer.inspectNetworkResponse(first.evidenceId, {
    requestId: "request-1", includeSensitive: true, view: "normalized"
  })).status, "expired");
  assert.equal(responseBodyReads, 1);
});

test("out-of-process network events retain their target-qualified request identity", () => {
  const activity = new BrowserActivityRecorder();
  activity.recordNetworkEvent("Network.requestWillBeSent", {
    requestId: "shared-request-id",
    request: { url: "https://frame.test/api", method: "GET" },
    timestamp: 1
  }, { frameTargetId: "frame-target-1" });
  activity.recordNetworkEvent("Network.requestWillBeSent", {
    requestId: "shared-request-id",
    request: { url: "https://frame.test/api", method: "GET" },
    timestamp: 1
  }, { frameTargetId: "frame-target-2" });
  activity.recordNetworkEvent("Network.responseReceived", {
    requestId: "shared-request-id",
    response: { status: 201, mimeType: "application/json" }
  }, { frameTargetId: "frame-target-2" });
  activity.recordNetworkEvent("Network.loadingFinished", {
    requestId: "shared-request-id",
    timestamp: 2,
    encodedDataLength: 24
  }, { frameTargetId: "frame-target-2" });

  const [first, second] = activity.snapshot().networkRequests;
  assert.equal(first.requestId, "frame-target-1:shared-request-id");
  assert.equal(first.status, null);
  assert.equal(first.finishedAt, null);
  assert.equal(second.requestId, "frame-target-2:shared-request-id");
  assert.equal(second.status, 201);
  assert.equal(second.finishedAt, 2);
  assert.equal(second.protocolRequestId, "shared-request-id", "the CDP request id remains internal for selected response retrieval");
});

test("network, lifecycle, and DOM mutation journals are bounded while raw deltas stay local", () => {
  const activity = new BrowserActivityRecorder({ maxRequests: 2, maxLifecycleEvents: 2, maxDomMutations: 2 });
  for (let index = 0; index < 3; index++) {
    activity.recordNetworkEvent("Network.requestWillBeSent", {
      requestId: `request-${index}`,
      request: { url: `https://example.test/${index}`, method: "GET", headers: { authorization: "private" }, postData: "private" },
      timestamp: index
    });
    activity.recordLifecycleEvent("Page.lifecycleEvent", { name: `event-${index}`, timestamp: index });
    activity.recordDomMutation("DOM.characterDataModified", { characterData: `private-${index}` });
  }
  const snapshot = activity.snapshot();
  assert.equal(snapshot.networkRequests.length, 2);
  assert.equal(snapshot.lifecycleEvents.length, 2);
  assert.equal(snapshot.droppedRequests, 1);
  assert.equal(snapshot.droppedLifecycleEvents, 1);
  assert.equal(snapshot.domMutations.length, 2);
  assert.equal(snapshot.droppedDomMutations, 1);
  assert.equal(JSON.stringify(snapshot).includes("authorization"), false, "request and response headers are not retained");
  assert.equal(JSON.stringify(snapshot).includes('"postData"'), false, "request bodies are not retained");
  assert.equal(JSON.stringify(snapshot).includes("private-2"), true, "raw mutation text remains available to the local observer for filtered retrieval");
});

test("mutation deltas preserve event-specific shadow, pseudo, style, and distribution identities", () => {
  const activity = new BrowserActivityRecorder({ maxDomMutations: 10 });
  activity.recordDomMutation("DOM.shadowRootPushed", {
    hostId: 10,
    root: { nodeId: 11, backendNodeId: 110, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open" }
  });
  activity.recordDomMutation("DOM.pseudoElementAdded", {
    parentId: 12,
    pseudoElement: { nodeId: 13, backendNodeId: 130, nodeType: 1, nodeName: "::before", pseudoType: "before" }
  });
  activity.recordDomMutation("DOM.inlineStyleInvalidated", { nodeIds: [20, 21, 22] });
  activity.recordDomMutation("DOM.distributedNodesUpdated", {
    insertionPointId: 30,
    distributedNodes: [{ backendNodeId: 301 }, { backendNodeId: 302 }]
  });
  const [shadowRoot, pseudoElement, styleInvalidation, distribution] = activity.snapshot().domMutations;
  assert.equal(shadowRoot.hostId, 10);
  assert.equal(shadowRoot.nodeId, 11);
  assert.equal(shadowRoot.shadowRootType, "open");
  assert.equal(pseudoElement.parentId, 12);
  assert.equal(pseudoElement.pseudoType, "before");
  assert.deepEqual(styleInvalidation.relatedNodeIds, [20, 21, 22]);
  assert.equal(distribution.insertionPointId, 30);
  assert.deepEqual(distribution.relatedBackendNodeIds, [301, 302]);
});

test("OOPIF snapshots that exceed the remaining evidence budget are omitted with explicit coverage", async () => {
  const session = fakeSession();
  session.getOutOfProcessFrames = async () => [{
    targetId: "oopif-target",
    frameId: "oopif-frame",
    parentFrameId: "frame-main",
    status: "ready",
    domObservationAvailable: true,
    networkObservationAvailable: true,
    client: {
      async send(method) {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "oopif-frame", url: "https://frame.test/child" } } };
        if (method === "DOMSnapshot.captureSnapshot") return { strings: ["x".repeat(1_100_000)], documents: [] };
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "Runtime.evaluate") return { result: { value: JSON.stringify({ url: "https://frame.test/child", title: "Child", readyState: "complete" }) } };
        throw new Error(`Unexpected child CDP method: ${method}`);
      }
    }
  }];
  const observer = new BrowserObserver(session, { maxEvidenceBytes: 1024 * 1024 });
  const compact = await observer.capture();
  assert.equal(compact.retained, true);
  assert.equal(compact.coverage.outOfProcessFramesObserved, 0);
  assert.equal(compact.coverage.outOfProcessFramesOmitted, 1);
  const detailed = observer.getEvidence(compact.evidenceId, { facets: ["outOfProcessFrames"] });
  assert.equal(detailed.outOfProcessFrames[0].status, "omitted");
  assert.equal(detailed.outOfProcessFrames[0].reason, "observation_budget");
});
