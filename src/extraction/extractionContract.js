const FIELD_TYPES = new Set(["string", "number", "integer", "boolean"]);
const DATA_CLASSES = new Set(["public", "personal", "sensitive", "credential"]);

function isCode(value, maxLength = 64) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122) || character === "_" || character === "-" || character === ".")) return false;
  }
  return true;
}

export function normalizeHeader(value) {
  let result = "";
  let pendingSpace = false;
  for (const character of String(value ?? "").trim()) {
    const code = character.codePointAt(0);
    const whitespace = code === 0x20 || (code >= 0x09 && code <= 0x0d)
      || code === 0x85 || code === 0xa0 || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
      || code === 0x202f || code === 0x205f || code === 0x3000;
    if (whitespace) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    result += character.toLowerCase();
    pendingSpace = false;
  }
  return result;
}

/** Validate the trusted, registered extraction contract. */
export function validateExtractionContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return { valid: false, errors: ["Extraction contract must be an object."] };
  if (contract.version !== 1) errors.push("Extraction contract version must be 1.");
  if (contract.scopeKind !== undefined && contract.scopeKind !== "ephemeral_observed_read") errors.push("scopeKind is unsupported.");
  const ephemeralObservedRead = contract.scopeKind === "ephemeral_observed_read";
  if (!isCode(contract.id, 96)) errors.push("Extraction contract id must be a bounded identifier.");
  if (!Number.isInteger(contract.maxRecords) || contract.maxRecords < 1 || contract.maxRecords > 10_000) errors.push("maxRecords must be from 1 to 10000.");
  if (contract.expectedRecords !== undefined
    && (!Number.isInteger(contract.expectedRecords) || contract.expectedRecords < 0 || contract.expectedRecords > contract.maxRecords)) {
    errors.push("expectedRecords must be an exact collection size between 0 and maxRecords.");
  }
  if (!new Set(["exact_count", "pagination_exhausted"]).has(contract.completionPolicy)) {
    errors.push("completionPolicy must be exact_count or pagination_exhausted.");
  }
  if (contract.completionPolicy === "exact_count" && !Number.isInteger(contract.expectedRecords)) {
    errors.push("exact_count completion requires expectedRecords.");
  }
  if (contract.completionPolicy === "pagination_exhausted" && (contract.expectedRecords !== undefined || contract.pagination === undefined)) {
    errors.push("pagination_exhausted completion requires pagination and forbids an exact expectedRecords count.");
  }
  if (contract.minRecords !== undefined && (!Number.isInteger(contract.minRecords) || contract.minRecords < 0 || contract.minRecords > contract.maxRecords)) {
    errors.push("minRecords must be between 0 and maxRecords.");
  }
  if (contract.completionPolicy === "exact_count" && Number.isInteger(contract.expectedRecords)
    && Number.isInteger(contract.minRecords) && contract.minRecords > contract.expectedRecords) {
    errors.push("minRecords cannot exceed expectedRecords under exact_count completion.");
  }
  if (!Array.isArray(contract.fields) || contract.fields.length < 1 || contract.fields.length > 64) {
    errors.push("fields must contain between 1 and 64 entries.");
  } else {
    const names = new Set();
    const sources = new Set();
    for (const field of contract.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) { errors.push("Every extraction field must be an object."); continue; }
      if (!isCode(field.name, 64)) errors.push("Field names must be bounded identifiers.");
      if (names.has(field.name)) errors.push(`Field '${field.name}' is duplicated.`);
      names.add(field.name);
      const hasHeader = typeof field.sourceHeader === "string" && field.sourceHeader.trim().length > 0 && field.sourceHeader.length <= 160;
      const hasSourceKey = isCode(field.sourceKey, 128);
      if (hasHeader === hasSourceKey) errors.push(`Field '${field.name}' requires exactly one bounded sourceHeader or sourceKey.`);
      const sourceIdentity = hasHeader ? `header:${normalizeHeader(field.sourceHeader)}` : hasSourceKey ? `key:${field.sourceKey}` : null;
      if (sourceIdentity && sources.has(sourceIdentity)) errors.push(`Field '${field.name}' duplicates an extraction source.`);
      if (sourceIdentity) sources.add(sourceIdentity);
      if (!FIELD_TYPES.has(field.type)) errors.push(`Field '${field.name}' has an unsupported type.`);
      if (typeof field.required !== "boolean") errors.push(`Field '${field.name}' must declare required as a boolean.`);
      if (!DATA_CLASSES.has(field.dataClass)) errors.push(`Field '${field.name}' must declare a trusted dataClass.`);
    }
  }
  if (contract.recordGroup !== undefined) {
    const group = contract.recordGroup;
    if (!group || typeof group !== "object" || Array.isArray(group)
      || !isCode(group.containerTagName, 16) || !isCode(group.itemTagName, 16)
      || !isCode(group.containerClassToken, 128) || !isCode(group.itemClassToken, 128)) {
      errors.push("recordGroup must contain bounded observed container/item tag names and exact class tokens.");
    }
    if (contract.fields?.some(field => typeof field?.sourceHeader === "string")) {
      errors.push("recordGroup fields must use observed sourceKey mappings, not table headers.");
    }
    if (contract.fields?.some(field => !isCode(field?.sourceTagName, 16))) {
      errors.push("recordGroup fields require a bounded observed sourceTagName.");
    }
  } else if (contract.fields?.some(field => typeof field?.sourceKey === "string")) {
    errors.push("sourceKey fields require an observed recordGroup contract.");
  }
  if (!Array.isArray(contract.uniqueBy) || (!ephemeralObservedRead && contract.uniqueBy.length < 1)
    || contract.uniqueBy.length > 8 || contract.uniqueBy.some(name => !contract.fields?.some(field => field.name === name))) {
    errors.push(ephemeralObservedRead
      ? "uniqueBy must be empty or name declared fields for an ephemeral read."
      : "uniqueBy must name one or more declared fields.");
  }
  if (contract.pagination !== undefined) {
    if (!contract.pagination || typeof contract.pagination !== "object" || Array.isArray(contract.pagination)
      || !new Set(["rel_next_same_path", "explicit_next_same_path", "page_number_query", "virtualized_list"]).has(contract.pagination.kind)
      || !Number.isInteger(contract.pagination.maxPages) || contract.pagination.maxPages < 2 || contract.pagination.maxPages > 100) {
      errors.push("pagination must be a trusted bounded strategy with a page limit from 2 to 100.");
    } else {
      const allowedPaginationKeys = contract.pagination.kind === "page_number_query"
        ? new Set(["kind", "queryParameter", "maxPages"])
        : new Set(["kind", "maxPages"]);
      if (Object.keys(contract.pagination).some(key => !allowedPaginationKeys.has(key))) errors.push("pagination contains unsupported strategy fields.");
      if (contract.pagination.kind === "page_number_query"
        && (typeof contract.pagination.queryParameter !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(contract.pagination.queryParameter))) {
        errors.push("page_number_query requires a bounded queryParameter name.");
      }
    }
  }
  if (contract.origin !== undefined) {
    try {
      const parsed = new URL(contract.origin);
      if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.origin !== contract.origin) errors.push("origin must be an exact HTTP(S) origin.");
    } catch { errors.push("origin must be an exact HTTP(S) origin."); }
  }
  if (typeof contract.pagePath !== "string" || contract.pagePath.length > 2048
    || !contract.pagePath.startsWith("/") || contract.pagePath.startsWith("//")) {
    errors.push("pagePath must be an exact absolute path within the registered origin.");
  } else {
    try {
      const page = new URL(contract.pagePath, "https://scope.invalid");
      if (page.pathname !== contract.pagePath || page.search || page.hash || page.origin !== "https://scope.invalid") {
        errors.push("pagePath must not contain a query, fragment, or origin change.");
      }
    } catch { errors.push("pagePath must be an exact absolute path within the registered origin."); }
  }
  if (!(ephemeralObservedRead && contract.environmentId === null) && !isCode(contract.environmentId, 128)) errors.push("environmentId must be a bounded identifier.");
  if (!(ephemeralObservedRead && contract.applicationId === null) && !isCode(contract.applicationId, 96)) errors.push("applicationId must be a bounded identifier.");
  if (ephemeralObservedRead && ((contract.environmentId === null) !== (contract.applicationId === null))) {
    errors.push("An unprofiled ephemeral read must have both environmentId and applicationId null.");
  }
  if (!isCode(contract.principalId, 128)) errors.push("principalId must bind the extraction contract to a verified principal.");
  return { valid: errors.length === 0, errors };
}

function parseNumber(value) {
  if (!value) return null;
  let index = 0;
  if (value[index] === "+" || value[index] === "-") index++;
  const integerStart = index;
  let digitCount = 0;
  let groupLength = 0;
  let hasComma = false;
  while (index < value.length && value[index] !== ".") {
    const character = value[index];
    if (character >= "0" && character <= "9") {
      digitCount++;
      groupLength++;
    } else if (character === ",") {
      if (groupLength === 0 || (hasComma && groupLength !== 3) || (!hasComma && groupLength > 3)) return null;
      hasComma = true;
      groupLength = 0;
    } else return null;
    index++;
  }
  if (digitCount === 0 || groupLength === 0 || (hasComma && groupLength !== 3)) return null;
  if (hasComma && groupLength === 0) return null;
  if (value[index] === ".") {
    index++;
    const decimalStart = index;
    while (index < value.length && value[index] >= "0" && value[index] <= "9") index++;
    if (index === decimalStart) return null;
  }
  if (index !== value.length || integerStart >= value.length) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeFieldValue(raw, field) {
  const value = String(raw ?? "").trim();
  if (!value) return { valid: !field.required, value: null };
  if (field.type === "string") return { valid: true, value };
  if (field.type === "boolean") {
    const normalized = value.toLocaleLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return { valid: true, value: true };
    if (["false", "no", "0"].includes(normalized)) return { valid: true, value: false };
    return { valid: false, value: null };
  }
  const numeric = parseNumber(value);
  if (numeric === null) return { valid: false, value: null };
  if (field.type === "integer" && !Number.isInteger(numeric)) return { valid: false, value: null };
  return { valid: true, value: numeric };
}

/** Describe how one observed value resolved without retaining its raw text. */
export function fieldResolutionState(raw, normalized, sourceMatchCount = 1) {
  if (!Number.isInteger(sourceMatchCount) || sourceMatchCount < 0) throw new Error("Field source match count must be a non-negative integer.");
  if (sourceMatchCount > 1) return "ambiguous";
  if (sourceMatchCount === 0) return "unavailable";
  const observed = String(raw ?? "").trim();
  if (!observed) return "missing";
  if (!normalized?.valid) return "invalid";
  return Object.is(normalized.value, observed) ? "observed" : "normalized";
}

export function fieldIsPermitted(field, authorizeField) {
  if (typeof authorizeField !== "function") return field.dataClass === "public";
  return authorizeField(Object.freeze({ ...field })) === true;
}

export function isExtractionCode(value, maxLength) { return isCode(value, maxLength); }
