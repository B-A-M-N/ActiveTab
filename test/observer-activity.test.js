import test from "node:test";
import assert from "node:assert/strict";
import { BrowserActivityRecorder } from "../src/browser/activity.js";
import { BrowserObserver } from "../src/observe/observer.js";

const pageUrl = "https://page-user:page-pass@example.test/page?token=topsecret#section";
const linkUrl = "https://link-user:link-pass@destination.test/account?session=private#modal";

function fixtureSnapshot() {
  const strings = ["frame-main", pageUrl, "HTML", "A", "Account", "href", linkUrl, "FORM", "BUTTON", "Search", "INPUT", "password", "value", "form-secret", "input", "type"];
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
        attributes: [[], [5, 6], [], [], [15, 11, 12, 13]],
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

test("compact and default evidence redact URL secrets while detailed URL access is opt-in", async () => {
  const session = fakeSession();
  const observer = new BrowserObserver(session);
  const compact = await observer.capture();
  assert.match(compact.pageChangeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(compact).includes("pageChangeFingerprint"), false, "the internal wait baseline is not returned as model evidence");
  assert.equal(JSON.stringify(compact).includes(compact.pageChangeFingerprint), false);
  assert.equal(compact.page.url, "https://example.test/page");
  assert.equal(compact.frames[0].url, "https://example.test/page");
  assert.equal(compact.candidates[0].href, "https://destination.test/account");
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

  const included = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeSensitive: true });
  assert.equal(bodyReads, 1);
  assert.equal(included.responseBody.status, "included");
  assert.equal(included.responseBody.data, JSON.stringify({ loaded: true, access_token: "fixture-response-secret" }));
  const truncated = await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "request-1", includeSensitive: true, maxBytes: 12 });
  assert.equal(truncated.responseBody.truncated, true);
  assert.equal(truncated.responseBody.returnedBytes, 12);
  assert.equal((await observer.inspectNetworkResponse(compact.evidenceId, { requestId: "missing" })).status, "not_found");
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
