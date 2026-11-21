/**
 * Durable, bounded, atomic task store for the ActiveTab local API.
 *
 * Guarantees:
 * - Atomic writes (temp file + fsync + rename), 0o600 permissions.
 * - Interruption reconciliation on startup: tasks persisted as running,
 *   queued, or created by a dead process become reconciling — a lost worker
 *   is not evidence that a remote operation failed or never happened.
 * - Terminal-state fencing: update() refuses to overwrite a terminal
 *   state with a different one, so stale workers cannot resurrect or
 *   rewrite finished/canceled/failed tasks.
 * - Human-handoff and reconciliation states (needs_human, waiting_*, and
 *   reconciling) remain resumable suspensions rather than terminal results.
 * - Capacity bound with a clear error when full.
 * - One API writer per canonical task directory, enforced by a process-held
 *   SQLite transaction that the OS releases on exit or crash.
 * - Durable peer idempotency reservations are persisted before worker start.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile, readFile, readdir, rename, open, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectInput } from "./input-projection.js";
import { findTemplate } from "./templates.js";

export const TERMINAL_STATUSES = new Set(["finished", "failed", "canceled"]);

/** Resumable suspension states (P0-3); these are never terminal. */
export const SUSPENDED_STATUSES = new Set([
  "needs_human",
  "waiting_for_tab_authorization", "waiting_for_authentication", "waiting_for_mfa",
  "waiting_for_human_approval", "waiting_for_external_authorization",
  "waiting_for_human_decision", "resume_validation", "reconciling"
]);

export class TaskStore {
  constructor(baseDir, { maxRecords = 1_000 } = {}) {
    this.baseDir = baseDir;
    this.maxRecords = Number.isInteger(maxRecords) && maxRecords >= 1
      ? Math.min(maxRecords, 10_000)
      : 1_000;
    this.tasks = new Map();
    this.peerReservations = new Map();
    this.writerLockDatabase = null;
    this.writerLockTransaction = false;
  }

  async init() {
    if (this.writerLockTransaction) return;
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const canonicalBaseDir = await realpath(this.baseDir);
    await chmod(canonicalBaseDir, 0o700);
    const lockPath = join(canonicalBaseDir, ".api-writer-lock.sqlite");
    const lockFile = await open(lockPath, "a", 0o600);
    await lockFile.chmod(0o600);
    await lockFile.close();
    const lockDatabase = new DatabaseSync(lockPath);
    try {
      lockDatabase.exec("PRAGMA busy_timeout = 500");
      lockDatabase.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      lockDatabase.close();
      if (/database is (?:locked|busy)/i.test(String(cause?.message ?? cause))) {
        throw Object.assign(new Error("Another API process already owns this task directory."), {
          code: "TASK_STORE_WRITER_HELD",
          cause
        });
      }
      throw cause;
    }
    this.writerLockDatabase = lockDatabase;
    this.writerLockTransaction = true;
    try {
      await this.#reconcileInterrupted();
      await this.#loadPeerReservations();
      await this.#reconcileOrphanPeerReservations();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    const database = this.writerLockDatabase;
    this.writerLockDatabase = null;
    if (!database) return;
    if (this.writerLockTransaction) {
      try { database.exec("ROLLBACK"); } catch { /* closing also releases a failed transaction */ }
    }
    this.writerLockTransaction = false;
    database.close();
  }

  async #reconcileInterrupted() {
    let entries;
    try { entries = await readdir(this.baseDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
      try {
        const task = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        let changed = false;
        const projectedInput = projectInput(task?.input, findTemplate(task?.template_id)?.input_schema);
        if (JSON.stringify(projectedInput) !== JSON.stringify(task?.input)) {
          task.input = projectedInput;
          changed = true;
        }
        if (task?.status === "running" || task?.status === "created" || task?.status === "queued" || task?.status === "cancel_requested") {
          task.status = "reconciling";
          task.error = task.cancellation_requested === true
            ? "interrupted: cancellation was requested, but the worker did not settle before the API server restarted; its remote outcome must be reconciled before retry or completion."
            : "interrupted: the API server restarted while this task was running; its remote outcome must be reconciled before retry or completion.";
          task.updated_at = new Date().toISOString();
          changed = true;
        }
        // Suspended (human-blocked) runs survive restarts: they are reloaded
        // for intervention re-evaluation, never auto-failed (P0-3/P1-4).
        if (task && typeof task.task_id === "string") {
          this.tasks.set(task.task_id, task);
          if (changed) await this.#writeAtomic(entry.name, task);
        }
      } catch { /* Unreadable records are left for explicit local inspection. */ }
    }
  }

  async #loadPeerReservations() {
    const directory = join(this.baseDir, "peer-idempotency");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
      const namespaceDigest = entry.name.slice(0, -5);
      try {
        const record = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
        if (record?.version !== 1
          || record.namespaceDigest !== namespaceDigest
          || !/^[0-9a-f]{64}$/.test(record.principalDigest ?? "")
          || !/^[0-9a-f]{64}$/.test(record.fingerprint ?? "")
          || !/^[0-9a-f-]{36}$/.test(record.taskId ?? "")
          || typeof record.createdAt !== "string") {
          this.peerReservations.set(namespaceDigest, { corrupt: true, fingerprint: null, taskId: null, persisting: null });
          continue;
        }
        this.peerReservations.set(record.namespaceDigest, {
          record,
          taskId: record.taskId,
          fingerprint: record.fingerprint,
          persisting: null
        });
      } catch {
        this.peerReservations.set(namespaceDigest, { corrupt: true, fingerprint: null, taskId: null, persisting: null });
      }
    }
  }

  async #reconcileOrphanPeerReservations() {
    for (const entry of this.peerReservations.values()) {
      if (entry.corrupt) continue; // The matching key fails closed when retried; no task identity can be trusted here.
      if (this.tasks.has(entry.taskId)) continue;
      const now = new Date().toISOString();
      this.tasks.set(entry.taskId, {
        task_id: entry.taskId,
        template_id: "remote-peer-run",
        bot_id: null,
        input: {},
        status: "reconciling",
        created_at: entry.record.createdAt,
        updated_at: now,
        credit: 0,
        bot_type: "agent",
        output: null,
        output_files: {},
        download_files: [],
        log_detail_url: `local://logs?task=${entry.taskId}`,
        live_url_info: null,
        error: "A durable peer idempotency reservation has no readable task record; the original outcome is unresolved and will not be replayed."
      });
      await this.persist(entry.taskId);
    }
  }

  /**
   * Reserve a peer task under the single API writer lock. The caller supplies
   * a verified principal, caller-owned key, and digest of the canonical
   * execution request. Only digests and the task identity are persisted.
   */
  reservePeerTask({ principalId, idempotencyKey, fingerprint, input = {}, botId = null } = {}) {
    if (!this.writerLockTransaction) {
      throw Object.assign(new Error("TaskStore must hold its API writer lock before admitting peer runs."), {
        code: "TASK_STORE_WRITER_NOT_HELD"
      });
    }
    if (typeof principalId !== "string" || !principalId
      || typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)
      || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw Object.assign(new Error("A bounded peer identity, idempotency key, and request fingerprint are required."), {
        code: "TASK_STORE_IDEMPOTENCY_INVALID"
      });
    }
    const principalDigest = createHash("sha256").update(principalId).digest("hex");
    const namespaceDigest = createHash("sha256").update(`${principalDigest}\0${idempotencyKey}`).digest("hex");
    let entry = this.peerReservations.get(namespaceDigest);
    if (entry) {
      if (entry.corrupt) {
        throw Object.assign(new Error("The durable peer reservation is corrupt; its outcome must be reconciled before retry."), {
          code: "TASK_STORE_IDEMPOTENCY_UNRESOLVED"
        });
      }
      if (entry.fingerprint !== fingerprint) {
        throw Object.assign(new Error("Idempotency-Key was already used for a different peer request."), {
          code: "TASK_STORE_IDEMPOTENCY_CONFLICT"
        });
      }
      return {
        created: false,
        task: this.tasks.get(entry.taskId) ?? null,
        taskId: entry.taskId,
        persisted: this.#ensurePeerReservationPersisted(entry)
      };
    }

    const task = this.create("remote-peer-run", input, botId);
    const record = {
      version: 1,
      namespaceDigest,
      principalDigest,
      fingerprint,
      taskId: task.task_id,
      createdAt: task.created_at
    };
    entry = { record, taskId: task.task_id, fingerprint, persisting: null };
    this.peerReservations.set(namespaceDigest, entry);
    return {
      created: true,
      task,
      taskId: task.task_id,
      persisted: this.#ensurePeerReservationPersisted(entry)
    };
  }

  #ensurePeerReservationPersisted(entry) {
    if (entry.persisting) return entry.persisting;
    entry.persisting = (async () => {
      const directory = join(this.baseDir, "peer-idempotency");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await this.#writeAtomic(join("peer-idempotency", `${entry.record.namespaceDigest}.json`), entry.record);
      await this.persist(entry.taskId);
    })().catch(error => {
      entry.persisting = null;
      throw error;
    });
    return entry.persisting;
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

  create(templateId, input, botId = null, inputSchema = findTemplate(templateId)?.input_schema) {
    if (this.tasks.size >= this.maxRecords) {
      throw Object.assign(new Error(`Task storage is full (${this.maxRecords} records).`), {
        code: "TASK_STORE_FULL"
      });
    }
    const taskId = randomUUID();
    const task = {
      task_id: taskId,
      template_id: templateId,
      bot_id: botId,
      input: projectInput(input, inputSchema),
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
    if (TERMINAL_STATUSES.has(task.status)) {
      return task; // terminal receipts, output, and metadata are immutable
    }
    Object.assign(task, updates, { updated_at: new Date().toISOString() });
    return task;
  }

  forceCancel(taskId, { notDispatched = false } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return task;
    const now = new Date().toISOString();
    task.cancellation_requested = true;
    task.cancellation_requested_at ??= now;
    if (notDispatched) {
      task.status = "canceled";
      task.finished_at = now;
      task.error = "Canceled before dispatch; no browser or peer operation was sent.";
    } else {
      task.status = "reconciling";
      task.error = "Cancellation was requested, but the operation outcome is unknown and must be reconciled before retry.";
      delete task.finished_at;
    }
    task.updated_at = now;
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
      let changed = false;
      const projectedInput = projectInput(task?.input, findTemplate(task?.template_id)?.input_schema);
      if (JSON.stringify(projectedInput) !== JSON.stringify(task?.input)) {
        task.input = projectedInput;
        changed = true;
      }
      if (["running", "queued", "created", "cancel_requested"].includes(task?.status)) {
        task.status = "reconciling";
        task.error = task.cancellation_requested === true
          ? "interrupted: cancellation was requested, but no live worker can confirm the outcome; reconcile before retry."
          : task.error ?? "interrupted: this task was not running in a live process; its outcome must be reconciled.";
        changed = true;
      }
      if (changed) await this.#writeAtomic(`${taskId}.json`, task);
      this.tasks.set(taskId, task);
      return task;
    } catch { return null; }
  }
}
