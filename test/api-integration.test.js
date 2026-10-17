/**
 * End-to-end integration test: API server + navigation runner with
 * a mock runner that simulates the NavigationEngine result shape.
 * This proves the full stack works: HTTP → runner → output files → file serving.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { createNavigationRunner } from "../src/api/navigation-runner.js";
import { generateOutputFiles } from "../src/api/output-files.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let api;
let apiToken;
let baseUrl;
let tempDir;

// A navigation runner that simulates real browser work without needing Chrome
function createMockNavigationRunner(outputDir, delayMs = 100) {
  return {
    async run(goal, { signal, input, templateId, taskId: providedTaskId } = {}) {
      // Simulate navigation delay
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      }).catch(e => {
        if (e.name === "AbortError") return { status: "canceled" };
        throw e;
      });

      if (signal?.aborted) return { status: "canceled" };

      const taskId = providedTaskId ?? randomUUID();
      const recordCount = input?.review_count ?? 2;
      const records = Array.from({ length: recordCount }, (_, i) => ({
        rank: i + 1,
        author: `Reviewer ${i + 1}`,
        text: `This is review ${i + 1} for the product.`,
        rating: 5 - (i % 3),
        date: "2 days ago"
      }));

      const output = { status: "succeeded", records };
      const credit = Math.ceil(recordCount * 1.5) + 2;
      const outputFiles = await generateOutputFiles(
        taskId,
        { goal, input, output, status: "succeeded" },
        outputDir
      );

      return {
        status: "succeeded",
        output,
        credit,
        output_files: outputFiles,
        live_url_info: null,
        task_id: taskId
      };
    }
  };
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "activetab-e2e-"));

  const runner = createMockNavigationRunner(join(tempDir, "output"), 100);

  apiToken = "test-api-token-for-integration";
  api = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks"),
    navigationRunner: runner,
    apiToken
  });

  const { url } = await api.start();
  baseUrl = url;
});

after(async () => {
  await api.stop();
  await rm(tempDir, { recursive: true, force: true });
});

async function apiCall(method, path, body) {
  const opts = { method, headers: { "Authorization": `Bearer ${apiToken}` } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  return { status: res.status, body: await res.json() };
}

async function waitForTerminalStatus(taskId, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await apiCall("GET", `/v3/bots/runs/${taskId}/status`);
    if (["finished", "failed", "canceled"].includes(res.body.status)) return res.body.status;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Task ${taskId} did not reach terminal status within ${maxMs}ms`);
}

test("Full E2E: create run → poll → detail with output files → fetch files", async () => {
  // 1. Create a run
  const createRes = await apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
    input: { url: "https://example.com/reviews", review_count: 3 }
  });
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.status, "created");
  const taskId = createRes.body.task_id;

  // 2. Wait for completion
  const finalStatus = await waitForTerminalStatus(taskId);
  assert.equal(finalStatus, "finished");

  // 3. Get full detail
  const detailRes = await apiCall("GET", `/v3/bots/runs/${taskId}`);
  assert.equal(detailRes.body.status, "finished");
  assert.ok(detailRes.body.output.records.length === 3);
  assert.ok(detailRes.body.credit > 0);

  // 4. Verify output_files in response
  assert.ok(detailRes.body.output_files.json);
  assert.ok(detailRes.body.output_files.md);
  assert.ok(detailRes.body.output_files.csv);
  // Default export formats are json+md(+csv when records exist); xml is opt-in.
  assert.ok(!("xml" in detailRes.body.output_files));

  // 5. Fetch output files through the API
  const jsonRes = await fetch(`${baseUrl}/output/${taskId}/result.json`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(jsonRes.status, 200);
  const jsonData = JSON.parse(await jsonRes.text());
  assert.equal(jsonData.status, "succeeded");

  const mdRes = await fetch(`${baseUrl}/output/${taskId}/result.md`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(mdRes.status, 200);
  const md = await mdRes.text();
  assert.ok(md.includes("# Task Result:"));

  const csvRes = await fetch(`${baseUrl}/output/${taskId}/result.csv`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.ok(csv.includes("rank"));
  assert.ok(csv.split("\n").length >= 4); // header + 3 rows
});

test("E2E: cancel a running task", async () => {
  // Use a slow runner to ensure we can cancel before completion
  const slowRunner = createMockNavigationRunner(join(tempDir, "output-slow"), 5000);
  const slowApi = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks-slow"),
    navigationRunner: slowRunner,
    apiToken
  });
  const { url: slowUrl } = await slowApi.start();

  // Create a task
  const createRes = await fetch(`${slowUrl}/v3/bots/templates/local-page-data-extractor/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
    body: JSON.stringify({ input: { url: "https://example.com/data" } })
  });
  const { task_id: taskId } = await createRes.json();

  // Cancel immediately
  const cancelRes = await fetch(`${slowUrl}/v3/bots/runs/${taskId}/cancel`, { method: "POST", headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(cancelRes.status, 200);

  // Status should be canceled
  const statusRes = await fetch(`${slowUrl}/v3/bots/runs/${taskId}/status`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  const statusBody = await statusRes.json();
  assert.equal(statusBody.status, "canceled");

  await slowApi.stop();
});

test("E2E: task persistence across server restart", async () => {
  const taskStoreDir = join(tempDir, "tasks-restart");
  const outputDir = join(tempDir, "output-restart");
  const runner = createMockNavigationRunner(outputDir, 50);

  // First server instance
  const api1 = createApiServer({ port: 0, taskStoreDir, navigationRunner: runner, apiToken });
  const { url: url1 } = await api1.start();

  const createRes = await fetch(`${url1}/v3/bots/templates/local-web-reviews-scraper/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
    body: JSON.stringify({ input: { url: "https://example.com/persist", review_count: 2 } })
  });
  const { task_id: taskId } = await createRes.json();

  // Wait for completion on first server
  await new Promise(r => setTimeout(r, 300));
  api1.stop();

  // Second server instance with same task store
  const api2 = createApiServer({ port: 0, taskStoreDir, navigationRunner: runner, apiToken });
  const { url: url2 } = await api2.start();

  // Task should be loadable from disk
  const res = await fetch(`${url2}/v3/bots/runs/${taskId}`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.task_id, taskId);
  assert.equal(body.status, "finished");

  await api2.stop();
});

test("E2E: path traversal rejected", async () => {
  const res = await fetch(`${baseUrl}/output/..%2f..%2fetc%2fpasswd/result.json`, { headers: { "Authorization": `Bearer ${apiToken}` } });
  assert.equal(res.status, 403);
});

test("E2E: multiple concurrent runs", async () => {
  const results = await Promise.all([
    apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
      input: { url: "https://a.com", review_count: 1 }
    }),
    apiCall("POST", "/v3/bots/templates/local-web-reviews-scraper/runs", {
      input: { url: "https://b.com", review_count: 2 }
    }),
    apiCall("POST", "/v3/bots/templates/local-form-filler/runs", {
      input: { url: "https://c.com", form_goal: "Fill the contact form" }
    })
  ]);

  const taskIds = results.map(r => r.body.task_id);
  assert.equal(new Set(taskIds).size, 3); // All unique

  // Wait for all to complete
  for (const taskId of taskIds) {
    const status = await waitForTerminalStatus(taskId);
    assert.equal(status, "finished");
  }
});
