/**
 * Structured logging for ActiveTab.
 *
 * Design goals: zero dependencies, machine-parseable output, privacy by
 * default. Sensitive values (goals, inputs, tokens, URLs with query data)
 * are never logged; events carry bounded metadata only. The log level is
 * controlled by ACTIVETAB_LOG_LEVEL (debug | info | warn | error; default
 * info) and ACTIVETAB_LOG_JSON=1 selects newline-delimited JSON output.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[(process.env.ACTIVETAB_LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
const asJson = process.env.ACTIVETAB_LOG_JSON === "1";

function write(level, event, fields) {
  if (LEVELS[level] < configuredLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    event: String(event).slice(0, 96),
    ...(fields && typeof fields === "object" ? fields : {})
  };
  const line = asJson ? JSON.stringify(entry) : formatLine(entry);
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

function formatLine(entry) {
  const { ts, level, event, ...rest } = entry;
  const extras = Object.keys(rest).length
    ? " " + Object.entries(rest).map(([k, v]) => `${k}=${formatValue(v)}`).join(" ")
    : "";
  return `${ts} ${level.toUpperCase().padEnd(5)} ${event}${extras}`;
}

function formatValue(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  return /\s/.test(s) ? JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s) : s;
}

/** Bound a string for log fields so a stray goal/error can never flood the log. */
export function bound(value, max = 160) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export const logger = {
  debug: (event, fields) => write("debug", event, fields),
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields)
};
