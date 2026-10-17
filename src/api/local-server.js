/**
 * ActiveTab Local API Server — routing and composition only.
 *
 * Responsibilities live in focused modules:
 * - Task persistence & interruption reconciliation: ./task-store.js
 * - Run workers & terminal-state translation:  ./run-lifecycle.js
 * - Host/Origin/bearer-token security:          ./security.js
 * - Template registry, input validation, goals: ./templates.js
 * - Redacted input projections:                 ./input-projection.js
 * - HTTP helpers:                               ./http-utils.js
 * - Local navigation execution:                 ./navigation-runner.js
 * - Remote (LAN peer) execution:                ../runtime/remote-executor.js
 *
 * The BrowserAct V3-shaped routes are an optional, compatibility-only
 * adapter over the native run lifecycle; template and bot runs share one
 * real execution path, and the peer endpoint forwards redacted requests
 * to a LAN executor node.
 */
import http from "node:http";
import { join, resolve } from "node:path";
import { open } from "node:fs/promises";
import { TaskStore } from "./task-store.js";
import { RunLifecycle } from "./run-lifecycle.js";
import { checkHost, checkOrigin, createMutationAuthorizer } from "./security.js";
import { OFFICIAL_TEMPLATES, REGIONS, findTemplate, validateInput, renderGoal } from "./templates.js";
import { projectInput } from "./input-projection.js";
import { sendJson, sendError, readBody, parseQuery } from "./http-utils.js";
import { createDiagnostics } from "../runtime/diagnostics.js";
import { logger } from "../runtime/logger.js";
import { DiagnosticCollector } from "../diagnostics/collector.js";
import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../diagnostics/contracts.js";
import { registerBrowserDiagnosticSources } from "../diagnostics/adapters/browserSources.js";
import { cloudAgentAdapterFromEnv } from "../diagnostics/adapters/cloudAgentApi.js";
import { DiagnosticCorrelator } from "../diagnostics/correlator.js";
import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS } from "../diagnostics/report.js";
import { TestRunner } from "../testing/runner.js";
import { ApplicationDiscoveryEngine } from "../discovery/engine.js";
import { InvestigationEngine } from "../investigation/engine.js";
import { randomUUID } from "node:crypto";

const DEFAULT_PORT = 9377;
const API_PREFIX = "/v3/bots";
const MAX_TASK_RECORDS = 1_000;
const MAX_OUTPUT_FILE_BYTES = 5 * 1024 * 1024;
const OUTPUT_EXTENSIONS = new Set(["json", "md", "csv", "xml"]);
const TERMINAL = new Set(["finished", "failed", "canceled", "needs_human"]);

export function createApiServer({ port = DEFAULT_PORT, taskStoreDir, navigationRunner, apiToken, host = "127.0.0.1", maxTasks = MAX_TASK_RECORDS, executorName, reportDir, testSessionResolver = null } = {}) {
  const store = new TaskStore(taskStoreDir ?? join(process.cwd(), ".activetab", "tasks"));
  const lifecycle = new RunLifecycle({ store, navigationRunner, executorName, reportDir });
  const token = apiToken ?? process.env.ACTIVETAB_API_TOKEN ?? null;
  const authorizeMutation = createMutationAuthorizer(token);
  const maxTaskRecords = Number.isInteger(maxTasks) && maxTasks >= 1 ? Math.min(maxTasks, 10_000) : MAX_TASK_RECORDS;
  const diagnostics = createDiagnostics();
  const testRuns = new Map();

  function createBrowserDiagnosticSources(session, collector) {
    registerBrowserDiagnosticSources(session, collector);
    const cloudAgent = cloudAgentAdapterFromEnv();
    if (cloudAgent) cloudAgent.registerSources(collector);
    return collector;
  }

  async function handleStartTestRun(req, res) {
    const body = await readBody(req);
    const workflow = body?.workflow;
    if (!workflow || typeof workflow !== "object" || !workflow.id || !Array.isArray(workflow.steps)) {
      sendError(res, 400, 99001, "workflow with id and steps is required.");
      return;
    }
    let session = null;
    if (typeof testSessionResolver === "function") {
      try { session = await testSessionResolver({ workflow, input: body?.input ?? {} }); } catch { session = null; }
    } else if (typeof body?.session === "object" && typeof body.session.observe === "function") {
      session = body.session;
    }
    if (!session || typeof session !== "object" || typeof session.observe !== "function" || typeof session.client?.send !== "function") {
      sendError(res, 400, 99002, "An attached browser session is required for test runs.");
      return;
    }
    const runId = `test-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const collector = new DiagnosticCollector({ runId });
    createBrowserDiagnosticSources(session, collector);
    const correlator = new DiagnosticCorrelator();
    const controller = new AbortController();
    const runner = new TestRunner({ session, collector, correlator, signal: controller.signal });
    const runPromise = runner.run(workflow, { runId });
    testRuns.set(runId, { collector, correlator, controller, runPromise, session, startedAt: new Date().toISOString() });
    sendJson(res, 200, { status: "started", runId });
  }

  async function handleGetTestRun(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
    let receipt;
    try { receipt = await Promise.race([run.runPromise, Promise.resolve(null)]); } catch { receipt = null; }
    if (receipt) { sendJson(res, 200, receipt.toObject()); return; }
    sendJson(res, 200, { runId, status: "RUNNING", startedAt: run.startedAt });
  }

  async function handleCancelTestRun(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
    run.controller.abort();
    sendJson(res, 200, { status: "cancel_requested", runId });
  }

  async function handleCollectTestRunDiagnostics(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
    const results = await run.collector.collectAll([
      { sourceId: "browser-network", operation: OPERATION.READ },
      { sourceId: "browser-lifecycle", operation: OPERATION.READ }
    ]);
    sendJson(res, 200, { runId, results });
  }

  async function handleGetTestReport(req, res, runId) {
    const run = testRuns.get(runId);
    if (!run) { sendError(res, 404, 99404, `No test run found for runId '${runId}'.`); return; }
    const receipt = await run.runPromise;
    const report = new DiagnosticReport({ runId, title: `Test run: ${receipt.workflowName}` });
    report.setCorrelationSummary(run.correlator.summary());
    for (const step of receipt.steps) {
      const level = step.status === "PASS" ? FINDING_LEVEL.CONFIRMED
        : step.status === "FAIL" ? FINDING_LEVEL.LIKELY
        : step.status === "BLOCKED" ? FINDING_LEVEL.BLOCKED
        : FINDING_LEVEL.INSUFFICIENT;
      report.addFinding({ level, subject: `Step ${step.stepId} (${step.type})`, description: step.reason, evidenceIds: step.evidenceIds });
    }
    for (const entry of run.collector.getSnapshots()) {
      report.logSourceAccess({ sourceId: entry.sourceId, operation: entry.operation, status: "ok" });
    }
    report.setInvestigationStatus(INVESTIGATION_STATUS.COMPLETE);
    sendJson(res, 200, report.redacted());
  }

  // Executor readiness: fail closed when no real navigation runner was provided.
  const executorReady = lifecycle.executorReady;
  const executorDetail = executorReady ? "ready" : "unavailable: no navigation runner configured";

  const server = http.createServer(async (req, res) => {
    const requestStart = Date.now();
    res.on("finish", () => diagnostics.httpLogger(req, res, requestStart));
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const query = parseQuery(url);
    const method = req.method ?? "GET";
    const requestOrigin = req.headers.origin ?? null;

    if (!checkHost(req, res, sendError)) return;
    if (!checkOrigin(req, res, sendError)) return;

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...(requestOrigin ? { "Access-Control-Allow-Origin": requestOrigin } : {}),
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      res.end();
      return;
    }

    const isStateChanging = method === "POST" || method === "PUT" || method === "DELETE";

    try {
      if (method === "GET" && (path === "/health" || path === "/")) {
        sendJson(res, 200, {
          status: "ok", service: "activetab-local-api", version: "0.1.0",
          executor: { ready: executorReady, detail: executorDetail },
          auth: { tokenRequired: token !== null },
          diagnostics: diagnostics.snapshot()
        }, { allowOrigin: requestOrigin ?? undefined });
        return;
      }

      // ── Discovery and investigation (file 3 sections 2 & 6) ──
      if (method === "POST" && path === "/v1/discover") {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        const body = await readBody(req);
        let session = null;
        if (typeof testSessionResolver === "function") {
          try { session = await testSessionResolver({ input: body ?? {} }); } catch { session = null; }
        }
        if (!session) { sendError(res, 400, 99002, "A browser session is required for discovery."); return; }
        const engine = new ApplicationDiscoveryEngine({
          session,
          maxSteps: body?.maxSteps ?? 8,
          maxLinksPerStep: body?.maxLinksPerStep ?? 4,
          ...(body?.knowledgeDir ? { knowledgeDir: body.knowledgeDir } : {})
        });
        const result = await engine.discover();
        sendJson(res, 200, result);
        return;
      }
      if (method === "POST" && path === "/v1/investigate") {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        const body = await readBody(req);
        if (!body?.subject || !body?.reason) { sendError(res, 400, 99001, "subject and reason are required."); return; }
        const engine = new InvestigationEngine({ collector: null, correlator: new DiagnosticCorrelator() });
        const result = await engine.investigate({ subject: body.subject, reason: body.reason, runId: body.runId ?? null });
        sendJson(res, 200, result);
        return;
      }

      // ── Test-run lifecycle (file 2 section 9) ──
      if (method === "POST" && path === "/v1/test/runs") {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        await handleStartTestRun(req, res);
        return;
      }
      const testRunMatch = path.match(/^\/v1\/test\/runs\/([^/]+)(?:\/(status|cancel|diagnostics|report))?$/);
      if (testRunMatch) {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        const runId = testRunMatch[1];
        const action = testRunMatch[2] ?? "status";
        if (method === "GET" && action === "status") { await handleGetTestRun(req, res, runId); return; }
        if (method === "POST" && action === "cancel") { await handleCancelTestRun(req, res, runId); return; }
        if (method === "POST" && action === "diagnostics") { await handleCollectTestRunDiagnostics(req, res, runId); return; }
        if (method === "GET" && action === "report") { await handleGetTestReport(req, res, runId); return; }
        sendError(res, 405, 99405, "Method not allowed for this test-run resource.");
        return;
      }

      if (path.startsWith("/v3/") || path.startsWith("/v2/")) {
        // The peer-execution endpoint authenticates with its own peer token
        // ring inside handlePeerRun; it must not require the local API token.
        const isPeerRun = method === "POST" && path === `${API_PREFIX}/remote/runs`;
        if (!isPeerRun && !authorizeMutation(req)) {
          // All other /v3 and /v2 endpoints are privileged or expose run metadata.
          // Require explicit credentials for both reads and mutations.
          sendError(res, 401, 99401, "Authentication required.");
          return;
        }

        // ── GET /v3/bots ──
        if (method === "GET" && path === API_PREFIX) {
          const page = parseInt(query.page ?? "1", 10);
          const limit = parseInt(query.limit ?? "20", 10);
          const allItems = OFFICIAL_TEMPLATES.map(t => ({ bot_id: t.template_id, name: t.name, bot_type: t.bot_type, template_id: t.template_id, recommend_desc: t.recommend_desc }));
          sendJson(res, 200, { items: allItems.slice((page - 1) * limit, page * limit), page, limit, total_count: allItems.length, total_pages: Math.ceil(allItems.length / limit) });
          return;
        }

        // ── GET /v3/bots/templates ──
        if (method === "GET" && path === `${API_PREFIX}/templates`) {
          const page = parseInt(query.page ?? "1", 10);
          const limit = parseInt(query.limit ?? "10", 10);
          const items = OFFICIAL_TEMPLATES.map(t => ({ name: t.name, template_id: t.template_id, bot_type: t.bot_type, recommend_desc: t.recommend_desc, detail_url: t.detail_url }));
          sendJson(res, 200, { items: items.slice((page - 1) * limit, page * limit), page, limit, total_count: items.length, total_pages: Math.ceil(items.length / limit) });
          return;
        }

        // ── GET /v3/bots/templates/:id ──
        if (method === "GET" && path.match(/^\/v3\/bots\/templates\/[^/]+$/)) {
          const template = findTemplate(path.split("/").pop());
          if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return; }
          sendJson(res, 200, {
            name: template.name, template_id: template.template_id, bot_type: template.bot_type,
            description: template.recommend_desc, input_schema: template.input_schema,
            recommend_desc: template.recommend_desc, detail_url: template.detail_url,
            created_at: "2026-10-16T00:00:00Z", published_at: "2026-10-16T00:00:00Z"
          });
          return;
        }

        // ── POST /v3/bots/remote/runs (peer execution; must precede :bot_id) ──
        if (method === "POST" && path === `${API_PREFIX}/remote/runs`) {
          await handlePeerRun(req, res, { store, lifecycle, executorReady, diagnostics });
          return;
        }

        // ── POST run creation (template and bot routes share one path) ──
        const templateRun = method === "POST" && path.match(/^\/v3\/bots\/templates\/[^/]+\/runs$/);
        const botRun = method === "POST" && path.match(/^\/v3\/bots\/[^/]+\/runs$/);
        if (templateRun || botRun) {
          await handleCreateRun(req, res, { templateRun, botRun, path, executorReady, store, lifecycle, maxTaskRecords, diagnostics });
          return;
        }

        // ── GET /v3/bots/regions ──
        if (method === "GET" && path === `${API_PREFIX}/regions`) {
          sendJson(res, 200, REGIONS);
          return;
        }

        // ── GET /v3/bots/:bot_id ──
        if (method === "GET" && path.match(/^\/v3\/bots\/[^/]+$/) && !path.includes("templates") && !path.includes("runs") && !path.includes("regions")) {
          const template = findTemplate(path.split("/").pop());
          if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return; }
          sendJson(res, 200, { bot_id: template.template_id, name: template.name, bot_type: template.bot_type, input_schema: template.input_schema, created_at: "2026-10-16T00:00:00Z" });
          return;
        }

        // ── GET /v3/bots/runs/:task_id/status ──
        if (method === "GET" && path.match(/^\/v3\/bots\/runs\/[^/]+\/status$/)) {
          const task = store.get(path.split("/")[4]) ?? await store.load(path.split("/")[4]);
          if (!task) { sendError(res, 404, 99404, "No static resource v3/bots/runs/status."); return; }
          sendJson(res, 200, { status: task.status, task_id: task.task_id, updated_at: task.updated_at });
          return;
        }

        // ── GET /v3/bots/runs/:task_id ──
        if (method === "GET" && path.match(/^\/v3\/bots\/runs\/[^/]+$/)) {
          const taskId = path.split("/")[4];
          const task = store.get(taskId) ?? await store.load(taskId);
          if (!task) { sendError(res, 404, 99404, `No static resource v3/bots/runs/${taskId}.`); return; }
          const template = findTemplate(task.template_id);
          sendJson(res, 200, {
            status: task.status, task_id: task.task_id,
            input: projectInput(task.input, template?.input_schema),
            output: task.output, usage: task.usage ?? null,
            ...(typeof task.credit === "number" ? { credit: task.credit } : {}),
            bot_type: task.bot_type,
            created_at: task.created_at, finished_at: task.finished_at ?? null,
            log_detail_url: task.log_detail_url, output_files: task.output_files,
            download_files: task.download_files, live_url_info: task.live_url_info,
            ...(task.error ? { error: task.error } : {})
          });
          return;
        }

        // ── POST /v3/bots/runs/:task_id/cancel ──
        if (method === "POST" && path.match(/^\/v3\/bots\/runs\/[^/]+\/cancel$/)) {
          const taskId = path.split("/")[4];
          const task = store.get(taskId) ?? await store.load(taskId);
          if (!task) { sendError(res, 404, 99404, `No static resource v3/bots/runs/${taskId}/cancel.`); return; }
          lifecycle.cancel(taskId);
          await store.persist(taskId);
          sendJson(res, 200, { status: task.status, task_id: taskId, updated_at: task.updated_at });
          return;
        }

        // ── GET /v3/bots/runs ──
        if (method === "GET" && path === `${API_PREFIX}/runs`) {
          sendJson(res, 200, store.list(parseInt(query.page ?? "1", 10), parseInt(query.limit ?? "10", 10)));
          return;
        }

        sendError(res, 404, 99404, `No static resource ${path.replace(/^\//, "")}.`);
        return;
      }

      // Output file serving: allowlisted extensions, safe path resolution, bounded size.
      if (method === "GET" && path.match(/^\/output\/[^/]+\/[^/]+$/)) {
        if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return; }
        await serveOutputFile(res, { store, path });
        return;
      }

      sendError(res, 404, 99404, `No static resource ${path.replace(/^\//, "")}.`);
    } catch (error) {
      sendError(res, 500, 99500, String(error.message ?? error).slice(0, 500));
    }
  });

  return {
    server,
    store,
    async start() {
      await store.init();
      return new Promise((resolvePromise, reject) => {
        server.listen(port, host, () => {
          const address = server.address();
          const boundHost = address.address === "::" ? "[::1]" : String(address.address);
          const url = `http://${boundHost}:${address.port}`;
          console.log(`ActiveTab local API server listening on ${url}`);
          resolvePromise({ port: address.port, url });
        });
        server.on("error", reject);
      });
    },
    async stop() {
      for (const run of testRuns.values()) run.controller.abort();
      await lifecycle.stopAll();
      return new Promise(resolvePromise => server.close(resolvePromise));
    }
  };
}

// ── Route handlers ───────────────────────────────────────────────────────

async function handleCreateRun(req, res, { templateRun, botRun, path, executorReady, store, lifecycle, maxTaskRecords, diagnostics }) {
  if (!executorReady) {
    // Fail closed: no executor, no acknowledged executable task.
    sendError(res, 503, 99503, "Navigation execution is unavailable on this server.");
    return;
  }
  if (store.tasks.size >= maxTaskRecords) {
    sendError(res, 507, 99507, `Task storage is full (${maxTaskRecords} records).`);
    return;
  }
  const id = templateRun ? path.split("/")[4] : path.split("/")[3];
  const template = findTemplate(id);
  if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return; }
  const body = await readBody(req);
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    sendError(res, 400, 99001, "must not be null");
    return;
  }
  const errors = validateInput(template.input_schema, body.input);
  if (errors.length) {
    sendError(res, 400, 99001, errors.map(e => `${e.field}: ${e.message}`).join("; "));
    return;
  }

  const task = store.create(id, body.input, templateRun ? null : id);
  store.update(task.task_id, { status: "queued" });
  await store.persist(task.task_id);
  diagnostics.bump("runs.created");
  logger.info("run.created", { task: task.task_id, template: id, executor: lifecycle.executorReady ? "configured" : "none" });

  lifecycle.start(task.task_id, controller => lifecycle.navigationRunner.run(renderGoal(template, body.input), {
    signal: controller.signal,
    input: body.input,
    templateId: id,
    taskId: task.task_id,
    inputSchema: template.input_schema
  }));

  sendJson(res, 200, { status: "created", task_id: task.task_id });
}

async function handlePeerRun(req, res, { store, lifecycle, executorReady, diagnostics }) {
  if (!executorReady) { sendError(res, 503, 99503, "Navigation execution is unavailable on this server."); return; }
  const peerAuth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const { loadPeerTokenRing, tokenMatches } = await import("../runtime/tokens.js");
  if (!tokenMatches(peerAuth, await loadPeerTokenRing())) {
    sendError(res, 403, 99403, "Peer token required.");
    return;
  }
  const body = await readBody(req);
  if (typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 2000) {
    sendError(res, 400, 99001, "A non-empty goal of at most 2000 characters is required.");
    return;
  }
  const task = store.create("remote-peer-run", {}, null);
  store.update(task.task_id, { status: "running" });
  await store.persist(task.task_id);
  diagnostics.bump("runs.peer");
  logger.info("run.peer.created", { task: task.task_id });

  const { controller, worker } = lifecycle.start(task.task_id, ctrl => lifecycle.navigationRunner.run(body.goal, {
    signal: ctrl.signal,
    input: (body.input && typeof body.input === "object" && !Array.isArray(body.input)) ? body.input : {},
    templateId: "remote-peer-run",
    taskId: task.task_id
  }));

  // Await-style peer response: heartbeats keep the socket responsive on
  // slow runs; the remote executor tolerates the leading blank lines.
  const heartbeat = setInterval(() => { try { res.write?.("\n"); } catch { /* socket gone */ } }, 15_000);
  try {
    await worker;
  } finally {
    clearInterval(heartbeat);
  }
  const finished = store.get(task.task_id);
  sendJson(res, 200, {
    status: finished.status === "finished" ? "succeeded" : finished.status,
    output: finished.output ?? null,
    usage: finished.usage ?? null,
    output_files: finished.output_files ?? {},
    task_id: task.task_id,
    ...(finished.error ? { error: finished.error } : {})
  });
}

async function serveOutputFile(res, { store, path }) {
  const parts = path.split("/");
  const taskId = parts[2];
  const filename = parts[3];
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  if (!/^[0-9a-f-]{36}$/.test(taskId) || !OUTPUT_EXTENSIONS.has(ext) || filename.includes("..")) {
    sendError(res, 403, 99403, "Forbidden");
    return;
  }
  let filePath;
  try {
    filePath = resolve(join(store.baseDir, "..", "output", taskId, filename));
    if (!filePath.startsWith(resolve(join(store.baseDir, "..", "output")) + "/")) throw new Error("path escape");
  } catch {
    sendError(res, 403, 99403, "Forbidden");
    return;
  }
  try {
    const file = await open(filePath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_OUTPUT_FILE_BYTES) {
        sendError(res, 404, 99404, "Output file not found.");
        return;
      }
      const content = await file.readFile("utf8");
      const mimeTypes = { json: "application/json", md: "text/markdown", csv: "text/csv", xml: "application/xml" };
      res.writeHead(200, { "Content-Type": mimeTypes[ext], "Content-Length": Buffer.byteLength(content) });
      res.end(content);
    } finally { await file.close(); }
  } catch {
    sendError(res, 404, 99404, `Output file not found: ${filename}`);
  }
}
