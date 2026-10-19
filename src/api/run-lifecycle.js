/**
 * Run lifecycle manager for the ActiveTab local API.
 *
 * Owns the mapping of in-flight task ids to their abort controllers and
 * worker promises, plus the terminal-state translation shared by the
 * local template/bot run path and the LAN peer-execution path.
 *
 * Stale-worker fencing: a worker may only write results while it still
 * holds the controller entry for its task; cancel replaces nothing, but
 * forceCancel marks the task terminal so later writes are rejected.
 */
import { runReporter } from "../runtime/reports.js";
import { logger, bound } from "../runtime/logger.js";

export class RunLifecycle {
  constructor({ store, navigationRunner, reportDir, executorName }) {
    this.store = store;
    this.navigationRunner = navigationRunner;
    this.running = new Map(); // task_id → { controller, worker, reporter }
    this.reportDir = reportDir ?? null;
    this.executorName = executorName ?? "local";
  }

  get executorReady() { return typeof this.navigationRunner?.run === "function"; }

  isCurrent(taskId, controller) {
    return this.running.get(taskId)?.controller === controller;
  }

  /**
   * Translate an executor result into a distinct task state.
   * verified success → finished; handoff → needs_human (a resumable
   * suspension, not a terminal failure); explicit waiting states map to
   * their resumable vocabulary; cancellation → canceled; everything else →
   * failed. Never collapses these.
   */
  applyResult(taskId, controller, result, reporter) {
    if (!this.isCurrent(taskId, controller) || controller.signal.aborted) return;
    if (result.status === "canceled") {
      reporter?.markTerminal("canceled", result.output?.reason);
      this.store.forceCancel(taskId);
      return;
    }
    const WAITING_STATES = new Set([
      "waiting_for_tab_authorization", "waiting_for_authentication", "waiting_for_mfa",
      "waiting_for_human_approval", "waiting_for_external_authorization",
      "waiting_for_human_decision", "resume_validation", "reconciling"
    ]);
    const status = result.status === "succeeded" ? "finished"
      : result.status === "needs_human" ? "needs_human"
      : WAITING_STATES.has(result.status) ? result.status
      : "failed";
    // The report records the same translated terminal state the store
    // exposes, so readers see one consistent vocabulary.
    reporter?.markTerminal(status, result.output?.reason);
    this.store.update(taskId, {
      status,
      output: result.output ?? null,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(typeof result.credit === "number" ? { credit: result.credit } : {}),
      finished_at: new Date().toISOString(),
      output_files: result.output_files ?? {},
      live_url_info: result.live_url_info ?? null,
      ...(status === "needs_human" && result.output?.reason ? { error: result.output.reason } : {})
    });
  }

  applyFailure(taskId, controller, error, reporter, { prefix = "" } = {}) {
    if (!this.isCurrent(taskId, controller) || controller.signal.aborted) return;
    const message = `${prefix}${String(error?.message ?? error).slice(0, 500)}`;
    reporter?.markTerminal("failed", message);
    logger.error("run.failed", { task: taskId, executor: this.executorName, reason: bound(message, 160) });
    this.store.update(taskId, {
      status: "failed",
      error: message,
      finished_at: new Date().toISOString()
    });
  }

  /**
   * Start a run worker. `execute(controller)` performs the actual
   * navigation-runner call; this method handles state transitions,
   * fencing, and cleanup. Returns { controller, worker }.
   */
  start(taskId, execute, { kind } = {}) {
    const controller = new AbortController();
    const reporter = runReporter({ taskId, executor: this.executorName, kind });
    logger.info("run.started", { task: taskId, executor: this.executorName, kind: kind ?? "run" });
    // Insert the entry before creating the worker: the worker's first
    // isCurrent() check must already see its own registration.
    const entry = { controller, worker: null, reporter };
    this.running.set(taskId, entry);
    entry.worker = (async () => {
      if (!this.isCurrent(taskId, controller) || controller.signal.aborted) {
        reporter.markTerminal("canceled", "aborted before dispatch");
        await this.#emitReport(taskId, reporter);
        return;
      }
      this.store.update(taskId, { status: "running" });
      await this.store.persist(taskId);
      const executePhase = reporter.phase("execute");
      try {
        const result = await execute(controller);
        executePhase.end({ status: result?.status ?? "unknown" });
        this.applyResult(taskId, controller, result, reporter);
      } catch (error) {
        executePhase.end({ error: bound(error?.message ?? error, 120) });
        this.applyFailure(taskId, controller, error, reporter);
      } finally {
        // Persist the run report before the terminal task state becomes
        // durable: readers that observe a finished/failed run must be
        // able to read its report.
        await this.#emitReport(taskId, reporter);
        if (this.isCurrent(taskId, controller)) {
          // stopAll() drains this map, so retain the worker until its final
          // atomic journal write settles.
          try {
            await this.store.persist(taskId);
          } finally {
            if (this.isCurrent(taskId, controller)) this.running.delete(taskId);
          }
        }
      }
    })();
    return { controller, worker: entry.worker };
  }

  async #emitReport(taskId, reporter) {
    const summary = reporter.report();
    if (!this.reportDir) return;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(this.reportDir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.reportDir, `${taskId}.report.json`), JSON.stringify(summary, null, 2), { mode: 0o600 });
    } catch (error) {
      logger.warn("report.persist.failed", { task: taskId, reason: bound(error?.message ?? error, 120) });
    }
  }

  cancel(taskId) {
    const entry = this.running.get(taskId);
    if (entry) entry.controller.abort();
    this.store.forceCancel(taskId);
    entry?.reporter?.markTerminal("canceled", "canceled by API request");
    logger.info("run.canceled", { task: taskId });
  }

  async stopAll() {
    for (const entry of this.running.values()) entry.controller.abort();
    await Promise.allSettled([...this.running.values()].map(entry => entry.worker));
  }
}
