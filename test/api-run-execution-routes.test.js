import test from "node:test";
import assert from "node:assert/strict";
import { createRunExecutionHandlers } from "../src/api/routes/runExecution.js";

function createHarness({ executorReady = true, body = { input: { url: "https://example.test" } } } = {}) {
  const calls = [];
  const responses = [];
  const task = { task_id: "task-1", status: "queued" };
  let worker;
  let navigationRun;
  const template = { template_id: "bot-1", input_schema: { required: ["url"] } };
  const lifecycle = {
    executorReady,
    navigationRunner: { async run(goal, options) { navigationRun = { goal, options }; return { status: "succeeded" }; } },
    start: (taskId, nextWorker) => { calls.push(["start", taskId]); worker = nextWorker; }
  };
  const handlers = createRunExecutionHandlers({
    executorReady,
    store: {
      tasks: new Map(),
      create: (...args) => { calls.push(["create", ...args]); return task; },
      update: (...args) => { calls.push(["update", ...args]); },
      persist: async (...args) => { calls.push(["persist", ...args]); },
      get: (...args) => { calls.push(["get", ...args]); return { status: "finished", output: {} }; }
    },
    lifecycle,
    maxTaskRecords: 5,
    diagnostics: { bump: name => calls.push(["bump", name]) },
    runStateStore: { id: "run-state-store" },
    capabilityService: null,
    authorizeExtractionRelease: null,
    findTemplate: id => { calls.push(["findTemplate", id]); return id === "bot-1" ? template : null; },
    validateInput: (schema, input) => { calls.push(["validateInput", schema, input]); return []; },
    buildPageDataExtractionWorkflow: () => { throw new Error("unexpected extraction workflow"); },
    renderGoal: (_template, input) => `open ${input.url}`,
    readBody: async () => body,
    sendJson: (_response, status, result) => responses.push({ status, body: result }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message }),
    logger: { info: (event, context) => calls.push(["log", event, context]) }
  });
  return { ...handlers, calls, responses, task, get navigationRun() { return navigationRun; }, async runWorker() { return worker({ signal: new AbortController().signal }); } };
}

test("run creation fails closed before reading input when no executor is ready", async () => {
  const harness = createHarness({ executorReady: false });

  await harness.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, [{ status: 503, code: 99503, message: "Navigation execution is unavailable on this server." }]);
});

test("run creation rejects invalid input before creating or persisting a task", async () => {
  const harness = createHarness({ body: { input: [] } });

  await harness.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });

  assert.deepEqual(harness.calls, [["findTemplate", "bot-1"]]);
  assert.deepEqual(harness.responses, [{ status: 400, code: 99001, message: "must not be null" }]);
});

test("run creation keeps the queued lifecycle and navigation runner bindings", async () => {
  const harness = createHarness();

  await harness.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });
  assert.deepEqual(harness.responses, [{ status: 200, body: { status: "created", task_id: "task-1" } }]);
  assert.deepEqual(harness.calls.map(call => call[0]), ["findTemplate", "validateInput", "create", "update", "persist", "bump", "log", "start"]);

  const result = await harness.runWorker();
  assert.deepEqual(harness.navigationRun, {
    goal: "open https://example.test",
    options: {
      signal: harness.navigationRun.options.signal,
      input: { url: "https://example.test" },
      templateId: "bot-1",
      taskId: "task-1",
      inputSchema: { required: ["url"] },
      runStateStore: { id: "run-state-store" }
    }
  });
  assert.deepEqual(result, { status: "succeeded" });
});
