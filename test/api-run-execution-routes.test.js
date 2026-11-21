import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunExecutionHandlers } from "../src/api/routes/runExecution.js";
import { TaskStore } from "../src/api/task-store.js";

function createHarness({ executorReady = true, body = { input: { url: "https://example.test" } }, maxTaskRecords = 5, initialTaskCount = 0, capabilityService = null, buildPageDataExtractionWorkflow = () => { throw new Error("unexpected extraction workflow"); }, renderGoal = (_template, input) => `open ${input.url}`, startFailure = null } = {}) {
  const calls = [];
  const responses = [];
  const task = { task_id: "task-1", status: "queued" };
  const taskRecords = new Map(Array.from({ length: initialTaskCount }, (_, index) => [`existing-${index}`, {}]));
  let worker;
  let navigationRun;
  const template = { template_id: "bot-1", input_schema: { required: ["url"] } };
  const lifecycle = {
    executorReady,
    navigationRunner: { async run(goal, options) { navigationRun = { goal, options }; return { status: "succeeded" }; } },
    start: (taskId, nextWorker) => { calls.push(["start", taskId]); if (startFailure) throw startFailure; worker = nextWorker; return { worker: Promise.resolve() }; }
  };
  const handlers = createRunExecutionHandlers({
    executorReady,
    store: {
      tasks: taskRecords,
      create: (...args) => {
        calls.push(["create", ...args]);
        if (taskRecords.size >= maxTaskRecords) throw Object.assign(new Error("full"), { code: "TASK_STORE_FULL" });
        taskRecords.set(task.task_id, task);
        return task;
      },
      reservePeerTask: () => {
        calls.push(["reservePeerTask"]);
        if (taskRecords.size >= maxTaskRecords) throw Object.assign(new Error("full"), { code: "TASK_STORE_FULL" });
        taskRecords.set(task.task_id, task);
        return { created: true, task, taskId: task.task_id, persisted: Promise.resolve() };
      },
      update: (taskId, updates) => { calls.push(["update", taskId, updates]); Object.assign(task, updates); },
      persist: async (...args) => { calls.push(["persist", ...args]); },
      get: (...args) => { calls.push(["get", ...args]); return { status: "finished", output: {} }; }
    },
    lifecycle,
    maxTaskRecords,
    diagnostics: { bump: name => calls.push(["bump", name]) },
    runStateStore: { id: "run-state-store" },
    capabilityService,
    authorizeExtractionRelease: null,
    findTemplate: id => { calls.push(["findTemplate", id]); return id === "bot-1" || id === "local-page-data-extractor" ? template : null; },
    validateInput: (schema, input) => { calls.push(["validateInput", schema, input]); return []; },
    buildPageDataExtractionWorkflow,
    renderGoal,
    readBody: async () => body,
    sendJson: (_response, status, result) => responses.push({ status, body: result }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message }),
    logger: {
      info: (event, context) => calls.push(["log", event, context]),
      error: (event, context) => calls.push(["error", event, context])
    }
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

test("run creation rejects non-object JSON bodies and missing input with 400 before task creation", async () => {
  for (const body of [null, [], "text", 12, false, {}]) {
    const harness = createHarness({ body, maxTaskRecords: 1, initialTaskCount: 1 });
    await harness.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });
    assert.equal(harness.responses[0].status, 400, `body ${JSON.stringify(body)}`);
    assert.equal(harness.calls.some(call => call[0] === "create" || call[0] === "persist"), false, `body ${JSON.stringify(body)}`);
  }
});

test("peer execution rejects non-object JSON bodies and missing goal with 400 before task creation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-peer-body-"));
  const tokenFile = join(directory, "peer-token");
  await writeFile(tokenFile, "route-test-peer-token\n", { mode: 0o600 });
  const previousTokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
  const previousToken = process.env.ACTIVETAB_REMOTE_TOKEN;
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  delete process.env.ACTIVETAB_REMOTE_TOKEN;
  t.after(async () => {
    if (previousTokenFile === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
    else process.env.ACTIVETAB_REMOTE_TOKEN_FILE = previousTokenFile;
    if (previousToken === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN;
    else process.env.ACTIVETAB_REMOTE_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  });

  for (const body of [null, [], "text", 12, false, {}]) {
    const harness = createHarness({ body });
    await harness.handlePeerRun({ headers: { authorization: "Bearer route-test-peer-token" } }, {});
    assert.equal(harness.responses[0].status, 400, `body ${JSON.stringify(body)}`);
    assert.equal(harness.calls.some(call => call[0] === "create" || call[0] === "persist"), false, `body ${JSON.stringify(body)}`);
  }

  for (const key of [undefined, "", "x".repeat(129), "clé"]) {
    const harness = createHarness({ body: { goal: "open the page" } });
    const headers = { authorization: "Bearer route-test-peer-token" };
    if (key !== undefined) headers["idempotency-key"] = key;
    await harness.handlePeerRun({ headers }, {});
    assert.equal(harness.responses[0].status, 400, `key ${JSON.stringify(key)}`);
    assert.equal(harness.calls.some(call => call[0] === "reservePeerTask" || call[0] === "start"), false);
  }
});

test("peer execution enforces task capacity after authenticating and validating the request", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-peer-capacity-"));
  const tokenFile = join(directory, "peer-token");
  await writeFile(tokenFile, "route-test-peer-token\n", { mode: 0o600 });
  const previousTokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
  const previousToken = process.env.ACTIVETAB_REMOTE_TOKEN;
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  delete process.env.ACTIVETAB_REMOTE_TOKEN;
  t.after(async () => {
    if (previousTokenFile === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
    else process.env.ACTIVETAB_REMOTE_TOKEN_FILE = previousTokenFile;
    if (previousToken === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN;
    else process.env.ACTIVETAB_REMOTE_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  });
  const harness = createHarness({ body: { goal: "open the page" }, maxTaskRecords: 1, initialTaskCount: 1 });

  await harness.handlePeerRun({ headers: { authorization: "Bearer route-test-peer-token", "idempotency-key": "stable-peer-run-1" } }, {});

  assert.deepEqual(harness.responses, [{ status: 507, code: 99507, message: "Task storage is full (1 records)." }]);
  assert.equal(harness.calls.some(call => call[0] === "create" || call[0] === "start"), false);
});

test("TaskStore atomically enforces capacity across concurrent create calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-task-capacity-"));
  try {
    const store = new TaskStore(directory, { maxRecords: 2 });
    store.create("remote-peer-run", {});
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.create("remote-peer-run", {})),
      Promise.resolve().then(() => store.create("remote-peer-run", {}))
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "TASK_STORE_FULL").length, 1);
    assert.equal(store.tasks.size, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task creation preparation and scheduling failures leave a durable failed record", async () => {
  const extractorPath = { templateRun: true, path: "/v3/bots/templates/local-page-data-extractor/runs" };
  const prepFailure = createHarness({
    body: { input: { url: "https://example.test" } },
    capabilityService: {},
    buildPageDataExtractionWorkflow: () => { throw new Error("private input must not be persisted"); }
  });
  await prepFailure.handleCreateRun({}, {}, extractorPath);
  assert.equal(prepFailure.task.status, "failed");
  assert.equal(prepFailure.task.error, "run preparation failed before navigation was scheduled");
  assert.equal(prepFailure.calls.filter(call => call[0] === "persist").length, 2);
  assert.equal(prepFailure.calls.some(call => call[0] === "start"), false);
  assert.equal(prepFailure.responses[0].status, 500);

  const startFailure = createHarness({ startFailure: new Error("scheduler detail") });
  await startFailure.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });
  assert.equal(startFailure.task.status, "failed");
  assert.equal(startFailure.task.error, "run scheduling failed before navigation was scheduled");
  assert.equal(startFailure.responses[0].status, 500);

  const renderFailure = createHarness({ renderGoal: () => { throw new Error("bad template rendering"); } });
  await assert.rejects(() => renderFailure.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" }));
  assert.equal(renderFailure.calls.some(call => call[0] === "create" || call[0] === "persist"), false);
});

test("run creation keeps the queued lifecycle and navigation runner bindings", async () => {
  const harness = createHarness();

  await harness.handleCreateRun({}, {}, { templateRun: true, path: "/v3/bots/templates/bot-1/runs" });
  assert.deepEqual(harness.responses, [{ status: 200, body: { status: "created", task_id: "task-1" } }]);
  assert.deepEqual(harness.calls.map(call => call[0]), ["findTemplate", "validateInput", "create", "update", "persist", "start", "bump", "log"]);

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
