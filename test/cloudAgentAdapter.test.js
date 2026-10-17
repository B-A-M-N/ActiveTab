import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { CloudAgentDiagnosticAdapter, cloudAgentAdapterFromEnv } from "../src/diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCollector } from "../src/diagnostics/collector.js";

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

test("cloudAgentAdapter healthCheck verifies connectivity and admin authority", async () => {
  await withMockServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/admin/agent/runs") {
      if (req.headers.authorization !== "Bearer test-admin-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "Unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runs: [], since: new Date().toISOString(), until: new Date().toISOString(), next_cursor: null }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Not Found" }));
  }, async url => {
    const adapter = new CloudAgentDiagnosticAdapter({ baseUrl: url, adminToken: "test-admin-token", diagnosticTransport: "ssh_tunnel", remoteTarget: "staging.freeinference.org" });
    const health = await adapter.healthCheck();
    assert.equal(health.healthy, true);
  });
});

test("cloudAgentAdapter rejects missing configuration", () => {
  assert.throws(() => new CloudAgentDiagnosticAdapter({ baseUrl: "http://127.0.0.1:18000" }), /requires an adminToken/);
  assert.throws(() => new CloudAgentDiagnosticAdapter({ adminToken: "x" }), /requires a baseUrl/);
  assert.throws(() => new CloudAgentDiagnosticAdapter({ baseUrl: "not-a-url", adminToken: "x" }), /not a valid URL/);
});

test("cloudAgentAdapter collects real records from all diagnostic sources", async () => {
  const responses = {
    "/admin/agent/runs": { runs: [{ id: "job-1", state: "finished", model: "gpt-4" }], since: "2026-01-01", until: "2026-01-02", next_cursor: null },
    "/admin/agent/steps": { steps: [{ step_id: "s1", status: "PASS" }], since: "2026-01-01", until: "2026-01-02" },
    "/admin/agent/usage": { summary: { run_count: 1 }, days: [{ date: "2026-01-01", usage: { run_count: 1 } }] },
    "/admin/agent/audit-log": { entries: [{ entry_id: "e1" }] },
    "/admin/agent/sandboxes": { sandboxes: [{ sandbox_id: "sb-1" }] },
    "/admin/agent/conversations": { conversations: [{ conversation_id: "c1" }] },
    "/admin/agent/measurements": { measurements: [{ measurement_id: "m1" }] },
    "/admin/agent/settings": { definitions: [{ key: "log_level", kind: "string", default: "INFO", secret: false, read_only: false }] }
  };
  await withMockServer((req, res) => {
    const path = req.url.split("?")[0];
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (responses[path]) {
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401); res.end(); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[path]));
      return;
    }
    res.writeHead(404); res.end();
  }, async url => {
    const adapter = new CloudAgentDiagnosticAdapter({ baseUrl: url, adminToken: "test-token", diagnosticTransport: "ssh_tunnel", remoteTarget: "staging.freeinference.org" });
    const collector = new DiagnosticCollector({ runId: "test-run" });
    adapter.registerSources(collector);
    const results = await collector.collectAll(collector.listSources().map(s => ({ sourceId: s.id, operation: "read" })));
    assert.equal(results.length, 8, "All sources collected.");
    for (const result of results) {
      assert.equal(result.status, "ok", `Source ${result.sourceId} should succeed.`);
      assert.equal(result.snapshot.data.status, "available", `Source ${result.sourceId} should return available evidence.`);
      assert.ok(result.snapshot.data.recordCount > 0, `Source ${result.sourceId} should have records.`);
    }
    // Verify usage records use the days array, not just the summary.
    const usageResult = results.find(r => r.sourceId === "cloud-agent-usage");
    assert.ok(usageResult.snapshot.data.records.some(r => r.date), "Usage records should include per-day entries.");
    // Verify settings records are redacted to non-secret fields.
    const settingsResult = results.find(r => r.sourceId === "cloud-agent-settings");
    assert.equal(settingsResult.snapshot.data.records[0].key, "log_level");
    assert.equal(settingsResult.snapshot.data.records[0].secret, false);
    assert.equal(settingsResult.snapshot.data.records[0].description, undefined, "Sensitive descriptions should be omitted from settings records.");
  });
});

test("cloudAgentAdapter getRunDetail and getRunActivity use the correct paths", async () => {
  await withMockServer((req, res) => {
    if (req.url === "/admin/agent/runs/job-123") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "job-123" }, attempts: [], usage: {} }));
      return;
    }
    if (req.url.startsWith("/admin/agent/runs/job-123/activity")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [], next_cursor: null }));
      return;
    }
    res.writeHead(404); res.end();
  }, async url => {
    const adapter = new CloudAgentDiagnosticAdapter({ baseUrl: url, adminToken: "t", diagnosticTransport: "ssh_tunnel", remoteTarget: "staging.freeinference.org" });
    const detail = await adapter.getRunDetail("job-123");
    assert.equal(detail.status, "ok");
    assert.equal(detail.data.run.id, "job-123");
    const activity = await adapter.getRunActivity("job-123");
    assert.equal(activity.status, "ok");
  });
});

test("cloudAgentAdapter rejects loopback without explicit ssh_tunnel transport", () => {
  assert.throws(
    () => new CloudAgentDiagnosticAdapter({ baseUrl: "http://127.0.0.1:18000", adminToken: "t" }),
    /requires diagnosticTransport 'ssh_tunnel'/
  );
});

test("cloudAgentAdapterFromEnv returns null without config and adapter with both vars", () => {
  assert.equal(cloudAgentAdapterFromEnv({}), null);
  const adapter = cloudAgentAdapterFromEnv({
    ACTIVETAB_CLOUD_AGENT_URL: "http://127.0.0.1:18000",
    ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN: "t",
    ACTIVETAB_CLOUD_AGENT_TRANSPORT: "ssh_tunnel",
    ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET: "staging.freeinference.org"
  });
  assert.ok(adapter instanceof CloudAgentDiagnosticAdapter);
});
