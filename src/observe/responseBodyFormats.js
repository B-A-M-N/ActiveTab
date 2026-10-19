/** Format-specific analyzers for text, markup, YAML, event streams, and tables. */
import {
  REDACTED,
  JSON_LIKE_START,
  MAX_MARKDOWN_ROWS,
  MAX_RESPONSE_BODY_COLUMNS,
  MAX_RESPONSE_BODY_RECORDS,
  safeJsonWrite,
  lineCount,
  valueType,
  isSensitiveField,
  jsonPathKey
} from "./responseBodyShared.js";
import { redactText, redactStructuredValue } from "./responseBodySecurity.js";
import { parseJsonLike, shapeOf } from "./responseBodyJson.js";
export function countDelimited(text, delimiter, { maxRows = MAX_RESPONSE_BODY_RECORDS, maxColumns = MAX_RESPONSE_BODY_COLUMNS } = {}) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let malformedQuotes = 0;
  let limitExceeded = null;
  let observedColumnCount = 0;
  const pushCell = () => {
    row.push(cell);
    cell = "";
    observedColumnCount = Math.max(observedColumnCount, row.length);
    if (row.length > maxColumns) limitExceeded = "delimited_column_limit";
  };
  const pushRow = () => {
    pushCell();
    if (limitExceeded) return;
    if (row.some(value => value !== "") || rows.length > 0) {
      if (rows.length >= maxRows) { limitExceeded = "delimited_record_limit"; return; }
      rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) { quoted = true; continue; }
    if (character === '"') { malformedQuotes++; cell += character; continue; }
    if (character === delimiter) { pushCell(); if (limitExceeded) break; continue; }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      pushRow();
      if (limitExceeded) break;
      continue;
    }
    cell += character;
  }
  if (!limitExceeded && (cell !== "" || row.length > 0 || rows.length === 0)) {
    pushRow();
  }
  return { rows, unterminatedQuote: quoted, malformedQuotes, limitExceeded, observedColumnCount };
}

export function redactMarkup(text, kind) {
  let result = redactText(text);
  let safeText = result.text;
  let count = result.count;
  safeText = safeText.replace(/<[^>]+>/g, tag => tag.replace(/(\b(?:data-)?(?:password|passwd|secret|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|credential|authorization|cookie|session(?:[_-]?(?:id|token))?|csrf[_-]?token|xsrf[_-]?token)\b\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_match, prefix, doubleQuoted, singleQuoted, bare) => {
    const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
    if (value === REDACTED) return _match;
    count++;
    return `${prefix}${doubleQuoted !== undefined ? `"${REDACTED}"` : singleQuoted !== undefined ? `'${REDACTED}'` : REDACTED}`;
  }));
  if (kind === "xml") {
    safeText = safeText.replace(/(<(?:[\w.-]+:)?(?:password|passwd|secret|private[_-]?key|token|api[_-]?key|client[_-]?secret|authorization|cookie|session|csrf|xsrf)\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?(?:password|passwd|secret|private[_-]?key|token|api[_-]?key|client[_-]?secret|authorization|cookie|session|csrf|xsrf)\s*>)/gi, (_match, open, value, close) => {
      if (value === REDACTED) return _match;
      count++;
      return `${open}${REDACTED}${close}`;
    });
  } else {
    safeText = safeText.replace(/(<textarea\b[^>]*\b(?:name|id)\s*=\s*(["'])[^"']*(?:password|passwd|secret|token|api[_-]?key|credential|csrf|xsrf)[^"']*\2[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi, (_match, open, _quote, close) => { count++; return `${open}${REDACTED}${close}`; });
    safeText = safeText.replace(/<(input|meta)\b[^>]*>/gi, tag => {
      const sensitive = /\btype\s*=\s*(["'])password\1/i.test(tag)
        || /\b(?:name|id|autocomplete)\s*=\s*(["'])[^"']*(?:password|passwd|secret|token|api[_-]?key|credential|csrf|xsrf)[^"']*\1/i.test(tag);
      if (!sensitive) return tag;
      return tag.replace(/\b(value|content)\s*=\s*(["'])(.*?)\2/gi, (_match, name, quote) => { count++; return `${name}=${quote}${REDACTED}${quote}`; });
    });
  }
  return { text: safeText, count };
}

export function redactYaml(text) {
  let count = 0;
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/(?:\r\n|\r|\n)$/, "");
    const block = line.match(/^(\s*(?:-\s*)?)([^:#][^:]*?)\s*:\s*([|>])(((?:[+-]\d*)|(?:\d+[+-]?))?\s*(?:#.*)?)$/);
    const key = block?.[2]?.trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
    if (!block || !isSensitiveField(key, "")) continue;
    const newline = lines[index].slice(line.length);
    lines[index] = `${block[1]}${block[2]}: ${block[3]}${block[4]}${newline}`;
    count++;
    const baseIndent = block[1].match(/^\s*/)?.[0].length ?? 0;
    for (let child = index + 1; child < lines.length; child++) {
      const childLine = lines[child].replace(/(?:\r\n|\r|\n)$/, "");
      const indentation = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childLine.trim() && indentation <= baseIndent) break;
      if (!childLine.trim()) continue;
      const childNewline = lines[child].slice(childLine.length);
      lines[child] = `${childLine.match(/^\s*/)?.[0] ?? ""}${REDACTED}${childNewline}`;
      count++;
    }
  }
  let safeText = lines.join("").replace(/^(\s*(?:-\s*)?([^:#]+?)\s*:\s*)(.+)$/gim, (_match, prefix, key, value) => {
    if (!isSensitiveField(key, value) || value.trim() === REDACTED || /^[|>](?:(?:[+-]\d*)|(?:\d+[+-]?))?$/.test(value.trim())) return _match;
    count++;
    return `${prefix}${REDACTED}`;
  });
  const generic = redactText(safeText);
  return { text: generic.text, count: count + generic.count };
}

export function yamlScalarType(value) {
  const scalar = String(value ?? "").trim();
  if (!scalar) return "container";
  if (scalar === REDACTED || /^(?:"|')\[REDACTED\](?:"|')$/.test(scalar)) return "redacted";
  if (/^[|>](?:(?:[+-]\d*)|(?:\d+[+-]?))?(?:\s+#.*)?$/.test(scalar)) return "block_scalar";
  if (/^(?:null|~)$/i.test(scalar)) return "null";
  if (/^(?:true|false)$/i.test(scalar)) return "boolean";
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(scalar)) return Number.isInteger(Number(scalar)) ? "integer" : "number";
  if (/^(?:\[|\{)/.test(scalar)) return "flow_collection";
  return "string";
}

export function decomposeYamlLines(text) {
  const entries = [];
  const parents = [{ indent: -1, path: "$" }];
  const sequenceCounts = new Map();
  let malformedLineCount = 0;
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^---\s*(?:#.*)?$/.test(trimmed) || /^\.\.\.\s*(?:#.*)?$/.test(trimmed)) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (parents.length > 1 && indent <= parents.at(-1).indent) parents.pop();
    const parentPath = parents.at(-1).path;
    const sequence = line.match(/^\s*-\s*(.*)$/);
    if (sequence) {
      const count = sequenceCounts.get(parentPath) ?? 0;
      sequenceCounts.set(parentPath, count + 1);
      const itemPath = `${parentPath}[${count}]`;
      const item = sequence[1];
      const mapping = item.match(/^([^:#][^:]*?)\s*:\s*(.*)$/);
      if (mapping) {
        const key = mapping[1].trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
        const value = mapping[2].trim();
        const path = jsonPathKey(itemPath, key);
        entries.push({ line: index + 1, indent, kind: "sequence_mapping", path, key, valueType: yamlScalarType(value) });
        parents.push({ indent, path: itemPath });
        if (!value) parents.push({ indent: indent + 1, path });
      } else {
        entries.push({ line: index + 1, indent, kind: "sequence_item", path: itemPath, key: null, valueType: yamlScalarType(item) });
        if (!item) parents.push({ indent, path: itemPath });
      }
      continue;
    }
    const mapping = line.match(/^\s*([^:#][^:]*?)\s*:\s*(.*)$/);
    if (mapping) {
      const key = mapping[1].trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
      const value = mapping[2].trim();
      const path = jsonPathKey(parentPath, key);
      entries.push({ line: index + 1, indent, kind: "mapping", path, key, valueType: yamlScalarType(value) });
      if (!value) parents.push({ indent, path });
      continue;
    }
    if (/^[-?]/.test(trimmed)) {
      entries.push({ line: index + 1, indent, kind: "sequence_or_key", path: parentPath, key: null, valueType: yamlScalarType(trimmed.replace(/^[-?]\s*/, "")) });
      continue;
    }
    malformedLineCount++;
    entries.push({ line: index + 1, indent, kind: "unclassified_line", path: parentPath, key: null, valueType: "unknown" });
  }
  return { entries: entries.slice(0, MAX_MARKDOWN_ROWS), omittedEntryCount: Math.max(0, entries.length - MAX_MARKDOWN_ROWS), malformedLineCount };
}

export function analyzeYaml(text) {
  let mappingEntryCount = 0;
  let sequenceItemCount = 0;
  let documentSeparators = 0;
  for (const _match of text.matchAll(/^\s*(?:-\s*)?[^#\s][^:]*:\s*/gm)) mappingEntryCount++;
  for (const _match of text.matchAll(/^\s*-\s+/gm)) sequenceItemCount++;
  for (const _match of text.matchAll(/^---\s*$/gm)) documentSeparators++;
  const decomposition = decomposeYamlLines(text);
  return {
    lineCount: lineCount(text),
    mappingEntryCount,
    sequenceItemCount,
    documentCount: Math.max(1, documentSeparators),
    parseMode: "conservative_line_structure",
    ...decomposition
  };
}

export function analyzeEventStream(text) {
  const eventTypes = {};
  let dataLines = 0;
  let comments = 0;
  const events = [];
  let current = { eventType: "message", hasId: false, idLength: null, retryMs: null, data: [], commentCount: 0 };
  let hasContent = false;
  const pushEvent = () => {
    if (!hasContent) return;
    const payload = current.data.join("\n");
    let dataShape = "none";
    let dataParseMode = null;
    let dataParseFailure = null;
    let dataRootType = null;
    let dataPropertyCount = 0;
    if (current.data.length) {
      const parsed = parseJsonLike(payload);
      if (!parsed.failure) {
        const safe = redactStructuredValue(parsed.value).value;
        dataShape = shapeOf(safe);
        dataParseMode = parsed.mode;
        dataRootType = valueType(safe);
        dataPropertyCount = safe && typeof safe === "object" ? Array.isArray(safe) ? safe.length : Object.keys(safe).length : 0;
      } else if (JSON_LIKE_START.test(payload)) {
        dataShape = "json_like_parse_failed";
        dataParseMode = "json_parse_failed";
        dataParseFailure = parsed.failure;
      } else dataShape = "text";
    }
    const eventType = current.eventType || "message";
    const known = Object.hasOwn(eventTypes, eventType);
    if (known || Object.keys(eventTypes).length < 64) safeJsonWrite(eventTypes, eventType, (known ? eventTypes[eventType] : 0) + 1);
    else safeJsonWrite(eventTypes, "[other event types]", (eventTypes["[other event types]"] ?? 0) + 1);
    events.push({
      index: events.length + 1,
      eventType,
      hasId: current.hasId,
      idLength: current.idLength,
      retryMs: current.retryMs,
      dataLineCount: current.data.length,
      dataCharacterCount: payload.length,
      dataParseMode,
      dataParseFailure,
      dataRootType,
      dataPropertyCount,
      dataShape
    });
    current = { eventType: "message", hasId: false, idLength: null, retryMs: null, data: [], commentCount: 0 };
    hasContent = false;
  };
  let lineStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== "\n" && text[index] !== "\r") continue;
    const line = text.slice(lineStart, index);
    if (!line) pushEvent();
    else if (line.startsWith(":")) { comments++; current.commentCount++; }
    else {
      hasContent = true;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") current.eventType = redactText(value || "message").text.slice(0, 128);
      else if (field === "id") { current.hasId = true; current.idLength = [...value].length; }
      else if (field === "retry" && /^\d+$/.test(value)) current.retryMs = Number(value);
      else if (field === "data") { dataLines++; current.data.push(value); }
    }
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    lineStart = index + 1;
  }
  pushEvent();
  return { eventCount: events.length, dataLineCount: dataLines, commentCount: comments, eventTypes, events: events.slice(0, MAX_MARKDOWN_ROWS), omittedEventCount: Math.max(0, events.length - MAX_MARKDOWN_ROWS) };
}

export function analyzeTextLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const indexed = [];
  let nonEmptyLineCount = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    nonEmptyLineCount++;
    const timestamp = line.match(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/)?.[0] ?? null;
    const severity = line.match(/\b(trace|debug|info|notice|warn(?:ing)?|error|fatal|critical)\b/i)?.[1]?.toUpperCase() ?? null;
    const correlationFields = [...new Set([...line.matchAll(/\b(trace[_-]?id|request[_-]?id|correlation[_-]?id|span[_-]?id)\s*[:=]/gi)].map(match => match[1].toLowerCase()))].slice(0, 8);
    const httpStatus = line.match(/\b(?:HTTP\/\d(?:\.\d)?\s+|status\s*[:= ]\s*)([1-5]\d\d)\b/i)?.[1] ?? null;
    const errorSignal = /\b(error|exception|failed|failure|timeout|denied|blocked|invalid)\b/i.test(line);
    indexed.push({ line: index + 1, characterCount: [...line].length, timestamp, severity, correlationFields, httpStatus, errorSignal });
  }
  return { lineCount: lines.length, nonEmptyLineCount, lines: indexed.slice(0, MAX_MARKDOWN_ROWS), omittedLineCount: Math.max(0, indexed.length - MAX_MARKDOWN_ROWS) };
}

export function redactEventStream(text) {
  const safe = redactText(text);
  let count = safe.count;
  let normalizedDataPayloadCount = 0;
  const result = safe.text.replace(/^(data:[ \t]*)(.*)$/gm, (line, prefix, payload) => {
    const parsed = parseJsonLike(payload);
    if (!parsed || parsed.failure) return line;
    const redacted = redactStructuredValue(parsed.value);
    if (!redacted.count) return line;
    count += redacted.count;
    normalizedDataPayloadCount++;
    return `${prefix}${JSON.stringify(redacted.value)}`;
  });
  return { text: result, count, normalizedDataPayloadCount };
}

export function analyzeMarkup(text, kind) {
  const tagCounts = {};
  for (const match of text.matchAll(/<\s*([A-Za-z][\w:.-]*)\b[^>]*>/g)) {
    const name = match[1].toLowerCase();
    safeJsonWrite(tagCounts, name, (Object.hasOwn(tagCounts, name) ? tagCounts[name] : 0) + 1);
  }
  const result = { tagCounts, tagCount: Object.values(tagCounts).reduce((sum, count) => sum + count, 0) };
  if (kind === "html") {
    const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? null;
    result.title = title ? redactText(title).text.slice(0, 240) : null;
    result.linkCount = tagCounts.a ?? 0;
    result.formCount = tagCounts.form ?? 0;
    result.scriptCount = tagCounts.script ?? 0;
    result.inputTypes = [];
    for (const match of text.matchAll(/<input\b[^>]*\btype\s*=\s*(["']?)([\w-]+)/gi)) {
      if (result.inputTypes.length === 64) break;
      result.inputTypes.push(match[2].toLowerCase());
    }
  } else {
    result.rootElement = text.match(/<([A-Za-z_][\w:.-]*)\b[^>]*>/)?.[1] ?? null;
    const stack = [];
    for (const match of text.matchAll(/<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b([^>]*)>/g)) {
      const closing = match[1] === "/";
      const name = match[2].toLowerCase();
      const tail = match[3] ?? "";
      if (closing) {
        const previous = stack.pop();
        if (previous !== name) result.mismatchedClosingTags = (result.mismatchedClosingTags ?? 0) + 1;
      } else if (!/\/\s*$/.test(tail)) stack.push(name);
    }
    result.unclosedElements = stack.length;
  }
  return result;
}

export function inferDelimited(text) {
  const lines = [];
  let lineStart = 0;
  for (let index = 0; index <= text.length && lines.length < 12; index++) {
    if (index < text.length && text[index] !== "\n" && text[index] !== "\r") continue;
    const line = text.slice(lineStart, index);
    if (line) lines.push(line);
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    lineStart = index + 1;
  }
  if (lines.length < 2) return null;
  const candidates = [",", "\t", ";", "|"];
  let best = null;
  for (const delimiter of candidates) {
    const counts = lines.map(line => countDelimited(line, delimiter).observedColumnCount ?? 1);
    const positive = counts.filter(count => count > 1);
    if (!positive.length) continue;
    const frequency = positive.filter(count => count === positive[0]).length / positive.length;
    const score = positive[0] * frequency;
    if (frequency >= 0.75 && (!best || score > best.score)) best = { delimiter, score };
  }
  return best?.delimiter ?? null;
}

export function redactDelimited(parsed) {
  const rows = parsed.rows.map(row => [...row]);
  const headers = rows[0] ?? [];
  let count = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (let column = 0; column < rows[rowIndex].length; column++) {
      if (rowIndex > 0 && isSensitiveField(headers[column] ?? "", rows[rowIndex][column])) {
        if (rows[rowIndex][column] !== REDACTED) count++;
        rows[rowIndex][column] = REDACTED;
      } else {
        const redacted = redactText(rows[rowIndex][column]);
        rows[rowIndex][column] = redacted.text;
        count += redacted.count;
      }
    }
  }
  return { rows, count };
}

export function serializeDelimited(rows, delimiter) {
  return rows.map(row => row.map(value => {
    const text = String(value ?? "");
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(delimiter)).join("\n");
}
