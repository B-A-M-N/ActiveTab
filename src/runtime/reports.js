/**
 * Run reporting for ActiveTab.
 *
 * Every run produces a bounded, evidence-linked report trail: what was
 * requested, which executor handled it, how long each phase took, and the
 * terminal classification. Reports never contain raw goals, raw inputs,
 * credentials, or browser evidence payloads — only references.
 */
import { logger, bound } from "./logger.js";

/** Per-run timers and counters; return `report()` to emit the summary. */
export function runReporter({ taskId, executor, kind }) {
  const startedAt = Date.now();
  const phases = [];
  const counters = {};
  let markedTerminal = null;

  const phase = name => {
    const t0 = Date.now();
    return {
      name,
      end(fields) {
        phases.push({ name, ms: Date.now() - t0, ...(fields ?? {}) });
      }
    };
  };
  const count = (name, by = 1) => { counters[name] = (counters[name] ?? 0) + by; };
  const markTerminal = (status, reason) => { markedTerminal = { status, reason: reason ? bound(reason, 200) : null }; };

  const report = () => {
    const summary = {
      task_id: taskId ?? null,
      kind: kind ?? "run",
      executor: executor ?? "local",
      total_ms: Date.now() - startedAt,
      phases: phases.map(p => ({ ...p, ms: Number(p.ms) })),
      counters,
      terminal: markedTerminal
    };
    logger.info("run.report", {
      task: taskId ?? "-",
      kind: summary.kind,
      executor: summary.executor,
      total_ms: summary.total_ms,
      terminal: markedTerminal?.status ?? "unknown",
      phases: phases.length
    });
    if (markedTerminal && markedTerminal.status !== "finished" && markedTerminal.status !== "succeeded") {
      logger.warn("run.terminal.non-success", {
        task: taskId ?? "-",
        terminal: markedTerminal.status,
        reason: markedTerminal.reason ?? "-"
      });
    }
    return summary;
  };

  return { phase, count, markTerminal, report };
}
