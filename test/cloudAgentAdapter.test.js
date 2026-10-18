import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CloudAgentDiagnosticAdapter, cloudAgentAdapterFromEnv } from "../src/diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";

const endpointBindings = [
  { name: "health", method: "GET", pathTemplate: "/api/admin/agent/health", observedStatus: 200, contentType: "application/json", sourceEvidenceId: "health-evidence-1" },
  { name: "runDetail", method: "GET", pathTemplate: "/api/admin/agent/runs/{runId}", observedStatus: 200, contentType: "application/json", sourceEvidenceId: "run-detail-evidence-1" },
  { name: "runActivity", method: "GET", pathTemplate: "/api/admin/agent/runs/{runId}/activity", observedStatus: 200, contentType: "application/json", sourceEvidenceId: "run-activity-evidence-1" }
];

function createMockAdapter(url, adminToken) {
  return new CloudAgentDiagnosticAdapter({
    baseUrl: url,
    adminToken,
    diagnosticTransport: "ssh_tunnel",
    remoteTarget: "staging.freeinference.org",
    remoteIdentityVerifier: async () => ({ verified: true, environmentId: "freeinference-staging" }),
    environmentBinding: {
      environmentId: "freeinference-staging",
      diagnosticEndpoint: url,
      diagnosticTransport: "ssh_tunnel",
      remoteTarget: "staging.freeinference.org",
      diagnosticEndpointBindings: endpointBindings
    },
    endpointBindings
  });
}

async function withMockServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("cloudAgentAdapter healthCheck checks service health without broad admin reads", async () => {
  await withMockServer((req, res) => {
    if (req.url === "/api/admin/agent/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    assert.notEqual(req.url, "/api/admin/agent/runs", "Health checks must not enumerate tenant runs.");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Not Found" }));
  }, async url => {
    const adapter = createMockAdapter(url, "test-admin-token");
    const health = await adapter.healthCheck();
    assert.equal(health.healthy, true);
    assert.equal(health.adminAuthority, "not_probed");
  });
});

test("cloudAgentAdapter rejects missing configuration", () => {
  assert.throws(() => new CloudAgentDiagnosticAdapter({ baseUrl: "http://127.0.0.1:18000" }), /requires an adminToken/);
  assert.throws(() => new CloudAgentDiagnosticAdapter({ adminToken: "x" }), /requires a baseUrl/);
  assert.throws(() => new CloudAgentDiagnosticAdapter({ baseUrl: "not-a-url", adminToken: "x" }), /not a valid URL/);
});

test("Cloud Agent diagnostic sources are exact-run scoped and project out task content", async () => {
  const seen = [];
  await withMockServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === "/api/admin/agent/runs/job-1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: {
        id: "job-1", status: "completed", model: "glm-5.3-flash", prompt: "private task content",
        usage: { input_tokens: 12, output_tokens: 7, access_token: "private-secret" }
      } }));
      return;
    }
    if (req.url === "/api/admin/agent/runs/job-1/activity?limit=50") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ steps: [
        { run_id: "job-1", step_id: "step-1", status: "completed", operation: "agent_step", prompt: "private text" },
        { run_id: "another-run", step_id: "step-other", status: "failed" }
      ] }));
      return;
    }
    res.writeHead(404); res.end();
  }, async url => {
    const adapter = createMockAdapter(url, "test-token");
    const collector = new DiagnosticCollector({ runId: "test-run" });
    adapter.registerRunScopedSources(collector, {
      activeTabRunId: "test-run",
      cloudAgentRunId: "job-1",
      sourceIds: ["cloud-agent-runs", "cloud-agent-steps", "cloud-agent-usage"]
    });
    const results = await collector.collectAll(collector.listSources().map(s => ({ sourceId: s.id, operation: "read_scoped" })));
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result.status, "ok", `Source ${result.sourceId} should succeed.`);
    }
    assert.equal(results[0].snapshot.data.records[0].id, "job-1");
    assert.equal(results[0].snapshot.data.records[0].prompt, undefined, "Raw task prompts must not leave the adapter.");
    assert.equal(results[1].snapshot.data.recordCount, 1, "Activity records with another run ID must be dropped.");
    assert.equal(results[1].snapshot.data.records[0].prompt, undefined, "Step text must not leave the adapter.");
    const usageResult = results.find(r => r.sourceId === "cloud-agent-usage");
    assert.deepEqual(usageResult.snapshot.data.records[0], { input_tokens: 12, output_tokens: 7 });
    assert.deepEqual(seen.map(request => request.url).sort(), ["/api/admin/agent/runs/job-1", "/api/admin/agent/runs/job-1/activity?limit=50"].sort());
    assert.ok(seen.every(request => request.authorization === "Bearer test-token"));
  });
});

test("Cloud Agent adapter refuses an endpoint that is not bound by the active environment profile", async () => {
  await withMockServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ status: "ok" })); }, async url => {
    assert.throws(() => new CloudAgentDiagnosticAdapter({
      baseUrl: url,
      adminToken: "private-test-token",
      environmentBinding: { environmentId: "freeinference-staging", diagnosticEndpoint: "https://other.example.test" },
      endpointBindings
    }), /exactly match the endpoint declared/);

    let calls = 0;
    const noRoutes = new CloudAgentDiagnosticAdapter({
      baseUrl: url,
      adminToken: "private-test-token",
      environmentBinding: { environmentId: "freeinference-staging", diagnosticEndpoint: url },
      endpointBindings: [],
      fetchImpl: async () => { calls++; throw new Error("Must not be called"); }
    });
    const health = await noRoutes.healthCheck();
    assert.equal(health.adminAuthority, "not_probed");
    assert.equal(calls, 0, "a configured service without a profile-validated route is not contacted");
    assert.equal(Object.hasOwn(noRoutes, "adminToken"), false, "the admin credential is held in a private class field");
  });
});

test("Cloud Agent diagnostic adapter refuses broad endpoints and run substitution", async () => {
  await withMockServer((req, res) => {
    if (req.url === "/api/admin/agent/runs/job-123") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "other-job", status: "completed" } }));
      return;
    }
    res.writeHead(404); res.end();
  }, async url => {
    const adapter = createMockAdapter(url, "t");
    const detail = await adapter.getRunDetail("job-123");
    assert.equal(detail.status, "mismatch");
    await assert.rejects(() => adapter.getRunDetail(".."), /bounded run identifier/);
    await assert.rejects(() => adapter.getRunActivity("job-123", { limit: 201 }), /between 1 and 200/);
    const collector = new DiagnosticCollector({ runId: "test-run" });
    assert.throws(() => adapter.registerRunScopedSources(collector, { activeTabRunId: "test-run", cloudAgentRunId: "job-123", sourceIds: ["cloud-agent-settings"] }), /approved run, step, or usage/);
  });
});

test("loopback diagnostics require an in-process remote identity verifier before sending the bearer token", async () => {
  let calls = 0;
  await withMockServer((req, res) => { calls++; res.writeHead(200); res.end(JSON.stringify({ status: "ok" })); }, async url => {
    const adapter = new CloudAgentDiagnosticAdapter({
      baseUrl: url,
      adminToken: "t",
      environmentBinding: {
        environmentId: "freeinference-staging",
        diagnosticEndpoint: url,
        diagnosticTransport: "ssh_tunnel",
        remoteTarget: "staging.freeinference.org",
        diagnosticEndpointBindings: endpointBindings
      },
      endpointBindings
    });
    const health = await adapter.healthCheck();
    assert.equal(health.healthy, false);
    assert.match(health.reason, /trusted tunnel adapter/);
    assert.equal(calls, 0);
  });
});

test("cloudAgentAdapterFromEnv requires an exact profile endpoint binding", () => {
  assert.equal(cloudAgentAdapterFromEnv({}), null);
  const env = {
    ACTIVETAB_CLOUD_AGENT_URL: "https://diagnostics.freeinference.org",
    ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN: "t"
  };
  assert.equal(cloudAgentAdapterFromEnv(env), null);
  const adapter = cloudAgentAdapterFromEnv(env, {
    environmentBinding: {
      environmentId: "freeinference-staging",
      diagnosticEndpoint: "https://diagnostics.freeinference.org",
      diagnosticTransport: "direct",
      remoteTarget: null,
      diagnosticEndpointBindings: endpointBindings
    }
  });
  assert.ok(adapter instanceof CloudAgentDiagnosticAdapter);
  assert.equal(cloudAgentAdapterFromEnv({ ...env, ACTIVETAB_CLOUD_AGENT_URL: "https://attacker.example.test" }, {
    environmentBinding: {
      environmentId: "freeinference-staging",
      diagnosticEndpoint: "https://diagnostics.freeinference.org",
      diagnosticTransport: "direct",
      remoteTarget: null,
      diagnosticEndpointBindings: endpointBindings
    }
  }), null);
});
