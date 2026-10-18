import { validateExtractionContract } from "../extraction/extractionContract.js";
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
    if (pagination?.kind !== "rel_next_same_path"
      || !candidate.paginationMethods?.includes("rel_next_same_path")
      || typeof authorizePagination !== "function"
      || authorizePagination(Object.freeze({
        origin: candidate.origin,
        environmentId: candidate.environmentId,
        applicationId: candidate.applicationId,
        pagePath: candidate.pagePath,
        kind: pagination.kind,
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
    ...(pagination ? { pagination: { kind: pagination.kind, maxPages: pagination.maxPages } } : {})
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
    if (pagination?.kind !== "rel_next_same_path"
      || !candidate.paginationMethods?.includes("rel_next_same_path")
      || typeof authorizePagination !== "function"
      || authorizePagination(Object.freeze({
        origin: candidate.origin,
        environmentId: candidate.environmentId,
        applicationId: candidate.applicationId,
        pagePath: candidate.pagePath,
        kind: pagination.kind,
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
    ...(pagination ? { pagination: { kind: pagination.kind, maxPages: pagination.maxPages } } : {})
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
