import { randomUUID } from "node:crypto";
import { appendAudit, rowToRun } from "./persistence.js";
import { readJson } from "./http.js";

const JOB_DURATION_MS = 120;

/**
 * Owns Cloud Agent task submission, status/diagnostic reads, and synthetic
 * job timing. HTTP authentication and fixture lifecycle stay with the
 * provider; all data mutation and job transitions live here.
 */
export function createAgentJobService({ getDatabase, getEpisodeId, getTask, faults, send }) {
  const timers = new Map();

  function clearTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  function startJob(runId) {
    const delay = faults.take("delay_job_completion") ? 5_000 : JOB_DURATION_MS;
    const timer = setTimeout(() => {
      timers.delete(runId);
      const db = getDatabase();
      const current = db?.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId);
      if (!current || current.status !== "queued") return;
      const startedAt = new Date().toISOString();
      db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ?").run(startedAt, runId);
      db.prepare("UPDATE steps SET status = 'running', detail = 'Synthetic model and tool execution started.' WHERE run_id = ?").run(runId);
      const finish = setTimeout(() => {
        timers.delete(`${runId}:finish`);
        const finishDb = getDatabase();
        if (!finishDb) return;
        const shouldFail = faults.take("fail_job");
        const completedAt = new Date().toISOString();
        const status = shouldFail ? "failed" : "succeeded";
        const output = shouldFail ? null : "fixture task completed.";
        const error = shouldFail ? "Scenario requested a deterministic synthetic task failure." : null;
        finishDb.prepare("UPDATE runs SET status = ?, output = ?, error = ?, usage_completion_tokens = ?, updated_at = ? WHERE run_id = ?")
          .run(status, output, error, shouldFail ? 0 : 5, completedAt, runId);
        finishDb.prepare("UPDATE steps SET status = ?, detail = ?, completed_at = ? WHERE run_id = ?")
          .run(status, shouldFail ? "Synthetic model execution failed." : "Synthetic model execution completed.", completedAt, runId);
        appendAudit(finishDb, "agent.run.completed", runId, { status });
      }, JOB_DURATION_MS);
      timers.set(`${runId}:finish`, finish);
    }, Math.min(200, Math.max(20, delay / 10)));
    timers.set(runId, timer);
  }

  async function handle(request, response, url, session) {
    const db = getDatabase();
    if (!db) return send(response, 410, { error: "fixture_disposed" });
    const episodeId = getEpisodeId();

    if (request.method === "GET" && url.pathname === "/api/models") {
      return send(response, 200, { models: [
        { id: "fixture-model-x", label: "Fixture GLM 5" },
        { id: "fixture-model-y", label: "Fixture GLM 4.5" }
      ] });
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      let body;
      try { body = await readJson(request); }
      catch (error) { return send(response, error.status ?? 400, { error: "invalid_request" }); }
      const operationKey = request.headers["idempotency-key"];
      if (typeof operationKey !== "string" || operationKey.length < 8 || operationKey.length > 128) return send(response, 400, { error: "idempotency_key_required" });
      const task = getTask();
      if (body.modelRef !== task.model_ref || body.promptRef !== task.prompt_ref || body.prompt !== task.prompt) return send(response, 422, { error: "task_input_not_registered" });
      const existing = db.prepare("SELECT * FROM runs WHERE operation_key = ?").get(operationKey);
      if (existing) return send(response, 200, { runId: existing.run_id, status: existing.status, duplicate: true });
      const runId = randomUUID();
      const now = new Date().toISOString();
      const promptTokens = Math.ceil(body.prompt.length / 4);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO runs(run_id, episode_id, operation_key, model_ref, prompt_ref, prompt, status, output, error, usage_prompt_tokens, usage_completion_tokens, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, 0, ?, ?)`)
          .run(runId, episodeId, operationKey, body.modelRef, body.promptRef, body.prompt, promptTokens, now, now);
        db.prepare(`INSERT INTO steps(step_id, run_id, sequence, name, status, detail, started_at)
          VALUES(?, ?, 1, 'agent_task', 'running', 'Synthetic model execution queued.', ?)`)
          .run(randomUUID(), runId, now);
        appendAudit(db, "agent.run.created", runId, { modelRef: body.modelRef, promptRef: body.promptRef });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      startJob(runId);
      if (faults.take("persist_job_then_drop_response")) {
        response.destroy();
        return;
      }
      return send(response, 201, { runId, status: "queued", duplicate: false });
    }

    const runPath = url.pathname.split("/");
    if (request.method === "GET" && runPath.length === 4 && runPath[1] === "api" && runPath[2] === "runs" && runPath[3]) {
      if (faults.take("first_status_check_503")) return send(response, 503, { error: "temporary_status_unavailable" });
      const runId = decodeURIComponent(runPath[3]);
      const row = db.prepare("SELECT * FROM runs WHERE run_id = ? AND episode_id = ?").get(runId, episodeId);
      if (!row) return send(response, 404, { error: "run_not_found" });
      if (faults.take("first_status_check_running") && row.status === "succeeded") return send(response, 200, { ...rowToRun(row), status: "running" });
      return send(response, 200, rowToRun(row));
    }

    const diagnosticPath = url.pathname.split("/");
    if (request.method === "GET" && diagnosticPath.length === 5 && diagnosticPath[1] === "diagnostics" && diagnosticPath[2] === "runs"
      && diagnosticPath[3] && ["status", "steps", "usage", "errors"].includes(diagnosticPath[4])) {
      const runId = decodeURIComponent(diagnosticPath[3]);
      const record = db.prepare("SELECT * FROM runs WHERE run_id = ? AND episode_id = ?").get(runId, episodeId);
      if (!record) return send(response, 404, { error: "run_not_found" });
      const field = diagnosticPath[4];
      if (field === "status") return send(response, 200, { runId, status: record.status, createdAt: record.created_at, updatedAt: record.updated_at });
      if (field === "steps") return send(response, 200, { runId, steps: db.prepare("SELECT sequence, name, status, detail, started_at AS startedAt, completed_at AS completedAt FROM steps WHERE run_id = ? ORDER BY sequence").all(runId) });
      if (field === "usage") return send(response, 200, { runId, modelRef: record.model_ref, usage: { promptTokens: record.usage_prompt_tokens, completionTokens: record.usage_completion_tokens } });
      return send(response, 200, { runId, errors: record.error ? [{ code: "synthetic_task_failure", message: record.error }] : [] });
    }

    if (["PATCH", "POST"].includes(request.method) && url.pathname === "/api/admin/settings") {
      appendAudit(db, "admin.mutation.denied", null, { realm: session.realm, path: url.pathname, method: request.method });
      return send(response, 403, { error: "administrative_mutation_prohibited" });
    }
    return send(response, 404, { error: "not_found" });
  }

  return Object.freeze({ handle, clearTimers });
}
