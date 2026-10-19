import { normalizeHeader, validateExtractionContract } from "../extraction/extractionContract.js";
import { validateSiteCapabilityManifest } from "./siteCapabilityManifest.js";

/** Compile an observed table and caller-authored field contract into a candidate recipe. */
export function compileTableRecipe({ candidate, capabilityId, capabilityVersion = 1, fields, classifyField, authorizePagination, maxRecords, minRecords = 1, expectedRecords, completionPolicy = "exact_count", uniqueBy = [], pagination } = {}) {
  if (!candidate || candidate.kind !== "visible_html_table" || candidate.qualificationStatus !== "candidate") {
    throw new Error("Recipe compilation requires a discovered visible HTML table candidate.");
  }
  if (typeof candidate.principalId !== "string" || candidate.principalId.length === 0) {
    throw new Error("Recipe compilation requires a verified principal binding.");
  }
  if (typeof classifyField !== "function") {
    throw new Error("Recipe compilation requires a trusted field-classification policy.");
  }
  const headers = new Set(candidate.headers ?? []);
  const classifiedFields = (fields ?? []).map(field => {
    if (!headers.has(field.sourceHeader)) throw new Error(`Source header '${field.sourceHeader}' was not present in the observed table.`);
    const dataClass = classifyField(Object.freeze({
      applicationId: candidate.applicationId,
      environmentId: candidate.environmentId,
      origin: candidate.origin,
      fieldName: field.name,
      sourceHeader: field.sourceHeader,
      type: field.type
    }));
    if (!["public", "personal", "sensitive", "credential"].includes(dataClass)) {
      throw new Error(`Field '${field.name}' has no trusted sensitivity classification.`);
    }
    return { ...field, dataClass };
  });
  if (pagination !== undefined) {
    const supportedKinds = new Set(["rel_next_same_path", "explicit_next_same_path", "page_number_query", "virtualized_list"]);
    if (!supportedKinds.has(pagination?.kind)
      || !candidate.paginationMethods?.includes(pagination.kind)
      || (pagination.kind === "page_number_query" && !candidate.paginationQueryParameters?.includes(pagination.queryParameter))
      || (pagination.kind === "virtualized_list" && candidate.kind !== "visible_html_table")
      || typeof authorizePagination !== "function"
      || authorizePagination(Object.freeze({
        origin: candidate.origin,
        environmentId: candidate.environmentId,
        applicationId: candidate.applicationId,
        pagePath: candidate.pagePath,
        kind: pagination.kind,
        ...(pagination.queryParameter ? { queryParameter: pagination.queryParameter } : {}),
        maxPages: pagination.maxPages
      })) !== true) {
      throw new Error("Pagination was not discovered and explicitly permitted by the trusted application policy.");
    }
  }
  const extractionContract = {
    version: 1,
    id: capabilityId,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    environmentId: candidate.environmentId,
    applicationId: candidate.applicationId,
    principalId: candidate.principalId,
    fields: structuredClone(classifiedFields),
    maxRecords,
    minRecords,
    ...(expectedRecords === undefined ? {} : { expectedRecords }),
    completionPolicy,
    uniqueBy: [...uniqueBy],
    ...(pagination ? { pagination: { kind: pagination.kind, ...(pagination.queryParameter ? { queryParameter: pagination.queryParameter } : {}), maxPages: pagination.maxPages } } : {})
  };
  const contractCheck = validateExtractionContract(extractionContract);
  if (!contractCheck.valid) throw new Error(`Extraction contract is invalid: ${contractCheck.errors.join(" ")}`);
  const manifest = {
    version: 1,
    capabilityId,
    capabilityVersion,
    kind: "visible_html_table",
    applicationId: candidate.applicationId,
    environmentId: candidate.environmentId,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    principalId: candidate.principalId,
    extractionContract,
    discoveredFrom: { observationId: candidate.observationId, tableIndex: candidate.tableIndex },
    qualification: { status: "candidate" }
  };
  const validation = validateSiteCapabilityManifest(manifest);
  if (!validation.valid) throw new Error(`Capability candidate is invalid: ${validation.errors.join(" ")}`);
  return Object.freeze(manifest);
}

/** Compile an observed repeated DOM record group into a typed extraction recipe. */
export function compileRecordGroupRecipe({ candidate, capabilityId, capabilityVersion = 1, fields, classifyField, authorizePagination, maxRecords, minRecords = 1, expectedRecords, completionPolicy = "exact_count", uniqueBy = [], pagination } = {}) {
  if (!candidate || candidate.kind !== "visible_record_group" || candidate.qualificationStatus !== "candidate"
    || !candidate.recordGroup || !Array.isArray(candidate.fields)) {
    throw new Error("Recipe compilation requires a discovered visible record group.");
  }
  if (typeof candidate.principalId !== "string" || candidate.principalId.length === 0) {
    throw new Error("Recipe compilation requires a verified principal binding.");
  }
  if (typeof classifyField !== "function") {
    throw new Error("Recipe compilation requires a trusted field-classification policy.");
  }
  const observedSources = new Map(candidate.fields.map(field => [field.sourceKey, field.sourceTagName]));
  const classifiedFields = (fields ?? []).map(field => {
    const sourceTagName = observedSources.get(field.sourceKey);
    if (typeof sourceTagName !== "string") throw new Error(`Source key '${field.sourceKey}' was not present in the observed record group.`);
    const dataClass = classifyField(Object.freeze({
      applicationId: candidate.applicationId,
      environmentId: candidate.environmentId,
      origin: candidate.origin,
      fieldName: field.name,
      sourceKey: field.sourceKey,
      sourceTagName,
      type: field.type
    }));
    if (!["public", "personal", "sensitive", "credential"].includes(dataClass)) {
      throw new Error(`Field '${field.name}' has no trusted sensitivity classification.`);
    }
    return { ...field, sourceTagName, dataClass };
  });
  if (pagination !== undefined) {
    const supportedKinds = new Set(["rel_next_same_path", "explicit_next_same_path", "page_number_query"]);
    if (!supportedKinds.has(pagination?.kind)
      || !candidate.paginationMethods?.includes(pagination.kind)
      || (pagination.kind === "page_number_query" && !candidate.paginationQueryParameters?.includes(pagination.queryParameter))
      || typeof authorizePagination !== "function"
      || authorizePagination(Object.freeze({
        origin: candidate.origin,
        environmentId: candidate.environmentId,
        applicationId: candidate.applicationId,
        pagePath: candidate.pagePath,
        kind: pagination.kind,
        ...(pagination.queryParameter ? { queryParameter: pagination.queryParameter } : {}),
        maxPages: pagination.maxPages
      })) !== true) {
      throw new Error("Pagination was not discovered and explicitly permitted by the trusted application policy.");
    }
  }
  const extractionContract = {
    version: 1,
    id: capabilityId,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    environmentId: candidate.environmentId,
    applicationId: candidate.applicationId,
    principalId: candidate.principalId,
    recordGroup: structuredClone(candidate.recordGroup),
    fields: structuredClone(classifiedFields),
    maxRecords,
    minRecords,
    ...(expectedRecords === undefined ? {} : { expectedRecords }),
    completionPolicy,
    uniqueBy: [...uniqueBy],
    ...(pagination ? { pagination: { kind: pagination.kind, ...(pagination.queryParameter ? { queryParameter: pagination.queryParameter } : {}), maxPages: pagination.maxPages } } : {})
  };
  const contractCheck = validateExtractionContract(extractionContract);
  if (!contractCheck.valid) throw new Error(`Extraction contract is invalid: ${contractCheck.errors.join(" ")}`);
  const manifest = {
    version: 1,
    capabilityId,
    capabilityVersion,
    kind: "visible_record_group",
    applicationId: candidate.applicationId,
    environmentId: candidate.environmentId,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    principalId: candidate.principalId,
    extractionContract,
    discoveredFrom: { observationId: candidate.observationId, recordGroup: structuredClone(candidate.recordGroup) },
    qualification: { status: "candidate" }
  };
  const validation = validateSiteCapabilityManifest(manifest);
  if (!validation.valid) throw new Error(`Capability candidate is invalid: ${validation.errors.join(" ")}`);
  return Object.freeze(manifest);
}

export function compileVisibleExtractionRecipe(options = {}) {
  if (options.candidate?.kind === "visible_record_group") return compileRecordGroupRecipe(options);
  return compileTableRecipe(options);
}

/** Compile a run-local read contract without creating a persistent site capability. */
export function compileEphemeralObservedReadContract({ candidate, fields, classifyField, maxRecords, uniqueBy = [] } = {}) {
  if (!candidate || !new Set(["visible_html_table", "visible_record_group"]).has(candidate.kind)
    || candidate.qualificationStatus !== "candidate" || typeof candidate.principalId !== "string" || !candidate.principalId) {
    throw new Error("Ephemeral extraction requires a bound current-observation candidate.");
  }
  if (typeof classifyField !== "function" || !Array.isArray(fields) || fields.length < 1 || fields.length > 32
    || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10_000) {
    throw new Error("Ephemeral extraction requires trusted field classification and bounded fields and records.");
  }
  const classifiedFields = fields.map(field => {
    let sourceHeader;
    if (candidate.kind === "visible_html_table" && typeof field.sourceHeader === "string") {
      sourceHeader = candidate.headers?.find(header => normalizeHeader(header) === normalizeHeader(field.sourceHeader));
      if (!sourceHeader) throw new Error(`Source header '${field.sourceHeader}' was not present in the observed table.`);
    } else if (candidate.kind === "visible_record_group" && typeof field.sourceKey === "string"
      && candidate.fields?.some(source => source.sourceKey === field.sourceKey)) {
      sourceHeader = null;
    } else {
      throw new Error(`Field '${field.name}' does not map to a source observed on this candidate.`);
    }
    const classification = classifyField(Object.freeze({
      applicationId: candidate.applicationId ?? null,
      environmentId: candidate.environmentId ?? null,
      origin: candidate.origin,
      fieldName: field.name,
      ...(sourceHeader ? { sourceHeader } : { sourceKey: field.sourceKey }),
      type: field.type
    }));
    if (!new Set(["public", "personal", "sensitive", "credential"]).has(classification)) {
      throw new Error(`Field '${field.name}' has no trusted sensitivity classification.`);
    }
    return {
      name: field.name,
      ...(sourceHeader ? { sourceHeader } : {
        sourceKey: field.sourceKey,
        sourceTagName: candidate.fields.find(source => source.sourceKey === field.sourceKey)?.sourceTagName
      }),
      type: field.type,
      required: field.required,
      dataClass: classification
    };
  });
  // A partial page read preserves every visible record. A displayed field
  // such as title or name is not a safe uniqueness key, so only assert
  // uniqueness when the caller supplied an explicit key.
  const effectiveUniqueBy = [...uniqueBy];
  const publicScope = candidate.environmentId == null && candidate.applicationId == null;
  const contract = {
    version: 1,
    scopeKind: "ephemeral_observed_read",
    id: "ephemeral.observed_records",
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    environmentId: publicScope ? null : candidate.environmentId,
    applicationId: publicScope ? null : candidate.applicationId,
    principalId: candidate.principalId,
    fields: classifiedFields,
    maxRecords,
    minRecords: 0,
    expectedRecords: Math.min(candidate.visibleRowCount, maxRecords),
    completionPolicy: "exact_count",
    uniqueBy: [...effectiveUniqueBy],
    ...(candidate.kind === "visible_record_group" ? {
      recordGroup: structuredClone(candidate.recordGroup)
    } : {})
  };
  const validation = validateExtractionContract(contract);
  if (!validation.valid) throw new Error(`Ephemeral extraction contract is invalid: ${validation.errors.join(" ")}`);
  return Object.freeze(contract);
}
