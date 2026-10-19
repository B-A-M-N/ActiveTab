import test from "node:test";
import assert from "node:assert/strict";
import { createUtf8OffsetIndex, indexMarkdownDocument, inspectResponseBody, selectMarkdownRange, sliceUtf8View } from "../src/observe/responseBodyInspector.js";
import {
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_BODY_COLUMNS,
  MAX_RESPONSE_BODY_LINES,
  MAX_RESPONSE_BODY_RECORDS,
  MAX_RESPONSE_JSON_DEPTH,
  MAX_RESPONSE_JSON_TOKENS
} from "../src/observe/responseBodyShared.js";

const inspect = (body, mimeType, options) => inspectResponseBody(Buffer.from(body), mimeType, options);

test("UTF-8 view paging preserves byte offsets without splitting code points", () => {
  const source = "Aé🌳\r\nनमस्ते🙂Z";
  const totalBytes = Buffer.byteLength(source, "utf8");
  const reconstructed = [];
  let offset = 0;
  while (offset < totalBytes) {
    const page = sliceUtf8View(source, offset, 2);
    assert.equal(page.offset, offset);
    assert.ok(page.nextOffset > offset, "each page advances by at least one complete code point");
    assert.equal(Buffer.byteLength(page.data, "utf8"), page.nextOffset - page.offset);
    assert.equal(page.data.includes("\uFFFD"), false);
    reconstructed.push(page.data);
    offset = page.nextOffset;
  }
  assert.equal(reconstructed.join(""), source);

  const insideAccent = sliceUtf8View(source, 2, 1);
  assert.equal(insideAccent.offset, 1, "an interior-byte offset backs up to the start of the code point");
  assert.equal(insideAccent.data, "é");
  assert.equal(insideAccent.nextOffset, 3);

  const insideEmoji = sliceUtf8View(source, 5, 1);
  assert.equal(insideEmoji.offset, 3);
  assert.equal(insideEmoji.data, "🌳");
  assert.equal(insideEmoji.nextOffset, 7);

  const index = createUtf8OffsetIndex(source, { strideBytes: 4 });
  const firstIndexedPage = sliceUtf8View(source, 0, 5, { index });
  const nextIndexedPage = sliceUtf8View(source, firstIndexedPage.nextOffset, 5, {
    index,
    cursor: { byteOffset: firstIndexedPage.nextOffset, characterOffset: firstIndexedPage.nextCharacterOffset }
  });
  assert.equal(firstIndexedPage.startLookupMode, "sparse_index");
  assert.equal(nextIndexedPage.startLookupMode, "cursor", "sequential pages continue from the prior code-point boundary");
  assert.equal(nextIndexedPage.data, source.slice(firstIndexedPage.nextCharacterOffset, firstIndexedPage.nextCharacterOffset + nextIndexedPage.data.length));
  assert.equal(index.totalBytes, totalBytes);
});

test("sparse byte lookup preserves combining marks and random offsets, and 8 MiB sequential paging reconstructs exactly", () => {
  const unicode = "Cafe\u0301 🌳 e\u0301🙂 — end";
  const index = createUtf8OffsetIndex(unicode, { strideBytes: 5 });
  const boundaries = [];
  let byteOffset = 0;
  let characterOffset = 0;
  for (const codePoint of unicode) {
    boundaries.push({ byteOffset, characterOffset });
    byteOffset += Buffer.byteLength(codePoint, "utf8");
    characterOffset += codePoint.length;
  }
  boundaries.push({ byteOffset, characterOffset });
  for (const requestedOffset of [0, 2, 5, 7, 10, 14, 19, byteOffset]) {
    const expectedStart = boundaries.filter(item => item.byteOffset <= requestedOffset).at(-1);
    const page = sliceUtf8View(unicode, requestedOffset, 7, { index });
    assert.equal(page.offset, expectedStart.byteOffset, `random byte offset ${requestedOffset} backs up to a code-point boundary`);
    assert.equal(page.data, unicode.slice(expectedStart.characterOffset, page.nextCharacterOffset));
    assert.equal(page.data.includes("\uFFFD"), false);
  }

  const large = "x".repeat(8 * 1024 * 1024);
  const largeIndex = createUtf8OffsetIndex(large);
  let offset = 0;
  let cursor;
  const pages = [];
  while (offset < largeIndex.totalBytes) {
    const page = sliceUtf8View(large, offset, 32 * 1024, { index: largeIndex, cursor });
    pages.push(page.data);
    offset = page.nextOffset;
    cursor = { byteOffset: offset, characterOffset: page.nextCharacterOffset };
  }
  assert.equal(pages.length, 256);
  assert.equal(pages.join(""), large, "8 MiB of sequential pages reconstruct the entire selected view");
});

test("Markdown selection preserves Unicode text at byte-addressed section and block boundaries", () => {
  const markdown = "## Café 🌳\n\nBefore 🧪.\n\n```text\nnaïve🙂\n```\n\n## Fin\n";
  const index = indexMarkdownDocument(markdown);
  const section = index.sections.find(item => item.title === "Café 🌳");
  const block = index.blocks.find(item => item.kind === "code_fence");
  assert.ok(section && block);
  assert.equal(selectMarkdownRange(markdown, index, { sectionId: section.id }).text, "## Café 🌳\n\nBefore 🧪.\n\n```text\nnaïve🙂\n```\n\n");
  assert.equal(selectMarkdownRange(markdown, index, { blockId: block.id }).text, "```text\nnaïve🙂\n```\n");
  const descriptor = selectMarkdownRange(markdown, index, { blockId: block.id, includeText: false });
  assert.equal(Object.hasOwn(descriptor, "text"), false, "paging can use the original document without copying the selected block");
  assert.equal(descriptor.selection.documentOffset, block.offset);
  assert.equal(descriptor.selection.totalBytes, block.byteLength);
});

test("loose JSON is repaired, redacted, and reported with separate parse evidence", () => {
  const report = inspect("{name: 'fixture', count: 2, access_token: 'fixture-secret',}", "application/json");

  assert.equal(report.format, "json");
  assert.equal(report.parseMode, "coerced_repaired_json");
  assert.deepEqual(report.analysis.parse.repairs, [
    "removed_trailing_commas",
    "normalized_single_quoted_strings",
    "quoted_unquoted_keys"
  ]);
  assert.equal(report.normalizedText, '{"name":"fixture","count":2,"access_token":"[REDACTED]"}');
  assert.equal(report.sourceText, report.normalizedText, "structure-aware credential redaction returns a complete canonical source view");
  assert.deepEqual(report.credentialDetails.items[0], {
    path: "$.access_token",
    field: "access_token",
    kind: "access_token",
    valueType: "string",
    source: "structured_field",
    characterLength: 14,
    byteLength: 14,
    format: "opaque",
    characterClasses: { lowercase: true, uppercase: false, digits: false, symbols: true }
  });
  assert.match(report.markdown, /### Credential analysis/u);
  assert.match(report.markdown, /### Parse diagnostics/u);
  assert.match(report.markdown, /### Normalized, redacted JSON/u);
  assert.equal(report.markdown.includes("fixture-secret"), false);
});

test("explicit credential-value inspection exposes complete values alongside format analysis", () => {
  const token = `CaseSensitive.Token+with/punctuation-${"x".repeat(400)}`;
  const json = inspect(JSON.stringify({ result: { access_token: token } }), "application/json", { includeCredentialValues: true });
  assert.equal(json.normalizedText, JSON.stringify({ result: { access_token: token } }));
  assert.equal(json.credentialDetails.items[0].characterLength, [...token].length);
  assert.equal(json.credentialValuesIncluded, true);
  assert.equal(json.credentialRedactions, 0);
  assert.match(json.markdown, /Complete source \(credential values included\)/u);
  assert.match(json.markdown, /Credential values are included/u);
  assert.ok(json.markdown.includes(token));

  const yaml = inspect(`auth_token: |\n  ${token}\n`, "application/yaml", { includeCredentialValues: true });
  assert.ok(yaml.sourceText.includes(token));
  assert.equal(yaml.credentialDetails.items[0].characterLength, [...token].length);

  const text = inspect(`authorization: "Bearer ${token}"\n`, "text/plain", { includeCredentialValues: true });
  assert.ok(text.sourceText.includes(token));
  assert.equal(text.credentialDetails.items[0].characterLength, [...`Bearer ${token}`].length);
  assert.ok(text.markdown.includes(token));
});

test("response analysis rejects byte, line, JSON-depth, token, row, and column overages", () => {
  const oversized = inspectResponseBody(Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 1), "text/plain");
  assert.equal(oversized.status, "over_limit");
  assert.equal(oversized.reasonCode, "decoded_body_bytes_limit");
  assert.equal(oversized.sourceText, null);

  const deep = inspect(`${"[".repeat(MAX_RESPONSE_JSON_DEPTH + 1)}0${"]".repeat(MAX_RESPONSE_JSON_DEPTH + 1)}`, "application/json");
  assert.equal(deep.status, "over_limit");
  assert.equal(deep.reasonCode, "json_depth_limit");
  assert.equal(deep.analysis.budgetExceeded.limit, MAX_RESPONSE_JSON_DEPTH);

  const manyTokens = `[${Array(MAX_RESPONSE_JSON_TOKENS + 2).fill("0").join(",")}]`;
  const tokenReport = inspect(manyTokens, "application/json");
  assert.equal(tokenReport.status, "over_limit");
  assert.equal(tokenReport.reasonCode, "json_token_limit");

  const manyLines = `${"line\n".repeat(MAX_RESPONSE_BODY_LINES)}line`;
  const lineReport = inspect(manyLines, "text/plain");
  assert.equal(lineReport.status, "over_limit");
  assert.equal(lineReport.reasonCode, "body_line_limit");

  const manyRows = `name,token\n${"a,secret\n".repeat(MAX_RESPONSE_BODY_RECORDS)}`;
  const rowReport = inspect(manyRows, "text/csv");
  assert.equal(rowReport.status, "over_limit");
  assert.equal(rowReport.reasonCode, "delimited_record_limit");

  const wideRow = Array(MAX_RESPONSE_BODY_COLUMNS + 1).fill("column").join(",");
  const manyColumns = `${wideRow}\n${wideRow}\n`;
  const columnReport = inspect(manyColumns, "text/csv");
  assert.equal(columnReport.status, "over_limit");
  assert.equal(columnReport.reasonCode, "delimited_column_limit");

  const bracesInsideString = inspect('{"message":"[[[[ , : ]]]]"}', "application/json");
  assert.equal(bracesInsideString.status, undefined, "quoted punctuation does not consume the JSON parser budget");
});

test("nested JSON becomes indexed Markdown tables while full safe JSON and credential shape remain available", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "person-123", exp: 2_000_000_000, roles: ["member", "admin"] })).toString("base64url");
  const jwt = `${header}.${claims}.signature-segment`;
  const report = inspect(JSON.stringify({
    accounts: [{ id: 1, name: "A", contact: { email: "a@example.test" } }, { id: 2, name: "B", contact: { email: "b@example.test" } }],
    auth: { access_token: jwt }
  }), "application/json");

  assert.match(report.markdown, /#### `\$\.accounts`/u);
  assert.match(report.markdown, /\| id \| name \| contact \|/u);
  assert.match(report.markdown, /#### `\$\.accounts\[\]\.contact`/u);
  const token = report.credentialDetails.items[0];
  assert.equal(token.kind, "access_token");
  assert.equal(token.format, "jwt");
  assert.deepEqual(token.jwt.claimNames, ["exp", "roles", "sub"]);
  assert.deepEqual(token.jwt.claimTypes, { sub: "string", exp: "number", roles: "array" });
  assert.ok(report.normalizedText.includes("[REDACTED]"));
  assert.equal(JSON.stringify(report).includes(jwt), false);
});

test("credential detail bounds are explicit while the complete redacted source remains available", () => {
  const secrets = Array.from({ length: 257 }, (_, index) => ({ api_token: `fixture-secret-${index}` }));
  const report = inspect(JSON.stringify({ records: secrets }), "application/json");

  assert.equal(report.credentialRedactions, secrets.length);
  assert.equal(report.credentialDetails.items.length, 256);
  assert.equal(report.credentialDetails.detailsMayBeIncomplete, true);
  assert.match(report.markdown, /Credential metadata reached the 256-entry discovery limit/u);
  assert.ok(report.sourceText.includes('"api_token":"[REDACTED]"'));
  assert.equal(report.sourceText.includes("fixture-secret-0"), false);
  assert.equal(report.sourceText.includes("fixture-secret-256"), false);
  assert.equal(JSON.stringify(report).includes("fixture-secret-256"), false);

  const included = inspect(JSON.stringify({ records: secrets }), "application/json", { includeCredentialValues: true });
  assert.equal(included.credentialDetails.items.length, 256);
  assert.ok(included.sourceText.includes('"api_token":"fixture-secret-256"'), "the complete source retains values beyond the bounded metadata index");
  assert.ok(included.markdown.includes("fixture-secret-256"), "Markdown keeps the complete body available after bounded decomposition");
});

test("unparseable JSON-like text reports safe parse locations and keeps a complete redacted source", () => {
  const source = '{"status":broken_value,"note":"fixture text"}';
  const report = inspect(source, "application/json");

  assert.equal(report.format, "json-like-text");
  assert.equal(report.analysis.parse.attempted, true);
  assert.equal(report.analysis.parse.success, false);
  assert.ok(report.analysis.parse.attempts.every(attempt => !Object.hasOwn(attempt, "message") && !Object.hasOwn(attempt, "source")));
  assert.equal(report.sourceText, source);
  assert.match(report.markdown, /fixture text/u);
});

test("HTML and XML are identified and summarized without losing their safe source", () => {
  const html = inspect('<!doctype html><html><head><title>Fixture inbox</title></head><body><form><input type="password" value="fixture-secret"><a href="/items">Items</a></form></body></html>', "text/html");
  assert.equal(html.format, "html");
  assert.equal(html.analysis.title, "Fixture inbox");
  assert.equal(html.analysis.formCount, 1);
  assert.equal(html.analysis.linkCount, 1);
  assert.equal(html.sourceText.includes("fixture-secret"), false);
  assert.equal(html.credentialDetails.items[0].kind, "password");
  assert.equal(html.credentialDetails.items[0].characterLength, 14);
  assert.match(html.markdown, /### Structure/u);
  assert.match(html.markdown, /### Complete redacted source/u);

  const xml = inspect("<result><token>fixture-secret</token><item>ready</item></result>", "application/xml");
  assert.equal(xml.format, "xml");
  assert.equal(xml.analysis.rootElement, "result");
  assert.equal(xml.analysis.unclosedElements, 0);
  assert.equal(xml.sourceText.includes("fixture-secret"), false);
  assert.match(xml.markdown, /<token>\[REDACTED\]<\/token>/u);
});

test("YAML and delimited records are decomposed into Markdown without losing credential shape", () => {
  const yaml = inspect("items:\n  - name: fixture\n    api_token: fixture-secret\n", "application/yaml");
  assert.equal(yaml.format, "yaml");
  assert.equal(yaml.analysis.mappingEntryCount, 2);
  assert.equal(yaml.analysis.sequenceItemCount, 1);
  assert.equal(yaml.sourceText.includes("fixture-secret"), false);
  assert.equal(yaml.analysis.parseMode, "conservative_line_structure");
  assert.ok(yaml.analysis.entries.some(entry => entry.path === "$.items[0].api_token" && entry.valueType === "redacted"));
  assert.match(yaml.markdown, /### Conservative line decomposition/u);
  assert.ok(yaml.markdown.includes("api\\_token"));
  assert.equal(yaml.credentialDetails.items[0].characterLength, 14);

  const yamlBlock = inspect("auth_token: |2-\n  fixture-secret-line-1\n  fixture-secret-line-2\nkeep: true\n", "application/yaml");
  assert.equal(yamlBlock.sourceText.includes("fixture-secret"), false);
  assert.match(yamlBlock.sourceText, /auth_token: \|2-\n  \[REDACTED\]\n  \[REDACTED\]/u);
  assert.equal(yamlBlock.credentialDetails.items[0].source, "yaml_block_scalar");
  assert.equal(yamlBlock.credentialDetails.items[0].characterLength, 43);

  const csv = inspect("name,api_key\nalice,fixture-secret\nbob,other-secret\n", "text/csv");
  assert.equal(csv.format, "csv");
  assert.equal(csv.analysis.recordCount, 2);
  assert.equal(csv.analysis.columnCount, 2);
  assert.equal(csv.sourceText.includes("fixture-secret"), false);
  assert.equal(csv.sourceText.includes("other-secret"), false);
  assert.ok(csv.markdown.includes("| name | api\\_key |"));
  assert.ok(csv.markdown.includes("| alice | \\[REDACTED\\] |"));
});

test("CSV and TSV Markdown retain complete source beyond the bounded preview table", () => {
  const rows = ["row_id,api_token", ...Array.from({ length: 120 }, (_, index) => `${index},fixture-secret-${index}`)];
  const csvSource = rows.join("\n");
  const redactedCsv = inspect(csvSource, "text/csv");
  assert.match(redactedCsv.markdown, /### Complete redacted source/u);
  assert.equal(redactedCsv.markdown.includes("fixture-secret-119"), false);
  assert.ok(redactedCsv.markdown.includes("119,[REDACTED]"));
  assert.match(redactedCsv.markdown, /additional records remain in the complete source below/u);
  const index = indexMarkdownDocument(redactedCsv.markdown);
  const csvSourceBlock = index.blocks.find(block => block.kind === "code_fence" && block.language === "csv");
  assert.ok(csvSourceBlock, "the full source is indexed as a selectable Markdown block");
  const selectedCsv = selectMarkdownRange(redactedCsv.markdown, index, { blockId: csvSourceBlock.id });
  assert.ok(selectedCsv.text.includes("119,[REDACTED]"));

  const credentialCsv = inspect(csvSource, "text/csv", { includeCredentialValues: true });
  assert.match(credentialCsv.markdown, /### Complete source \(credential values included\)/u);
  assert.ok(credentialCsv.markdown.includes("119,fixture-secret-119"), "the complete source exposes values beyond the bounded preview when explicitly requested");

  const tsvSource = "id\tname\n1\tA\n2\tB\n";
  const tsv = inspect(tsvSource, "text/tab-separated-values");
  assert.ok(tsv.markdown.includes("### Complete redacted source"));
  assert.ok(tsv.markdown.includes("```tsv\n" + tsvSource));
});

test("event streams and binary bodies expose format-specific diagnostics and complete safe views", () => {
  const events = inspect("event: update\ndata: {\"token\":\"fixture-secret\"}\n\nevent: done\ndata: complete\n", "text/event-stream");
  assert.equal(events.format, "event-stream");
  assert.equal(events.analysis.eventCount, 2);
  assert.equal(events.analysis.dataLineCount, 2);
  assert.equal(events.analysis.eventTypes.update, 1);
  assert.equal(events.analysis.eventTypes.done, 1);
  assert.equal(events.analysis.normalizedDataPayloadCount, 1);
  assert.equal(events.credentialRedactions, 1);
  assert.equal(events.sourceText.includes("fixture-secret"), false);
  assert.match(events.markdown, /### Event index/u);
  assert.match(events.markdown, /#### Event 1 data shape/u);
  assert.equal(events.markdown.includes("fixture-secret"), false);

  const malformed = inspect("event: update\ndata: {\"status\":broken_value}\n\n", "text/event-stream");
  assert.equal(malformed.analysis.events[0].dataParseMode, "json_parse_failed");
  assert.match(malformed.markdown, /#### JSON-like payload parse failures/u);

  const log = inspect("2026-10-18T12:34:56Z ERROR request_id=abc status=503 timeout\nINFO completed\n", "text/plain");
  assert.equal(log.analysis.lineStructure.nonEmptyLineCount, 2);
  assert.match(log.markdown, /### Line index/u);
  assert.ok(log.markdown.includes("request\\_id"));
  assert.match(log.markdown, /503/u);

  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(20, 16);
  png.writeUInt32BE(10, 20);
  const image = inspectResponseBody(png, "image/png", { base64Encoded: true });
  assert.equal(image.format, "binary");
  assert.equal(image.analysis.format, "png");
  assert.equal(image.analysis.width, 20);
  assert.equal(image.analysis.height, 10);
  assert.equal(image.displayText, png.toString("base64"));
  assert.match(image.markdown, /### Complete base64 body/u);
});
