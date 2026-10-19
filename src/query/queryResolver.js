import { normalizeFieldValue } from "../extraction/extractionContract.js";
import { parseSemanticQuery, SemanticQuerySyntaxError } from "./queryParser.js";

const MAX_QUERY_RECORDS = 256;
const ROLE_ALIASES = new Map([
  ["name", "name"], ["title", "name"], ["productname", "name"], ["itemname", "name"], ["price", "price"],
  ["cost", "price"], ["saleprice", "price"], ["description", "description"], ["summary", "description"],
  ["sku", "sku"], ["productid", "sku"], ["rating", "rating"], ["date", "date"], ["author", "author"],
  ["category", "category"], ["availability", "availability"], ["url", "url"], ["count", "count"]
]);

function nameKey(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function roleFor(value) {
  const key = nameKey(value);
  return ROLE_ALIASES.get(key) ?? key;
}

function evidenceMatches(page, expected) {
  const actual = page?.evidence;
  if (page?.schemaVersion !== 3 || !actual || typeof actual.observationId !== "string"
    || typeof actual.targetId !== "string" || !Number.isInteger(actual.documentGeneration)) return false;
  if (!Array.isArray(page.controls) || page.controls.length > 384
    || !Array.isArray(page.forms) || page.forms.length > 32
    || !Array.isArray(page.regions) || page.regions.length > 96
    || !Array.isArray(page.collections) || page.collections.length > 48
    || page.controls.some(control => !control || typeof control !== "object")
    || page.forms.some(form => !form || typeof form !== "object")
    || page.regions.some(region => !region || typeof region !== "object")
    || page.collections.some(collection => !collection || typeof collection !== "object"
      || !Array.isArray(collection.fields) || collection.fields.length > 16
      || !Array.isArray(collection.items) || collection.items.length > 64
      || collection.items.some(item => !item || typeof item !== "object" || !Array.isArray(item.fields) || item.fields.length > 16))) return false;
  return !expected || (expected.observationId === actual.observationId
    && expected.targetId === actual.targetId && expected.documentGeneration === actual.documentGeneration);
}

function safeTokens(value) {
  const stopwords = new Set(["a", "and", "for", "in", "of", "the"]);
  return (String(value ?? "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => !stopwords.has(token));
}

function elementSearchIncompleteReasons(page) {
  const reasons = [];
  const candidates = page?.candidateCoverage;
  if (!candidates) reasons.push("candidate_coverage_unknown");
  else {
    if (candidates.pageCoverage !== "complete") {
      reasons.push(candidates.pageCoverage === "partial" ? "candidate_limit" : "candidate_coverage_unknown");
    }
    if (candidates.selectionScope !== "page") reasons.push("candidate_scope_limited");
    if (candidates.scopeCoverage !== "complete") reasons.push("candidate_limit");
  }
  const frameCoverage = page?.coverage?.outOfProcessFrames;
  if (frameCoverage !== "complete") reasons.push(frameCoverage === "incomplete" ? "frame_unavailable" : "frame_coverage_unknown");
  const shadowCoverage = page?.coverage?.closedShadowRoots;
  if (shadowCoverage !== "complete" || page?.warnings?.includes("closed_shadow_dom_not_observed")) {
    reasons.push(shadowCoverage === "unavailable" || page?.warnings?.includes("closed_shadow_dom_not_observed")
      ? "closed_shadow_root"
      : "closed_shadow_coverage_unknown");
  }
  return [...new Set(reasons)];
}

function resolveElement(page, query) {
  if (query.role === "form") return { status: "unsupported", reasonCode: "forms_are_scope_only" };
  const forms = new Map((page.forms ?? []).map(form => [form.ref, form]));
  const regions = new Map((page.regions ?? []).map(region => [region.ref, region]));
  const scopeTerms = safeTokens(query.scope);
  const candidates = (page.controls ?? []).filter(control => {
    const roleMatches = control.role === query.role || control.classification?.value === query.role
      || query.role === "textbox" && control.role === "searchbox";
    if (!roleMatches || control.identityEvidence !== "fresh_dom_accessibility_candidate" || !control.targetRef) return false;
    if (!scopeTerms.length) return true;
    const form = control.formRef ? forms.get(control.formRef) : null;
    const region = control.regionRef ? regions.get(control.regionRef) : null;
    const scopeText = [region?.kind, region?.label?.value, region?.tag,
      form ? "form" : "", form?.method, control.label?.value, control.contextLabel?.value]
      .filter(Boolean).join(" ");
    const available = new Set(safeTokens(scopeText));
    return (!scopeTerms.includes("form") || Boolean(form)) && scopeTerms.every(term => available.has(term));
  });
  const incompleteReasons = elementSearchIncompleteReasons(page);
  if (incompleteReasons.length) return {
    status: "incomplete",
    reasonCode: incompleteReasons[0],
    incompletenessReasons: incompleteReasons,
    candidateCount: candidates.length,
    actionAuthorized: false
  };
  if (candidates.length !== 1) return {
    status: candidates.length ? "ambiguous" : "not_found",
    candidateCount: candidates.length,
    reasonCode: candidates.length ? "multiple_observed_controls" : "control_not_observed",
    actionAuthorized: false
  };
  const control = candidates[0];
  return Object.freeze({
    status: "unique",
    target: Object.freeze({ targetRef: control.targetRef, frameId: control.frameId, role: control.role, label: control.label?.value ?? null }),
    observationId: page.evidence.observationId,
    targetId: page.evidence.targetId,
    documentGeneration: page.evidence.documentGeneration,
    actionAuthorized: false
  });
}

function collectionMatchesName(collection, name) {
  const requested = nameKey(name).replace(/s$/u, "");
  if (collection.kind === "repeated_dom_structure" || collection.kind === "html_table") return true;
  const kind = nameKey(String(collection.kind ?? "").replace(/^microdata_/u, "")).replace(/s$/u, "");
  return kind === requested;
}

function findSourceField(collection, requestedName) {
  const role = roleFor(requestedName);
  const matches = (collection.fields ?? []).filter(field => roleFor(field.semanticRole ?? "") === role
    || nameKey(field.name) === nameKey(requestedName)
    || field.label?.value && nameKey(field.label.value) === nameKey(requestedName));
  return matches.length === 1 ? { status: "available", field: matches[0] }
    : { status: matches.length ? "ambiguous" : "unavailable" };
}

function itemSourceFields(item, descriptor) {
  return (item.fields ?? []).filter(field => descriptor.sourceKey && descriptor.sourceTag
    ? field.sourceKey === descriptor.sourceKey && field.sourceTag === descriptor.sourceTag
    : field.name === descriptor.name && field.semanticRole === descriptor.semanticRole);
}

function callPolicy(callback, input) {
  if (typeof callback !== "function") return false;
  try { return callback(Object.freeze(input)) === true; }
  catch { return false; }
}

function resolveCollection(page, query, options) {
  if (query.fields.some(field => field.kind !== "scalar")) return { status: "unsupported", reasonCode: "nested_collection_resolution_not_supported" };
  const sourceDescriptors = query.fields.map(field => ({ requested: field, resolution: null }));
  const candidates = [];
  let ambiguousFieldAssociation = false;
  for (const collection of page.collections ?? []) {
    if (!collectionMatchesName(collection, query.name)) continue;
    const descriptors = sourceDescriptors.map(({ requested }) => findSourceField(collection, requested.name));
    ambiguousFieldAssociation ||= descriptors.some(item => item.status === "ambiguous");
    if (descriptors.every(item => item.status === "available")) candidates.push({ collection, descriptors: descriptors.map(item => item.field) });
  }
  if (candidates.length === 0 && ambiguousFieldAssociation) return {
    status: "ambiguous", reasonCode: "ambiguous_field_association", completeness: "incomplete"
  };
  if (candidates.length !== 1) return {
    status: candidates.length ? "ambiguous" : "not_found",
    reasonCode: candidates.length ? "multiple_matching_collections" : "collection_or_fields_unavailable",
    candidateCount: candidates.length,
    completeness: "incomplete"
  };
  const { collection, descriptors } = candidates[0];
  if (collection.recordBindingStatus === "ambiguous") return { status: "ambiguous", reasonCode: "record_group_ambiguous", completeness: "incomplete" };
  if (typeof options.authorizeField !== "function" || typeof options.authorizeRelease !== "function") {
    return { status: "blocked", reasonCode: "trusted_field_read_and_release_policy_required", completeness: "incomplete" };
  }
  const bindings = descriptors.map((source, index) => ({ source, requested: query.fields[index] }));
  for (const { source, requested } of bindings) {
    const policyInput = {
      origin: page.page?.origin ?? null,
      observationId: page.evidence.observationId,
      targetId: page.evidence.targetId,
      collectionRef: collection.ref,
      fieldName: source.name,
      sourceKey: source.sourceKey ?? null,
      semanticRole: source.semanticRole ?? null
    };
    if (!callPolicy(options.authorizeField, policyInput) || !callPolicy(options.authorizeRelease, policyInput)) {
      return { status: "blocked", reasonCode: "field_read_or_release_denied", completeness: "incomplete" };
    }
    if (source.status === "unknown" || source.semanticRoleStatus === "unknown" && !source.name) {
      return { status: "incomplete", reasonCode: "field_source_unverified", field: requested.name };
    }
  }
  const maxRecords = options.maxRecords ?? MAX_QUERY_RECORDS;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_QUERY_RECORDS) {
    return { status: "invalid", reasonCode: "query_record_limit_invalid" };
  }
  const rows = (collection.items ?? []).slice(0, maxRecords);
  const records = [];
  let unresolved = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const item = rows[rowIndex];
    const values = {};
    const provenance = {};
    for (const { source, requested } of bindings) {
      const matches = itemSourceFields(item, source);
      const observed = matches.length === 1 ? matches[0] : null;
      const raw = observed?.status === "observed" ? observed.value : "";
      const normalized = normalizeFieldValue(raw, { type: requested.type, required: true });
      const resolutionState = matches.length > 1 ? "ambiguous"
        : matches.length === 0 || observed?.status !== "observed" || !observed.valueRef ? "unavailable"
          : !String(raw ?? "").trim() ? "missing"
            : !normalized.valid ? "invalid"
              : Object.is(normalized.value, String(raw).trim()) ? "observed" : "normalized";
      if (!["observed", "normalized"].includes(resolutionState)) unresolved = true;
      values[requested.name] = normalized.valid ? normalized.value : null;
      provenance[requested.name] = Object.freeze({
        collectionRef: collection.ref,
        recordRef: item.ref,
        observationId: page.evidence.observationId,
        valueRef: observed?.valueRef ?? observed?.evidenceRef ?? null,
        sourceKey: observed?.sourceKey ?? source.sourceKey ?? null,
        sourceTag: observed?.sourceTag ?? source.sourceTag ?? null,
        resolutionState
      });
    }
    records.push(Object.freeze({ values: Object.freeze(values), provenance: Object.freeze(provenance) }));
  }
  return Object.freeze({
    status: unresolved || collection.itemsTruncated === true ? "incomplete" : "available",
    collectionRef: collection.ref,
    records: Object.freeze(records),
    completeness: "observed_partial",
    scopeCoverage: collection.itemsTruncated === true || (collection.items?.length ?? 0) > rows.length ? "incomplete" : "complete",
    pageCompleteness: collection.completeness ?? "unknown"
  });
}

/** Resolve a parsed query only against one fresh semantic-page observation. */
export function resolveSemanticQuery(page, queryInput, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return { status: "invalid", reasonCode: "query_options_invalid" };
  let query;
  try { query = typeof queryInput === "string" ? parseSemanticQuery(queryInput) : validateSemanticQueryAst(queryInput); }
  catch (error) {
    if (error instanceof SemanticQuerySyntaxError) return { status: "unsupported", reasonCode: error.code };
    throw error;
  }
  if (!query || !["element", "collection"].includes(query.kind)) return { status: "invalid", reasonCode: "query_ast_invalid" };
  if (!evidenceMatches(page, options.expectedEvidence)) return { status: "stale_or_unavailable", reasonCode: "semantic_page_evidence_mismatch" };
  if (query.kind === "element") return resolveElement(page, query);
  return resolveCollection(page, query, options);
}

function validateSemanticQueryAst(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticQuerySyntaxError("Query AST is malformed or exceeds its nesting limit.", "query_ast_invalid");
  }
  const exactKeys = (object, expected) => Object.keys(object).length === expected.length
    && expected.every(key => Object.hasOwn(object, key));
  if (value.kind === "element" && exactKeys(value, ["kind", "role", "description", "scope"])) {
    const parsed = parseSemanticQuery(`find ${value.description}${value.scope ? ` in ${value.scope}` : ""}`);
    if (parsed.kind !== "element" || parsed.role !== value.role) {
      throw new SemanticQuerySyntaxError("Element query AST does not match its bounded query text.", "query_ast_invalid");
    }
    return parsed;
  }
  if (value.kind !== "collection" || !exactKeys(value, ["kind", "name", "fields"]) || !Array.isArray(value.fields)) {
    throw new SemanticQuerySyntaxError("Collection query AST is malformed.", "query_ast_invalid");
  }
  const allowedIdentifier = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
  if (!allowedIdentifier.test(value.name) || value.fields.length < 1 || value.fields.length > 32) {
    throw new SemanticQuerySyntaxError("Collection query AST exceeds its identifier or field bounds.", "query_ast_invalid");
  }
  const names = new Set();
  const fields = value.fields.map(field => {
    if (!field || typeof field !== "object" || Array.isArray(field)) throw new SemanticQuerySyntaxError("Query field AST is malformed.", "query_ast_invalid");
    if (field.kind === "scalar" && exactKeys(field, ["name", "kind", "type"]) && allowedIdentifier.test(field.name)
      && new Set(["string", "number", "integer", "boolean"]).has(field.type)) {
      if (names.has(field.name)) throw new SemanticQuerySyntaxError("Query field AST contains duplicate fields.", "duplicate_query_field");
      names.add(field.name);
      return Object.freeze({ ...field });
    }
    if (field.kind === "collection" && exactKeys(field, ["name", "kind", "fields"]) && allowedIdentifier.test(field.name)
      && Array.isArray(field.fields) && depth < 3) {
      if (names.has(field.name)) throw new SemanticQuerySyntaxError("Query field AST contains duplicate fields.", "duplicate_query_field");
      names.add(field.name);
      const nested = validateSemanticQueryAst({ kind: "collection", name: field.name, fields: field.fields }, depth + 1);
      return Object.freeze({ name: nested.name, kind: "collection", fields: nested.fields });
    }
    throw new SemanticQuerySyntaxError("Query field AST is malformed or unsupported.", "query_ast_invalid");
  });
  return Object.freeze({ kind: "collection", name: value.name, fields: Object.freeze(fields) });
}
