/**
 * Cloud Agent entry and read-only discovery contracts.
 *
 * The profile's Cloud Agent URL is an identity hint only. Navigation is
 * assembled from current visible page evidence, and diagnostic destinations
 * are inventoried without opening them.
 */

import { verifyObservedUrl } from "../environments/model.js";

const DIAGNOSTIC_SURFACE_HINTS = new Set([
  "admin", "diagnostic", "diagnostics", "log", "logs", "history", "request", "requests", "activity", "event", "events",
  "audit", "analytics", "usage", "metric", "metrics", "trace", "traces", "monitor", "monitoring", "observability",
  "execution", "executions", "run", "runs", "report", "reports", "error", "errors", "failure", "failures", "worker", "workers", "queue", "queues"
]);
const TASK_HISTORY_TERMS = new Set(["history", "recent", "past", "completed", "failed", "run", "runs"]);
const SAFE_SURFACE_TERMS = new Set([
  ...DIAGNOSTIC_SURFACE_HINTS, "console", "dashboard", "task", "tasks", "job", "jobs", "recent", "completed", "failed", "view", "page", "panel"
]);

function isAsciiLetterOrDigit(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function structuralTokens(value) {
  const tokens = [];
  let word = "";
  const flush = () => {
    if (!word) return;
    tokens.push({ value: word, normalized: word.toLowerCase() });
    word = "";
  };
  for (const character of String(value ?? "").normalize("NFKC")) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && isAsciiLetterOrDigit(code)) word += character;
    else flush();
  }
  flush();
  return tokens;
}

function structuralWords(value) {
  return structuralTokens(value).map(token => token.normalized);
}

function compactLabel(value, maxLength = 120) {
  let result = "";
  let pendingSpace = false;
  for (const character of String(value ?? "").normalize("NFKC")) {
    if (character.trim() === "") {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    result += character;
    pendingSpace = false;
    if (result.length >= maxLength) break;
  }
  return result.slice(0, maxLength);
}

function hasAnyWord(words, allowed) {
  return words.some(word => allowed.has(word));
}

function looksLikeUuid(value) {
  if (value.length !== 36 || value[8] !== "-" || value[13] !== "-" || value[18] !== "-" || value[23] !== "-") return false;
  for (let index = 0; index < value.length; index++) {
    if ([8, 13, 18, 23].includes(index)) continue;
    const code = value.charCodeAt(index);
    const isHex = (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (!isHex) return false;
  }
  return true;
}

function isLongNumericSegment(value) {
  if (value.length < 4) return false;
  for (const character of value) if (character < "0" || character > "9") return false;
  return true;
}

function redactPath(pathname) {
  return pathname.split("/").map(segment => {
    if (!segment) return segment;
    if (looksLikeUuid(segment) || isLongNumericSegment(segment) || segment.length > 64) return ":id";
    return segment;
  }).join("/");
}

/**
 * Inventory visible, relevant links from the current page. This is an
 * operator discovery hint: it never opens a link or reads its target.
 */
export function discoverVisibleDiagnosticSurfaces(observation, environment) {
  const allowedOrigins = new Set(environment?.authorizedOrigins ?? []);
  const seen = new Set();
  const surfaces = [];
  for (const candidate of observation?.candidates ?? []) {
    if (candidate.visible !== true || (!candidate.href && String(candidate.role).toLowerCase() !== "link")) continue;
    const label = compactLabel(candidate.name);
    const labelTokens = structuralTokens(label);
    const labelWords = labelTokens.map(token => token.normalized);
    let destination = null;
    let pathname = "";
    if (candidate.href) {
      try {
        const url = new URL(candidate.href, observation?.page?.url);
        if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) continue;
        pathname = url.pathname;
        destination = `${url.origin}${redactPath(pathname)}`;
      } catch { continue; }
    }
    const pathWords = structuralWords(pathname);
    const taskHistoryLabel = hasAnyWord(labelWords, new Set(["task", "tasks", "job", "jobs"])) && hasAnyWord(labelWords, TASK_HISTORY_TERMS);
    if (!label || (!hasAnyWord(labelWords, DIAGNOSTIC_SURFACE_HINTS) && !hasAnyWord(pathWords, DIAGNOSTIC_SURFACE_HINTS) && !taskHistoryLabel)) continue;
    const safeTerms = labelTokens.filter(token => SAFE_SURFACE_TERMS.has(token.normalized)).map(token => token.value);
    const safePathTerms = structuralTokens(pathname).filter(token => SAFE_SURFACE_TERMS.has(token.normalized)).map(token => token.value);
    const reportedLabel = (safeTerms.length ? safeTerms : safePathTerms).join(" ").slice(0, 120);
    const key = `${label.toLowerCase()}|${destination ?? "no-href"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let sourceOrigin = null;
    let sourcePage = null;
    try {
      const sourceUrl = new URL(observation?.page?.url);
      sourceOrigin = sourceUrl.origin;
      sourcePage = `${sourceUrl.origin}${redactPath(sourceUrl.pathname)}`;
    } catch { /* keep source unknown */ }
    surfaces.push({
      sourceOrigin,
      sourcePage,
      label: reportedLabel || "diagnostic candidate",
      role: String(candidate.role ?? "link").slice(0, 32),
      destination,
      category: hasAnyWord([...labelWords, ...pathWords], new Set(["admin"])) ? "admin-entry" : "diagnostic-candidate",
      action: "not opened"
    });
    if (surfaces.length >= 20) break;
  }
  return surfaces;
}

/** Return a profile identity hint. This URL is never used as a navigation target. */
export function resolveCloudAgentEntry(environment) {
  const app = (environment?.applications ?? []).find(item => item.applicationId === "fi-agents");
  if (!app?.candidateEntry) return null;
  let url;
  try { url = new URL(app.candidateEntry, environment.applicationEntryUrl); }
  catch { throw new Error("The profile's Cloud Agent entry is not a valid URL."); }
  const identity = verifyObservedUrl(environment, url.href);
  if (!identity.ok) throw new Error(`The profile's Cloud Agent entry is not authorized: ${identity.reason}`);
  return { url: url.href, origin: url.origin, applicationId: app.applicationId, authenticationRealm: app.authenticationRealm ?? "agents-session" };
}

/** The actual Agent destination must be reached through the staging UI. */
export function verifyCloudAgentReady(observation, environment, expectedOrigin) {
  const url = observation?.page?.url;
  const identity = verifyObservedUrl(environment, url);
  if (!identity.ok) return { ok: false, reason: identity.reason ?? "Observed URL is outside the authorized staging environment." };
  if (expectedOrigin && identity.origin !== expectedOrigin) {
    return { ok: false, reason: `Observed application origin '${identity.origin}' does not match the profile's Cloud Agent identity hint.` };
  }
  const titleWords = structuralWords(observation?.page?.title);
  if (!titleWords.includes("agent") && !titleWords.includes("agents")) {
    return { ok: false, reason: "The observed page title does not identify the Cloud Agent application." };
  }
  if (!hasCloudAgentTaskComposer(observation)) {
    return { ok: false, reason: "The protected Cloud Agent task composer is not visible yet." };
  }
  return { ok: true, origin: identity.origin, evidenceId: observation.evidenceId ?? null };
}

/** Positive UI evidence that the protected task application, not its login page, is ready. */
export function hasCloudAgentTaskComposer(observation) {
  const candidates = observation?.candidates ?? [];
  const hasNewTaskControl = candidates.some(candidate => {
    if (candidate.visible === false) return false;
    const words = structuralWords(candidate.name);
    return words.some((word, index) => word === "new" && words[index + 1] === "task");
  });
  const hasTaskInput = candidates.some(candidate =>
    candidate.visible !== false && candidate.disabled !== true &&
    String(candidate.role ?? "").toLowerCase() === "textbox"
  );
  return hasNewTaskControl && hasTaskInput;
}

/** Build a workflow that follows visible UI navigation and never auto-navigates to candidate_entry. */
export function createCloudAgentEntryWorkflow(environment, observation, { forceEntryStep = false } = {}) {
  const agentEntry = resolveCloudAgentEntry(environment);
  if (!agentEntry) return null;
  const alreadyAtComposer = verifyCloudAgentReady(observation, environment, agentEntry.origin).ok;
  const steps = [];
  if (!alreadyAtComposer || forceEntryStep) {
    steps.push({
      type: "goal",
      id: "follow-visible-agents-route",
      goal: "Follow the visible Cloud Agents link from the current FreeInference staging page, complete the visible Agent login link if required, and reach the Cloud Agent task composer",
      intervention: {
        type: "authentication",
        realm: agentEntry.authenticationRealm,
        requiredAction: "In the open browser, finish the current login if needed, return to the staging page, click its visible Cloud Agents link, then click the Agent page's visible login link. Stop when the Cloud Agent task composer is visible.",
        condition: { type: "authenticated_session_check", realm: agentEntry.authenticationRealm }
      }
    });
  }
  steps.push({
    id: "verify-task-composer",
    type: "assert",
    assertion: { type: "candidate_name_contains", value: "new task" }
  });
  return {
    agentEntry,
    alreadyAtComposer,
    workflow: {
      id: "cloud-agent-enter-agents",
      name: "Follow staging navigation and verify the Cloud Agent task composer",
      steps
    }
  };
}
