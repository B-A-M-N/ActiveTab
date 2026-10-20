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
  readBody,
  sendJson,
  sendError,
  logger
} = {}) {
  async function handleCreateRun(req, res, { templateRun, path } = {}) {
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

    const task = store.create(id, body.input, templateRun ? null : id, template.input_schema);
    store.update(task.task_id, { status: "queued" });
    await store.persist(task.task_id);
    diagnostics.bump("runs.created");
    logger.info("run.created", { task: task.task_id, template: id, executor: lifecycle.executorReady ? "configured" : "none" });

    const extractionWorkflow = id === "local-page-data-extractor" && capabilityService
      ? buildPageDataExtractionWorkflow(body.input, task.task_id)
      : null;
    const goal = extractionWorkflow
      ? `Go to ${body.input.url} and ${body.input.capability_id ? "extract with a qualified capability" : "discover visible structured data"}.`
      : renderGoal(template, body.input);
    lifecycle.start(task.task_id, async controller => {
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

    sendJson(res, 200, { status: "created", task_id: task.task_id });
  }

  async function handlePeerRun(req, res) {
    if (!executorReady) { sendError(res, 503, 99503, "Navigation execution is unavailable on this server."); return; }
    const peerAuth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const { loadPeerTokenRing, tokenMatches } = await import("../../runtime/tokens.js");
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
      taskId: task.task_id,
      plannerMode: body.plannerMode,
      workflowIntent: body.workflowIntent,
      runStateStore
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

  return Object.freeze({ handleCreateRun, handlePeerRun });
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
