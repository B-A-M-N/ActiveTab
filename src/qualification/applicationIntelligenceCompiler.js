import { isLowercaseCode } from "../telemetry/privacy.js";

function code(value, label, maxLength = 96) {
  if (!isLowercaseCode(value, { maxLength })) throw new Error(`Application intelligence ${label} must be a bounded lowercase code.`);
  return value;
}

function compileTaskIntent(value) {
  const allowed = ["purposeCode", "outcomeCode", "cardinality", "permittedPurposeCodes", "targetRoles", "constraints", "requiredCapabilityIds"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error("Workflow synthesis requires a typed task intent; free-form goals are not sent to remote models.");
  }
  if (!Object.hasOwn(value, "purposeCode") || !Object.hasOwn(value, "outcomeCode")) {
    throw new Error("Workflow task intent requires purposeCode and outcomeCode.");
  }
  const targetRoles = value.targetRoles ?? [];
  const constraints = value.constraints ?? [];
  const requiredCapabilityIds = value.requiredCapabilityIds ?? [];
  const permittedPurposeCodes = value.permittedPurposeCodes ?? [];
  const cardinality = value.cardinality ?? "unknown";
  if (!Array.isArray(targetRoles) || targetRoles.length > 24 || !Array.isArray(constraints) || constraints.length > 24
    || !Array.isArray(requiredCapabilityIds) || requiredCapabilityIds.length > 24
    || !Array.isArray(permittedPurposeCodes) || permittedPurposeCodes.length > 24) {
    throw new Error("Workflow task intent exceeds its bounded role, constraint, or required-capability list.");
  }
  if (!["atomic", "compound", "unknown"].includes(cardinality)) throw new Error("Workflow task intent cardinality must be atomic, compound, or unknown.");
  return Object.freeze({
    purposeCode: code(value.purposeCode, "purpose code", 64),
    outcomeCode: code(value.outcomeCode, "outcome code", 64),
    cardinality,
    permittedPurposeCodes: Object.freeze([...new Set(permittedPurposeCodes.map(item => code(item, "permitted purpose code", 64)))]),
    targetRoles: Object.freeze([...new Set(targetRoles.map(role => code(role, "target role", 64)))]),
    constraints: Object.freeze([...new Set(constraints.map(item => code(item, "constraint", 64)))]),
    requiredCapabilityIds: Object.freeze([...new Set(requiredCapabilityIds.map(id => code(id, "required capability id")))])
  });
}

function compileScope(scope) {
  const allowed = ["applicationId", "environmentClass", "principalId"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)
    || Object.keys(scope).some(key => !allowed.includes(key))) {
    throw new Error("Application intelligence scope contains unsupported fields.");
  }
  const environmentClass = String(scope.environmentClass ?? "unknown");
  if (!["local", "staging", "production", "unknown"].includes(environmentClass)) throw new Error("Application intelligence environment class is unsupported.");
  return {
    applicationId: code(scope.applicationId ?? "unknown", "application id"),
    environmentClass,
    principalId: code(scope.principalId ?? "unknown", "principal id")
  };
}

function compileInputRefs(inputRefs) {
  if (!Array.isArray(inputRefs) || inputRefs.length > 32) throw new Error("Application intelligence input references exceed their bound.");
  return [...new Set(inputRefs.map(value => code(value, "input reference", 64)))];
}

function compileRepair(repair) {
  if (repair == null) return null;
  const allowed = ["failedStepId", "failureCode", "completedStepIds", "completedCapabilityIds"];
  if (!repair || typeof repair !== "object" || Array.isArray(repair)
    || Object.keys(repair).some(key => !allowed.includes(key))) throw new Error("Workflow repair context contains unsupported fields.");
  const list = (value, label) => {
    if (!Array.isArray(value) || value.length > 24) throw new Error(`Workflow repair ${label} exceeds its bound.`);
    return [...new Set(value.map(item => code(item, label, 96)))];
  };
  return {
    failedStepId: code(repair.failedStepId, "failed step id", 64),
    failureCode: code(repair.failureCode, "repair failure code", 64),
    completedStepIds: list(repair.completedStepIds ?? [], "completed step id"),
    completedCapabilityIds: list(repair.completedCapabilityIds ?? [], "completed capability id")
  };
}

function compileSemanticLabel(value) {
  const allowed = ["value", "status", "source"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || !["observed", "inferred", "unknown", "redacted"].includes(value.status)
    || (value.value !== null && (typeof value.value !== "string" || value.value.length > 240))
    || (value.source !== null && (typeof value.source !== "string" || value.source.length > 80))
    || (["unknown", "redacted"].includes(value.status) && (value.value !== null || value.source !== null))
    || (!["unknown", "redacted"].includes(value.status) && typeof value.value !== "string")) {
    throw new Error("Semantic page labels require bounded, provenance-marked values.");
  }
  return Object.freeze({ value: value.value, status: value.status, source: value.source });
}

function compileSemanticPage(value) {
  const allowed = ["schemaVersion", "pageType", "outline", "candidateCoverage", "regions", "forms", "collections", "warnings", "trust"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || ![1, 2, 3].includes(value.schemaVersion)
    || value.trust !== "page_content_is_untrusted_evidence") {
    throw new Error("Semantic page projection has an unsupported schema or trust contract.");
  }
  const pageType = value.pageType;
  if (!pageType || typeof pageType !== "object" || Array.isArray(pageType)
    || Object.keys(pageType).some(key => !["value", "status"].includes(key))
    || typeof pageType.value !== "string" || pageType.value.length > 64
    || !["observed", "inferred", "unknown"].includes(pageType.status)) {
    throw new Error("Semantic page type is outside its bounded status contract.");
  }
  const coverage = value.candidateCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
    || Object.keys(coverage).some(key => !["pageCandidateCount", "pageCoverage", "selectionScope", "scopeCandidateCount", "scopeCoverage"].includes(key))
    || !Number.isInteger(coverage.pageCandidateCount) || coverage.pageCandidateCount < 0 || coverage.pageCandidateCount > 10_000
    || !Number.isInteger(coverage.scopeCandidateCount) || coverage.scopeCandidateCount < 0 || coverage.scopeCandidateCount > coverage.pageCandidateCount
    || !["complete", "partial"].includes(coverage.pageCoverage)
    || !["page", "task_relevant_region"].includes(coverage.selectionScope)
    || !["complete", "incomplete"].includes(coverage.scopeCoverage)
    || (coverage.selectionScope === "page" && coverage.scopeCoverage === "complete" && coverage.pageCoverage !== "complete")
    || (coverage.selectionScope === "page" && coverage.scopeCandidateCount !== coverage.pageCandidateCount)) {
    throw new Error("Semantic page candidate coverage is inconsistent.");
  }
  if (!Array.isArray(value.outline) || value.outline.length > 32
    || value.outline.some(item => !item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["level", "text", "status"].includes(key))
      || !(item.level === null || Number.isInteger(item.level) && item.level >= 1 && item.level <= 6)
      || typeof item.text !== "string" || item.text.length > 240 || item.status !== "observed")) {
    throw new Error("Semantic page outline is outside its bound.");
  }
  const boundedList = (items, max, label) => {
    if (!Array.isArray(items) || items.length > max) throw new Error(`Semantic page ${label} exceed their bound.`);
    return items;
  };
  const regions = boundedList(value.regions, 32, "regions").map(item => {
    const keys = ["ref", "kind", "tag", "label"];
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !keys.includes(key))
      || typeof item.ref !== "string" || item.ref.length > 64
      || typeof item.kind !== "string" || item.kind.length > 32
      || typeof item.tag !== "string" || item.tag.length > 32) throw new Error("Semantic page region is invalid.");
    return Object.freeze({ ref: item.ref, kind: item.kind, tag: item.tag, label: compileSemanticLabel(item.label) });
  });
  const forms = boundedList(value.forms, 32, "forms").map(item => {
    const keys = ["ref", "method", "controlCount", "submitControlCount", "effect"];
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !keys.includes(key))
      || typeof item.ref !== "string" || item.ref.length > 64
      || !(item.method === null || typeof item.method === "string" && item.method.length <= 16)
      || !Number.isInteger(item.controlCount) || item.controlCount < 0 || item.controlCount > 384
      || !Number.isInteger(item.submitControlCount) || item.submitControlCount < 0 || item.submitControlCount > item.controlCount
      || item.effect !== "unknown") throw new Error("Semantic page form is invalid or declares an effect.");
    return Object.freeze({ ...item });
  });
  let totalRecords = 0;
  const collections = boundedList(value.collections, 24, "collections").map(item => {
    const keys = ["ref", "kind", "status", "visibleCount", "completeness", "fieldCount", "fields", "fieldsTruncated", "itemsTruncated", "recordBindingStatus", "records"];
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !keys.includes(key))
      || typeof item.ref !== "string" || item.ref.length > 64
      || typeof item.kind !== "string" || item.kind.length > 48
      || !["observed", "inferred"].includes(item.status)
      || !Number.isInteger(item.visibleCount) || item.visibleCount < 0 || item.visibleCount > 10_000
      || item.completeness !== "unknown"
      || !Number.isInteger(item.fieldCount) || item.fieldCount < 0 || item.fieldCount > 32
      || (item.fields !== undefined && (!Array.isArray(item.fields) || item.fields.length > 32))
      || (item.fieldsTruncated !== undefined && typeof item.fieldsTruncated !== "boolean")
      || (item.itemsTruncated !== undefined && typeof item.itemsTruncated !== "boolean")
      || (item.recordBindingStatus !== undefined && !["unique", "ambiguous", "unknown"].includes(item.recordBindingStatus))) {
      throw new Error("Semantic page collection is invalid or claims unsupported completeness.");
    }
    const semanticRoles = new Set(["name", "price", "description", "sku", "rating", "date", "author", "category", "location", "count", "url", "image", "brand", "availability", "country", "population"]);
    const fields = (item.fields ?? []).map(field => {
      if (!field || typeof field !== "object" || Array.isArray(field)
        || Object.keys(field).some(key => !["name", "status", "semanticRole", "semanticRoleStatus", "label", "evidenceRef"].includes(key))
        || typeof field.name !== "string" || field.name.length > 120
        || !["observed", "inferred", "unknown"].includes(field.status)
        || !(field.semanticRole === undefined || field.semanticRole === null || semanticRoles.has(field.semanticRole))
        || !(field.semanticRoleStatus === undefined || ["observed", "inferred", "unknown", "redacted"].includes(field.semanticRoleStatus))
        || !(field.label === undefined || field.label === null || typeof field.label === "object" && !Array.isArray(field.label))
        || !(field.evidenceRef === undefined || field.evidenceRef === null || typeof field.evidenceRef === "string" && field.evidenceRef.length <= 160)) {
        throw new Error("Semantic page collection field is invalid.");
      }
      return Object.freeze({
        name: field.name,
        status: field.status,
        semanticRole: field.semanticRole ?? null,
        semanticRoleStatus: field.semanticRoleStatus ?? "unknown",
        label: field.label ? compileSemanticLabel(field.label) : Object.freeze({ value: null, status: "unknown", source: null }),
        evidenceRef: field.evidenceRef ?? null
      });
    });
    const records = boundedList(item.records ?? [], 64, "collection records").map(record => {
      totalRecords++;
      if (!record || typeof record !== "object" || Array.isArray(record)
        || Object.keys(record).some(key => !["ref", "ordinal", "fields", "controlRefs"].includes(key))
        || typeof record.ref !== "string" || record.ref.length > 64
        || !Number.isInteger(record.ordinal) || record.ordinal < 1 || record.ordinal > 10_000
        || !Array.isArray(record.fields) || record.fields.length > 16
        || !Array.isArray(record.controlRefs) || record.controlRefs.length > 160
        || record.controlRefs.some(ref => typeof ref !== "string" || ref.length < 1 || ref.length > 64)) {
        throw new Error("Semantic page collection record is invalid or exceeds its bound.");
      }
      const recordFields = record.fields.map(field => {
        if (!field || typeof field !== "object" || Array.isArray(field)
          || Object.keys(field).some(key => !["name", "value", "status", "semanticRole", "semanticRoleStatus", "label", "valueRef", "truncated"].includes(key))
          || typeof field.name !== "string" || field.name.length > 120
          || !(field.value === null || typeof field.value === "string" && field.value.length <= 180)
          || !["observed", "inferred", "unknown", "redacted"].includes(field.status)
          || !(field.semanticRole === undefined || field.semanticRole === null || semanticRoles.has(field.semanticRole))
          || !(field.semanticRoleStatus === undefined || ["observed", "inferred", "unknown", "redacted"].includes(field.semanticRoleStatus))
          || !(field.label === undefined || field.label === null || typeof field.label === "object" && !Array.isArray(field.label))
          || !(field.valueRef === undefined || field.valueRef === null || typeof field.valueRef === "string" && field.valueRef.length <= 160)
          || typeof field.truncated !== "boolean") {
          throw new Error("Semantic page record field is invalid.");
        }
        return Object.freeze({
          name: field.name,
          value: field.value,
          status: field.status,
          semanticRole: field.semanticRole ?? null,
          semanticRoleStatus: field.semanticRoleStatus ?? "unknown",
          label: field.label ? compileSemanticLabel(field.label) : Object.freeze({ value: null, status: "unknown", source: null }),
          valueRef: field.valueRef ?? null,
          truncated: field.truncated
        });
      });
      return Object.freeze({ ...record, fields: Object.freeze(recordFields), controlRefs: Object.freeze([...record.controlRefs]) });
    });
    return Object.freeze({
      ...item,
      fields: Object.freeze(fields),
      records: Object.freeze(records)
    });
  });
  if (totalRecords > 64) throw new Error("Semantic page record projection exceeds its page-wide bound.");
  const allowedWarnings = new Set([
    "candidate_list_truncated", "task_scope_incomplete", "heading_list_truncated",
    "closed_shadow_dom_not_observed", "collection_completeness_unknown",
    "collection_items_truncated", "collection_fields_truncated", "collection_values_truncated"
  ]);
  const warnings = boundedList(value.warnings ?? [], 8, "warnings");
  if (warnings.some(warning => !allowedWarnings.has(warning))) throw new Error("Semantic page contains an unsupported warning.");
  return Object.freeze({
    schemaVersion: 3,
    pageType: Object.freeze({ value: pageType.value, status: pageType.status }),
    outline: Object.freeze(value.outline.map(item => Object.freeze({ ...item }))),
    candidateCoverage: Object.freeze({ ...coverage }),
    regions: Object.freeze(regions),
    forms: Object.freeze(forms),
    collections: Object.freeze(collections),
    warnings: Object.freeze([...warnings]),
    trust: value.trust
  });
}

export class ApplicationIntelligenceCompiler {
  compile({ taskIntent, observation, trustedCapabilities, qualifiedKnowledge, inputRefs = [], repairContext = null, scope = {}, maxSteps = 24 } = {}) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)
      || Object.keys(observation).some(key => !["observationId", "pageOrigin", "title", "headings", "candidateCoverage", "candidates", "semanticPage"].includes(key))) {
      throw new Error("Application intelligence requires a minimized typed observation projection.");
    }
    const coverage = observation.candidateCoverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
      || Object.keys(coverage).some(key => !["candidateCount", "scopedCandidateCount", "submittedCandidateCount", "scrollTargetCount", "submittedScrollTargetCount", "disposition", "selectionScope", "pageCandidateCount", "pageScrollTargetCount", "pageCoverage", "scopeCoverage"].includes(key))
      || [coverage.candidateCount, coverage.submittedCandidateCount, coverage.scrollTargetCount, coverage.submittedScrollTargetCount]
        .some(value => !Number.isInteger(value) || value < 0 || value > 10_000)
      || !["complete", "incomplete"].includes(coverage.disposition)
      || coverage.submittedCandidateCount > coverage.candidateCount
      || coverage.submittedScrollTargetCount > coverage.scrollTargetCount
      || (coverage.disposition === "complete" && (coverage.submittedCandidateCount !== coverage.candidateCount
        || coverage.submittedScrollTargetCount !== coverage.scrollTargetCount))
      || (coverage.selectionScope !== undefined && (
        !["page", "task_relevant_region"].includes(coverage.selectionScope)
        || !Number.isInteger(coverage.scopedCandidateCount) || coverage.scopedCandidateCount !== coverage.candidateCount
        || !Number.isInteger(coverage.pageCandidateCount) || coverage.pageCandidateCount < coverage.candidateCount || coverage.pageCandidateCount > 10_000
        || !Number.isInteger(coverage.pageScrollTargetCount) || coverage.pageScrollTargetCount < coverage.scrollTargetCount || coverage.pageScrollTargetCount > 10_000
        || !["complete", "partial"].includes(coverage.pageCoverage)
        || !["complete", "incomplete"].includes(coverage.scopeCoverage)
        || coverage.scopeCoverage !== coverage.disposition
        || (coverage.pageCoverage === "complete" && (coverage.pageCandidateCount !== coverage.candidateCount || coverage.pageScrollTargetCount !== coverage.scrollTargetCount))
        || (coverage.selectionScope === "page" && coverage.scopeCoverage === "complete" && coverage.pageCoverage !== "complete")
      ))) {
      throw new Error("Application intelligence requires an explicit, consistent candidate coverage contract.");
    }
    if (!Array.isArray(trustedCapabilities) || trustedCapabilities.length < 1 || trustedCapabilities.length > 64) {
      throw new Error("Application intelligence requires a bounded trusted capability catalog.");
    }
    if (!Array.isArray(qualifiedKnowledge) || qualifiedKnowledge.length > 24) throw new Error("Qualified application intelligence exceeds its bound.");
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 24) throw new Error("Application intelligence step limit is invalid.");
    compileScope(scope);
    const normalizedObservation = observation.semanticPage === undefined
      ? observation
      : Object.freeze({ ...observation, semanticPage: compileSemanticPage(observation.semanticPage) });
    if (Array.isArray(normalizedObservation.candidates)) {
      const recordsByRef = new Map((normalizedObservation.semanticPage?.collections ?? [])
        .flatMap(collection => collection.records.map(record => [record.ref, record])));
      for (const candidate of normalizedObservation.candidates) {
        if (candidate?.recordRef == null) continue;
        if (typeof candidate.recordRef !== "string" || candidate.recordRef.length > 64
          || typeof candidate.candidateRef !== "string" || candidate.candidateRef.length > 64
          || !recordsByRef.get(candidate.recordRef)?.controlRefs.includes(candidate.candidateRef)) {
          const error = new Error("Semantic record-to-control relationship is inconsistent.");
          error.kind = "schema";
          throw error;
        }
      }
    }
    return Object.freeze({
      planVersion: 1,
      task: Object.freeze({ ...compileTaskIntent(taskIntent), inputRefs: Object.freeze(compileInputRefs(inputRefs)) }),
      observation: normalizedObservation,
      trustedCapabilities,
      qualifiedKnowledge,
      ...(repairContext ? { repair: compileRepair(repairContext) } : {}),
      limits: Object.freeze({ maxSteps, maxBrowserActions: Math.min(40, maxSteps * 2), unknownEffect: "suspend" })
    });
  }
}
