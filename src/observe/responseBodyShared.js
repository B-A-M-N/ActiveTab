/** Shared bounds and primitives for response-body interpretation. */
export const REDACTED = "[REDACTED]";
export const SENSITIVE_KEY = /pass(word)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf/i;
export const SENSITIVE_URL_KEY = /(?:pass(word)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf|signature|access.?key)|^(?:code|state|nonce|sig)$/i;
export const MAX_MARKDOWN_ROWS = 100;
export const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BODY_LINES = 20_000;
export const MAX_RESPONSE_BODY_RECORDS = 10_000;
export const MAX_RESPONSE_BODY_COLUMNS = 256;
export const MAX_RESPONSE_JSON_DEPTH = 64;
export const MAX_RESPONSE_JSON_TOKENS = 100_000;
export const MAX_RESPONSE_NORMALIZED_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_MARKDOWN_BYTES = 8 * 1024 * 1024;
export const JSON_LIKE_START = new RegExp("^\\s*(?:\\uFEFF|\\)\\]\\]',?\\s*)?(?:[\\[{]|\\x60\\x60\\x60(?:json|js|javascript)?\\s*[\\[{]|[\\w$.]+\\s*\\(\\s*[\\[{])", "i");
export function safeJsonWrite(parent, key, value) {
  Object.defineProperty(parent, key, { value, writable: true, configurable: true, enumerable: true });
}

export function lineCount(text) {
  let count = 1;
  for (const _match of text.matchAll(/\r\n|\r|\n/g)) count++;
  return count;
}

export function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function isSensitiveField(key, value) {
  if (/^(?:auth|authentication)$/i.test(String(key))) {
    if (value && typeof value === "object" && !Array.isArray(value)) return false;
    if (typeof value === "string" && /^[\[{]/.test(value.trim())) return false;
    return true;
  }
  return SENSITIVE_KEY.test(String(key));
}

export function jsonPathKey(path, key) {
  const name = String(key);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

export function extractBalancedValue(source) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character !== "{" && character !== "[") continue;
    const start = index;
    const stack = [character];
    quote = null;
    escaped = false;
    for (let cursor = index + 1; cursor < source.length; cursor++) {
      const current = source[cursor];
      if (quote) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === '"' || current === "'") { quote = current; continue; }
      if (current === "{" || current === "[") stack.push(current);
      else if (current === "}" || current === "]") {
        const open = stack.pop();
        if ((open === "{" && current !== "}") || (open === "[" && current !== "]")) break;
        if (stack.length === 0) return source.slice(start, cursor + 1);
      }
    }
    return null;
  }
  return null;
}
