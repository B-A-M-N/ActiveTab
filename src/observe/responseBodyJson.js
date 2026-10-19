/** Non-evaluating JSON-like parsing, repair, and safe structural summaries. */
import {
  MAX_RESPONSE_JSON_DEPTH,
  MAX_RESPONSE_JSON_TOKENS,
  safeJsonWrite,
  lineCount,
  valueType,
  isSensitiveField,
  extractBalancedValue
} from "./responseBodyShared.js";
export { extractBalancedValue };
export function readSingleQuoted(source, start) {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index++];
    if (character === "'") return { value, next: index };
    if (character !== "\\") { value += character; continue; }
    if (index >= source.length) return null;
    const escaped = source[index++];
    const escapes = { "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (Object.hasOwn(escapes, escaped)) { value += escapes[escaped]; continue; }
    if (escaped === "u" && /^[0-9a-f]{4}$/i.test(source.slice(index, index + 4))) {
      value += String.fromCharCode(parseInt(source.slice(index, index + 4), 16));
      index += 4;
      continue;
    }
    if (escaped === "x" && /^[0-9a-f]{2}$/i.test(source.slice(index, index + 2))) {
      value += String.fromCharCode(parseInt(source.slice(index, index + 2), 16));
      index += 2;
      continue;
    }
    value += escaped;
  }
  return null;
}

export function skipDoubleQuoted(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index++] === '"') break;
  }
  return index;
}

export function removeTrailingCommas(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"') {
      const end = skipDoubleQuoted(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }
    if (source[index] === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === "}" || source[next] === "]") { index++; continue; }
    }
    result += source[index++];
  }
  return result;
}

/** Repair common JSONC and JavaScript-object syntax without evaluation. */

export function coerceJsonSyntax(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const end = skipDoubleQuoted(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }
    if (character === "'") {
      const quoted = readSingleQuoted(source, index);
      if (!quoted) return null;
      result += JSON.stringify(quoted.value);
      index = quoted.next;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[\w$-]/.test(source[index])) index++;
      const word = source.slice(start, index);
      let lookahead = index;
      while (/\s/.test(source[lookahead] ?? "")) lookahead++;
      if (source[lookahead] === ":") result += JSON.stringify(word);
      else {
        const literal = ({ True: "true", False: "false", None: "null", undefined: "null", NaN: "null", Infinity: "null" })[word];
        result += literal ?? word;
      }
      continue;
    }
    if (character === ";") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (next === source.length) { index = next; continue; }
    }
    result += character;
    index++;
  }
  result = result.replace(/(^|[\s[:,])\+((?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, "$1$2");
  result = result.replace(/(^|[\s[:,])(-?0x[\da-f]+)\b/gi, (_match, prefix, number) => `${prefix}${Number.parseInt(number, 16)}`);
  return removeTrailingCommas(result.trim().replace(/;\s*$/, ""));
}

export function closeUnfinishedContainers(source) {
  const stack = [];
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
    if (character === '"') { quote = character; continue; }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const open = stack.pop();
      if (!open || (open === "{" && character !== "}") || (open === "[" && character !== "]")) return null;
    }
  }
  if (quote || stack.length === 0) return null;
  return source + stack.reverse().map(open => open === "{" ? "}" : "]").join("");
}

export function safeParseLocation(error, source) {
  const message = String(error?.message ?? "");
  let position = Number(message.match(/\bposition\s+(\d+)/i)?.[1]);
  if (!Number.isFinite(position)) {
    const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColumn) {
      const line = Number(lineColumn[1]);
      const column = Number(lineColumn[2]);
      let lineStart = 0;
      for (let currentLine = 1; currentLine < line; currentLine++) {
        const nextNewline = source.indexOf("\n", lineStart);
        if (nextNewline < 0) break;
        lineStart = nextNewline + 1;
      }
      position = lineStart + Math.max(0, column - 1);
    }
  }
  if (!Number.isFinite(position)) return null;
  const prefix = source.slice(0, Math.min(source.length, position));
  const lastNewline = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  return { line: lineCount(prefix), column: prefix.length - lastNewline };
}

/** Bound JSON-like parser work before JSON.parse or syntax coercion allocates a tree. */
export function scanJsonWorkBudget(source, {
  maxDepth = MAX_RESPONSE_JSON_DEPTH,
  maxTokens = MAX_RESPONSE_JSON_TOKENS
} = {}) {
  const stack = [];
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let tokenSeparators = 0;
  let maximumDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "/" && next === "/") { lineComment = true; index++; continue; }
    if (character === "/" && next === "*") { blockComment = true; index++; continue; }
    if (character === "{" || character === "[") {
      stack.push(character);
      maximumDepth = Math.max(maximumDepth, stack.length);
      if (stack.length > maxDepth) return { exceeded: "json_depth_limit", maximumDepth, tokenSeparators };
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.at(-1) === expected) stack.pop();
      continue;
    }
    if (character === "," || character === ":") {
      tokenSeparators++;
      if (tokenSeparators > maxTokens) return { exceeded: "json_token_limit", maximumDepth, tokenSeparators };
    }
  }
  return { maximumDepth, tokenSeparators };
}

export function describeSyntaxRepairs(source, repaired) {
  const repairs = [];
  if (/\/\/|\/\*/.test(source)) repairs.push("removed_comments");
  if (/,\s*[}\]]/.test(source)) repairs.push("removed_trailing_commas");
  if (/'(?:\\.|[^'\\])*'/.test(source)) repairs.push("normalized_single_quoted_strings");
  if (/(?:^|[{,\s])[$A-Za-z_][\w$-]*\s*:/m.test(source)) repairs.push("quoted_unquoted_keys");
  if (/\b(?:True|False|None|undefined|NaN|Infinity)\b/.test(source)) repairs.push("normalized_non_json_literals");
  if (/(?:^|[\s[:,])\+(?:0|[1-9]\d*)(?:\.\d+)?|(?:^|[\s[:,])-?0x[\da-f]+/i.test(source)) repairs.push("normalized_numeric_syntax");
  if (/;\s*[}\]]?\s*$/.test(source)) repairs.push("removed_trailing_semicolon");
  if (!repairs.length && source !== repaired) repairs.push("normalized_json_syntax");
  return repairs;
}

export function parseJsonLike(text) {
  let normalized = text.replace(/^\uFEFF/, "").trim();
  let modePrefix = "";
  const xssi = normalized.match(/^\)\]\}',?\s*/);
  if (xssi) { normalized = normalized.slice(xssi[0].length); modePrefix = "xssi_"; }
  const fence = normalized.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  if (fence) { normalized = fence[1]; modePrefix = "fenced_"; }
  const candidates = [{ text: normalized, mode: `${modePrefix}json` }];
  const balanced = extractBalancedValue(normalized);
  if (/^[\w$.]+\s*\(/.test(normalized) && balanced) candidates.push({ text: balanced, mode: "jsonp_payload" });
  else if (balanced && balanced !== normalized) {
    const start = normalized.indexOf(balanced);
    const suffix = normalized.slice(start + balanced.length);
    if (!/^\s*[\[{]/.test(suffix)) candidates.push({ text: balanced, mode: "wrapped_json" });
  }
  const failures = [];
  for (const candidate of candidates) {
    try { return { value: JSON.parse(candidate.text), mode: candidate.mode, repairs: modePrefix ? [modePrefix.slice(0, -1)] : [] }; }
    catch (error) { failures.push({ mode: candidate.mode, stage: "parse", location: safeParseLocation(error, candidate.text) }); }
    const repaired = coerceJsonSyntax(candidate.text);
    if (repaired !== null) {
      try { return { value: JSON.parse(repaired), mode: "coerced_repaired_json", repairs: describeSyntaxRepairs(candidate.text, repaired) }; }
      catch (error) { failures.push({ mode: candidate.mode, stage: "syntax_repair", location: safeParseLocation(error, repaired) }); }
      const closed = closeUnfinishedContainers(repaired);
      if (closed) {
        try { return { value: JSON.parse(closed), mode: "coerced_closed_json", repairs: [...describeSyntaxRepairs(candidate.text, repaired), "closed_unfinished_containers"] }; }
        catch (error) { failures.push({ mode: candidate.mode, stage: "container_repair", location: safeParseLocation(error, closed) }); }
      }
    }
  }
  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.length <= 100_000) {
    const values = [];
    let valid = true;
    for (const line of lines) {
      try { values.push(JSON.parse(line)); continue; }
      catch { /* Try loose object syntax. */ }
      const repaired = coerceJsonSyntax(line);
      try { if (repaired === null) throw new Error(); values.push(JSON.parse(repaired)); }
      catch { valid = false; break; }
    }
    if (valid) return { value: values, mode: "json_lines", repairs: ["separated_json_lines"] };
  }
  if (/^\s*\{[\s\S]*\}\s*,\s*\{/.test(normalized)) {
    const repaired = coerceJsonSyntax(`[${normalized}]`);
    try { if (repaired !== null) return { value: JSON.parse(repaired), mode: "coerced_object_sequence", repairs: ["wrapped_object_sequence", ...describeSyntaxRepairs(normalized, repaired)] }; }
    catch (error) { failures.push({ mode: "object_sequence", stage: "sequence_repair", location: safeParseLocation(error, repaired ?? normalized) }); }
  }
  return { failure: { attempted: true, success: false, candidateType: "json_like", candidateCount: candidates.length, attempts: failures.slice(0, 8) } };
}

export function shapeOf(value, depth = 0, budget = { left: 120 }) {
  if (--budget.left < 0) return { type: "omitted_from_shape" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return {
    type: "array", length: value.length,
    ...(value.length && depth < 5 ? { itemShape: shapeOf(value[0], depth + 1, budget) } : {})
  };
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const properties = {};
    for (const key of keys.slice(0, 64)) {
      safeJsonWrite(properties, key, isSensitiveField(key, value[key])
        ? { type: "redacted", reason: "credential_field" }
        : depth < 5 ? shapeOf(value[key], depth + 1, budget) : { type: typeof value[key] });
    }
    return { type: "object", propertyCount: keys.length, properties };
  }
  return { type: typeof value };
}
