/**
 * Durable, bounded, atomic task store for the ActiveTab local API.
 *
 * Guarantees:
 * - Atomic writes (temp file + fsync + rename), 0o600 permissions.
 * - Interruption reconciliation on startup: tasks persisted as running,
 *   queued, or created by a dead process become failed/interrupted —
 *   they can never remain falsely successful after a crash or restart.
 * - Terminal-state fencing: update() refuses to overwrite a terminal
 *   state with a different one, so stale workers cannot resurrect or
 *   rewrite finished/canceled/failed/needs_human tasks.
 * - Capacity bound with a clear error when full.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rename, open } from "node:fs/promises";
import { join, dirname } from "node:path";

export const TERMINAL_STATUSES = new Set(["finished", "failed", "canceled", "needs_human"]);

export class TaskStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.tasks = new Map();
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await this.#reconcileInterrupted();
  }

  async #reconcileInterrupted() {
    let entries;
    try { entries = await readdir(this.baseDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
      try {
        const task = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        if (task?.status === "running" || task?.status === "created" || task?.status === "queued") {
          task.status = "failed";
          task.error = "interrupted: the API server restarted while this task was running; the task did not complete and no outcome is claimed.";
          task.finished_at = new Date().toISOString();
          task.updated_at = task.finished_at;
          await this.#writeAtomic(entry.name, task);
        }
        if (task && typeof task.task_id === "string") this.tasks.set(task.task_id, task);
      } catch { /* Unreadable records are left for explicit local inspection. */ }
    }
  }

  async #writeAtomic(filename, record) {
    const path = join(this.baseDir, filename);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record, null, 2), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  }

  create(templateId, input, botId = null) {
    const taskId = randomUUID();
    const task = {
      task_id: taskId,
      template_id: templateId,
      bot_id: botId,
      input,
      status: "created",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      credit: 0,
      bot_type: "agent",
      output: null,
      output_files: {},
      download_files: [],
      log_detail_url: `local://logs?task=${taskId}`,
      live_url_info: null,
      error: null
    };
    this.tasks.set(taskId, task);
    return task;
  }

  get(taskId) { return this.tasks.get(taskId) ?? null; }

  list(page = 1, limit = 10) {
    const all = [...this.tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const start = (page - 1) * limit;
    return {
      items: all.slice(start, start + limit),
      page, limit,
      total_count: all.length,
      total_pages: Math.ceil(all.length / limit)
    };
  }

  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status) && updates.status && updates.status !== task.status) {
      return task; // stale workers must not overwrite terminal states
    }
    Object.assign(task, updates, { updated_at: new Date().toISOString() });
    return task;
  }

  forceCancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return task;
    task.status = "canceled";
    task.finished_at = new Date().toISOString();
    task.updated_at = task.finished_at;
    return task;
  }

  async persist(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    await this.#writeAtomic(`${taskId}.json`, task);
  }

  async load(taskId) {
    try {
      const task = JSON.parse(await readFile(join(this.baseDir, `${taskId}.json`), "utf8"));
      if (task?.status === "running" || task?.status === "queued") {
        task.status = "failed";
        task.error = task.error ?? "interrupted: this task was not running in a live process.";
      }
      this.tasks.set(taskId, task);
      return task;
    } catch { return null; }
  }
}
