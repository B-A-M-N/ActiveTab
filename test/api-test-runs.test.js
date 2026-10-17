import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";

test("local API test-run lifecycle: start → status → cancel → report", async () => {
  const mockSession = {
    async observe() {
      return { page: { title: "Fixture", url: "http://fixture.local/" }, candidates: [], headings: [], frames: [], evidenceId: "ev-1" };
    },
    client: { async send() { return {}; } },
    target: { id: "target-1" },
    async close() {}
  };
  const api = createApiServer({
    port: 0, taskStoreDir: undefined,
    navigationRunner: { run: async () => ({}) },
    testSessionResolver: async () => mockSession,
    apiToken: "test-token"
  });
  const { url } = await api.start();
  try {
    // start
    const startRes = await fetch(`${url}/v1/test/runs`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
      body: JSON.stringify({ workflow: { id: "wf-1", name: "Test", steps: [{ id: "s1", type: "cleanup" }] } })
    });
    assert.equal(startRes.status, 200);
    const { status: startStatus, runId } = await startRes.json();
    assert.equal(startStatus, "started");
    assert.ok(runId);

    // get status (should be done or running)
    const statusRes = await fetch(`${url}/v1/test/runs/${runId}/status`, { headers: { "Authorization": "Bearer test-token" } });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.ok(["RUNNING", "PASSED", "FAILED", "BLOCKED", "CANCELED"].includes(statusBody.status), `Got ${statusBody.status}`);

    // diagnostics
    const diagRes = await fetch(`${url}/v1/test/runs/${runId}/diagnostics`, { method: "POST", headers: { "Authorization": "Bearer test-token" } });
    assert.equal(diagRes.status, 200);
    const diagBody = await diagRes.json();
    assert.ok(Array.isArray(diagBody.results));

    // report
    const reportRes = await fetch(`${url}/v1/test/runs/${runId}/report`, { headers: { "Authorization": "Bearer test-token" } });
    assert.equal(reportRes.status, 200);
    const reportBody = await reportRes.json();
    assert.equal(reportBody.runId, runId);
    assert.ok(Array.isArray(reportBody.findings));

    // cancel a new run
    const start2 = await fetch(`${url}/v1/test/runs`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
      body: JSON.stringify({ workflow: { id: "wf-2", name: "Test2", steps: [{ id: "s1", type: "cleanup" }] } })
    });
    const { runId: runId2 } = await start2.json();
    const cancelRes = await fetch(`${url}/v1/test/runs/${runId2}/cancel`, { method: "POST", headers: { "Authorization": "Bearer test-token" } });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.status, "cancel_requested");
  } finally {
    await api.stop();
  }
});

test("local API test-run rejects missing workflow or session", async () => {
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res1 = await fetch(`${url}/v1/test/runs`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({}) });
    assert.equal(res1.status, 400);
    const res2 = await fetch(`${url}/v1/test/runs`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({ workflow: { id: "x", name: "x", steps: [] } }) });
    assert.equal(res2.status, 400);
    const res3 = await fetch(`${url}/v1/test/runs`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({ workflow: { id: "x", name: "x", steps: [{ id: "s1", type: "cleanup" }] } }) });
    assert.equal(res3.status, 400);
    const res3body = await res3.json();
    assert.match(res3body.msg ?? res3body.error ?? "", /session/i);
  } finally {
    await api.stop();
  }
});

test("local API test-run 404 for unknown runId", async () => {
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res = await fetch(`${url}/v1/test/runs/does-not-exist/status`, { headers: { "Authorization": "Bearer test-token" } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.msg ?? body.error ?? "", /No test run found/);
  } finally {
    await api.stop();
  }
});

test("local API discovery endpoint requires a session", async () => {
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res = await fetch(`${url}/v1/discover`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.msg ?? "", /session/i);
  } finally {
    await api.stop();
  }
});

test("local API discovery endpoint runs with a session resolver", async () => {
  const mockSession = {
    async observe() {
      return { page: { title: "Fixture", url: "http://fixture.local/" }, candidates: [{ role: "link", name: "Home", href: "http://fixture.local/", visible: true }], headings: [], frames: [] };
    },
    client: { async send() { return {}; } },
    target: { id: "t" },
    async close() {}
  };
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, testSessionResolver: async () => mockSession, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res = await fetch(`${url}/v1/discover`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({ maxSteps: 1 }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.capabilityMap);
    assert.ok(body.discoveries.some(d => d.type === "initial_observation"));
  } finally {
    await api.stop();
  }
});

test("local API investigation endpoint requires subject and reason", async () => {
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res = await fetch(`${url}/v1/investigate`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.msg ?? "", /subject and reason/i);
  } finally {
    await api.stop();
  }
});

test("local API investigation endpoint returns a qualified report", async () => {
  const api = createApiServer({ port: 0, taskStoreDir: undefined, navigationRunner: { run: async () => ({}) }, apiToken: "test-token" });
  const { url } = await api.start();
  try {
    const res = await fetch(`${url}/v1/investigate`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" }, body: JSON.stringify({ subject: "Test failure", reason: "Page navigate error" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.classification);
    assert.ok(Array.isArray(body.hypotheses));
    assert.ok(body.report);
  } finally {
    await api.stop();
  }
});
