/** Route the compatibility API's task run record endpoints. */
const API_PREFIX = "/v3/bots";

export function createLegacyRunRoutes({ store, lifecycle, findTemplate, projectInput, sendJson, sendError } = {}) {
  return async function handleLegacyRunRoute(_req, res, { method, path, query = {} } = {}) {
    if (method === "GET" && path.match(/^\/v3\/bots\/runs\/[^/]+\/status$/)) {
      const task = store.get(path.split("/")[4]) ?? await store.load(path.split("/")[4]);
      if (!task) { sendError(res, 404, 99404, "No static resource v3/bots/runs/status."); return true; }
      sendJson(res, 200, { status: task.status, task_id: task.task_id, updated_at: task.updated_at });
      return true;
    }

    if (method === "GET" && path.match(/^\/v3\/bots\/runs\/[^/]+$/)) {
      const taskId = path.split("/")[4];
      const task = store.get(taskId) ?? await store.load(taskId);
      if (!task) { sendError(res, 404, 99404, `No static resource v3/bots/runs/${taskId}.`); return true; }
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
      return true;
    }

    if (method === "POST" && path.match(/^\/v3\/bots\/runs\/[^/]+\/cancel$/)) {
      const taskId = path.split("/")[4];
      const task = store.get(taskId) ?? await store.load(taskId);
      if (!task) { sendError(res, 404, 99404, `No static resource v3/bots/runs/${taskId}/cancel.`); return true; }
      const canceled = await lifecycle.cancel(taskId);
      // Lightweight route fixtures and older lifecycle adapters may not own
      // persistence; the production RunLifecycle persists intent before abort.
      if (canceled === undefined) await store.persist(taskId);
      const current = canceled ?? task;
      sendJson(res, 200, { status: current.status, task_id: taskId, updated_at: current.updated_at });
      return true;
    }

    if (method === "GET" && path === `${API_PREFIX}/runs`) {
      const result = store.list(parseInt(query.page ?? "1", 10), parseInt(query.limit ?? "10", 10));
      sendJson(res, 200, {
        ...result,
        items: result.items.map(task => {
          const template = findTemplate(task.template_id);
          return {
            task_id: task.task_id,
            template_id: task.template_id,
            status: task.status,
            input: projectInput(task.input, template?.input_schema),
            created_at: task.created_at,
            updated_at: task.updated_at,
            finished_at: task.finished_at ?? null
          };
        })
      });
      return true;
    }

    return false;
  };
}
