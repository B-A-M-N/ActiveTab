/**
 * Runtime diagnostics for ActiveTab.
 *
 * Aggregates counters and recent events in-process (no external state) and
 * renders them for /health and reporting. Privacy: only bounded, non-
 * sensitive metadata is counted — never goals, inputs, credentials, or
 * evidence payloads.
 */
import { logger, bound } from "./logger.js";

const MAX_EVENTS = 200;

export function createDiagnostics() {
  const counters = new Map();
  const events = [];
  let startedAt = Date.now();

  const bump = (name, by = 1) => counters.set(name, (counters.get(name) ?? 0) + by);
  const record = (type, fields) => {
    events.push({ ts: new Date().toISOString(), type: String(type).slice(0, 64), ...fields });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  const httpLogger = (req, res, startedAtMs) => {
    const ms = Date.now() - startedAtMs;
    const status = res.statusCode;
    bump(`http.${req.method}`);
    bump(`http.${status}`);
    bump("http.total");
    // Requests carry no goal/input data; only the route shape and outcome.
    const pathShape = String(req.url ?? "/").split("?")[0].replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/:id");
    record("http", { method: req.method, path: pathShape.slice(0, 64), status, ms });
    logger.debug("http.request", { method: req.method, path: pathShape.slice(0, 64), status, ms });
  };

  return {
    bump,
    record,
    httpLogger,
    uptimeMs: () => Date.now() - startedAt,
    snapshot() {
      return {
        uptime_ms: Date.now() - startedAt,
        counters: Object.fromEntries(counters),
        recent_events: events.slice(-20)
      };
    }
  };
}
