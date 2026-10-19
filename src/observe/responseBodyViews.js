/** Markdown projections and byte-addressable response views. */
const REDACTED = "[REDACTED]";
const MAX_MARKDOWN_NODES = 256;
const MAX_MARKDOWN_ROWS = 100;
const MAX_MARKDOWN_COLUMNS = 24;
const DEFAULT_UTF8_INDEX_STRIDE = 16 * 1024;

function utf8Width(codePoint) {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

/** Build a sparse UTF-8 byte-to-UTF-16 index for repeated random or sequential paging. */
export function createUtf8OffsetIndex(text, { strideBytes = DEFAULT_UTF8_INDEX_STRIDE } = {}) {
  if (typeof text !== "string") throw new Error("text must be a string.");
  if (!Number.isInteger(strideBytes) || strideBytes < 1) throw new Error("strideBytes must be a positive integer.");
  const checkpoints = [{ byteOffset: 0, characterOffset: 0 }];
  let characterOffset = 0;
  let byteOffset = 0;
  let nextCheckpoint = strideBytes;
  while (characterOffset < text.length) {
    const codePoint = text.codePointAt(characterOffset);
    characterOffset += codePoint > 0xffff ? 2 : 1;
    byteOffset += utf8Width(codePoint);
    if (byteOffset >= nextCheckpoint) {
      checkpoints.push({ byteOffset, characterOffset });
      nextCheckpoint = byteOffset + strideBytes;
    }
  }
  if (checkpoints.at(-1).byteOffset !== byteOffset) checkpoints.push({ byteOffset, characterOffset });
  return { totalBytes: byteOffset, strideBytes, checkpoints };
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonPathKey(path, key) {
  const name = String(key);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~])/g, "\\$1")
    .replace(/\r?\n/g, "<br>");
}

function fenced(language, text) {
  let maxTicks = 0;
  for (const match of text.matchAll(/`+/g)) maxTicks = Math.max(maxTicks, match[0].length);
  const marker = "`".repeat(Math.max(3, maxTicks + 1));
  return `${marker}${language}\n${text}\n${marker}`;
}

function markdownScalar(value) {
  if (typeof value === "string") {
    if ([...value].length > 256) return `[string; ${[...value].length} characters; see the complete JSON block]`;
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function markdownComplexSummary(value) {
  return Array.isArray(value) ? `[array; ${value.length} items]`
    : `[object; ${Object.keys(value ?? {}).length} fields]`;
}

function markdownTableCell(value) {
  if (typeof value === "string" && [...value].length > 256) return `[string; ${[...value].length} characters; see the complete source]`;
  return escapeMarkdownCell(value);
}

function markdownJsonDecomposition(root, title = "Decomposition", headingLevel = 3) {
  const level = Math.max(1, Math.min(5, Number.isInteger(headingLevel) ? headingLevel : 3));
  const lines = [`${"#".repeat(level)} ${title}`, "", "Complex structured data is split into indexed sections and tables. The complete data block below retains every field.", ""];
  const state = { nodes: 0, omitted: 0 };
  const pathTitle = (path, depth) => `${"#".repeat(Math.min(6, level + 1 + depth))} \`${path.replaceAll("`", "\\`").replace(/[\r\n]/g, " ").slice(0, 512)}\``;
  const markdownCell = (row, column) => {
    const value = row?.[column];
    return value && typeof value === "object" ? markdownComplexSummary(value) : markdownScalar(value);
  };
  const visit = (value, path, depth) => {
    if (++state.nodes > MAX_MARKDOWN_NODES) { state.omitted++; return; }
      if (depth > 8) { lines.push(pathTitle(path, depth), "", "Further nesting is shown in the complete normalized JSON block.", ""); return; }
    if (Array.isArray(value)) {
      const objectRows = value.filter(item => item && typeof item === "object" && !Array.isArray(item));
      if (objectRows.length) {
        const columns = [...new Set(objectRows.slice(0, MAX_MARKDOWN_ROWS).flatMap(item => Object.keys(item)))].slice(0, MAX_MARKDOWN_COLUMNS);
        const rows = objectRows.slice(0, MAX_MARKDOWN_ROWS);
        const nonObjectCount = value.length - objectRows.length;
        lines.push(pathTitle(path, depth), "", `Array of objects: ${objectRows.length} records${nonObjectCount ? ` and ${nonObjectCount} non-object items` : ""}; ${rows.length} rows and ${columns.length} columns are indexed here.`, "");
        lines.push(`| ${columns.map(escapeMarkdownCell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
        for (const row of rows) lines.push(`| ${columns.map(column => escapeMarkdownCell(markdownCell(row, column))).join(" | ")} |`);
        if (value.length > rows.length) lines.push("", `${value.length - rows.length} additional records remain in the complete normalized JSON block.`);
        if ([...new Set(objectRows.flatMap(item => Object.keys(item)))].length > columns.length) lines.push("", "Additional fields remain in the complete normalized JSON block.");
        const nestedKeySet = new Set();
        for (const row of rows) {
          for (const [key, itemValue] of Object.entries(row)) {
            if (itemValue && typeof itemValue === "object") nestedKeySet.add(key);
            if (nestedKeySet.size > 32) break;
          }
          if (nestedKeySet.size > 32) break;
        }
        const nestedKeys = [...nestedKeySet].slice(0, 32);
        if (nestedKeySet.size > nestedKeys.length) lines.push("", "Additional nested field paths remain in the complete normalized JSON block.");
        for (const key of nestedKeys) {
          const first = objectRows.find(item => item[key] && typeof item[key] === "object");
          visit(first[key], `${path}[]${jsonPathKey("", String(key).slice(0, 96))}`, depth + 1);
        }
        return;
      }
      lines.push(pathTitle(path, depth), "", `Array: ${value.length} items.`, "", "| Index | Type | Value |", "| --- | --- | --- |");
      for (const [index, item] of value.slice(0, MAX_MARKDOWN_ROWS).entries()) {
        lines.push(`| ${index} | ${valueType(item)} | ${escapeMarkdownCell(item && typeof item === "object" ? markdownComplexSummary(item) : markdownScalar(item))} |`);
      }
      if (value.length > MAX_MARKDOWN_ROWS) lines.push("", `${value.length - MAX_MARKDOWN_ROWS} additional items remain in the complete normalized JSON block.`);
      return;
    }
    if (!value || typeof value !== "object") {
      lines.push(pathTitle(path, depth), "", `Type: ${valueType(value)}`, "", fenced("json", JSON.stringify(value)));
      return;
    }
    const entries = Object.entries(value);
    const scalarEntries = entries.filter(([, item]) => !item || typeof item !== "object");
    if (scalarEntries.length) {
      lines.push(pathTitle(path, depth), "", "| Field | Type | Value |", "| --- | --- | --- |");
      for (const [key, item] of scalarEntries.slice(0, MAX_MARKDOWN_ROWS)) {
        lines.push(`| ${escapeMarkdownCell(key)} | ${valueType(item)} | ${escapeMarkdownCell(markdownScalar(item))} |`);
      }
      if (scalarEntries.length > MAX_MARKDOWN_ROWS) lines.push("", `${scalarEntries.length - MAX_MARKDOWN_ROWS} additional fields remain in the complete normalized JSON block.`);
      lines.push("");
    } else if (entries.length) lines.push(pathTitle(path, depth), "", `Object: ${entries.length} nested fields.`, "");
    else lines.push(pathTitle(path, depth), "", "Empty object.", "");
    for (const [key, item] of entries.filter(([, entry]) => entry && typeof entry === "object")) {
      visit(item, jsonPathKey(path, String(key).slice(0, 96)), depth + 1);
    }
  };
  visit(root, "$", 0);
  if (state.omitted) lines.push("", `${state.omitted} additional nested sections exceed the decomposition limit; their complete data remains in the normalized JSON block.`);
  return lines.join("\n");
}

/** Render trusted, already-projected structured diagnostics as decomposable Markdown. */
export function renderStructuredMarkdown(value, { title = "Decomposition", completeTitle = "Complete structured data", headingLevel = 3 } = {}) {
  const serialized = JSON.stringify(value, null, 2);
  const level = Math.max(1, Math.min(5, Number.isInteger(headingLevel) ? headingLevel : 3));
  if (serialized === undefined) return `${markdownJsonDecomposition(value, title, level)}\n\n${"#".repeat(level)} ${completeTitle}\n\n${fenced("text", String(value))}`;
  return `${markdownJsonDecomposition(value, title, level)}\n\n${"#".repeat(level)} ${completeTitle}\n\n${fenced("json", serialized)}`;
}

function credentialMarkdown(details, credentialValuesIncluded = false) {
  if (!details?.items?.length) return [];
  return [
    "### Credential analysis",
    "",
    credentialValuesIncluded
      ? "Credential values are included because the trusted local caller explicitly requested `includeCredentialValues:true`. Metadata also describes their type, size, encoding clues, and structured token shape."
      : "Credential values are redacted. The following metadata preserves their type, size, encoding clues, and structured token shape without exposing the values:",
    ...(details.detailsMayBeIncomplete ? ["", `Credential metadata reached the ${details.items.length}-entry discovery limit. The complete source remains available below, but this metadata list may not describe every credential location.`] : []),
    ...(details.duplicateCount ? ["", `${details.duplicateCount} duplicate credential locations were merged in the metadata list.`] : []),
    "",
    fenced("json", JSON.stringify(details, null, 2)),
    ""
  ];
}

export function renderResponseMarkdown({ format, safeText, safeValue, shape, analysis, parseMode, binaryData, credentials, credentialValuesIncluded = false }) {
  const lines = [`## Response body: ${format}`, ""];
  const sourceTitle = credentialValuesIncluded ? "Complete source (credential values included)" : "Complete redacted source";
  if (format === "json" && safeValue !== undefined) {
    lines.push(
      "Parsed as `" + parseMode + "`.",
      "",
      "### Parse diagnostics",
      "",
      fenced("json", JSON.stringify(analysis.parse ?? {}, null, 2)),
      "",
      "### Structure",
      "",
      fenced("json", JSON.stringify(shape, null, 2)),
      "",
      ...markdownJsonDecomposition(safeValue).split("\n"),
      "",
      ...credentialMarkdown(credentials, credentialValuesIncluded),
      credentialValuesIncluded ? "### Normalized JSON" : "### Normalized, redacted JSON",
      "",
      fenced("json", JSON.stringify(safeValue, null, 2)),
      "",
      `### ${sourceTitle}`,
      "",
      fenced("text", safeText)
    );
  } else if (format === "csv" || format === "tsv") {
    const rows = analysis._rowsForMarkdown ?? [];
    if (rows.length) {
      const actualColumns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
      const columns = Math.min(actualColumns, MAX_MARKDOWN_COLUMNS);
      lines.push("### Table diagnostics", "", fenced("json", JSON.stringify({ recordCount: analysis.recordCount, columnCount: analysis.columnCount, inconsistentRowCount: analysis.inconsistentRowCount, unterminatedQuote: analysis.unterminatedQuote, malformedQuotes: analysis.malformedQuotes, delimiter: analysis.delimiter, parse: analysis.parse ?? null }, null, 2)), "", ...credentialMarkdown(credentials, credentialValuesIncluded), `| ${Array.from({ length: columns }, (_, index) => markdownTableCell(rows[0]?.[index] ?? "")).join(" | ")} |`, `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`);
      for (const row of rows.slice(1, MAX_MARKDOWN_ROWS + 1)) lines.push(`| ${Array.from({ length: columns }, (_, index) => markdownTableCell(row[index] ?? "")).join(" | ")} |`);
      if (rows.length > MAX_MARKDOWN_ROWS + 1) lines.push("", `${rows.length - MAX_MARKDOWN_ROWS - 1} additional records remain in the complete source below.`);
      if (actualColumns > columns) lines.push("", `${actualColumns - columns} additional columns remain in the complete source below.`);
    }
    lines.push("", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced(format, safeText));
  } else if (format === "html" || format === "xml") {
    lines.push("### Structure", "", fenced("json", JSON.stringify(analysis, null, 2)), "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced(format, safeText));
  } else if (format === "form-urlencoded") {
    const pairs = new URLSearchParams(safeText);
    lines.push("### Parsed fields", "", "| Field | Value |", "| --- | --- |", ...[...pairs.entries()].map(([key, value]) => `| ${escapeMarkdownCell(key)} | ${escapeMarkdownCell(value)} |`), "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced("text", safeText));
  } else if (format === "yaml") {
    lines.push("### Conservative line decomposition", "", `This is a bounded indentation and scalar scan, not a complete YAML parser. It reports the structure it can establish and leaves ambiguous syntax visible in the ${credentialValuesIncluded ? "complete source" : "complete redacted source"} below.`, "", "| Line | Indent | Kind | Path | Scalar type |", "| ---: | ---: | --- | --- | --- |",
      ...(analysis.entries ?? []).map(entry => `| ${entry.line} | ${entry.indent} | ${escapeMarkdownCell(entry.kind)} | ${escapeMarkdownCell(entry.path)} | ${escapeMarkdownCell(entry.valueType)} |`),
      ...(analysis.omittedEntryCount ? ["", `${analysis.omittedEntryCount} additional structural entries remain in the complete source below.`] : []),
      "", `Diagnostics: ${analysis.mappingEntryCount} mapping lines, ${analysis.sequenceItemCount} sequence lines, ${analysis.documentCount} document(s), ${analysis.malformedLineCount} unclassified lines.`, "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced("yaml", safeText));
  } else if (format === "event-stream") {
    lines.push("### Event index", "", `Event payload values remain in the ${credentialValuesIncluded ? "complete source" : "complete redacted source"}; this index shows event framing and safe payload shape only.`, "", "| # | Event | Has ID | Retry ms | Data lines | Data characters | Parse mode | Root |", "| ---: | --- | --- | ---: | ---: | ---: | --- | --- |",
      ...(analysis.events ?? []).map(event => `| ${event.index} | ${escapeMarkdownCell(event.eventType)} | ${event.hasId ? "yes" : "no"}${event.hasId ? ` (${event.idLength} chars)` : ""} | ${event.retryMs ?? ""} | ${event.dataLineCount} | ${event.dataCharacterCount} | ${escapeMarkdownCell(event.dataParseMode ?? "text")} | ${escapeMarkdownCell(event.dataRootType ?? "") } |`),
      "", `Diagnostics: ${analysis.eventCount} events, ${analysis.dataLineCount} data lines, ${analysis.commentCount} comments.`,
      ...((analysis.events ?? []).filter(event => event.dataShape && typeof event.dataShape === "object").flatMap(event => ["", `#### Event ${event.index} data shape`, "", fenced("json", JSON.stringify(event.dataShape, null, 2))])),
      ...((analysis.events ?? []).some(event => event.dataParseFailure) ? ["", "#### JSON-like payload parse failures", "", "| Event | Mode | Stage | Line | Column |", "| ---: | --- | --- | ---: | ---: |",
        ...(analysis.events ?? []).flatMap(event => (event.dataParseFailure?.attempts ?? []).slice(0, 8).map(attempt => `| ${event.index} | ${escapeMarkdownCell(attempt.mode)} | ${escapeMarkdownCell(attempt.stage)} | ${attempt.location?.line ?? ""} | ${attempt.location?.column ?? ""} |`))] : []),
      ...(analysis.omittedEventCount ? ["", `${analysis.omittedEventCount} additional events remain in the complete source below.`] : []),
      "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced("text", safeText));
  } else if (format === "text" || format === "json-like-text") {
    const indexedLines = analysis.lineStructure?.lines ?? [];
    lines.push("### Line index", "", "Lines are indexed by structural clues so long responses can be scanned without hiding the complete source.", "", "| Line | Characters | Timestamp | Severity | Correlation fields | HTTP status | Error signal |", "| ---: | ---: | --- | --- | --- | ---: | --- |",
      ...indexedLines.map(line => `| ${line.line} | ${line.characterCount} | ${escapeMarkdownCell(line.timestamp ?? "")} | ${escapeMarkdownCell(line.severity ?? "")} | ${escapeMarkdownCell(line.correlationFields.join(", "))} | ${line.httpStatus ?? ""} | ${line.errorSignal ? "yes" : "no"} |`),
      ...(analysis.lineStructure?.omittedLineCount ? ["", `${analysis.lineStructure.omittedLineCount} additional non-empty lines remain in the complete source below.`] : []),
      "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced("text", safeText));
  } else if (format === "binary") {
    lines.push("### Binary metadata", "", fenced("json", JSON.stringify(analysis, null, 2)), "", "### Complete base64 body", "", fenced("base64", binaryData));
  } else {
    lines.push("### Diagnostics", "", fenced("json", JSON.stringify(analysis, null, 2)), "", ...credentialMarkdown(credentials, credentialValuesIncluded), `### ${sourceTitle}`, "", fenced("text", safeText));
  }
  return lines.join("\n");
}

/** Page a UTF-8 view while preserving code points and optionally reusing indexed offsets. */
export function sliceUtf8View(text, offset = 0, maxBytes = 32 * 1024, {
  index,
  cursor,
  endOffset,
  rangeStart = 0
} = {}) {
  const totalBytes = index?.totalBytes ?? Buffer.byteLength(text, "utf8");
  const rangeEnd = Math.min(endOffset ?? totalBytes, totalBytes);
  const requestedOffset = Math.min(rangeStart + offset, rangeEnd);
  const start = cursor?.byteOffset === requestedOffset && Number.isSafeInteger(cursor.characterOffset)
    ? { byteOffset: cursor.byteOffset, characterOffset: cursor.characterOffset, scannedBytes: 0, lookupMode: "cursor" }
    : utf8OffsetBoundary(text, requestedOffset, { index });
  const end = utf8OffsetBoundary(text, Math.min(rangeEnd, start.byteOffset + maxBytes), { roundUp: true, index });
  return {
    data: text.slice(start.characterOffset, end.characterOffset),
    offset: Math.max(0, start.byteOffset - rangeStart),
    nextOffset: Math.max(0, end.byteOffset - rangeStart),
    totalBytes: Math.max(0, rangeEnd - rangeStart),
    hasMore: end.byteOffset < rangeEnd,
    nextCharacterOffset: end.characterOffset,
    startLookupMode: start.lookupMode,
    endLookupMode: end.lookupMode,
    scannedBytes: start.scannedBytes + end.scannedBytes
  };
}

function utf8OffsetBoundary(text, targetByteOffset, { roundUp = false, index } = {}) {
  let characterOffset = 0;
  let byteOffset = 0;
  let scannedBytes = 0;
  let lookupMode = "linear";
  if (index?.checkpoints?.length) {
    let low = 0;
    let high = index.checkpoints.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (index.checkpoints[middle].byteOffset <= targetByteOffset) low = middle;
      else high = middle - 1;
    }
    ({ byteOffset, characterOffset } = index.checkpoints[low]);
    lookupMode = "sparse_index";
  }
  while (characterOffset < text.length && byteOffset < targetByteOffset) {
    const codePoint = text.codePointAt(characterOffset);
    const characterWidth = codePoint > 0xffff ? 2 : 1;
    const byteWidth = utf8Width(codePoint);
    if (byteOffset + byteWidth > targetByteOffset && !roundUp) break;
    characterOffset += characterWidth;
    byteOffset += byteWidth;
    scannedBytes += byteWidth;
  }
  return { characterOffset, byteOffset, scannedBytes, lookupMode };
}

function markdownLines(markdown) {
  const lines = [];
  let characterOffset = 0;
  let byteOffset = 0;
  while (characterOffset < markdown.length) {
    const start = characterOffset;
    while (characterOffset < markdown.length && markdown[characterOffset] !== "\n" && markdown[characterOffset] !== "\r") characterOffset++;
    const text = markdown.slice(start, characterOffset);
    const lineOffset = byteOffset;
    const textBytes = Buffer.byteLength(text);
    if (markdown[characterOffset] === "\r" && markdown[characterOffset + 1] === "\n") characterOffset += 2;
    else if (characterOffset < markdown.length) characterOffset++;
    const newline = markdown.slice(start + text.length, characterOffset);
    byteOffset += textBytes + Buffer.byteLength(newline);
    lines.push({ text, offset: lineOffset, contentEndOffset: lineOffset + textBytes, endOffset: byteOffset });
  }
  return { lines, totalBytes: byteOffset };
}

function markdownTableCells(line) {
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of line.trim()) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
    }
  }
  cells.push(cell.trim());
  if (line.trim().startsWith("|") && cells[0] === "") cells.shift();
  if (line.trim().endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function markdownJsonPath(title) {
  return title.match(/^`(\$.*)`$/)?.[1] ?? null;
}

function jsonPathParent(path) {
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;
  let segmentStart = -1;
  for (let index = 1; index < path.length; index++) {
    const character = path[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (bracketDepth && (character === "\"" || character === "'")) { quote = character; continue; }
    if (!bracketDepth && (character === "." || character === "[")) segmentStart = index;
    if (character === "[") bracketDepth++;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
  }
  if (segmentStart < 0) return null;
  return path.slice(0, segmentStart).replace(/\[\]$/u, "") || null;
}

function isDescendantSection(section, ancestorId, sectionsById) {
  let parentId = section.parentId;
  const seen = new Set();
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = sectionsById.get(parentId)?.parentId ?? null;
  }
  return false;
}

function isMarkdownTableSeparator(line) {
  const cells = markdownTableCells(line);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

/** Index Markdown headings and data blocks without parsing or changing their contents. */
export function indexMarkdownDocument(markdown) {
  const { lines, totalBytes } = markdownLines(markdown);
  const headings = [];
  const blocks = [];
  const headingStack = [];
  const seenHeadings = new Map();
  let fence = null;
  let fenceBlock = null;
  let nextBlockId = 0;

  const addBlock = block => blocks.push({ id: `${block.kind}-${++nextBlockId}`, ...block });
  for (let index = 0; index < lines.length; index++) {
    const row = lines[index];
    if (fence) {
      const closing = row.text.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.markerLength) {
        fenceBlock.closed = true;
        fenceBlock.byteLength = row.endOffset - fenceBlock.offset;
        fenceBlock.contentByteLength = row.offset - fenceBlock.contentOffset;
        addBlock(fenceBlock);
        fence = null;
        fenceBlock = null;
      }
      continue;
    }

    const opening = row.text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (opening) {
      const marker = opening[1];
      const info = opening[2].trim();
      fence = { marker: marker[0], markerLength: marker.length };
      fenceBlock = {
        kind: "code_fence",
        offset: row.offset,
        byteLength: 0,
        contentOffset: row.endOffset,
        contentByteLength: 0,
        language: info.split(/\s+/, 1)[0]?.toLowerCase() || null,
        closed: false,
        parentId: headingStack.at(-1)?.id ?? null
      };
      continue;
    }

    const heading = row.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
      const title = heading[2];
      const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `section-${headings.length + 1}`;
      const count = (seenHeadings.get(base) ?? 0) + 1;
      seenHeadings.set(base, count);
      const item = {
        id: count === 1 ? base : `${base}-${count}`,
        level,
        title,
        offset: row.offset,
        headingByteLength: row.endOffset - row.offset,
        contentOffset: row.endOffset,
        parentId: headingStack.at(-1)?.id ?? null,
        childIds: []
      };
      if (headingStack.length) headingStack.at(-1).childIds.push(item.id);
      headings.push(item);
      headingStack.push(item);
      continue;
    }

    if (row.text.includes("|") && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1].text)) {
      const tableRows = [row];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].text.trim() && lines[cursor].text.includes("|")) tableRows.push(lines[cursor++]);
      const dataRows = tableRows.map(item => markdownTableCells(item.text));
      const columnCounts = dataRows.map(cells => cells.length);
      const columnCount = columnCounts[0] ?? 0;
      addBlock({
        kind: "table",
        offset: row.offset,
        byteLength: tableRows.at(-1).endOffset - row.offset,
        parentId: headingStack.at(-1)?.id ?? null,
        rowCount: dataRows.length,
        columnCount,
        inconsistentRowCount: columnCounts.filter(count => count !== columnCount).length
      });
      index = cursor - 1;
    }
  }

  if (fenceBlock) {
    fenceBlock.byteLength = totalBytes - fenceBlock.offset;
    fenceBlock.contentByteLength = totalBytes - fenceBlock.contentOffset;
    addBlock(fenceBlock);
  }

  const pathSections = new Map();
  for (const item of headings) {
    const path = markdownJsonPath(item.title);
    if (!path) continue;
    const parent = pathSections.get(jsonPathParent(path));
    if (parent) {
      const previousParent = headings.find(candidate => candidate.id === item.parentId);
      if (previousParent) previousParent.childIds = previousParent.childIds.filter(id => id !== item.id);
      item.parentId = parent.id;
      if (!parent.childIds.includes(item.id)) parent.childIds.push(item.id);
    }
    pathSections.set(path, item);
  }

  const sectionsById = new Map(headings.map(item => [item.id, item]));
  for (let index = 0; index < headings.length; index++) {
    const item = headings[index];
    const sectionEnd = headings[index + 1]?.offset ?? totalBytes;
    item.byteLength = sectionEnd - item.offset;
    item.contentByteLength = sectionEnd - item.contentOffset;
    const nextSiblingOrAncestor = headings.slice(index + 1).find(candidate => !isDescendantSection(candidate, item.id, sectionsById));
    item.subtreeByteLength = (nextSiblingOrAncestor?.offset ?? totalBytes) - item.offset;
  }
  for (const block of blocks) {
    const owner = headings.filter(item => item.offset <= block.offset && block.offset < item.offset + item.subtreeByteLength)
      .sort((left, right) => right.offset - left.offset)[0];
    if (owner) block.parentId = owner.id;
  }

  return { sections: headings, blocks, totalBytes, byteOffsets: createUtf8OffsetIndex(markdown) };
}

/** Build byte-addressable Markdown heading entries for callers that need focused decomposition. */
export function indexMarkdownSections(markdown) {
  return indexMarkdownDocument(markdown).sections;
}

/** Select a complete indexed Markdown subtree or data block without changing its source. */
export function selectMarkdownRange(markdown, index, { sectionId, blockId, includeText = true } = {}) {
  if (sectionId && blockId) throw new Error("Select either a Markdown section or block, not both.");
  const kind = sectionId ? "section" : blockId ? "block" : "document";
  if (kind === "document") return {
    ...(includeText ? { text: markdown } : {}),
    selection: { kind, id: null, documentOffset: 0, totalBytes: index?.totalBytes ?? Buffer.byteLength(markdown) }
  };

  const entries = kind === "section" ? index.sections : index.blocks;
  const id = sectionId ?? blockId;
  const entry = entries.find(item => item.id === id);
  if (!entry) return null;
  const documentOffset = entry.offset;
  const totalBytes = kind === "section" ? entry.subtreeByteLength : entry.byteLength;
  const byteOffsets = index.byteOffsets;
  const start = utf8OffsetBoundary(markdown, documentOffset, { index: byteOffsets });
  const end = utf8OffsetBoundary(markdown, documentOffset + totalBytes, { roundUp: true, index: byteOffsets });
  return {
    ...(includeText ? { text: markdown.slice(start.characterOffset, end.characterOffset) } : {}),
    selection: {
      kind,
      id,
      ...(entry.title ? { title: entry.title } : {}),
      parentId: entry.parentId,
      documentOffset,
      totalBytes
    }
  };
}
