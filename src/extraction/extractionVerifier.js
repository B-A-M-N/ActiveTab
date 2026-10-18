export function verifyExtractionResult(result) {
  if (!result || result.completeness !== "complete") {
    return { status: "incomplete", reason: "Extraction did not meet every completeness check." };
  }
  if (!result.verification || typeof result.verification !== "object" || Array.isArray(result.verification)) {
    return { status: "incomplete", reason: "Output verification receipt is missing or malformed." };
  }
  if (!Array.isArray(result.records) || result.records.length !== result.verification.recordCount) {
    return { status: "incomplete", reason: "Output record count does not match its verification receipt." };
  }
  const countComplete = result.verification.completionPolicy === "exact_count"
    ? result.records.length === result.verification.expectedRecords
    : result.verification.completionPolicy === "pagination_exhausted" && result.verification.paginationExhausted === true;
  if (!countComplete || result.verification.pageCount < 1) {
    return { status: "incomplete", reason: "Output does not satisfy its declared count-completion policy or contains no page evidence." };
  }
  if (result.verification.invalidRows !== 0 || result.verification.duplicateKeys !== 0
    || (result.verification.invalidUniqueKeys ?? 0) !== 0 || result.verification.overflow
    || (result.verification.failures?.length ?? 0) > 0) {
    return { status: "incomplete", reason: "Extraction contains invalid rows, duplicate keys, or a record-limit overflow." };
  }
  const schemaFields = result.schema?.items;
  if (!Array.isArray(result.fieldProvenance) || result.fieldProvenance.length !== result.records.length) {
    return { status: "incomplete", reason: "Per-record provenance is missing or does not match the output records." };
  }
  for (let recordIndex = 0; recordIndex < result.fieldProvenance.length; recordIndex++) {
    const record = result.fieldProvenance[recordIndex];
    if (record.recordIndex !== recordIndex || Object.keys(record.fields ?? {}).length !== Object.keys(schemaFields ?? {}).length
      || Object.keys(schemaFields ?? {}).some(name => !Object.hasOwn(record.fields ?? {}, name))) {
      return { status: "incomplete", reason: "A record does not have provenance for every declared field." };
    }
    for (const [name, field] of Object.entries(record.fields ?? {})) {
      const fieldUrl = (() => { try { return new URL(field.pageUrl); } catch { return null; } })();
      if (!field.observationId || field.validation !== "valid" || field.method !== "visible_html_table_cell"
        || field.sourceHeader !== schemaFields?.[name]?.sourceHeader
        || !fieldUrl || fieldUrl.origin !== result.scope?.origin || fieldUrl.pathname !== result.scope?.pagePath
        || fieldUrl.search || fieldUrl.hash) {
        return { status: "incomplete", reason: "A field lacks valid observation provenance." };
      }
    }
  }
  const fields = schemaFields;
  if (!fields || typeof fields !== "object") return { status: "incomplete", reason: "Output schema is missing." };
  for (const record of result.records) {
    const names = Object.keys(record ?? {});
    if (names.length !== Object.keys(fields).length || names.some(name => !Object.hasOwn(fields, name))) {
      return { status: "incomplete", reason: "A record contains missing or undeclared fields." };
    }
  }
  if (!Array.isArray(result.verification.uniqueBy) || result.verification.uniqueBy.length === 0
    || result.verification.uniqueBy.some(name => !Object.hasOwn(fields, name))) {
    return { status: "incomplete", reason: "Output uniqueness contract is missing or malformed." };
  }
  const uniqueKeys = new Set();
  for (const record of result.records) {
    const values = result.verification.uniqueBy.map(name => record[name]);
    if (values.some(value => value === null || value === undefined || value === "")) {
      return { status: "incomplete", reason: "A record is missing a declared uniqueness key." };
    }
    const key = JSON.stringify(values);
    if (uniqueKeys.has(key)) return { status: "incomplete", reason: "Output contains duplicate records under its uniqueness contract." };
    uniqueKeys.add(key);
  }
  for (const record of result.records) {
    for (const [name, field] of Object.entries(fields)) {
      const value = record?.[name];
      if (field.required && (value === null || value === undefined || value === "")) {
        return { status: "incomplete", reason: `Required field '${name}' is missing.` };
      }
      if (value === null || value === undefined) continue;
      const valid = field.type === "string" ? typeof value === "string"
        : field.type === "integer" ? Number.isInteger(value)
          : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : field.type === "boolean" ? typeof value === "boolean" : false;
      if (!valid) return { status: "incomplete", reason: `Field '${name}' does not match its declared type.` };
    }
  }
  return { status: "complete", reason: "Schema, field provenance, counts, uniqueness, and completeness checks passed." };
}
