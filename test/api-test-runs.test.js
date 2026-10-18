import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { InterventionStore, INTERVENTION_TYPE } from "../src/runtime/interventions.js";
import { canonicalInputHash } from "../src/runtime/approvals.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("operator approval resolution uses an independent identity and exact request revision", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-operator-approval-"));
  const interventionStore = new InterventionStore(join(tempDir, "interventions"));
  await interventionStore.init();
  const request = await interventionStore.create({
    runId: "run-fixture",
    stepId: "approve-fixture-cleanup",
    type: INTERVENTION_TYPE.HUMAN_APPROVAL,
    reason: "Delete one verified test-owned fixture.",
    requiredHumanAction: "Review and approve this exact cleanup operation.",
    environmentId: "fixture-staging",
    applicationId: "fixture-app",
    completionCondition: {
      type: "approval_grant",
      operation: "delete_test_fixture",
      resource: "fixture-1",
      inputHash: canonicalInputHash({ fixtureId: "fixture-1" }),
      allowedEffects: ["delete:test_owned_resource"],
      reversible: false
    }
  });
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks"),
    navigationRunner: { run: async () => ({}) },
    apiToken: "automation-token",
    operatorToken: "separate-operator-token",
    operatorId: "operator-alice"
  });
  const { url } = await api.start();
  const path = `/v1/interventions/${request.intervention_id}/resolve`;
  try {
    const forged = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer automation-token", "Content-Type": "application/json" },
      body: JSON.stringify({ authenticatedOperator: "operator-alice", expectedRevision: request.revision })
    });
    assert.equal(forged.status, 403, "the automation API token and a caller-supplied name cannot approve");

    const spoofed = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "X-ActiveTab-Operator-Token": "separate-operator-token", "Content-Type": "application/json" },
      body: JSON.stringify({ authenticatedOperator: "operator-bob", expectedRevision: request.revision })
    });
    assert.equal(spoofed.status, 400, "operator identity cannot be supplied in the request body");

    const approved = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "X-ActiveTab-Operator-Token": "separate-operator-token", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: request.revision })
    });
    assert.equal(approved.status, 200);
    const result = await approved.json();
    assert.ok(result.grantId);

    const persisted = new InterventionStore(join(tempDir, "interventions"));
    await persisted.init();
    const resolved = persisted.get(request.intervention_id);
    assert.equal(resolved.approvalResolution.operatorId, "operator-alice");
    assert.equal(resolved.approvalResolution.grantId, result.grantId);
    assert.equal(resolved.completionCondition.grantId, result.grantId);
    assert.equal(resolved.completionCondition.operation, "delete_test_fixture");

    const replay = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "X-ActiveTab-Operator-Token": "separate-operator-token", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: request.revision })
    });
    assert.equal(replay.status, 409, "a stale approval request cannot issue another grant");
    const replayBody = await replay.json();
    assert.match(replayBody.msg ?? replayBody.error ?? "", /revision|resolution|pending/i);
  } finally {
    await api.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local API test-run lifecycle: start → status → cancel → report", async () => {
  const mockSession = {
    async observe() {
      return { page: { title: "Fixture", url: "http://fixture.local/" }, candidates: [], headings: [], frames: [], evidenceId: "ev-1" };
    },
    client: { async send() { return {}; } },
    target: { id: "target-1", url: "http://fixture.local/" },
    attached: true,
    async close() {}
  };
  const api = createApiServer({
    port: 0, taskStoreDir: undefined,
    navigationRunner: { run: async () => ({}) },
    testSessionResolver: async () => mockSession,
    testEnvironmentResolver: async () => ({ environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] }),
    testProfileIdResolver: async () => "fixture-profile",
    testPrincipalResolver: async () => "fixture-principal",
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

    // A durable run may still be committing its terminal receipt. Wait for
    // that state before requesting a report; the report endpoint correctly
    // refuses to turn an in-flight run into a partial report.
    let terminal = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const latest = await fetch(`${url}/v1/test/runs/${runId}/status`, { headers: { "Authorization": "Bearer test-token" } });
      const latestBody = await latest.json();
      if (["PASSED", "FAILED", "BLOCKED", "CANCELED", "UNCERTAIN"].includes(latestBody.status)) { terminal = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(terminal, true, "run should reach a reportable state");

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

test("HTTP run status returns the settled receipt instead of racing it against an already-resolved null", async () => {
  const mockSession = {
    async observe() { return { page: { title: "Fixture", url: "http://fixture.local/" }, candidates: [], headings: [], frames: [], evidenceId: "ev-status" }; },
    client: { async send() { return {}; } },
    target: { id: "target-status", url: "http://fixture.local/" },
    attached: true,
    async close() {}
  };
  const api = createApiServer({
    port: 0,
    navigationRunner: { run: async () => ({}) },
    testSessionResolver: async () => mockSession,
    testEnvironmentResolver: async () => ({ environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] }),
    testProfileIdResolver: async () => "fixture-profile",
    testPrincipalResolver: async () => "fixture-principal",
    apiToken: "test-token"
  });
  const { url } = await api.start();
  try {
    const start = await fetch(`${url}/v1/test/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ workflow: { id: "wf-settled", name: "Settled fixture", steps: [{ id: "cleanup", type: "cleanup" }] } })
    });
    const { runId } = await start.json();
    let body;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await fetch(`${url}/v1/test/runs/${runId}/status`, { headers: { Authorization: "Bearer test-token" } });
      body = await status.json();
      if (body.status !== "RUNNING") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(body.status, "PASSED");
  } finally {
    await api.stop();
  }
});

test("HTTP restart resume reports durable status and refuses replay of an uncertain DAG effect", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-api-resume-"));
  const taskStoreDir = join(tempDir, "tasks");
  let dispatchCount = 0;
  let reattachResolverCalls = 0;
  const candidate = { identity: "open-report", targetId: "api-resume-target", documentGeneration: 1, backendNodeId: 44, name: "Open report", role: "link", tag: "a", href: "http://fixture.local/report", visible: true, disabled: false };
  const makeSession = () => ({
    target: { id: "api-resume-target", url: "http://fixture.local/" },
    attached: true,
    async observe() { return { targetId: "api-resume-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Home" }, candidates: [candidate], evidenceId: "api-resume-observation" }; },
    async click() { dispatchCount++; throw new Error("CDP closed after dispatch began"); },
    client: { async send() { return {}; } }
  });
  const workflow = {
    id: "api-resume-dag", name: "API durable resume", execution: "dag",
    steps: [
      { id: "open", type: "interact", dependsOn: [], action: { type: "click", target: { identity: "open-report" } } },
      { id: "verify", type: "assert", dependsOn: ["open"], assertion: { type: "page_title_contains", value: "Report" } }
    ]
  };
  const apiOptions = {
    port: 0, taskStoreDir, navigationRunner: { run: async () => ({}) }, apiToken: "test-token",
    testEnvironmentResolver: async () => ({ environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] }),
    testProfileIdResolver: async () => "fixture-profile",
    testPrincipalResolver: async () => "fixture-principal"
  };
  const api = createApiServer({ ...apiOptions, testSessionResolver: async () => makeSession() });
  const { url } = await api.start();
  let runId;
  try {
    const start = await fetch(`${url}/v1/test/runs`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ workflow })
    });
    assert.equal(start.status, 200);
    runId = (await start.json()).runId;
    let statusBody;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await fetch(`${url}/v1/test/runs/${runId}/status`, { headers: { Authorization: "Bearer test-token" } });
      statusBody = await status.json();
      if (statusBody.status !== "RUNNING") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(statusBody.status, "UNCERTAIN");
    assert.equal(dispatchCount, 1);
  } finally {
    await api.stop();
  }

  const restarted = createApiServer({
    ...apiOptions,
    testSessionResolver: async () => { reattachResolverCalls++; return makeSession(); }
  });
  const restartedAddress = await restarted.start();
  try {
    const status = await fetch(`${restartedAddress.url}/v1/test/runs/${runId}/status`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, "RECONCILING");
    const resumed = await fetch(`${restartedAddress.url}/v1/test/runs/${runId}/resume`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ workflow })
    });
    assert.equal(resumed.status, 409);
    assert.equal((await resumed.json()).status, "UNCERTAIN");
    assert.equal(reattachResolverCalls, 0, "unresolved dispatch is rejected before obtaining another execution session");
    assert.equal(dispatchCount, 1, "restart must not replay the possibly dispatched click");
  } finally {
    await restarted.stop();
    await rm(tempDir, { recursive: true, force: true });
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
    attached: true,
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
