import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let api;
let baseUrl;
let tempDir;

const MOCK_NAVIGATION_RUNNER = {
  async run(goal, { signal, input, templateId } = {}) {
    // Simulate a short navigation task
    await new Promise(resolve => setTimeout(resolve, 50));
    if (signal?.aborted) return { status: "canceled" };
    return {
      status: "succeeded",
      output: { records: [{ id: 1, title: "Mock result for: " + goal }] },
      usage: { actions: 1, recoveries: 0, planner_calls: null, tokens_used: null, elapsed_ms: 50 },
      output_files: {
        json: { file_name: "result.json", file_size: 128, download_url: "local://output/result.json" }
      },
      live_url_info: null
    };
  }
};

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "activetab-api-test-"));
  api = createApiServer({
    port: 0, // random available port
    taskStoreDir: join(tempDir, "tasks"),
    navigationRunner: MOCK_NAVIGATION_RUNNER,
    apiToken: "test-token"
  });
  const { url } = await api.start();
  baseUrl = url;
});

after(async () => {
  await api.stop();
  await rm(tempDir, { recursive: true, force: true });
});

async function apiCall(method, path, body) {
  const opts = { method, headers: { "Authorization": "Bearer test-token" } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json();
  return { status: res.status, body: json };
}

// ── Health check ─────────────────────────────────────────────────────────

test("GET /health returns ok", async () => {
  const { status, body } = await apiCall("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "activetab-local-api");
});

test("API startup refuses readiness when durable intervention storage fails", async () => {
  let initCalls = 0;
  const unavailable = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks-intervention-failure"),
    navigationRunner: MOCK_NAVIGATION_RUNNER,
    interventionStore: { async init() { initCalls++; throw new Error("read-only storage"); } }
  });
  await assert.rejects(unavailable.start(), error => error?.code === "intervention_store_unavailable");
  assert.equal(initCalls, 1, "startup and request lifecycle share one initialization attempt");
});

test("test-run status is projected from durable state rather than a process-local worker receipt", async () => {
  const runId = "durable-authority-test";
  const durableState = {
    runId,
    status: "uncertain",
    createdAt: "2026-10-19T12:00:00.000Z",
    workflowId: "durable-workflow",
    completedSteps: [{ stepId: "step-a", type: "navigate", status: "PASS", evidenceIds: [] }],
    pendingOperations: [{ operationId: "operation-uncertain", status: "UNCERTAIN" }],
    pendingInterventionId: "intervention-pending",
    cancellationRequested: true
  };
  const durableStore = {
    async init() {},
    async acquireTargetLease() { throw new Error("This status-only test does not acquire browser leases."); },
    async getFresh(id) { return id === runId ? structuredClone(durableState) : null; }
  };
  const server = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks-durable-authority"),
    navigationRunner: MOCK_NAVIGATION_RUNNER,
    apiToken: "test-token",
    runStateStore: durableStore
  });
  const { url } = await server.start();
  try {
    const response = await fetch(`${url}/v1/test/runs/${runId}/status`, {
      headers: { Authorization: "Bearer test-token" }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "UNCERTAIN");
    assert.equal(body.pendingInterventionId, "intervention-pending");
    assert.deepEqual(body.unresolvedOperationIds, ["operation-uncertain"]);
    assert.equal(body.cancellationRequested, true);
  } finally {
    await server.stop();
  }
});

// ── Bots listing ─────────────────────────────────────────────────────────

test("GET /v3/bots returns template list", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.total_count > 0);
  assert.ok(body.items[0].bot_id);
  assert.ok(body.items[0].name);
  assert.equal(body.items[0].bot_type, "agent");
});

test("GET /v3/bots with pagination params", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots?page=1&limit=2");
  assert.equal(status, 200);
  assert.equal(body.page, 1);
  assert.equal(body.limit, 2);
  assert.ok(body.items.length <= 2);
});

// ── Templates ────────────────────────────────────────────────────────────

test("GET /v3/bots/templates returns official templates", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/templates");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.total_count >= 3);
  const t = body.items[0];
  assert.ok(t.template_id);
  assert.ok(t.name);
  assert.ok(t.recommend_desc);
  assert.ok(t.detail_url);
});

test("GET /v3/bots/templates/:id returns detail with input_schema", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/templates/local-web-reviews-scraper");
  assert.equal(status, 200);
  assert.equal(body.template_id, "local-web-reviews-scraper");
  assert.ok(body.input_schema);
  assert.equal(body.input_schema.type, "object");
  assert.ok(body.input_schema.required.includes("url"));
  assert.ok(body.input_schema.required.includes("review_count"));
});

test("GET /v3/bots/templates/:id with invalid id returns 99010", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/templates/nonexistent");
  assert.equal(status, 400);
  assert.equal(body.code, 99010);
  assert.equal(body.msg, "bot_id is invalid.");
});

// ── Regions ──────────────────────────────────────────────────────────────

test("GET /v3/bots/regions returns local region", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/regions");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.some(r => r.code === "LOCAL"));
});

// ── Run creation ─────────────────────────────────────────────────────────

test("POST /v3/bots/templates/:id/runs creates a run", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/reviews", review_count: 5 }
  });
  assert.equal(status, 200);
  assert.equal(body.status, "created");
  assert.ok(body.task_id);
});

test("POST run with missing input returns 99001", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {});
  assert.equal(status, 400);
  assert.equal(body.code, 99001);
});

test("POST run with invalid input returns 99001", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com", review_count: 999 } // exceeds max
  });
  assert.equal(status, 400);
  assert.equal(body.code, 99001);
});

test("POST run rejects and does not persist undeclared input fields", async () => {
  const before = await apiCall("GET", "/v3/bots/runs");
  const secretValue = "must-not-be-persisted-or-returned";
  const result = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com", review_count: 2, undeclared_secret: secretValue }
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 99001);
  assert.equal(JSON.stringify(result.body).includes(secretValue), false);
  const after = await apiCall("GET", "/v3/bots/runs");
  assert.equal(after.body.total_count, before.body.total_count);
});

test("POST run with missing required field returns 99001", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com" } // missing review_count
  });
  assert.equal(status, 400);
  assert.equal(body.code, 99001);
});

test("POST run with invalid template returns 99010", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/templates/nonexistent/runs", {
    input: { url: "https://example.com" }
  });
  assert.equal(status, 400);
  assert.equal(body.code, 99010);
});

// ── Run lifecycle ────────────────────────────────────────────────────────

test("Full run lifecycle: create → status → detail", async () => {
  // Create
  const createRes = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/page", review_count: 3 }
  });
  assert.equal(createRes.status, 200);
  const taskId = createRes.body.task_id;

  // Poll status (allow time for mock runner)
  await new Promise(r => setTimeout(r, 200));
  const statusRes = await apiCall("GET", `/v3/bots/runs/${taskId}/status`);
  assert.equal(statusRes.status, 200);
  assert.ok(["queued", "running", "finished", "created"].includes(statusRes.body.status));
  assert.equal(statusRes.body.task_id, taskId);

  // Wait for completion
  await new Promise(r => setTimeout(r, 200));
  const detailRes = await apiCall("GET", `/v3/bots/runs/${taskId}`);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.status, "finished");
  assert.ok(detailRes.body.output);
  assert.equal(typeof detailRes.body.usage.actions, "number", "locally measured usage replaces synthetic credits");
  assert.equal(detailRes.body.bot_type, "agent");
  assert.ok(detailRes.body.created_at);
  assert.ok(detailRes.body.finished_at);
});

test("Run detail for nonexistent task returns 99404", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/runs/fake-task-id");
  assert.equal(status, 404);
  assert.equal(body.code, 99404);
});

test("Run status for nonexistent task returns 99404", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/runs/fake-task-id/status");
  assert.equal(status, 404);
  assert.equal(body.code, 99404);
});

// ── Cancel ───────────────────────────────────────────────────────────────

test("Cancel a run", async () => {
  // Create a run (mock runner takes ~50ms)
  const createRes = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/cancel-test", review_count: 10 }
  });
  const taskId = createRes.body.task_id;

  // Cancel immediately (before mock runner completes)
  const cancelRes = await apiCall("POST", `/v3/bots/runs/${taskId}/cancel`);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, "canceled");

  // Verify status is canceled
  const statusRes = await apiCall("GET", `/v3/bots/runs/${taskId}/status`);
  assert.equal(statusRes.body.status, "canceled");
});

test("Cancel nonexistent task returns 99404", async () => {
  const { status, body } = await apiCall("POST", "/v3/bots/runs/fake-task-id/cancel");
  assert.equal(status, 404);
  assert.equal(body.code, 99404);
});

// ── Bot detail ───────────────────────────────────────────────────────────

test("GET /v3/bots/:bot_id returns bot detail", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/local-web-reviews-scraper");
  assert.equal(status, 200);
  assert.equal(body.bot_id, "local-web-reviews-scraper");
  assert.ok(body.name);
  assert.equal(body.bot_type, "agent");
});

test("GET /v3/bots/:bot_id with invalid id returns 99010", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/nonexistent");
  assert.equal(status, 400);
  assert.equal(body.code, 99010);
});

// ── Error envelope shape ─────────────────────────────────────────────────

test("Error responses match BrowserAct error envelope", async () => {
  const { status, body } = await apiCall("GET", "/v3/bots/nonexistent");
  assert.equal(status, 400);
  // Must match: {code, msg, data, ts, time, traceId}
  assert.ok(typeof body.code === "number");
  assert.ok(typeof body.msg === "string");
  assert.equal(body.data, null);
  assert.ok(typeof body.ts === "number");
  assert.ok(typeof body.time === "string");
  assert.ok(typeof body.traceId === "string");
});

// ── V2 shape compatibility ───────────────────────────────────────────────

test("GET /v3/bots/runs lists tasks in V2-compatible shape", async () => {
  const created = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/list-test", review_count: 2 }
  });

  const { status, body } = await apiCall("GET", "/v3/bots/runs");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(typeof body.total_count === "number");
  assert.ok(typeof body.total_pages === "number");
  const item = body.items.find(task => task.task_id === created.body.task_id);
  assert.deepEqual(item.input, { url: "[redacted]", review_count: 2 });
  assert.equal(JSON.stringify(item).includes("list-test"), false);
  assert.equal(Object.hasOwn(item, "output"), false, "the list projection omits full run results");
});

// ── Milestone 0: execution, security, and lifecycle hardening ───────────

import { createHash } from "node:crypto";

async function waitForTerminal(base, taskId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/v3/bots/runs/${taskId}/status`, { headers: { "Authorization": "Bearer test-token" } }).then(r => r.json());
    if (["finished", "failed", "canceled", "needs_human"].includes(res.status)) return res.status;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`task ${taskId} did not reach a terminal state in time`);
}

test("health reports real executor readiness", async () => {
  const { status, body } = await apiCall("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.executor.ready, true);
  const tokenless = createApiServer({ port: 0, taskStoreDir: join(tempDir, "tasks-none"), apiToken: "test-token" });
  const { url } = await tokenless.start();
  const health = await fetch(`${url}/health`).then(r => r.json());
  assert.equal(health.executor.ready, false);
  await tokenless.stop();
});

test("server without a runner fails closed: no executable task is acknowledged", async () => {
  const tokenless = createApiServer({ port: 0, taskStoreDir: join(tempDir, "tasks-closed"), apiToken: "test-token" });
  const { url } = await tokenless.start();
  const res = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.code, 99503);
  await tokenless.stop();
});

test("bot runs reach the same real execution path as template runs", async () => {
  const createRes = await apiCall("POST", "/v3/bots/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/bot-run", review_count: 2 }
  });
  assert.equal(createRes.status, 200);
  const terminal = await waitForTerminal(baseUrl, createRes.body.task_id);
  assert.equal(terminal, "finished");
  const detailRes = await apiCall("GET", `/v3/bots/runs/${createRes.body.task_id}`);
  assert.ok(detailRes.body.output);
});

test("needs_human is preserved as a distinct terminal state", async () => {
  const humanRunner = {
    async run() {
      return { status: "needs_human", output: { reason: "A login step is required." } };
    }
  };
  const humanApi = createApiServer({ port: 0, taskStoreDir: join(tempDir, "tasks-human"), navigationRunner: humanRunner, apiToken: "test-token" });
  const { url } = await humanApi.start();
  const create = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  }).then(r => r.json());
  assert.equal(await waitForTerminal(url, create.task_id), "needs_human");
  await humanApi.stop();
});

test("canceling a slow run produces canceled, and the worker cannot overwrite it", async () => {
  let release;
  const slowRunner = {
    async run(goal, { signal } = {}) {
      await new Promise((resolve, reject) => {
        release = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: signal?.aborted ? "canceled" : "succeeded", output: { status: signal?.aborted ? "canceled" : "succeeded" } };
    }
  };
  const slowApi = createApiServer({ port: 0, taskStoreDir: join(tempDir, "tasks-slow"), navigationRunner: slowRunner, apiToken: "test-token" });
  const { url } = await slowApi.start();
  const create = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  }).then(r => r.json());
  await new Promise(r => setTimeout(r, 100));
  const cancel = await fetch(`${url}/v3/bots/runs/${create.task_id}/cancel`, { method: "POST", headers: { "Authorization": "Bearer test-token" } });
  assert.equal(cancel.status, 200);
  release?.();
  await new Promise(r => setTimeout(r, 200));
  const detail = await fetch(`${url}/v3/bots/runs/${create.task_id}`, { headers: { "Authorization": "Bearer test-token" } }).then(r => r.json());
  assert.equal(detail.status, "canceled", "a stale worker must not resurrect a canceled task");
  await slowApi.stop();
});

test("run detail returns the redacted input projection, never raw input", async () => {
  const createRes = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/raw-input-url", review_count: 7 }
  });
  await waitForTerminal(baseUrl, createRes.body.task_id);
  const detailRes = await apiCall("GET", `/v3/bots/runs/${createRes.body.task_id}`);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.input.url, "[redacted]");
  assert.equal(detailRes.body.input.review_count, 7);
});

test("runs report locally measured usage instead of synthetic vendor credits", async () => {
  const createRes = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/usage", review_count: 1 }
  });
  await waitForTerminal(baseUrl, createRes.body.task_id);
  const detailRes = await apiCall("GET", `/v3/bots/runs/${createRes.body.task_id}`);
  assert.equal(typeof detailRes.body.usage.elapsed_ms, "number");
  assert.equal(typeof detailRes.body.usage.actions, "number");
});

test("legacy run and catalog reads, cancellation, and run creation require the bearer token when configured", async () => {
  const token = "test-token-" + createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 8);
  const secureApi = createApiServer({ port: 0, taskStoreDir: join(tempDir, "tasks-secure"), navigationRunner: MOCK_NAVIGATION_RUNNER, apiToken: token });
  const { url } = await secureApi.start();
  const unauth = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  });
  assert.equal(unauth.status, 401);
  const unauthCatalog = await fetch(`${url}/v3/bots`);
  assert.equal(unauthCatalog.status, 401);
  const unauthRunList = await fetch(`${url}/v3/bots/runs`);
  assert.equal(unauthRunList.status, 401);
  const unauthCancel = await fetch(`${url}/v3/bots/runs/missing-task/cancel`, { method: "POST" });
  assert.equal(unauthCancel.status, 401);
  const auth = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  });
  assert.equal(auth.status, 200);
  await secureApi.stop();
});

test("untrusted Host and Origin headers are rejected", async () => {
  const { request } = await import("node:http");
  const parsed = new URL(baseUrl);
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = request({ host: parsed.hostname, port: parsed.port, path: "/v3/bots", headers }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await raw({ Host: "evil.example.com" }), 403, "DNS-rebinding Host header rejected");
  assert.equal(await raw({ Host: "127.0.0.1", Origin: "https://evil.example.com" }), 403, "untrusted browser origin rejected");
  assert.equal(await raw({ Host: "127.0.0.1", Origin: "chrome-extension://abcdefg", Authorization: "Bearer test-token" }), 200, "allowed extension origin with auth accepted");
  assert.equal(await raw({ Host: "127.0.0.1", Origin: "chrome-extension://abcdefg" }), 401, "allowed extension origin without auth is rejected");
});

test("output endpoint rejects path traversal and non-allowlisted names", async () => {
  const res = await fetch(`${baseUrl}/output/..%2f..%2fetc/passwd/result.json`);
  assert.ok([403, 404].includes(res.status));
});

test("interrupted running tasks remain reconciling after restart", async () => {
  const dir = join(tempDir, "tasks-reconcile");
  const first = createApiServer({ port: 0, taskStoreDir: dir, navigationRunner: MOCK_NAVIGATION_RUNNER, apiToken: "test-token" });
  const { url } = await first.start();
  const create = await fetch(`${url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
    body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
  }).then(r => r.json());
  // Simulate a crash: stop the server while the run is mid-flight.
  await new Promise(r => setTimeout(r, 20));
  await first.stop();

  const second = createApiServer({ port: 0, taskStoreDir: dir, navigationRunner: MOCK_NAVIGATION_RUNNER, apiToken: "test-token" });
  const secondInfo = await second.start();
  const detail = await fetch(`${secondInfo.url}/v3/bots/runs/${create.task_id}`, { headers: { "Authorization": "Bearer test-token" } }).then(r => r.json());
  assert.equal(detail.status, "reconciling", "a lost worker is not treated as proof of remote failure");
  assert.match(detail.error, /interrupted/);
  await second.stop();
});
