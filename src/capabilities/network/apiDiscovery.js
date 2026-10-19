import { createHash, randomUUID } from "node:crypto";
import { resolveObservedApplication } from "../../environments/model.js";

const MAX_REQUESTS = 300;
const MAX_SELECTED_BODY_BYTES = 256 * 1024;
const MAX_COLLECTION_DEPTH = 6;
const MAX_RECORDS_FOR_SHAPE = 1_000;
const MAX_FIELDS = 64;
const CREDENTIAL_FIELD = /pass(word|wd|phrase)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf/i;
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

function exactPageUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function requestUrl(value, pageOrigin) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== pageOrigin || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function apiJsonMime(value) {
  const mime = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return mime === "application/json" || mime === "text/json" || /\+json$/.test(mime);
}

/** Discover only successful, same-origin GET JSON requests already made by the page. */
export function discoverObservedApiRequests({ observation, networkActivity, environment, principalId } = {}) {
  if (!observation?.evidenceId || observation.documentGeneration == null || typeof observation.targetId !== "string" || !observation.targetId) {
    return { status: "unavailable", candidates: [], reasonCode: "fresh_observation_required" };
  }
  const page = exactPageUrl(observation.page?.url);
  if (!page) return { status: "unavailable", candidates: [], reasonCode: "page_scope_not_exact" };
  const environmentId = environment?.environmentId ?? environment?.id;
  const application = resolveObservedApplication(environment, page.href);
  if (application.status !== "matched") return { status: "unavailable", candidates: [], reasonCode: `application_identity_${application.status}` };
  const applicationId = application.applicationId;
  if (typeof environmentId !== "string" || !environmentId || typeof applicationId !== "string" || !applicationId
    || typeof principalId !== "string" || !principalId) {
    return { status: "unavailable", candidates: [], reasonCode: "verified_scope_required" };
  }
  if (!Array.isArray(networkActivity)) return { status: "unavailable", candidates: [], reasonCode: "network_activity_unavailable" };
  const candidates = [];
  for (const request of networkActivity.slice(-MAX_REQUESTS)) {
    if (request?.method !== "GET" || !Number.isInteger(request.status) || request.status < 200 || request.status >= 300
      || request.failure || request.redirectedTo || request.finishedAt == null || !apiJsonMime(request.mimeType)
      || !["Fetch", "XHR"].includes(request.resourceType) || typeof request.requestId !== "string") continue;
    const endpoint = requestUrl(request.url, page.origin);
    if (!endpoint) continue;
    candidates.push({
      candidateId: randomUUID(),
      kind: "observed_read_only_api",
      method: "GET",
      origin: endpoint.origin,
      endpointPath: endpoint.pathname,
      pagePath: page.pathname,
      contentType: String(request.mimeType).split(";", 1)[0].trim().toLowerCase(),
      status: request.status,
      resourceType: request.resourceType,
      requestId: request.requestId,
      observationId: observation.evidenceId,
      targetId: observation.targetId,
      documentGeneration: observation.documentGeneration,
      environmentId,
      applicationId,
      principalId,
      qualificationStatus: "candidate"
    });
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.method}\n${candidate.origin}\n${candidate.endpointPath}\n${candidate.contentType}`;
    unique.set(key, candidate);
  }
  return { status: unique.size ? "candidate" : "empty", candidates: [...unique.values()] };
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function safeFieldName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function collectionCandidates(value, path = [], depth = 0, result = []) {
  if (depth > MAX_COLLECTION_DEPTH || result.length >= 32 || value === null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    const records = value.filter(item => item && typeof item === "object" && !Array.isArray(item));
    if (records.length > 0 && records.length === value.length) {
      const names = [...new Set(records.slice(0, MAX_RECORDS_FOR_SHAPE).flatMap(record => Object.keys(record)))].slice(0, MAX_FIELDS);
      const fields = names.filter(safeFieldName).map(name => {
        const types = [...new Set(records.slice(0, MAX_RECORDS_FOR_SHAPE).map(record => valueType(record[name])))];
        const credentialLike = CREDENTIAL_FIELD.test(name);
        const type = types.length === 1 && SCALAR_TYPES.has(types[0]) ? types[0]
          : types.length > 1 && types.every(item => item === "integer" || item === "number") ? "number" : "mixed";
        return {
          sourcePath: [name],
          name,
          type,
          observedTypes: types.slice(0, 8),
          credentialLike,
          readEligible: !credentialLike,
          requiresTrustedClassification: true
        };
      });
      result.push({ collectionPath: [...path], recordCount: value.length, fields });
    }
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!safeFieldName(key)) continue;
    collectionCandidates(child, [...path, key], depth + 1, result);
  }
  return result;
}

function validateCandidateScope(candidate, observation) {
  if (!candidate || candidate.kind !== "observed_read_only_api" || candidate.method !== "GET"
    || candidate.qualificationStatus !== "candidate" || candidate.observationId !== observation?.evidenceId
    || candidate.targetId !== observation?.targetId || candidate.documentGeneration !== observation?.documentGeneration
    || typeof candidate.requestId !== "string") return false;
  const page = exactPageUrl(observation.page?.url);
  return page?.pathname === candidate.pagePath && page.origin === candidate.origin;
}

/** Inspect only the explicitly selected response from the current retained observation. */
export async function inspectObservedApiCandidate({ candidate, observation, observer } = {}) {
  if (!validateCandidateScope(candidate, observation)) return { status: "blocked", reasonCode: "api_candidate_scope_mismatch" };
  if (!observer || typeof observer.inspectNetworkResponse !== "function") return { status: "unavailable", reasonCode: "selected_response_inspector_unavailable" };
  const selected = await observer.inspectNetworkResponse(observation.evidenceId, {
    requestId: candidate.requestId,
    includeSensitive: true,
    view: "normalized",
    maxBytes: MAX_SELECTED_BODY_BYTES
  });
  if (selected?.status !== "available" || selected.responseBody?.status !== "included") {
    return { status: "unavailable", reasonCode: selected?.responseBody?.status ?? "selected_response_unavailable" };
  }
  const selectedUrl = requestUrl(selected.request?.url, candidate.origin);
  if (selected.request?.method !== "GET" || selected.request?.status !== candidate.status
    || selected.request?.resourceType !== candidate.resourceType || !apiJsonMime(selected.request?.mimeType)
    || selectedUrl?.pathname !== candidate.endpointPath) {
    return { status: "blocked", reasonCode: "selected_response_identity_mismatch" };
  }
  if (selected.responseBody.format !== "json" || selected.responseBody.hasMore || typeof selected.responseBody.data !== "string") {
    return { status: "incomplete", reasonCode: selected.responseBody.hasMore ? "selected_response_too_large" : "selected_response_not_normalized_json" };
  }
  let document;
  try { document = JSON.parse(selected.responseBody.data); }
  catch { return { status: "incomplete", reasonCode: "normalized_response_parse_failed" }; }
  const collections = collectionCandidates(document);
  if (!collections.length) return { status: "empty", reasonCode: "json_record_collection_not_found" };
  const candidates = collections.map(collection => ({
    ...structuredClone(candidate),
    candidateId: randomUUID(),
    collectionPath: collection.collectionPath,
    recordCount: collection.recordCount,
    fields: collection.fields,
    credentialRedactions: selected.responseBody.credentialRedactions ?? 0,
    credentialDetails: structuredClone(selected.responseBody.credentialDetails ?? { items: [], omitted: 0 }),
    responseShapeDigest: createHash("sha256").update(JSON.stringify({ collectionPath: collection.collectionPath, fields: collection.fields.map(({ sourcePath, type, observedTypes, credentialLike }) => ({ sourcePath, type, observedTypes, credentialLike })) })).digest("hex"),
    qualificationStatus: "candidate"
  }));
  return { status: "candidate", observationId: observation.evidenceId, candidates };
}

/** Qualify a discovered response shape only with independently scored fixture variants. */
export async function qualifyObservedApiCandidate(candidate, { runQualification, variants = 30, signal } = {}) {
  let origin = null;
  try { origin = new URL(candidate?.origin); } catch { /* The candidate fails scope validation below. */ }
  if (!candidate || candidate.kind !== "observed_read_only_api" || candidate.qualificationStatus !== "candidate"
    || !Array.isArray(candidate.collectionPath) || !Array.isArray(candidate.fields) || !candidate.fields.length
    || candidate.collectionPath.length > MAX_COLLECTION_DEPTH || candidate.collectionPath.some(key => !safeFieldName(key))
    || candidate.fields.length > MAX_FIELDS || candidate.fields.some(field => !field || !Array.isArray(field.sourcePath)
      || field.sourcePath.length !== 1 || field.sourcePath.some(key => !safeFieldName(key)) || !safeFieldName(field.name)
      || field.sourcePath[0] !== field.name || typeof field.credentialLike !== "boolean"
      || typeof field.readEligible !== "boolean" || field.readEligible !== !field.credentialLike
      || ![...SCALAR_TYPES, "mixed"].includes(field.type))
    || candidate.method !== "GET" || !origin || origin.origin !== candidate.origin || candidate.origin !== origin.origin
    || typeof candidate.pagePath !== "string" || !candidate.pagePath.startsWith("/") || /[?#]/.test(candidate.pagePath)
    || typeof candidate.endpointPath !== "string" || !candidate.endpointPath.startsWith("/") || /[?#]/.test(candidate.endpointPath)
    || !Number.isInteger(candidate.status) || candidate.status < 200 || candidate.status >= 300
    || !["Fetch", "XHR"].includes(candidate.resourceType) || !apiJsonMime(candidate.contentType)
    || typeof candidate.requestId !== "string" || !candidate.requestId
    || typeof candidate.environmentId !== "string" || !candidate.environmentId
    || typeof candidate.applicationId !== "string" || !candidate.applicationId
    || typeof candidate.principalId !== "string" || !candidate.principalId
    || !/^[a-f0-9]{64}$/.test(candidate.responseShapeDigest ?? "")) {
    throw new Error("Only a bounded, inspected API response candidate can be qualified.");
  }
  if (!Number.isInteger(variants) || variants < 3 || variants > 1000) throw new Error("API shape qualification requires 3 to 1000 seeded fixture variants.");
  if (typeof runQualification !== "function") return { status: "unavailable", reasonCode: "independent_api_fixture_oracle_unavailable" };
  const result = await runQualification({ candidate: structuredClone(candidate), variants, signal });
  const reports = Array.isArray(result?.variants) ? result.variants : [];
  const passed = result?.oracleIndependent === true && reports.length === variants
    && reports.every(report => report?.status === "complete" && report.schemaMatch === true
      && report.completenessVerified === true && report.privacyBoundaryPassed === true);
  if (!passed) return {
    status: "not_qualified",
    reasonCode: "independent_api_fixture_check_failed",
    passedVariants: reports.filter(report => report?.status === "complete" && report.schemaMatch === true
      && report.completenessVerified === true && report.privacyBoundaryPassed === true).length,
    variantCount: variants
  };
  const evidenceRefs = [...new Set(reports.map(report => report.evidenceRef).filter(value => typeof value === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)))].slice(0, 32);
  if (!evidenceRefs.length) return { status: "inconclusive", reasonCode: "api_fixture_evidence_missing" };
  const qualificationProjection = reports.map(({ scenarioId, status, schemaMatch, completenessVerified, privacyBoundaryPassed }) => ({
    scenarioId, status, schemaMatch, completenessVerified, privacyBoundaryPassed
  }));
  const qualificationDigest = createHash("sha256").update(JSON.stringify(qualificationProjection)).digest("hex");
  return {
    status: "qualified",
    candidate: {
      ...structuredClone(candidate),
      qualificationStatus: "qualified",
      qualification: {
        status: "qualified",
        level: "resolver",
        providerId: "activetab_api_shape_resolver",
        providerIdentity: "activetab_api_shape_twin_oracle_v1",
        scenarioSeed: 0,
        sourceRevision: "activetab_api_shape_resolver_v1",
        oracleReference: "api_shape_synthetic_variant_oracle_v1",
        cleanupResult: { status: "not_applicable", reasonCode: "in_memory_variants_only" },
        independentApplicationOutcome: false,
        variantCount: variants,
        evidenceRefs,
        evidenceDigest: qualificationDigest
      }
    }
  };
}
