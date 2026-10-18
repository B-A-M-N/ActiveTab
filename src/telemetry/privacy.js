/**
 * Structural privacy rules for decision telemetry.
 *
 * This module does not inspect free text for secrets. Callers must project
 * values onto the versioned event schemas before persistence. Codes and
 * evidence references accept only a small ASCII identifier alphabet; nested
 * payloads are validated against exact field sets by decisionEvents.js.
 */
const CODE_CHARACTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-");
const MODEL_CHARACTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:/-");
const OBSERVED_ROLE_CODES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader",
  "combobox", "complementary", "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure",
  "form", "generic", "grid", "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log",
  "main", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter",
  "navigation", "none", "note", "option", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree",
  "treegrid", "treeitem", "unknown"
]);
const OBSERVED_TAG_CODES = new Set([
  "a", "abbr", "article", "aside", "area", "button", "canvas", "details", "dialog", "div", "fieldset", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "iframe", "img", "input", "label", "legend", "li",
  "main", "nav", "ol", "option", "p", "section", "select", "span", "summary", "table", "tbody", "td", "textarea",
  "tfoot", "th", "thead", "tr", "ul", "unknown"
]);

function hasBoundedCharacters(value, allowedCharacters, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  const first = value.charCodeAt(0);
  if (!isAsciiLetterOrDigit(first)) return false;
  for (const character of value) if (!allowedCharacters.has(character)) return false;
  return true;
}

function isAsciiLetterOrDigit(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

export function isSafeTelemetryCode(value, { maxLength = 96 } = {}) {
  return hasBoundedCharacters(value, CODE_CHARACTERS, maxLength);
}

export function isSafeModelId(value, { maxLength = 96 } = {}) {
  return hasBoundedCharacters(value, MODEL_CHARACTERS, maxLength);
}

export function isLowercaseCode(value, { maxLength = 96 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  const first = value.charCodeAt(0);
  if (first < 97 || first > 122) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === "_")) return false;
  }
  return true;
}

export function isSha256Digest(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

export function normalizeObservedRole(value) {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  return OBSERVED_ROLE_CODES.has(role) ? role : "unknown";
}

export function normalizeObservedTag(value) {
  const tag = typeof value === "string" ? value.toLowerCase() : "";
  return OBSERVED_TAG_CODES.has(tag) ? tag : "unknown";
}

export function requireSafeTelemetryCode(value, field, options) {
  if (!isSafeTelemetryCode(value, options)) throw new Error(`Telemetry field '${field}' must be a bounded structural code.`);
  return value;
}

export function isSafeEvidenceRef(value) {
  return isSafeTelemetryCode(value, { maxLength: 128 });
}

export function requireSafeEvidenceRefs(value, field = "evidenceRefs") {
  if (!Array.isArray(value) || value.length > 32 || value.some(ref => !isSafeEvidenceRef(ref))) {
    throw new Error(`Telemetry field '${field}' must contain at most 32 opaque evidence references.`);
  }
  return [...new Set(value)];
}
