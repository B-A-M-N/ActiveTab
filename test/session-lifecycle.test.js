import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../src/browser/session.js";

class MockTransport {
  listeners = new Map();
  commands = [];

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method, params = {}, sessionId = null) {
    for (const listener of this.listeners.get(method) ?? []) listener(params, sessionId);
  }

  async send(method, params = {}, sessionId = null) {
    this.commands.push({ method, params, sessionId });
    if (method === "Target.attachToTarget") return { sessionId: "root-session" };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "Target.getTargets") return { targetInfos: [] };
    return {};
  }
}

async function createHitTestSession() {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "visual-hit-test-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();
  const pendingQueries = [];
  let resolutions = 0;
  const evidenceId = "visual-evidence-1";
  session.observer.getHitTestContext = selectedEvidenceId => ({
    status: selectedEvidenceId === evidenceId ? "available" : "stale",
    targetId: session.target.id,
    documentGeneration: session.documentGeneration,
    viewport: { width: 100, height: 80 },
    viewportScroll: { x: 0, y: 0 },
    deviceScaleFactor: 1,
    domMutationCount: session.activity.totalDomMutations
  });
  session.observer.resolveCandidateForHitNode = (_selectedEvidenceId, hit) => {
    resolutions++;
    return { status: "candidate", candidateHint: { identity: `node-${hit.backendNodeId}` } };
  };
  const originalSend = transport.send.bind(transport);
  transport.send = async (method, params = {}, sessionId = null, options = {}) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: { width: 100, height: 80, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 } } };
    }
    if (method === "DOM.getNodeForLocation") {
      return await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(Object.assign(new Error("query consumer aborted"), { code: "CDP_ABORTED" }));
        };
        const query = {
          params,
          complete(result = { backendNodeId: 17, frameId: "root-frame" }) {
            cleanup();
            resolve(result);
          },
          fail(error = new Error("mock query failed")) {
            cleanup();
            reject(error);
          }
        };
        pendingQueries.push(query);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
        if (Number.isInteger(options.timeoutMs)) {
          timer = setTimeout(() => {
            cleanup();
            reject(Object.assign(new Error("mock query deadline"), {
              code: "CDP_TIMEOUT",
              callerDeadlineExceeded: true,
              commandMayStillComplete: true
            }));
          }, options.timeoutMs);
        }
      });
    }
    return originalSend(method, params, sessionId, options);
  };
  return {
    session,
    transport,
    pendingQueries,
    get resolutions() { return resolutions; },
    evidenceId
  };
}

async function waitForPendingQuery(pendingQueries, expectedCount = 1) {
  for (let attempt = 0; attempt < 20 && pendingQueries.length < expectedCount; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(pendingQueries.length, expectedCount, "the visual query should be dispatched once");
}

test("a detached authorized tab stops observations and native actions immediately", async () => {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "selected-tab-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();

  assert.equal(session.targetLifecycle, "attached");
  transport.emit("Target.detachedFromTarget", { sessionId: "root-session", targetId: "selected-tab-target" });
  assert.equal(session.targetLifecycle, "detached");
  assert.equal(session.attached, false);

  const commandCount = transport.commands.length;
  await assert.rejects(() => session.observe(), /authorized browser target is detached/);
  await assert.rejects(() => session.click({ targetId: "selected-tab-target" }), /authorized browser target is detached/);
  await session.waitForChange(5_000);
  assert.equal(transport.commands.length, commandCount, "a detached session does not issue more CDP commands or wait for the timeout");
  await session.close();
});

test("a lost CDP or Native Messaging transport invalidates the current target session", async () => {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "transport-loss-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();

  transport.emit("CDP.connectionClosed", { reason: "The local browser connection closed." });

  assert.equal(session.targetLifecycle, "detached");
  await assert.rejects(() => session.observe(), /authorized browser target is detached/);
  await session.close();
});

test("out-of-order observations remain historical and cannot replace the current evidence pointer", async () => {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "ordered-observation-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();
  const pending = [];
  session.observer.capture = () => new Promise(resolve => pending.push(resolve));

  const olderPromise = session.observe();
  const olderSequence = session.observationGeneration;
  const newerPromise = session.observe();
  const newerSequence = session.observationGeneration;
  assert.ok(newerSequence > olderSequence);

  pending[1]({ evidenceId: "newer-evidence", targetId: session.target.id, documentGeneration: session.documentGeneration });
  const newer = await newerPromise;
  assert.equal(newer.historical, false);
  assert.equal(newer.observationSequence, newerSequence);
  assert.equal(session.latestEvidenceId, "newer-evidence");

  pending[0]({ evidenceId: "older-evidence", targetId: session.target.id, documentGeneration: session.documentGeneration });
  const older = await olderPromise;
  assert.equal(older.historical, true);
  assert.equal(older.observationSequence, olderSequence);
  assert.equal(session.latestEvidenceId, "newer-evidence");

  const oldGeneration = session.documentGeneration;
  const oldGenerationPromise = session.observe();
  session.documentGeneration++;
  pending[pending.length - 1]({ evidenceId: "old-generation-evidence", targetId: session.target.id, documentGeneration: oldGeneration });
  const oldGenerationObservation = await oldGenerationPromise;
  assert.equal(oldGenerationObservation.historical, true);
  assert.equal(session.latestEvidenceId, "newer-evidence");

  const detachedPromise = session.observe();
  const detachedEvidence = pending.length;
  session.attached = false;
  session.targetLifecycle = "detached";
  pending[detachedEvidence - 1]({ evidenceId: "detached-evidence", targetId: session.target.id, documentGeneration: session.documentGeneration });
  const detached = await detachedPromise;
  assert.equal(detached.historical, true);
  assert.equal(session.latestEvidenceId, "newer-evidence");
  await session.close();
});

test("visual hit testing allows only one outstanding probe per target", async () => {
  const harness = await createHitTestSession();
  try {
    const first = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 500 });
    await waitForPendingQuery(harness.pendingQueries);
    const second = await harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 21, y: 31, timeoutMs: 500 });
    assert.equal(second.reasonCode, "hit_test_in_progress");
    assert.equal(harness.pendingQueries.length, 1);

    harness.pendingQueries[0].complete();
    const result = await first;
    assert.equal(result.status, "candidate");
    assert.equal(harness.resolutions, 1);
  } finally {
    await harness.session.close();
  }
});

test("visual probe shares one deadline across viewport recheck and DOM hit test", async () => {
  const harness = await createHitTestSession();
  try {
    const commandTimeouts = [];
    const originalSend = harness.session.client.send.bind(harness.session.client);
    harness.session.client.send = async (method, params, options = {}) => {
      if (["Runtime.evaluate", "DOM.getNodeForLocation"].includes(method)) {
        commandTimeouts.push({ method, timeoutMs: options.timeoutMs });
      }
      if (method === "Runtime.evaluate") await new Promise(resolve => setTimeout(resolve, 20));
      return originalSend(method, params, options);
    };

    const pending = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await waitForPendingQuery(harness.pendingQueries);
    assert.equal(commandTimeouts.length, 2);
    assert.equal(commandTimeouts[0].method, "Runtime.evaluate");
    assert.ok(commandTimeouts[0].timeoutMs > 0 && commandTimeouts[0].timeoutMs <= 1_000);
    assert.equal(commandTimeouts[1].method, "DOM.getNodeForLocation");
    assert.ok(commandTimeouts[1].timeoutMs > 0 && commandTimeouts[1].timeoutMs < commandTimeouts[0].timeoutMs,
      "the hit test receives only the remaining caller budget");

    harness.pendingQueries[0].complete();
    assert.equal((await pending).status, "candidate");
  } finally {
    await harness.session.close();
  }
});

test("visual probe deadline applies to viewport recheck and prevents a later hit-test dispatch", async () => {
  const harness = await createHitTestSession();
  try {
    let viewportTimeoutMs = null;
    let hitTestDispatched = false;
    harness.session.client.send = (method, _params, options = {}) => {
      if (method === "Runtime.evaluate") {
        viewportTimeoutMs = options.timeoutMs;
        return Promise.reject(Object.assign(new Error("caller deadline exceeded"), {
          callerDeadlineExceeded: true,
          commandMayStillComplete: true
        }));
      }
      if (method === "DOM.getNodeForLocation") hitTestDispatched = true;
      return Promise.resolve({});
    };

    const result = await harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 50 });
    assert.ok(viewportTimeoutMs > 0 && viewportTimeoutMs <= 50);
    assert.equal(result.reasonCode, "hit_test_deadline");
    assert.equal(hitTestDispatched, false);
  } finally {
    await harness.session.close();
  }
});

test("visual hit-test deadline expires the consumer and ignores a later completion", async () => {
  const harness = await createHitTestSession();
  try {
    const timedOut = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 50 });
    await waitForPendingQuery(harness.pendingQueries);
    const result = await timedOut;
    assert.equal(result.status, "unavailable");
    assert.equal(result.reasonCode, "hit_test_deadline");

    harness.pendingQueries[0].complete({ backendNodeId: 99, frameId: "late-frame" });
    assert.equal(harness.resolutions, 0);

    const current = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 25, y: 35, timeoutMs: 500 });
    await waitForPendingQuery(harness.pendingQueries, 2);
    harness.pendingQueries[1].complete({ backendNodeId: 18, frameId: "root-frame" });
    assert.equal((await current).status, "candidate");
    assert.equal(harness.resolutions, 1);
  } finally {
    await harness.session.close();
  }
});

test("target detachment aborts a visual query consumer and prevents late resolution", async () => {
  const harness = await createHitTestSession();
  try {
    const pending = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 500 });
    await waitForPendingQuery(harness.pendingQueries);
    harness.transport.emit("Target.detachedFromTarget", {
      sessionId: "root-session",
      targetId: "visual-hit-test-target"
    });
    const result = await pending;
    assert.equal(result.status, "stale");
    assert.equal(result.reasonCode, "target_detached");
    harness.pendingQueries[0].complete({ backendNodeId: 99, frameId: "late-frame" });
    assert.equal(harness.resolutions, 0);
  } finally {
    await harness.session.close();
  }
});

test("a newer observation invalidates an in-flight visual result", async () => {
  const harness = await createHitTestSession();
  try {
    const pending = harness.session.probeVisualCandidateAtPoint(harness.evidenceId, { x: 20, y: 30, timeoutMs: 500 });
    await waitForPendingQuery(harness.pendingQueries);
    harness.session.observer.capture = async () => ({ evidenceId: "visual-evidence-2" });
    await harness.session.observe();

    const result = await pending;
    assert.equal(result.status, "stale");
    assert.equal(result.reasonCode, "superseded_by_new_observation");
    harness.pendingQueries[0].complete({ backendNodeId: 100, frameId: "late-frame" });
    assert.equal(harness.resolutions, 0);
  } finally {
    await harness.session.close();
  }
});
