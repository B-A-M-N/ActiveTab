import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyRunRoutes } from "../src/api/routes/legacyRuns.js";

function createHarness({ task = null, listed = [] } = {}) {
  const calls = [];
  const responses = [];
  const store = {
    get: id => { calls.push(["get", id]); return task; },
    load: async id => { calls.push(["load", id]); return task; },
    persist: async id => { calls.push(["persist", id]); },
    list: (page, limit) => {
      calls.push(["list", page, limit]);
      return { items: listed, page, limit, total_count: listed.length, total_pages: 1 };
    }
  };
  const route = createLegacyRunRoutes({
    store,
    lifecycle: { cancel: id => calls.push(["cancel", id]) },
    findTemplate: id => { calls.push(["findTemplate", id]); return id ? { input_schema: { type: "object" } } : null; },
    projectInput: (input, schema) => ({ projected: input, schema }),
    sendJson: (_response, status, body) => responses.push({ status, body }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message })
  });
  return { route, calls, responses };
}

test("legacy run routes leave unrelated paths and methods to API composition", async () => {
  const harness = createHarness();

  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/templates" }), false);
  assert.equal(await harness.route({}, {}, { method: "POST", path: "/v3/bots/runs/task-1/status" }), false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, []);
});

test("legacy run status loads durable task state and preserves the compatibility response", async () => {
  const harness = createHarness({ task: { status: "running", task_id: "task-1", updated_at: "now" } });
  const handled = await harness.route({}, {}, { method: "GET", path: "/v3/bots/runs/task-1/status" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["get", "task-1"]]);
  assert.deepEqual(harness.responses, [{ status: 200, body: { status: "running", task_id: "task-1", updated_at: "now" } }]);
});

test("legacy run detail projects caller input and retains optional output fields", async () => {
  const task = {
    task_id: "task-2", template_id: "template-2", input: { secret: "private" }, status: "finished",
    output: { items: [] }, usage: { actions: 1 }, credit: 3, bot_type: "web",
    created_at: "start", finished_at: "finish", log_detail_url: null, output_files: {},
    download_files: {}, live_url_info: null, error: "bounded error"
  };
  const harness = createHarness({ task });
  const handled = await harness.route({}, {}, { method: "GET", path: "/v3/bots/runs/task-2" });

  assert.equal(handled, true);
  assert.deepEqual(harness.responses, [{ status: 200, body: {
    status: "finished", task_id: "task-2", input: { projected: task.input, schema: { type: "object" } },
    output: task.output, usage: task.usage, credit: 3, bot_type: "web", created_at: "start",
    finished_at: "finish", log_detail_url: null, output_files: {}, download_files: {},
    live_url_info: null, error: "bounded error"
  } }]);
});

test("legacy run cancel keeps lifecycle cancellation before durable persistence", async () => {
  const harness = createHarness({ task: { status: "cancel_requested", task_id: "task-3", updated_at: "later" } });
  const handled = await harness.route({}, {}, { method: "POST", path: "/v3/bots/runs/task-3/cancel" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["get", "task-3"], ["cancel", "task-3"], ["persist", "task-3"]]);
  assert.deepEqual(harness.responses, [{ status: 200, body: { status: "cancel_requested", task_id: "task-3", updated_at: "later" } }]);
});

test("legacy run listing keeps pagination and safe input projection", async () => {
  const task = { task_id: "task-4", template_id: "template-4", status: "queued", input: { name: "value" }, created_at: "start", updated_at: "update", finished_at: null };
  const harness = createHarness({ listed: [task] });
  const handled = await harness.route({}, {}, { method: "GET", path: "/v3/bots/runs", query: { page: "2", limit: "4" } });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["list", 2, 4], ["findTemplate", "template-4"]]);
  assert.deepEqual(harness.responses, [{ status: 200, body: {
    page: 2, limit: 4, total_count: 1, total_pages: 1,
    items: [{ task_id: "task-4", template_id: "template-4", status: "queued",
      input: { projected: task.input, schema: { type: "object" } }, created_at: "start",
      updated_at: "update", finished_at: null }]
  } }]);
});

test("missing legacy run cancellation preserves not-found behavior without lifecycle effects", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, { method: "POST", path: "/v3/bots/runs/missing/cancel" });

  assert.equal(handled, true);
  assert.deepEqual(harness.calls, [["get", "missing"], ["load", "missing"]]);
  assert.deepEqual(harness.responses, [{
    status: 404, code: 99404, message: "No static resource v3/bots/runs/missing/cancel."
  }]);
});
