/**
 * Output file generation for ActiveTab API runs.
 *
 * Privacy policy (default): exports contain redacted projections only.
 * - The raw natural-language goal is never written to disk.
 * - Raw caller input is replaced by a schema-derived projection. Fields
 *   whose names suggest credentials or secrets are omitted entirely;
 *   all other scalar values are redacted to a bounded placeholder so
 *   structural shape (types, counts) remains inspectable without
 *   disclosing task specifics.
 * - Browser evidence is referenced by evidence id, never embedded.
 *
 * Sensitive (full) exports are opt-in per call and must be explicitly
 * authorized by the run owner.
 *
 * Zero dependencies — uses only Node.js platform APIs.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|credential|session|cookie|auth/i;
const PLACEHOLDER = "[redacted]";
const MAX_EXPORT_BYTES = 256 * 1024;

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeCsv(str) {
  let value = str ?? "";
  let s = String(value);
  if (typeof value === "string") {
    let first = 0;
    while (first < s.length && [" ", "\t", "\r", "\n"].includes(s[first])) first++;
    if (["=", "+", "-", "@"].includes(s[first])) s = `'${s}`;
  }
  let quote = false;
  for (const character of s) if ([",", '"', "\n", "\r"].includes(character)) quote = true;
  if (quote) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function flattenObject(obj, prefix = "") {
  const result = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      result[flatKey] = "";
    } else if (typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, flatKey));
    } else if (Array.isArray(value)) {
      result[flatKey] = JSON.stringify(value);
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}

/**
 * Redact a caller-input object into a schema-shaped projection.
 * Sensitive-looking fields are omitted; other values become placeholders.
 * Arrays preserve length; nested objects preserve shape.
 */
export function redactInput(input, schema) {
  if (input === null || input === undefined) return input ?? null;
  if (Array.isArray(input)) return input.map(item => redactInput(item, undefined));
  if (typeof input !== "object") {
    if (typeof input === "string") return PLACEHOLDER;
    if (typeof input === "number" || typeof input === "boolean") return input;
    return PLACEHOLDER;
  }
  const props = schema?.properties ?? {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) continue; // never export credential-like fields
    if (props[key]?.type === "integer" || props[key]?.type === "number" ||
        props[key]?.type === "boolean" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    result[key] = redactInput(value, props[key]);
  }
  return result;
}

function defaultFormats(records) {
  const formats = ["json", "md"];
  if (Array.isArray(records) && records.length > 0) formats.push("csv");
  return formats;
}

function projectExportOutput(output, includeSensitive) {
  const fields = output?.schema?.items;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    if (!Array.isArray(output?.records) || output.records.length === 0) return output;
    return {
      ...output,
      records: [],
      completeness: "incomplete",
      release: { status: "partial", omittedFields: ["unclassified_records"] },
      verification: {
        ...output.verification,
        releaseStatus: "partial",
        omittedFields: ["unclassified_records"],
        reason: "Records without a declared field schema cannot be released as structured output."
      }
    };
  }
  const allowed = new Set(Object.entries(fields)
    .filter(([, field]) => field?.dataClass === "public"
      || (includeSensitive && ["personal", "sensitive"].includes(field?.dataClass)))
    .map(([name]) => name));
  const omitted = Object.keys(fields).filter(name => !allowed.has(name));
  if (omitted.length === 0) return output;
  return {
    ...output,
    schema: { ...output.schema, items: Object.fromEntries(Object.entries(fields).filter(([name]) => allowed.has(name))) },
    ...(Array.isArray(output.records) ? { records: output.records.map(record => Object.fromEntries(Object.entries(record ?? {}).filter(([name]) => allowed.has(name)))) } : {}),
    ...(Array.isArray(output.fieldProvenance) ? { fieldProvenance: output.fieldProvenance.map(record => ({
      ...record,
      fields: Object.fromEntries(Object.entries(record.fields ?? {}).filter(([name]) => allowed.has(name)))
    })) } : {}),
    completeness: "incomplete",
    release: { status: "partial", omittedFields: omitted },
    verification: {
      ...output.verification,
      releaseStatus: "partial",
      omittedFields: omitted,
      reason: "Some output fields were omitted by the artifact release policy."
    }
  };
}

function generateMarkdown(taskId, input, output, status) {
  const lines = [
    `# Task Result: ${taskId}`,
    ``,
    `**Status:** ${status}`,
    `**Completed:** ${new Date().toISOString()}`,
    ``,
    `## Input (redacted)`,
    ``,
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    ``,
    `## Output`,
    ``,
    "```json",
    JSON.stringify(output, null, 2),
    "```",
    ``
  ];
  return lines.join("\n");
}

function generateCsv(records) {
  if (!Array.isArray(records) || records.length === 0) return "no data\n";
  const flattened = records.map(r => flattenObject(r));
  const allKeys = [...new Set(flattened.flatMap(r => Object.keys(r)))];
  const header = allKeys.map(escapeCsv).join(",");
  const rows = flattened.map(r => allKeys.map(k => escapeCsv(r[k] ?? "")).join(","));
  return [header, ...rows].join("\n") + "\n";
}

function generateXml(taskId, input, output, status) {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<task id="${escapeXml(taskId)}" status="${escapeXml(status)}">`,
    `  <input>${escapeXml(JSON.stringify(input))}</input>`,
    `  <output>${escapeXml(JSON.stringify(output))}</output>`,
    `</task>`
  ];
  return lines.join("\n");
}

/**
 * Generate output files for a completed run.
 *
 * @param {string} taskId
 * @param {object} data - { goal, input, output, status, evidenceId, inputSchema }
 * @param {string} outputDir
 * @param {object} [options]
 * @param {string[]} [options.formats] - Explicit format list; default is json+md(+csv when records exist).
 * @param {boolean} [options.includeSensitive] - Owner-authorized full export (raw input/goal). Default false.
 * @param {boolean} [options.includeEvidence] - Embed evidence snapshot in the JSON export. Default false;
 *   evidence references (evidence_id) are included by default without payloads.
 * @returns {Promise<object>} Map matching the output_files shape.
 */
export async function generateOutputFiles(taskId, { goal, input, output, status, evidenceId, inputSchema }, outputDir, options = {}) {
  const dir = join(outputDir, taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const formats = options.formats ?? defaultFormats(output?.records);
  const allowed = new Set(["json", "md", "csv", "xml"]);
  const requested = [...new Set(formats)].filter(format => allowed.has(format));
  const includeSensitive = options.includeSensitive === true && options.authorized === true;

  const exportedInput = includeSensitive ? input : redactInput(input, inputSchema);
  const exportedGoal = includeSensitive ? goal : "[redacted]";
  const exportOutput = { ...projectExportOutput(output, includeSensitive), goal: exportedGoal };
  if (evidenceId && !includeSensitive) exportOutput.evidence_id = evidenceId;
  const artifactStatus = exportOutput.completeness === "incomplete" && status === "succeeded"
    ? "partial"
    : status;

  const files = {};
  const write = async (name, content, mime) => {
    if (Buffer.byteLength(content, "utf8") > MAX_EXPORT_BYTES) {
      throw new Error(`Export ${name} exceeds the ${MAX_EXPORT_BYTES}-byte bound.`);
    }
    const path = join(dir, name);
    await writeFile(path, content, { mode: 0o600 });
    return {
      file_name: name,
      file_size: Buffer.byteLength(content),
      download_url: `local://output/${taskId}/${name}`,
      ...(mime ? { content_type: mime } : {})
    };
  };

  for (const format of requested) {
    if (format === "json") {
      files.json = await write("result.json", JSON.stringify({
        task_id: taskId,
        status: artifactStatus,
        goal: exportedGoal,
        input: exportedInput,
        output: exportOutput,
        ...(includeSensitive && options.includeEvidence === true && options.evidence ? { evidence: options.evidence } : {})
      }, null, 2), "application/json");
    } else if (format === "md") {
      files.md = await write("result.md", generateMarkdown(taskId, exportedInput, exportOutput, artifactStatus), "text/markdown");
    } else if (format === "csv") {
      // A flat CSV cannot express that privacy filtering removed columns. Do
      // not publish a partial row set as if it were the complete result.
      if (exportOutput.completeness !== "incomplete") {
        files.csv = await write("result.csv", generateCsv(exportOutput?.records), "text/csv");
      }
    } else if (format === "xml") {
      files.xml = await write("result.xml", generateXml(taskId, exportedInput, exportOutput, artifactStatus), "application/xml");
    }
  }

  return files;
}
