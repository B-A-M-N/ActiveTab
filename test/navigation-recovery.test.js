import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserSession } from "../src/browser/session.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import { FileUploadGrantStore } from "../src/runtime/fileUploadGrants.js";
import { DISPATCH_DISPOSITION, normalizeDispatchOutcome } from "../src/runtime/dispatchDisposition.js";

test("BrowserSession tracks and handles JavaScript dialogs", async t => {
  const dialogEvent = { type: "confirm", message: "Are you sure?", url: "http://fixture.local/" };
  const events = [];
  const handlers = new Map();
  const sessionId = () => "sim";
  const mockTransport = {
    on: (method, listener) => {
      // Store a dispatcher that matches the session-client's session filter.
      handlers.set(method, params => listener(params, sessionId()));
      return () => {};
    },
    send: async (method, params) => {
      if (method === "Page.handleJavaScriptDialog") {
        events.push({ method, params });
        return {};
      }
      throw new Error(`Unexpected ${method}`);
    }
  };
  const target = {
    id: "test-target", url: "http://fixture.local/",
    browserClient: mockTransport, rootAlreadyAttached: true
  };
  const session = new BrowserSession(target);
  // Simulate attach minimal state.
  session.attached = true;
  session.targetLifecycle = "attached";
  session.sessionId = "sim";
  session.client = {
    send: mockTransport.send,
    on: (method, listener) => {
      handlers.set(method, params => listener(params, sessionId()));
      return () => {};
    }
  };
  // Private #onDialogOpening is not accessible from tests; simulate what it
  // stores by setting the state directly and testing handleDialog.
  session.pendingDialog = {
    type: dialogEvent.type,
    message: dialogEvent.message,
    defaultPrompt: dialogEvent.defaultPrompt,
    url: dialogEvent.url,
    capturedAt: new Date().toISOString()
  };

  assert.equal(session.hasPendingDialog, true);
  assert.equal(session.hasPendingDialog, true);
  assert.equal(session.pendingDialog.type, "confirm");
  assert.equal(session.pendingDialog.message, "Are you sure?");

  // Accept the dialog.
  const result = await session.handleDialog({ accept: true });
  assert.equal(result.accepted, true);
  assert.equal(result.type, "confirm");
  assert.equal(session.hasPendingDialog, false);
  assert.equal(events[0].method, "Page.handleJavaScriptDialog");
  assert.equal(events[0].params.accept, true);

  // Simulate a prompt dialog.
  session.pendingDialog = { type: "prompt", message: "Enter value", defaultPrompt: "old", url: null, capturedAt: new Date().toISOString() };
  assert.equal(session.hasPendingDialog, true);
  const promptResult = await session.handleDialog({ accept: true, promptText: "new-value" });
  assert.equal(promptResult.accepted, true);
  assert.equal(events[1].params.promptText, "new-value");

  // HandleDialog without a pending dialog throws.
  await assert.rejects(() => session.handleDialog(), /No JavaScript dialog is currently open/);
});

test("stale-looking exception text stays uncertain unless the executor returns a typed pre-dispatch refusal", () => {
  const errorOutcome = normalizeDispatchOutcome({ error: new Error("The target became stale before dispatch.") });
  assert.equal(errorOutcome.dispatchDisposition, DISPATCH_DISPOSITION.UNCERTAIN);
  assert.equal(errorOutcome.browserEffectPossible, true);
  assert.equal(errorOutcome.retryWithoutReconciliation, false);

  const refusal = normalizeDispatchOutcome({
    dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
    reasonCode: "target_occluded"
  });
  assert.equal(refusal.dispatchStatus, "refused");
  assert.equal(refusal.browserEffectPossible, false);
  assert.equal(refusal.retryWithoutReconciliation, true);

  const unboundedCode = normalizeDispatchOutcome({
    dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
    reasonCode: "unexpected free-form page text"
  });
  assert.equal(unboundedCode.reasonCode, null, "only bounded reason codes enter durable pending metadata");
});

test("scroll convergence stops after repeated scrolling without new content", async t => {
  // Simulate a scroll target that never produces new matching candidates.
  const scrollTarget = {
    identity: "scroll-list", kind: "container", name: "List",
    visible: true, canScrollDown: true, scrollTop: 0, maxScrollTop: 1000, backendNodeId: 10
  };
  let scrollCount = 0;
  const mockSession = {
    target: { id: "t1", endpoint: "local-cdp" },
    documentGeneration: 1,
    async observe() {
      return {
        evidenceId: `ev-${scrollCount}`,
        page: { url: "http://fixture.local/", title: "Infinite" },
        candidates: [], // Never produces matching candidates
        headings: [], frames: [],
        scrollTargets: [scrollTarget],
        pageChangeFingerprint: `fp-${scrollCount}`
      };
    },
    async scroll(target) {
      scrollCount++;
      target.scrollTop = scrollCount * 100;
      return { dispatched: true };
    },
    async waitForChange() {}
  };
  // Use a goal that should trigger scrolling but never finds a target.
  const engine = new NavigationEngine(mockSession, { maxActions: 10, maxScrolls: 8, maxRecoveries: 0 });
  const result = await engine.run("Find a specific item in the list");
  // The engine should stop before exhausting all 8 scroll actions.
  assert.ok(result.attempts < 8, `Engine should stop before 8 scrolls, got ${result.attempts}`);
  assert.ok(["unresolved", "needs_human"].includes(result.status), `Unexpected status: ${result.status}`);
  t.diagnostic(`Scroll convergence: stopped after ${result.attempts} actions with status ${result.status}`);
});

test("BrowserSession uploadFile dispatches only a specifically staged one-use grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-upload-session-"));
  try {
  const sourcePath = join(directory, "test-file-a.txt");
  await writeFile(sourcePath, "approved local fixture");
  const grants = new FileUploadGrantStore({ stagingDirectory: join(directory, "staged"), allowedRoots: [directory], trustedIssuer: "unit-test-operator" });
  const cdpCalls = [];
  const session = new BrowserSession({
    id: "t1", url: "http://fixture.local/",
    browserClient: {
      on: () => () => {},
      send: async (method, params) => {
        cdpCalls.push({ method, params });
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: { connected: true, disabled: false, labelMatches: true, multiple: true } } };
        }
        if (method === "DOM.setFileInputFiles") return {};
        if (method === "Runtime.releaseObject") return {};
        throw new Error(`Unexpected ${method}`);
      }
    },
    rootAlreadyAttached: true
  });
  session.attached = true;
  session.targetLifecycle = "attached";
  session.sessionId = "sim";
  session.documentGeneration = 1;
  session.client = {
    send: async (method, params) => {
      cdpCalls.push({ method, params });
      if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { connected: true, disabled: false, labelMatches: true, multiple: true } } };
      }
      if (method === "DOM.setFileInputFiles") return {};
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`Unexpected ${method}`);
    }
  };
  const candidate = {
    identity: "file-input-1", backendNodeId: 10, targetId: "t1",
    tag: "input", type: "file", name: "Upload attachment",
    visible: true, disabled: false, documentGeneration: 1
  };
  const issued = await grants.issue({ approvalRef: "operator-confirmation-1", filePath: sourcePath,
    principalId: "principal", targetId: "t1", candidateIdentity: candidate.identity,
    operationId: "upload_attachment", environmentId: "fixture", applicationId: "app" });
  const context = { principalId: "principal", targetId: "t1", candidateIdentity: candidate.identity,
    operationId: "upload_attachment", environmentId: "fixture", applicationId: "app" };
  const dispatch = await grants.beginDispatch(issued.grantId, context);
  assert.equal(dispatch.ok, true);
  const result = await session.uploadFile(candidate, dispatch.stagedPaths, {
    grantToken: dispatch.dispatchToken,
    beforeDispatch: async () => assert.equal((await grants.assertDispatchToken(dispatch.dispatchToken, context)).ok, true)
  });
  await grants.complete(issued.grantId);
  assert.equal(result.dispatched, true);
  assert.equal(result.fileCount, 1);
  const setFiles = cdpCalls.find(c => c.method === "DOM.setFileInputFiles");
  assert.ok(setFiles, "DOM.setFileInputFiles was called");
  assert.deepEqual(setFiles.params.files, dispatch.stagedPaths);
  assert.equal(JSON.stringify(issued).includes(sourcePath), false);
  assert.equal(setFiles.params.backendNodeId, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("BrowserSession uploadFile rejects non-file inputs", async () => {
  const session = new BrowserSession({
    id: "t1", url: "http://fixture.local/",
    browserClient: { on: () => () => {}, send: async () => { throw new Error("should not reach CDP"); } },
    rootAlreadyAttached: true
  });
  session.attached = true;
  session.targetLifecycle = "attached";
  session.documentGeneration = 1;
  session.client = { send: async () => { throw new Error("should not reach CDP"); } };
  const candidate = {
    identity: "btn-1", backendNodeId: 1, targetId: "t1",
    tag: "button", role: "button", name: "Not a file input",
    visible: true, disabled: false, documentGeneration: 1
  };
  await assert.rejects(() => session.uploadFile(candidate, ["/tmp/x.txt"]), /limited to input\[type=file\]/);
});

test("BrowserSession detectSpaNavigation identifies same-origin path changes", async () => {
  let currentUrl = "http://app.local/page-a";
  const session = new BrowserSession({
    id: "t1", url: currentUrl,
    browserClient: { on: () => () => {}, send: async () => { throw new Error("not needed"); } },
    rootAlreadyAttached: true
  });
  session.attached = true;
  session.targetLifecycle = "attached";
  session.sessionId = "sim";
  session.observe = async () => ({
    evidenceId: "ev-spa-1",
    page: { url: currentUrl, title: "SPA" },
    candidates: [], headings: [], frames: [], scrollTargets: [],
    pageChangeFingerprint: "fp-1"
  });

  // SPA: same origin, different path.
  currentUrl = "http://app.local/page-b";
  const spaResult = await session.detectSpaNavigation("http://app.local/page-a");
  assert.equal(spaResult.isSpaNavigation, true, "Same-origin path change should be SPA navigation");

  // Full navigation: different origin.
  currentUrl = "http://other.local/page-b";
  const fullNavResult = await session.detectSpaNavigation("http://app.local/page-a");
  assert.equal(fullNavResult.isSpaNavigation, false, "Different-origin should not be SPA");

  // No change.
  currentUrl = "http://app.local/page-a";
  const noChangeResult = await session.detectSpaNavigation("http://app.local/page-a");
  assert.equal(noChangeResult.isSpaNavigation, false, "URL unchanged should not be SPA");
});
