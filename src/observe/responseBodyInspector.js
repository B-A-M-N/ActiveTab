/** Selected response-body inspection and content-format dispatch. */
import { renderResponseMarkdown } from "./responseBodyViews.js";
import {
  REDACTED,
  JSON_LIKE_START,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_BODY_COLUMNS,
  MAX_RESPONSE_BODY_LINES,
  MAX_RESPONSE_BODY_RECORDS,
  MAX_RESPONSE_JSON_DEPTH,
  MAX_RESPONSE_JSON_TOKENS,
  MAX_RESPONSE_NORMALIZED_BYTES,
  MAX_RESPONSE_MARKDOWN_BYTES,
  isSensitiveField,
  lineCount
} from "./responseBodyShared.js";
import { MAX_CREDENTIAL_DETAILS, credentialDetail, credentialDetailsFor, redactText, redactStructuredValue } from "./responseBodySecurity.js";
import { parseJsonLike, scanJsonWorkBudget, shapeOf } from "./responseBodyJson.js";
import { countDelimited, redactMarkup, redactYaml, analyzeYaml, analyzeEventStream, analyzeTextLines, redactEventStream, analyzeMarkup, inferDelimited, redactDelimited, serializeDelimited } from "./responseBodyFormats.js";
export { createUtf8OffsetIndex, indexMarkdownDocument, indexMarkdownSections, selectMarkdownRange, sliceUtf8View, renderStructuredMarkdown } from "./responseBodyViews.js";
export { redactCredentialUrl } from "./responseBodySecurity.js";

const HTML_START = /^\s*(?:<!doctype\s+html\b|<(?:html|head|body|main|article|section|div|span|p|a|button|input|textarea|select|option|label|form|fieldset|legend|table|thead|tbody|tfoot|tr|td|th|caption|ul|ol|li|nav|header|footer|aside|h[1-6]|img|script|style|link|meta|title|details|summary|dialog|canvas|video|audio|source|iframe)\b)/i;
const XML_START = /^\s*(?:<\?xml\b|<[A-Za-z_][\w.:-]*(?:\s[^>]*)?>)/;

function lineCountWithinLimit(text) {
  let count = 1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    if (++count > MAX_RESPONSE_BODY_LINES) return count;
  }
  return count;
}

function overLimitInspection(reasonCode, { buffer, mimeType, observed, limit, detail = {} }) {
  return {
    status: "over_limit",
    reasonCode,
    format: "unavailable",
    parseMode: null,
    sourceText: null,
    normalizedText: null,
    displayText: null,
    markdown: null,
    analysis: {
      contentType: mimeType ?? null,
      sourceBytes: buffer.length,
      budgetExceeded: { reasonCode, observed, limit, ...detail }
    },
    credentialRedactions: 0,
    credentialValuesIncluded: false,
    credentialDetails: { items: [], duplicateCount: 0, detailsMayBeIncomplete: false },
    encoding: "utf-8"
  };
}

function decodeText(bytes, mimeType) {
  const charset = String(mimeType ?? "").match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
  const aliases = { latin1: "windows-1252", "iso-8859-1": "windows-1252", "utf8": "utf-8", "utf-16": "utf-16le" };
  const encoding = aliases[charset] ?? charset;
  try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), charset: encoding, decodeErrors: false }; }
  catch {
    try { return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8", decodeErrors: true }; }
    catch { return { text: bytes.toString("latin1"), charset: "latin1", decodeErrors: true }; }
  }
}

function mostlyText(bytes, text) {
  if (!bytes.length) return true;
  if (bytes.includes(0)) return false;
  let controls = 0;
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  return controls / bytes.length < 0.02 && text.length > 0;
}

function binarySignature(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { format: "jpeg" };
  if (bytes.length >= 10 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return { format: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return { format: "pdf", pages: (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length };
  if (bytes.subarray(0, 4).toString("ascii") === "PK\x03\x04") return { format: "zip" };
  if (bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return { format: "gzip" };
  if (bytes.subarray(0, 4).toString("ascii") === "\0asm") return { format: "wasm" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { format: "webp" };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return { format: "iso-bmff-media", brand: bytes.subarray(8, 12).toString("ascii") };
  if (bytes.subarray(0, 4).toString("ascii") === "wOF2") return { format: "woff2" };
  if (bytes.subarray(0, 4).toString("ascii") === "wOFF") return { format: "woff" };
  return { format: "binary" };
}

export function inspectResponseBody(bytes, mimeType, {
  base64Encoded = false,
  includeCredentialValues = false,
  includeMarkdown = true
} = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length > MAX_RESPONSE_BODY_BYTES) return overLimitInspection("decoded_body_bytes_limit", {
    buffer, mimeType, observed: buffer.length, limit: MAX_RESPONSE_BODY_BYTES
  });
  const decoded = decodeText(buffer, mimeType);
  const text = decoded.text.replace(/^\uFEFF/, "");
  const mime = String(mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  const mimeJson = /(?:\/json5?$|\+json5?$|graphql-response\+json$|ndjson$|json-seq$)/.test(mime) || mime === "text/json";
  const bodyLineCount = lineCountWithinLimit(text);
  if (bodyLineCount > MAX_RESPONSE_BODY_LINES) return overLimitInspection("body_line_limit", {
    buffer, mimeType, observed: bodyLineCount, limit: MAX_RESPONSE_BODY_LINES
  });
  const jsonCandidate = JSON_LIKE_START.test(text) || mimeJson;
  const jsonWork = jsonCandidate ? scanJsonWorkBudget(text) : null;
  if (jsonWork?.exceeded) return overLimitInspection(jsonWork.exceeded, {
    buffer, mimeType,
    observed: jsonWork.exceeded === "json_depth_limit" ? jsonWork.maximumDepth : jsonWork.tokenSeparators,
    limit: jsonWork.exceeded === "json_depth_limit" ? MAX_RESPONSE_JSON_DEPTH : MAX_RESPONSE_JSON_TOKENS,
    detail: { tokenSeparators: jsonWork.tokenSeparators, maximumDepth: jsonWork.maximumDepth }
  });
  const parseAttempt = jsonCandidate ? parseJsonLike(text) : null;
  const parsed = parseAttempt && !parseAttempt.failure ? parseAttempt : null;
  const credentials = credentialDetailsFor(text, parsed ? parsed.value : undefined);
  let format;
  let sourceText = text;
  let normalizedText = null;
  let safeValue;
  let shape;
  let parseMode = null;
  let redactionCount = 0;
  let analysis = {
    contentType: mimeType ?? null,
    charset: decoded.charset,
    sourceBytes: buffer.length,
    decodeErrors: decoded.decodeErrors,
    workBudget: {
      maxSourceBytes: MAX_RESPONSE_BODY_BYTES,
      maxLines: MAX_RESPONSE_BODY_LINES,
      maxRecords: MAX_RESPONSE_BODY_RECORDS,
      maxJsonDepth: MAX_RESPONSE_JSON_DEPTH,
      maxJsonTokenSeparators: MAX_RESPONSE_JSON_TOKENS,
      maxNormalizedBytes: MAX_RESPONSE_NORMALIZED_BYTES,
      maxMarkdownBytes: MAX_RESPONSE_MARKDOWN_BYTES,
      observedLines: bodyLineCount,
      ...(jsonWork ? { observedJsonDepth: jsonWork.maximumDepth, observedJsonTokenSeparators: jsonWork.tokenSeparators } : {})
    },
    ...(parseAttempt?.failure ? { parse: parseAttempt.failure } : {})
  };
  let binaryData = null;

  if (parsed) {
    format = "json";
    parseMode = parsed.mode;
    const redacted = redactStructuredValue(structuredClone(parsed.value));
    safeValue = redacted.value;
    const visibleValue = includeCredentialValues ? parsed.value : safeValue;
    const sourceRedaction = redactText(text);
    normalizedText = JSON.stringify(visibleValue);
    const normalizedBytes = Buffer.byteLength(normalizedText);
    if (normalizedBytes > MAX_RESPONSE_NORMALIZED_BYTES) return overLimitInspection("normalized_output_limit", {
      buffer, mimeType, observed: normalizedBytes, limit: MAX_RESPONSE_NORMALIZED_BYTES,
      detail: { parseMode, jsonWork }
    });
    const normalizeRedactedSource = redacted.complexSensitive || redacted.sensitiveFieldCount > 0;
    sourceText = includeCredentialValues ? text : normalizeRedactedSource ? normalizedText : sourceRedaction.text;
    redactionCount = Math.max(redacted.count, sourceRedaction.count);
    shape = shapeOf(visibleValue);
    analysis = {
      ...analysis,
      rootType: visibleValue === null ? "null" : Array.isArray(visibleValue) ? "array" : typeof visibleValue,
      structure: shape,
      parse: { attempted: true, success: true, mode: parseMode, repairs: parsed.repairs ?? [] },
      parseMode,
      normalized: parseMode !== "json",
      redactedSourceNormalized: includeCredentialValues ? false : normalizeRedactedSource
    };
  } else if (/application\/x-www-form-urlencoded/i.test(mime)) {
    format = "form-urlencoded";
    const params = new URLSearchParams(text);
    const safeParams = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      const redacted = isSensitiveField(key, value) ? { text: REDACTED, count: 1 } : redactText(value);
      safeParams.append(key, redacted.text);
      redactionCount += redacted.count;
    }
    sourceText = includeCredentialValues ? text : safeParams.toString();
    analysis = { ...analysis, fieldCount: [...safeParams.keys()].length, fields: [...new Set([...safeParams.keys()])] };
  } else if (/\bhtml\b/i.test(mime) || HTML_START.test(text)) {
    format = "html";
    const redacted = redactMarkup(text, "html");
    sourceText = includeCredentialValues ? text : redacted.text;
    redactionCount += redacted.count;
    analysis = { ...analysis, ...analyzeMarkup(sourceText, "html") };
  } else if (/\bxml\b/i.test(mime) || /\+xml$/i.test(mime) || XML_START.test(text)) {
    format = "xml";
    const redacted = redactMarkup(text, "xml");
    sourceText = includeCredentialValues ? text : redacted.text;
    redactionCount += redacted.count;
    analysis = { ...analysis, ...analyzeMarkup(sourceText, "xml") };
  } else if (/text\/event-stream/i.test(mime)) {
    format = "event-stream";
    const redacted = redactEventStream(text);
    sourceText = includeCredentialValues ? text : redacted.text;
    redactionCount += redacted.count;
    analysis = { ...analysis, ...analyzeEventStream(sourceText), normalizedDataPayloadCount: redacted.normalizedDataPayloadCount };
  } else if (/\byaml\b|\bx-yaml\b/i.test(mime) || /^\s*(?:---\s*$\s*)?[A-Za-z_][\w.-]*\s*:\s*\S/m.test(text)) {
    format = "yaml";
    const redacted = redactYaml(text);
    sourceText = includeCredentialValues ? text : redacted.text;
    redactionCount += redacted.count;
    analysis = { ...analysis, ...analyzeYaml(sourceText) };
  } else {
    const delimiter = /\btsv\b/i.test(mime) ? "\t" : /\bcsv\b/i.test(mime) ? "," : inferDelimited(text);
    if (delimiter) {
      format = delimiter === "\t" ? "tsv" : "csv";
      const parsedRows = countDelimited(text, delimiter);
      if (parsedRows.limitExceeded) return overLimitInspection(parsedRows.limitExceeded, {
        buffer, mimeType,
        observed: parsedRows.rows.length + 1,
        limit: parsedRows.limitExceeded === "delimited_column_limit" ? MAX_RESPONSE_BODY_COLUMNS : MAX_RESPONSE_BODY_RECORDS,
        detail: { delimiter: delimiter === "\t" ? "tab" : delimiter }
      });
      const safeRows = redactDelimited(parsedRows);
      const headerCells = parsedRows.rows[0] ?? [];
      for (let rowIndex = 1; rowIndex < parsedRows.rows.length && credentials.items.length < MAX_CREDENTIAL_DETAILS; rowIndex++) {
        for (let columnIndex = 0; columnIndex < headerCells.length && credentials.items.length < MAX_CREDENTIAL_DETAILS; columnIndex++) {
          const key = headerCells[columnIndex];
          if (isSensitiveField(key ?? "", parsedRows.rows[rowIndex]?.[columnIndex] ?? "")) credentials.items.push(credentialDetail({
            key,
            value: parsedRows.rows[rowIndex]?.[columnIndex] ?? "",
            path: `$.rows[${rowIndex - 1}].${String(key).slice(0, 96)}`,
            source: "delimited_field"
          }));
        }
      }
      if (credentials.items.length >= MAX_CREDENTIAL_DETAILS) credentials.detailsMayBeIncomplete = true;
      sourceText = includeCredentialValues ? text : serializeDelimited(safeRows.rows, delimiter);
      redactionCount += safeRows.count;
      const expectedColumns = safeRows.rows[0]?.length ?? 0;
      analysis = {
        ...analysis,
        delimiter: delimiter === "\t" ? "tab" : delimiter,
        _rowsForMarkdown: includeCredentialValues ? parsedRows.rows : safeRows.rows,
        recordCount: Math.max(0, safeRows.rows.length - 1),
        columnCount: expectedColumns,
        inconsistentRowCount: safeRows.rows.slice(1).filter(row => row.length !== expectedColumns).length,
        unterminatedQuote: parsedRows.unterminatedQuote,
        malformedQuotes: parsedRows.malformedQuotes
      };
    } else if (mostlyText(buffer, text) || /^text\//i.test(mime)) {
      format = mimeJson || parseAttempt ? "json-like-text" : "text";
      const redacted = redactText(text);
      sourceText = includeCredentialValues ? text : redacted.text;
      redactionCount += redacted.count;
      analysis = {
        ...analysis,
        lineCount: lineCount(sourceText),
        characterCount: sourceText.length,
        lineStructure: analyzeTextLines(sourceText)
      };
    } else {
      format = "binary";
      const signature = binarySignature(buffer);
      binaryData = buffer.toString("base64");
      const binaryText = buffer.toString("latin1");
      const redacted = redactText(binaryText);
      if (redacted.count && !includeCredentialValues) binaryData = Buffer.from(redacted.text, "latin1").toString("base64");
      redactionCount += redacted.count;
      sourceText = binaryData;
      analysis = { ...analysis, ...signature, transferEncoding: base64Encoded ? "base64" : "binary", base64Length: binaryData.length };
    }
  }

  if (format === "json" && safeValue !== undefined) {
    const visibleValue = includeCredentialValues ? parsed.value : safeValue;
    const displayText = JSON.stringify(visibleValue, null, 2);
    if (Buffer.byteLength(displayText) > MAX_RESPONSE_NORMALIZED_BYTES) return overLimitInspection("normalized_output_limit", {
      buffer, mimeType, observed: Buffer.byteLength(displayText), limit: MAX_RESPONSE_NORMALIZED_BYTES,
      detail: { parseMode, presentation: "pretty_json" }
    });
    const publicAnalysis = { ...analysis };
    delete publicAnalysis._rowsForMarkdown;
    const markdown = includeMarkdown
      ? renderResponseMarkdown({ format, safeText: sourceText, safeValue: visibleValue, shape, analysis, parseMode, credentials, credentialValuesIncluded: includeCredentialValues })
      : null;
    if (markdown !== null && Buffer.byteLength(markdown) > MAX_RESPONSE_MARKDOWN_BYTES) return overLimitInspection("markdown_output_limit", {
      buffer, mimeType, observed: Buffer.byteLength(markdown), limit: MAX_RESPONSE_MARKDOWN_BYTES,
      detail: { format, parseMode }
    });
    return {
      format,
      parseMode,
      sourceText,
      normalizedText,
      displayText,
      markdown,
      analysis: publicAnalysis,
      credentialRedactions: includeCredentialValues ? 0 : redactionCount,
      credentialValuesIncluded: includeCredentialValues,
      credentialDetails: credentials,
      encoding: "utf-8"
    };
  }
  const displayText = sourceText;
  if (normalizedText !== null && Buffer.byteLength(normalizedText) > MAX_RESPONSE_NORMALIZED_BYTES) return overLimitInspection("normalized_output_limit", {
    buffer, mimeType, observed: Buffer.byteLength(normalizedText), limit: MAX_RESPONSE_NORMALIZED_BYTES,
    detail: { format, parseMode }
  });
  const publicAnalysis = { ...analysis };
  delete publicAnalysis._rowsForMarkdown;
  const markdown = includeMarkdown
    ? renderResponseMarkdown({ format, safeText: sourceText, analysis, binaryData: binaryData ?? sourceText, credentials, credentialValuesIncluded: includeCredentialValues })
    : null;
  if (markdown !== null && Buffer.byteLength(markdown) > MAX_RESPONSE_MARKDOWN_BYTES) return overLimitInspection("markdown_output_limit", {
    buffer, mimeType, observed: Buffer.byteLength(markdown), limit: MAX_RESPONSE_MARKDOWN_BYTES,
    detail: { format, parseMode }
  });
  return {
    format,
    parseMode,
    sourceText,
    normalizedText,
    displayText,
    markdown,
    analysis: publicAnalysis,
    credentialRedactions: includeCredentialValues ? 0 : redactionCount,
    credentialValuesIncluded: includeCredentialValues,
    credentialDetails: credentials,
    encoding: format === "binary" ? "base64" : "utf-8"
  };
}

/** Return a UTF-8-safe page; offsets let a viewer inspect the complete view without truncation. */
/** Remove URL user-info and recognizable credential-valued query parameters. */
