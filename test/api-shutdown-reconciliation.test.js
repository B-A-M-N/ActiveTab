import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/local-server.js";
import { RunStateStore } from "../src/testing/runState.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Condition was not reached within ${timeoutMs}ms.`);
  })();
}

function createHeldObservationSession({ entered, release }) {
  const target = { id: "shutdown-target", url: "https://fixture.local/" };
  let observations = 0;
  return {
    target,
    attached: true,
    client: { async send() { return {}; } },
    async observe() {
      observations++;
      if (observations === 1) {
        entered.resolve();
        return await release.promise;
      }
      return {
        evidenceId: `shutdown-observation-${observations}`,
        targetId: target.id,
        page: { title: "Fixture", url: target.url },
        headings: [], candidates: [], frames: [], scrollTargets: []
      };
    }
  };
}

function workflow() {
  return {
    id: "shutdown-reconciliation",
    name: "Shutdown reconciliation",
    steps: [
      { id: "first", type: "assert", assertion: { type: "page_title_contains", value: "Fixture" } },
      { id: "second", type: "assert", assertion: { type: "page_title_contains", value: "Fixture" } }
    ]
  };
}

async function startHeldRun({ directory, runStateStore, events, shutdownTimeoutMs = 100 }) {
  const entered = deferred();
  const release = deferred();
  const resourceClosed = deferred();
  const session = createHeldObservationSession({ entered, release });
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(directory, "tasks"),
    runStateStore,
    navigationRunner: { async run() { return {}; } },
    testSessionResolver: async () => session,
    testEnvironmentResolver: async () => ({ environmentId: "shutdown-fixture", authorizedOrigins: ["https://fixture.local"] }),
    testProfileIdResolver: async () => "shutdown-profile",
    testPrincipalResolver: async () => "shutdown-principal",
    decisionRuntime: {
      startEpisode() { return { episodeId: "shutdown-episode" }; },
      completeEpisode() {},
      close() { events.push("resources-closed"); resourceClosed.resolve(); }
    },
    apiToken: "shutdown-test-token",
    shutdownTimeoutMs
  });
  const { url } = await api.start();
  const OriginalAbortController = globalThis.AbortController;
  globalThis.AbortController = class extends OriginalAbortController {
    abort(...args) {
      events.push("signal-abort");
      return super.abort(...args);
    }
  };
  try {
    const started = await fetch(`${url}/v1/test/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer shutdown-test-token" },
      body: JSON.stringify({ workflow: workflow() })
    });
    assert.equal(started.status, 200);
    const { runId } = await started.json();
    let startupTimeout;
    try {
      await Promise.race([
        entered.promise,
        new Promise((_, reject) => {
          startupTimeout = setTimeout(async () => {
            const durable = await runStateStore.getFresh(runId);
            const status = await fetch(`${url}/v1/test/runs/${runId}/status`, { headers: { Authorization: "Bearer shutdown-test-token" } }).then(response => response.text());
            reject(new Error(`Run ${runId} did not enter its held observation; durable state: ${JSON.stringify(durable)}; status response: ${status}`));
          }, 2_000);
        })
      ]);
    } finally {
      clearTimeout(startupTimeout);
    }
    return { api, runId, release, resourceClosed: resourceClosed.promise };
  } catch (error) {
    await api.stop();
    throw error;
  } finally {
    globalThis.AbortController = OriginalAbortController;
  }
}

test("API shutdown persists cancellation before abort and keeps unsettled runs unresolved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-api-shutdown-"));
  const runStateStore = new RunStateStore(join(directory, "runs"));
  const events = [];
  const originalRequestCancellation = runStateStore.requestCancellation.bind(runStateStore);
  runStateStore.requestCancellation = async runId => {
    const result = await originalRequestCancellation(runId);
    events.push("cancellation-persisted");
    return result;
  };
  let api;
  let held;
  try {
    await runStateStore.init();
    held = await startHeldRun({ directory, runStateStore, events, shutdownTimeoutMs: 1_000 });
    api = held.api;
    // The test run has entered an observation that deliberately cannot settle
    // until after shutdown reaches its bounded wait policy.
    const stopping = api.stop();
    await stopping;

    const afterTimeout = await runStateStore.getFresh(held.runId);
    assert.equal(afterTimeout.cancellationRequested, true);
    assert.equal(afterTimeout.status, "cancel_requested");
    assert.ok(events.indexOf("cancellation-persisted") >= 0);
    assert.ok(events.indexOf("signal-abort") > events.indexOf("cancellation-persisted"));
    assert.equal(events.includes("resources-closed"), false, "owned resources stay open while a worker still uses them");

    held.release.resolve({
      evidenceId: "shutdown-observation-released",
      targetId: "shutdown-target",
      page: { title: "Fixture", url: "https://fixture.local/" },
      headings: [], candidates: [], frames: [], scrollTargets: []
    });
    const reconciled = await waitFor(async () => {
      const current = await runStateStore.getFresh(held.runId);
      return ["canceled", "reconciling"].includes(current?.status) ? current : null;
    });
    assert.equal(reconciled.status, "canceled");
    await held.resourceClosed;
    assert.equal(events.at(-1), "resources-closed");
  } finally {
    held?.release.resolve({ evidenceId: "shutdown-cleanup", targetId: "shutdown-target", page: { title: "Fixture", url: "https://fixture.local/" }, headings: [], candidates: [], frames: [], scrollTargets: [] });
    await api?.stop();
    await held?.resourceClosed.catch(() => {});
    runStateStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown does not abort when cancellation intent persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-api-shutdown-fault-"));
  const runStateStore = new RunStateStore(join(directory, "runs"));
  const events = [];
  const originalRequestCancellation = runStateStore.requestCancellation.bind(runStateStore);
  runStateStore.requestCancellation = async runId => {
    if (runStateStore.getFresh) {
      const current = await runStateStore.getFresh(runId);
      if (current) throw new Error("injected cancellation persistence failure");
    }
    return await originalRequestCancellation(runId);
  };
  let api;
  let held;
  try {
    await runStateStore.init();
    held = await startHeldRun({ directory, runStateStore, events, shutdownTimeoutMs: 60 });
    api = held.api;
    await api.stop();

    const unresolved = await runStateStore.getFresh(held.runId);
    assert.equal(unresolved.status, "running");
    assert.notEqual(unresolved.cancellationRequested, true);
    assert.equal(events.includes("signal-abort"), false, "the worker must not be aborted without durable cancellation intent");
    assert.equal(events.includes("resources-closed"), false);

    held.release.resolve({
      evidenceId: "shutdown-fault-released",
      targetId: "shutdown-target",
      page: { title: "Fixture", url: "https://fixture.local/" },
      headings: [], candidates: [], frames: [], scrollTargets: []
    });
    await held.resourceClosed;
    const completed = await runStateStore.getFresh(held.runId);
    assert.equal(completed.status, "passed", "natural completion remains a real worker outcome, not a synthesized cancellation");
  } finally {
    held?.release.resolve({ evidenceId: "shutdown-fault-cleanup", targetId: "shutdown-target", page: { title: "Fixture", url: "https://fixture.local/" }, headings: [], candidates: [], frames: [], scrollTargets: [] });
    await api?.stop();
    await held?.resourceClosed.catch(() => {});
    runStateStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
