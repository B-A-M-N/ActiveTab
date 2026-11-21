import { createHash } from "node:crypto";
import { projectExtractionOutput, projectExtractionOutputs } from "../../extraction/outputRelease.js";

/** Compose compatibility run creation and peer execution from server-owned services. */
export function createRunExecutionHandlers({
  executorReady,
  store,
  lifecycle,
  maxTaskRecords,
  diagnostics,
  runStateStore,
  capabilityService,
  authorizeExtractionRelease,
  findTemplate,
  validateInput,
  buildPageDataExtractionWorkflow,
  renderGoal,
  isShuttingDown = () => false,
  readBody,
  sendJson,
  sendError,
  logger
} = {}) {
  const peerRunsInFlight = new Map();

  function createTask(templateId, input, botId, inputSchema, res) {
    try { return store.create(templateId, input, botId, inputSchema); }
    catch (error) {
      if (error?.code !== "TASK_STORE_FULL") throw error;
      sendError(res, 507, 99507, `Task storage is full (${maxTaskRecords} records).`);
      return null;
    }
  }

  async function recordSchedulingFailure(taskId, phase, res, { status = 500, code = 99500, message = null } = {}) {
    store.update(taskId, {
      status: "failed",
      error: `run ${phase} failed before navigation was scheduled`,
      finished_at: new Date().toISOString()
    });
    try {
      await store.persist(taskId);
    } catch {
      logger.error("run.failure.persist.failed", { task: taskId, phase });
      sendError(res, 503, 99503, "Run scheduling failed and its durable state could not be confirmed.");
      return;
    }
    logger.error("run.scheduling.failed", { task: taskId, phase });
    sendError(res, status, code, message ?? `Run ${phase} failed before navigation was scheduled; failure was recorded.`);
  }

  async function handleCreateRun(req, res, { templateRun, path } = {}) {
    if (isShuttingDown()) { sendError(res, 503, 99503, "The API server is shutting down."); return; }
    if (!executorReady) {
      // Fail closed: no executor, no acknowledged executable task.
      sendError(res, 503, 99503, "Navigation execution is unavailable on this server.");
      return;
    }
    const id = templateRun ? path.split("/")[4] : path.split("/")[3];
    const template = findTemplate(id);
    if (!template) { sendError(res, 400, 99010, "bot_id is invalid."); return; }
    const body = await readBody(req);
    if (isShuttingDown()) { sendError(res, 503, 99503, "The API server is shutting down."); return; }
    if (!isJsonObject(body)) {
      sendError(res, 400, 99001, "JSON request body must be an object.");
      return;
    }
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
      sendError(res, 400, 99001, "must not be null");
      return;
    }
    const errors = validateInput(template.input_schema, body.input);
    if (errors.length) {
      sendError(res, 400, 99001, errors.map(error => `${error.field}: ${error.message}`).join("; "));
      return;
    }

    if (id === "local-page-data-extractor" && typeof body.input.capability_id === "string") {
      let requestedUrl;
      try { requestedUrl = new URL(body.input.url); }
      catch { sendError(res, 400, 99001, "url must match the exact route of a registered extraction capability."); return; }
      const matchingCapabilities = (capabilityService?.registry?.list?.() ?? []).filter(manifest => {
        if (manifest.capabilityId !== body.input.capability_id
          || manifest.capabilityVersion !== (body.input.capability_version ?? 1)
          || manifest.origin !== requestedUrl.origin || manifest.pagePath !== requestedUrl.pathname) return false;
        return true;
      });
      if (requestedUrl.username || requestedUrl.password || requestedUrl.search || requestedUrl.hash
        || !["http:", "https:"].includes(requestedUrl.protocol) || matchingCapabilities.length !== 1) {
        sendError(res, 400, 99001, "capability_id and url must identify one registered origin and exact route without credentials, query, or fragment.");
        return;
      }
    }

    if (store.tasks.size >= maxTaskRecords) {
      sendError(res, 507, 99507, `Task storage is full (${maxTaskRecords} records).`);
      return;
    }
    const usesExtractionWorkflow = id === "local-page-data-extractor" && Boolean(capabilityService);
    const goal = usesExtractionWorkflow
      ? `Go to ${body.input.url} and ${body.input.capability_id ? "extract with a qualified capability" : "discover visible structured data"}.`
      : renderGoal(template, body.input);
    const task = createTask(id, body.input, templateRun ? null : id, template.input_schema, res);
    if (!task) return;
    store.update(task.task_id, { status: "queued" });
    await store.persist(task.task_id);
    if (isShuttingDown()) {
      await recordSchedulingFailure(task.task_id, "canceled during shutdown", res, {
        status: 503, code: 99503,
        message: "The API server is shutting down; this run was recorded as failed before scheduling."
      });
      return;
    }

    try {
      const extractionWorkflow = usesExtractionWorkflow
        ? buildPageDataExtractionWorkflow(body.input, task.task_id)
        : null;
      await lifecycle.start(task.task_id, async controller => {
        const result = await lifecycle.navigationRunner.run(goal, {
          signal: controller.signal,
          input: body.input,
          templateId: id,
          taskId: task.task_id,
          inputSchema: template.input_schema,
          ...(extractionWorkflow ? { workflow: extractionWorkflow } : {}),
          runStateStore
        });
        return extractionWorkflow
          ? projectRunResultForRelease(result, authorizeExtractionRelease, { req, taskId: task.task_id })
          : result;
      });
    } catch {
      await recordSchedulingFailure(task.task_id, usesExtractionWorkflow ? "preparation" : "scheduling", res);
      return;
    }

    diagnostics.bump("runs.created");
    logger.info("run.created", { task: task.task_id, template: id, executor: lifecycle.executorReady ? "configured" : "none" });
    sendJson(res, 200, { status: "created", task_id: task.task_id });
  }

  async function handlePeerRun(req, res) {
    if (isShuttingDown()) { sendError(res, 503, 99503, "The API server is shutting down."); return; }
    if (!executorReady) { sendError(res, 503, 99503, "Navigation execution is unavailable on this server."); return; }
    const peerAuth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const { loadPeerTokenRing, tokenMatches } = await import("../../runtime/tokens.js");
    if (!tokenMatches(peerAuth, await loadPeerTokenRing())) {
      sendError(res, 403, 99403, "Peer token required.");
      return;
    }
    const body = await readBody(req);
    if (isShuttingDown()) { sendError(res, 503, 99503, "The API server is shutting down."); return; }
    if (!isJsonObject(body)) {
      sendError(res, 400, 99001, "JSON request body must be an object.");
      return;
    }
    if (typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 2000) {
      sendError(res, 400, 99001, "A non-empty goal of at most 2000 characters is required.");
      return;
    }
    const idempotencyKey = req.headers?.["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
      sendError(res, 400, 99001, "A stable Idempotency-Key header of 1 to 128 visible ASCII characters is required.");
      return;
    }
    const input = (body.input && typeof body.input === "object" && !Array.isArray(body.input)) ? body.input : {};
    let reservation;
    try {
      reservation = store.reservePeerTask({
        // The current peer-token ring represents one shared peer principal.
        // Token rotation does not change this principal or its key namespace.
        principalId: "shared-peer-token",
        idempotencyKey,
        fingerprint: fingerprintPeerRequest({
          goal: body.goal,
          input,
          plannerMode: body.plannerMode,
          workflowIntent: body.workflowIntent
        }),
        input
      });
    } catch (error) {
      if (error?.code === "TASK_STORE_FULL") {
        sendError(res, 507, 99507, `Task storage is full (${maxTaskRecords} records).`);
        return;
      }
      if (error?.code === "TASK_STORE_IDEMPOTENCY_CONFLICT") {
        sendError(res, 409, 99409, "Idempotency-Key was already used for a different peer request.");
        return;
      }
      logger.error("run.peer.reservation.failed", { reason: String(error?.message ?? error).slice(0, 160) });
      sendError(res, 503, 99503, "Peer run reservation could not be confirmed; no run was scheduled.");
      return;
    }

    let inFlight = null;
    if (reservation.created) {
      let signalStarted;
      inFlight = { worker: null, started: new Promise(resolve => { signalStarted = resolve; }), signalStarted: null };
      inFlight.signalStarted = signalStarted;
      peerRunsInFlight.set(reservation.taskId, inFlight);
    }

    try {
      await reservation.persisted;
    } catch (error) {
      logger.error("run.peer.reservation.persist.failed", { task: reservation.taskId, reason: String(error?.message ?? error).slice(0, 160) });
      if (inFlight && peerRunsInFlight.get(reservation.taskId) === inFlight) {
        inFlight.signalStarted();
        peerRunsInFlight.delete(reservation.taskId);
      }
      sendError(res, 503, 99503, "Peer run reservation could not be confirmed; no run was scheduled.");
      return;
    }

    if (reservation.created) {
      try {
        if (isShuttingDown()) {
          await recordSchedulingFailure(reservation.taskId, "canceled during shutdown", res, {
            status: 503, code: 99503,
            message: "The API server is shutting down; this run was recorded as failed before scheduling."
          });
          return;
        }
        diagnostics.bump("runs.peer");
        logger.info("run.peer.created", { task: reservation.taskId });
        const started = lifecycle.start(reservation.taskId, ctrl => lifecycle.navigationRunner.run(body.goal, {
          signal: ctrl.signal,
          input,
          templateId: "remote-peer-run",
          taskId: reservation.taskId,
          plannerMode: body.plannerMode,
          workflowIntent: body.workflowIntent,
          runStateStore
        }));
        inFlight.worker = started.worker;
      } catch {
        await recordSchedulingFailure(reservation.taskId, "scheduling", res);
      } finally {
        inFlight.signalStarted();
      }
    }

    const activeRun = reservation.created ? inFlight : peerRunsInFlight.get(reservation.taskId);
    if (activeRun) {
      const heartbeat = setInterval(() => { try { res.write?.("\n"); } catch { /* socket gone */ } }, 15_000);
      try {
        await activeRun.started;
        if (activeRun.worker) await activeRun.worker;
      } finally {
        clearInterval(heartbeat);
        if (reservation.created && peerRunsInFlight.get(reservation.taskId) === activeRun) {
          peerRunsInFlight.delete(reservation.taskId);
        }
      }
    } else {
      const existing = store.get(reservation.taskId);
      if (existing && ["created", "queued", "running"].includes(existing.status)) {
        store.update(reservation.taskId, {
          status: "reconciling",
          error: "A matching peer request has no live worker; its original outcome must be reconciled before any retry."
        });
        await store.persist(reservation.taskId);
      }
    }
    const finished = store.get(reservation.taskId);
    sendPeerTaskResult(res, finished, reservation.taskId, sendJson);
  }

  return Object.freeze({ handleCreateRun, handlePeerRun });
}

function fingerprintPeerRequest(request) {
  const canonicalize = value => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(request))).digest("hex");
}

function sendPeerTaskResult(res, task, taskId, sendJson) {
  if (!task) {
    sendJson(res, 200, {
      status: "unresolved",
      output: null,
      usage: null,
      output_files: {},
      task_id: taskId,
      error: "The reserved peer task is unavailable; its outcome must be reconciled before retry.",
      uncertain: true
    });
    return;
  }
  sendJson(res, 200, {
    status: task.status === "finished" ? "succeeded" : task.status === "reconciling" ? "unresolved" : task.status,
    output: task.output ?? null,
    usage: task.usage ?? null,
    output_files: task.output_files ?? {},
    task_id: task.task_id,
    uncertain: task.status === "reconciling" || task.output?.uncertain === true,
    ...(task.error ? { error: task.error } : {})
  });
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectRunResultForRelease(result, authorizeExtractionRelease, context) {
  if (!result?.output || typeof result.output !== "object") return result;
  const output = result.output;
  const outputs = projectExtractionOutputs(output.outputs ?? {}, authorizeExtractionRelease, context);
  const primary = output.schema?.items
    ? projectExtractionOutput(output, authorizeExtractionRelease, context)
    : null;
  return {
    ...result,
    output: {
      ...output,
      ...(primary ? {
        schema: primary.schema,
        records: primary.records,
        fieldProvenance: primary.fieldProvenance,
        completeness: primary.completeness,
        verification: primary.verification,
        ...(primary.release ? { release: primary.release } : {})
      } : {}),
      outputs
    }
  };
}
