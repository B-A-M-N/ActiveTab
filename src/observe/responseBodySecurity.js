/** Credential discovery, safe metadata, and redaction for selected bodies. */
import { REDACTED, SENSITIVE_URL_KEY, safeJsonWrite, lineCount, valueType, isSensitiveField, jsonPathKey, extractBalancedValue } from "./responseBodyShared.js";
export const MAX_CREDENTIAL_DETAILS = 256;
const CREDENTIAL_TEXT_HINT = /pass(word)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf|(?:^|[^A-Za-z])auth(?:entication)?(?:[^A-Za-z]|$)|\b(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:eyJ|AKIA|github_pat|glpat|xox[baprs]|AIza|sk-|rk-|gh[pousr]_)/i;
export function credentialKind(key = "") {
  const name = String(key).toLocaleLowerCase().replaceAll("-", "_");
  if (/pass(word|wd|phrase)?/.test(name)) return "password";
  if (/refresh.?token/.test(name)) return "refresh_token";
  if (/access.?token/.test(name)) return "access_token";
  if (/id.?token/.test(name)) return "identity_token";
  if (/cookie|set_cookie/.test(name)) return "cookie";
  if (/authorization|bearer|auth/.test(name)) return "authorization";
  if (/api.?key/.test(name)) return "api_key";
  if (/private.?key/.test(name)) return "private_key";
  if (/csrf|xsrf/.test(name)) return "request_forgery_token";
  if (/session/.test(name)) return "session_credential";
  return "secret";
}

export function credentialFormat(value) {
  if (typeof value !== "string") return "structured";
  const token = value.replace(/^(?:Bearer|Basic)\s+/i, "");
  const segments = token.split(".");
  if (segments.length === 3 && segments.every(segment => /^[A-Za-z0-9_-]+$/.test(segment))) return "jwt";
  if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(token)) return "private_key_pem";
  if (/^[0-9a-f]+$/i.test(token) && token.length >= 32 && token.length % 2 === 0) return "hex";
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(token) && token.length >= 24) return "base64_or_token";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return "uuid";
  return "opaque";
}

export function jwtStructure(value) {
  if (typeof value !== "string") return undefined;
  const token = value.replace(/^Bearer\s+/i, "");
  const [encodedHeader, encodedPayload, signature, extra] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature || extra !== undefined) return undefined;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return undefined;
    const claimEntries = Object.entries(payload);
    const claimNames = Object.keys(payload).sort();
    return {
      algorithm: typeof header.alg === "string" ? header.alg.slice(0, 32) : null,
      tokenType: typeof header.typ === "string" ? header.typ.slice(0, 32) : null,
      claimNames: claimNames.slice(0, 64),
      claimNamesOmitted: Math.max(0, claimNames.length - 64),
      claimTypes: Object.fromEntries(claimEntries.slice(0, 64).map(([name, claim]) => [name.slice(0, 80), valueType(claim)])),
      claimTypesOmitted: Math.max(0, claimEntries.length - 64)
    };
  } catch { return undefined; }
}

export function credentialDetail({ key, value, path, source = "structured_field" }) {
  const detail = {
    path: String(path ?? "$").slice(0, 512),
    field: typeof key === "string" ? key.slice(0, 96) : null,
    kind: credentialKind(key),
    valueType: valueType(value),
    source
  };
  if (typeof value === "string") {
    const normalized = value.replace(/^(?:Bearer|Basic)\s+/i, "");
    detail.characterLength = [...value].length;
    detail.byteLength = Buffer.byteLength(value);
    detail.format = credentialFormat(value);
    detail.characterClasses = {
      lowercase: /[a-z]/.test(normalized),
      uppercase: /[A-Z]/.test(normalized),
      digits: /[0-9]/.test(normalized),
      symbols: /[^A-Za-z0-9]/.test(normalized)
    };
    const jwt = jwtStructure(value);
    if (jwt) detail.jwt = jwt;
  } else if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    detail.itemCount = entries.length;
    detail.memberShape = entries.slice(0, 32).map(([name, item]) => ({ name: String(name).slice(0, 80), type: valueType(item) }));
    if (entries.length > 32) detail.memberShapeOmitted = entries.length - 32;
    detail.format = "structured";
  } else detail.format = "scalar";
  return detail;
}

export function credentialDetailsFor(text, parsedValue) {
  const details = [];
  let detailsMayBeIncomplete = false;
  if (parsedValue !== undefined) {
    const stack = [{ value: parsedValue, path: "$", key: null }];
    while (stack.length && details.length < MAX_CREDENTIAL_DETAILS) {
      const current = stack.pop();
      if (current.key !== null && isSensitiveField(current.key, current.value)) {
        details.push(credentialDetail(current));
        continue;
      }
      if (!current.value || typeof current.value !== "object") continue;
      const entries = Array.isArray(current.value) ? current.value.map((value, index) => [String(index), value]) : Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index];
        stack.push({ value, key, path: Array.isArray(current.value) ? `${current.path}[${key}]` : jsonPathKey(current.path, String(key).slice(0, 96)) });
      }
    }
    detailsMayBeIncomplete = details.length >= MAX_CREDENTIAL_DETAILS && stack.length > 0;
  } else if (CREDENTIAL_TEXT_HINT.test(text)) {
    const assignment = /(?:"((?:\\.|[^"\\]){1,160})"|'((?:\\.|[^'\\]){1,160})'|([A-Za-z_$][\w$.-]{0,159}))\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;&}\]]+))/g;
    let match;
    while ((match = assignment.exec(text)) && details.length < MAX_CREDENTIAL_DETAILS) {
      const key = match[1] ?? match[2] ?? match[3];
      const raw = match[4] ?? match[5] ?? match[6] ?? "";
      if (!isSensitiveField(key, raw)) continue;
      if (/^[|>](?:(?:[+-]\d*)|(?:\d+[+-]?))?$/.test(raw.trim())) continue;
      let value = raw;
      if (match[4] !== undefined) {
        try { value = JSON.parse(`"${raw}"`); } catch { /* Keep the encoded length if the source is malformed. */ }
      }
      const prefix = text.slice(0, match.index);
      details.push(credentialDetail({ key, value, path: `line ${lineCount(prefix)}, column ${prefix.length - Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"))}`, source: "text_assignment" }));
    }
    const yamlLines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
    let yamlOffset = 0;
    for (let index = 0; index < yamlLines.length && details.length < MAX_CREDENTIAL_DETAILS; index++) {
      const startIndex = index;
      const rawLine = yamlLines[index];
      const line = rawLine.replace(/(?:\r\n|\r|\n)$/, "");
      const block = line.match(/^(\s*(?:-\s*)?)([^:#][^:]*?)\s*:\s*([|>])(?:(?:[+-]\d*)|(?:\d+[+-]?))?\s*(?:#.*)?$/);
      const prefix = text.slice(0, yamlOffset);
      yamlOffset += rawLine.length;
      if (!block || !isSensitiveField(block[2].trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2"), "")) continue;
      const baseIndent = block[1].match(/^\s*/)?.[0].length ?? 0;
      const values = [];
      for (let child = index + 1; child < yamlLines.length; child++) {
        const childLine = yamlLines[child].replace(/(?:\r\n|\r|\n)$/, "");
        const indentation = childLine.match(/^\s*/)?.[0].length ?? 0;
        if (childLine.trim() && indentation <= baseIndent) break;
        values.push(childLine.trimStart());
        index = child;
      }
      if (index > startIndex) yamlOffset += yamlLines.slice(startIndex + 1, index + 1).reduce((total, item) => total + item.length, 0);
      const key = block[2].trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
      details.push(credentialDetail({ key, value: values.join("\n"), path: `line ${lineCount(prefix)}`, source: "yaml_block_scalar" }));
    }
    const xmlField = /<([A-Za-z_][\w:.-]*(?:token|secret|password|credential|authorization|cookie|api.?key)[\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    while ((match = xmlField.exec(text)) && details.length < MAX_CREDENTIAL_DETAILS) {
      const prefix = text.slice(0, match.index);
      details.push(credentialDetail({ key: match[1], value: match[2], path: `line ${lineCount(prefix)}`, source: "xml_element" }));
    }
    const inputTag = /<(input|meta)\b[^>]*>/gi;
    while ((match = inputTag.exec(text)) && details.length < MAX_CREDENTIAL_DETAILS) {
      const attributes = Object.fromEntries([...match[0].matchAll(/\b(type|name|id|autocomplete|value|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
        .map(attribute => [attribute[1].toLocaleLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? ""]));
      const key = attributes.name || attributes.id || attributes.autocomplete || attributes.type;
      const isPassword = attributes.type?.toLocaleLowerCase() === "password";
      if (!Object.hasOwn(attributes, "value") && !Object.hasOwn(attributes, "content")) continue;
      if (!isPassword && !isSensitiveField(key ?? "", attributes.value ?? attributes.content)) continue;
      const prefix = text.slice(0, match.index);
      details.push(credentialDetail({ key: key || "password", value: attributes.value ?? attributes.content, path: `line ${lineCount(prefix)}`, source: "markup_attribute" }));
    }
    const textarea = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea\s*>/gi;
    while ((match = textarea.exec(text)) && details.length < MAX_CREDENTIAL_DETAILS) {
      const name = match[1].match(/\b(?:name|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const key = name?.[1] ?? name?.[2] ?? name?.[3];
      if (!isSensitiveField(key ?? "", match[2])) continue;
      const prefix = text.slice(0, match.index);
      details.push(credentialDetail({ key, value: match[2], path: `line ${lineCount(prefix)}`, source: "markup_element" }));
    }
  }
  if (parsedValue === undefined) {
    const jwtPattern = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
    let match;
    while ((match = jwtPattern.exec(text)) && details.length < MAX_CREDENTIAL_DETAILS) {
      const prefix = text.slice(0, match.index);
      details.push(credentialDetail({ key: "unlabeled_token", value: match[0], path: `line ${lineCount(prefix)}`, source: "token_signature" }));
    }
  }
  const unique = new Map();
  for (const detail of details) unique.set(`${detail.path}\0${detail.kind}\0${detail.characterLength ?? detail.itemCount ?? 0}`, detail);
  return {
    items: [...unique.values()],
    duplicateCount: Math.max(0, details.length - unique.size),
    detailsMayBeIncomplete: detailsMayBeIncomplete || details.length >= MAX_CREDENTIAL_DETAILS
  };
}

export function redactSensitiveContainers(source) {
  if (!CREDENTIAL_TEXT_HINT.test(source) || !/[:=]/u.test(source) || !/[{[]/u.test(source)) return { text: source, count: 0 };
  const keyAndSeparator = /("(?:\\.|[^"\\]){1,160}"|'(?:\\.|[^'\\]){1,160}'|[A-Za-z_$][\w$.-]{0,159})\s*[:=]\s*/g;
  let result = "";
  let cursor = 0;
  let count = 0;
  let match;
  while ((match = keyAndSeparator.exec(source))) {
    const rawKey = match[1];
    const key = rawKey[0] === "\"" || rawKey[0] === "'" ? rawKey.slice(1, -1) : rawKey;
    const valueStart = keyAndSeparator.lastIndex;
    if (!isSensitiveField(key, source[valueStart] === "{" || source[valueStart] === "[" ? {} : "")) continue;
    if (source[valueStart] !== "{" && source[valueStart] !== "[") continue;
    const container = extractBalancedValue(source.slice(valueStart));
    if (!container || container[0] !== source[valueStart]) continue;
    result += source.slice(cursor, valueStart) + `"${REDACTED}"`;
    cursor = valueStart + container.length;
    keyAndSeparator.lastIndex = cursor;
    count++;
  }
  return count ? { text: result + source.slice(cursor), count } : { text: source, count: 0 };
}

export function redactText(value) {
  if (!CREDENTIAL_TEXT_HINT.test(value)) return { text: value, count: 0 };
  const containers = redactSensitiveContainers(value);
  let text = containers.text;
  let count = containers.count;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      const redacted = typeof replacement === "function" ? replacement(...args) : replacement;
      if (redacted !== args[0]) count++;
      return redacted;
    });
  };

  replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
  replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_match, scheme) => `${scheme} ${REDACTED}`);
  replace(/(?:(["'])([A-Za-z_$][\w$.-]{0,159})\1|([A-Za-z_$][\w$.-]{0,159}))(\s*[:=]\s*)(?:(Bearer|Basic)\s+(?:[A-Za-z0-9._~+/=-]+|\[REDACTED\])|(\[REDACTED\])|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+))/gi, (_match, keyQuote, quotedKey, bareKey, separator, authValue, markedValue, quotedValue) => {
    const key = quotedKey ?? bareKey;
    if (!isSensitiveField(key, authValue ?? markedValue ?? quotedValue ?? "")) return _match;
    if (markedValue || authValue?.endsWith(REDACTED)) return _match;
    const value = authValue ?? markedValue ?? quotedValue ?? "";
    if (/^[|>](?:(?:[+-]\d*)|(?:\d+[+-]?))?$/.test(value)) return _match;
    const quote = value[0] === "\"" || value[0] === "'" ? value[0] : "";
    const renderedKey = quotedKey ? `${keyQuote}${quotedKey}${keyQuote}` : bareKey;
    return `${renderedKey}${separator}${quote}${REDACTED}${quote}`;
  });
  replace(/([?&#](?:password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|credential|authorization|cookie|session|csrf|xsrf|code|state|nonce|signature|sig)[^=&#\s]*=)[^&#\s]*/gi, (_match, prefix) => `${prefix}${REDACTED}`);
  replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);
  replace(/\b(?:sk|rk|gh[pousr]|github_pat|glpat|xox[baprs]|AIza)[-_][A-Za-z0-9_-]{16,}\b/g, REDACTED);
  replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  return { text, count };
}

export function redactStructuredValue(root) {
  const stack = [{ parent: null, key: null, value: root }];
  let count = 0;
  let sensitiveFieldCount = 0;
  let safeRoot = root;
  let complexSensitive = false;
  while (stack.length) {
    const item = stack.pop();
    if (item.key !== null && isSensitiveField(item.key, item.value)) {
      if (item.parent === null) safeRoot = REDACTED;
      else safeJsonWrite(item.parent, item.key, REDACTED);
      if (item.value && typeof item.value === "object") complexSensitive = true;
      sensitiveFieldCount++;
      count++;
      continue;
    }
    if (typeof item.value === "string") {
      const redacted = redactText(item.value);
      if (item.parent === null) safeRoot = redacted.text;
      else safeJsonWrite(item.parent, item.key, redacted.text);
      count += redacted.count;
      continue;
    }
    if (!item.value || typeof item.value !== "object") continue;
    for (const key of Object.keys(item.value)) stack.push({ parent: item.value, key, value: item.value[key] });
  }
  return { value: safeRoot, count, sensitiveFieldCount, complexSensitive };
}

export function redactCredentialUrl(value, { includeUserInfo = false } = {}) {
  if (typeof value !== "string" || !value) return value;
  try {
    const url = new URL(value);
    if (!includeUserInfo) {
      url.username = "";
      url.password = "";
    }
    for (const key of url.searchParams.keys()) if (SENSITIVE_URL_KEY.test(key)) url.searchParams.set(key, REDACTED);
    if (url.hash.includes("=")) {
      const params = new URLSearchParams(url.hash.slice(1));
      for (const key of params.keys()) if (SENSITIVE_URL_KEY.test(key)) params.set(key, REDACTED);
      url.hash = params.toString();
    }
    url.hash = redactText(url.hash).text;
    return url.href;
  } catch { return redactText(value).text; }
}
