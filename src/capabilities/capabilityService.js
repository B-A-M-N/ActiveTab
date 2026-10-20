import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolveObservedApplication } from "../environments/model.js";
import { discoverTableCapabilities } from "./capabilityDiscovery.js";
import { compileEphemeralObservedReadContract, compileVisibleExtractionRecipe } from "./recipeCompiler.js";
import { executeExtractionCapability } from "./recipeExecutor.js";
import { NetworkApiCapabilityService } from "./network/networkApiCapabilityService.js";
import { resolveVisibleTableRecords } from "../extraction/recordResolver.js";
import { resolveVisibleRecordGroupRecords } from "../extraction/recordGroupResolver.js";
import { OutputAccumulator } from "../extraction/outputAccumulator.js";
import { projectExtractionOutput } from "../extraction/outputRelease.js";
import { normalizeHeader } from "../extraction/extractionContract.js";
import { buildDocumentIndex } from "../observe/documentIndex.js";
import { classifyObservedPublicField } from "./fieldPolicy.js";
import { requestedLocalTransformFields } from "../extraction/recordTransformations.js";
import { RunLocalPublicReadGrants } from "./runLocalPublicReadGrants.js";

function fieldMatchesCandidate(field, candidate) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return false;
  if (candidate.kind === "visible_html_table") {
    return typeof field.sourceHeader === "string"
      && candidate.headers.some(header => normalizeHeader(header) === normalizeHeader(field.sourceHeader));
  }
  return candidate.kind === "visible_record_group"
    && typeof field.sourceKey === "string"
    && Array.isArray(candidate.fields)
    && candidate.fields.some(source => source.sourceKey === field.sourceKey);
}

function sameCandidateSource(left, right) {
  if (!left || !right || left.kind !== right.kind || left.origin !== right.origin
    || left.environmentId !== right.environmentId || left.applicationId !== right.applicationId
    || left.pagePath !== right.pagePath) return false;
  if (left.kind === "visible_html_table") {
    return left.tableIndex === right.tableIndex
      && JSON.stringify(left.headers) === JSON.stringify(right.headers);
  }
  return left.kind === "visible_record_group"
    && JSON.stringify(left.recordGroup) === JSON.stringify(right.recordGroup)
    && JSON.stringify(left.fields) === JSON.stringify(right.fields);
}

function candidateSourceProjection(candidate) {
  return candidate?.kind === "visible_html_table" ? {
    kind: candidate.kind,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    tableIndex: candidate.tableIndex,
    headers: candidate.headers
  } : {
    kind: candidate?.kind,
    origin: candidate?.origin,
    pagePath: candidate?.pagePath,
    documentIndex: candidate?.documentIndex,
    frameId: candidate?.frameId,
    frameTargetId: candidate?.frameTargetId,
    parentFrameId: candidate?.parentFrameId,
    recordGroup: candidate?.recordGroup,
    fields: candidate?.fields
  };
}

function environmentKey(environment, origin) {
  return environment?.environmentId ?? environment?.id ?? `public:${origin}`;
}

function isPublicObservedReadScope(candidate, environment) {
  if (candidate?.environmentId == null && candidate?.applicationId == null) return true;
  return environment?.ephemeral === true
    && environment.scopeKind === "current_origin"
    && typeof environment.environmentId === "string"
    && candidate?.environmentId === environment.environmentId
    && candidate?.applicationId === "ephemeral_public_site"
    && Array.isArray(environment.authorizedOrigins)
    && environment.authorizedOrigins.length === 1
    && environment.authorizedOrigins[0] === candidate?.origin;
}

const FIELD_MATCH_STOP_WORDS = new Set([
  "the", "and", "for", "from", "into", "with", "that", "this", "then", "please",
  "return", "list", "show", "get", "find", "read", "extract", "collect", "retrieve",
  "summarize", "summarise", "compare", "products", "product", "records", "rows", "items", "visible"
]);

const REQUESTED_FIELD_ROLE_ALIASES = new Map([
  ["name", "name"], ["title", "name"], ["product", "name"], ["item", "name"],
  ["price", "price"], ["cost", "price"], ["amount", "price"],
  ["author", "author"], ["creator", "author"], ["writer", "author"],
  ["description", "description"], ["summary", "description"],
  ["date", "date"], ["published", "date"], ["rating", "rating"],
  ["category", "category"], ["brand", "brand"], ["location", "location"],
  ["country", "country"], ["nation", "country"], ["population", "population"]
]);

function fieldTerms(value) {
  return String(value ?? "").normalize("NFKC").replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.map(term =>
    term.length > 4 && term.endsWith("ies") ? `${term.slice(0, -3)}y`
      : term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term
  ).filter(term => !FIELD_MATCH_STOP_WORDS.has(term)) ?? [];
}

function fieldCode(value) {
  const code = normalizeHeader(value).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : null;
}

function semanticRolesFromTerms(terms) {
  const roles = new Set([...terms].map(term => REQUESTED_FIELD_ROLE_ALIASES.get(term)).filter(Boolean));
  // "Country names" names one country field; it does not request a second
  // generic name field from the same record.
  if (roles.has("country") && roles.has("name")) roles.delete("name");
  return roles;
}

function semanticFieldCode(value) {
  const roles = semanticRolesFromTerms(fieldTerms(value));
  return roles.size === 1 ? [...roles][0] : fieldCode(value);
}

function semanticCollectionMatchesCandidate(collection, candidate) {
  if (candidate?.kind !== "visible_record_group" || collection?.kind !== "repeated_dom_structure"
    || collection.recordBindingStatus !== "unique" || collection.fieldsTruncated === true
    || !Array.isArray(collection.fields) || !Array.isArray(candidate.fields)
    || collection.fields.length !== candidate.fields.length
    || collection.visibleCount !== candidate.visibleRowCount
    || collection.documentIndex !== candidate.documentIndex
    || collection.frameId !== (candidate.frameId ?? null)
    || collection.frameTargetId !== (candidate.frameTargetId ?? null)
    || collection.parentFrameId !== (candidate.parentFrameId ?? null)
    || JSON.stringify(collection.sourceGroup) !== JSON.stringify(candidate.recordGroup)) return false;
  if (!Number.isInteger(candidate.documentIndex)) return false;
  return collection.fields.every((field, index) => {
    const source = candidate.fields[index];
    return field.sourceKey === source.sourceKey
      && field.sourceTag === String(source.sourceTagName ?? "").toLowerCase();
  });
}

function requestedSemanticRecordFields(goal, collection, candidate) {
  const goalTerms = [...fieldTerms(goal), ...requestedLocalTransformFields(goal)];
  const requestedTerms = new Set(goalTerms);
  const requestedRoleOrder = [...semanticRolesFromTerms(goalTerms)];
  const descriptors = collection.fields.map((semanticField, index) => {
    const source = candidate.fields[index];
    const roleStatus = ["observed", "inferred"].includes(semanticField.semanticRoleStatus)
      ? semanticField.semanticRoleStatus : null;
    const sourceTerms = new Set([
      ...fieldTerms(semanticField.label?.value),
      ...fieldTerms(source?.sourceKey)
    ]);
    const inferredRoles = semanticRolesFromTerms(sourceTerms);
    return {
      semanticField,
      source,
      role: roleStatus ? semanticField.semanticRole : inferredRoles.size === 1 ? [...inferredRoles][0] : null,
      sourceTerms
    };
  });

  let selected;
  if (requestedRoleOrder.length) {
    selected = [];
    for (const role of requestedRoleOrder) {
      const matchingRole = descriptors.filter(item => item.role === role);
      const exactTerms = goalTerms.filter(term => REQUESTED_FIELD_ROLE_ALIASES.get(term) === role);
      const sourceSpecific = matchingRole.filter(item => exactTerms.some(term => item.sourceTerms.has(term)));
      const resolved = sourceSpecific.length ? sourceSpecific : matchingRole;
      if (resolved.length !== 1) return [];
      const name = fieldCode(role);
      if (!name) return [];
      selected.push({
        name,
        sourceKey: resolved[0].source.sourceKey,
        type: "string",
        required: true
      });
    }
  } else {
    selected = [];
    const names = new Set();
    for (const item of descriptors) {
      if (![...item.sourceTerms].some(term => requestedTerms.has(term))) continue;
      const name = fieldCode(item.semanticField.semanticRole ?? (item.semanticField.label?.value || item.source.sourceKey));
      if (!name || names.has(name)) return [];
      names.add(name);
      selected.push({ name, sourceKey: item.source.sourceKey, type: "string", required: true });
    }
  }
  return selected;
}

function requestedSemanticFieldNames(goal) {
  return [...semanticRolesFromTerms(fieldTerms(goal))]
    .map(fieldCode).filter(Boolean);
}

function observedReadFailure(reasonCode, message) {
  return Object.assign(new Error(message), { reasonCode });
}

function retainedRouteUrl(session, observation) {
  const retainedPage = session?.observer?.getEvidence?.(observation?.evidenceId, {
    facets: ["page"],
    includeSensitiveUrlData: true
  });
  return retainedPage?.status === "available" && typeof retainedPage.page?.url === "string"
    ? retainedPage.page.url
    : observation?.page?.url;
}

/** Native ActiveTab facade for discovery, candidate compilation, qualification, and reuse. */
export class CapabilityService {
  #networkApiCapabilityService;

  constructor({ registry, qualifier, classifyField, authorizeRead = null, authorizeRelease = null, authorizePublicRead = null, authorizePublicRelease = null, classifyPublicField = null, publicFieldPolicy = null, approvePublicRead = null, publicReadGrantNow = () => Date.now(), publicReadGrantTtlMs = 5 * 60_000, publicReadMaxBytes = 64 * 1024, authorizePagination = null, runApiQualification = null, maxCandidates = 100, candidateTtlMs = 15 * 60_000 } = {}) {
    this.registry = registry;
    this.qualifier = qualifier;
    this.classifyField = classifyField;
    this.authorizeRead = authorizeRead;
    this.authorizeRelease = authorizeRelease;
    this.classifyPublicField = classifyPublicField;
    this.publicFieldPolicy = publicFieldPolicy;
    this.authorizePublicRead = authorizePublicRead;
    this.authorizePublicRelease = authorizePublicRelease;
    this.approvePublicRead = typeof approvePublicRead === "function" ? approvePublicRead : null;
    this.publicReadGrantNow = publicReadGrantNow;
    this.publicReadGrantTtlMs = Math.max(1_000, Math.min(15 * 60_000, Number(publicReadGrantTtlMs) || 5 * 60_000));
    this.publicReadMaxBytes = Math.max(1024, Math.min(1024 * 1024, Number(publicReadMaxBytes) || 64 * 1024));
    this.publicReadGrantAuthority = new RunLocalPublicReadGrants({
      enabled: Boolean(this.approvePublicRead),
      now: publicReadGrantNow,
      expiresInMs: this.publicReadGrantTtlMs
    });
    // Preserve the existing inspection surface while ownership moves to the grant authority.
    this.publicReadGrantStore = this.publicReadGrantAuthority.store;
    this.publicReadGrantBindings = this.publicReadGrantAuthority.bindings;
    this.authorizePagination = authorizePagination;
    this.runApiQualification = runApiQualification;
    this.maxCandidates = Math.max(1, Math.min(1000, Number(maxCandidates) || 100));
    this.candidateTtlMs = Math.max(60_000, Math.min(60 * 60_000, Number(candidateTtlMs) || 15 * 60_000));
    this.candidates = new Map();
    this.recipes = new Map();
    this.#networkApiCapabilityService = new NetworkApiCapabilityService({
      maxCandidates: this.maxCandidates,
      candidateTtlMs: this.candidateTtlMs
    });
    // Keep the existing read surface while candidate ownership moves to the API service.
    this.apiCandidates = this.#networkApiCapabilityService.candidates;
    this.routeFingerprintKey = randomBytes(32);
  }

  #runLocalPublicReadScope({ session, environment, principalId, candidate, selectedFields, maxRecords, maxBytes }) {
    const candidateId = candidate?.candidateId;
    const entry = candidateId ? this.#get(this.candidates, candidateId) : null;
    if (!entry || entry.targetId !== session?.target?.id || entry.principalId !== principalId) return null;
    const origin = candidate.origin;
    const environmentId = environmentKey(environment, origin);
    const fields = selectedFields.map(field => ({
      name: field.name,
      ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }),
      type: field.type,
      required: field.required
    }));
    const input = Object.freeze({
      origin,
      pagePath: candidate.pagePath,
      targetId: session.target.id,
      sourceFingerprint: entry.observedBinding.sourceFingerprint,
      fields: Object.freeze(fields.map(field => Object.freeze(field))),
      maxRecords,
      maxBytes
    });
    return { entry, input, environmentId, fields };
  }

  #authorizePublicField(field, context = {}, kind = "read") {
    const policy = kind === "read" ? this.authorizePublicRead : this.authorizePublicRelease;
    return this.publicReadGrantAuthority.authorize(field, context, kind, policy);
  }

  async discover({ session, environment, principalId } = {}) {
    const discovery = await this.#discover({ session, environment, principalId });
    const { observation: _observation, evidence: _evidence, ...result } = discovery;
    return {
      ...result,
      candidates: result.candidates.map(({ documentIndex: _documentIndex, frameId: _frameId,
        frameTargetId: _frameTargetId, parentFrameId: _parentFrameId, ...candidate }) => candidate)
    };
  }

  async #discover({ session, environment, principalId } = {}, suppliedObservation = null) {
    const observation = suppliedObservation ?? await session?.observe?.();
    if (session?.attached !== true || typeof session.target?.id !== "string"
      || !observation?.evidenceId || observation.targetId !== session.target.id
      || observation.documentGeneration !== session.documentGeneration) {
      return { status: "unavailable", candidates: [], reasonCode: "fresh_observation_required" };
    }
    const evidence = session.observer?.getEvidence?.(observation.evidenceId, { facets: ["domSnapshot"] });
    if (evidence?.status !== "available" || !evidence.domSnapshot) {
      return { status: "unavailable", candidates: [], reasonCode: "retained_dom_evidence_unavailable" };
    }
    let observedUrl;
    try { observedUrl = new URL(observation.page?.url); }
    catch { return { status: "unavailable", candidates: [], reasonCode: "page_origin_unavailable" }; }
    if (!["http:", "https:"].includes(observedUrl.protocol) || observedUrl.username || observedUrl.password) {
      return { status: "unavailable", candidates: [], reasonCode: "public_page_origin_required" };
    }
    let privateObservedUrl;
    try { privateObservedUrl = new URL(retainedRouteUrl(session, observation)); }
    catch { privateObservedUrl = observedUrl; }
    if (!["http:", "https:"].includes(privateObservedUrl.protocol) || privateObservedUrl.username || privateObservedUrl.password
      || privateObservedUrl.origin !== observedUrl.origin || privateObservedUrl.pathname !== observedUrl.pathname) {
      return { status: "unavailable", candidates: [], reasonCode: "private_page_route_unavailable" };
    }
    let applicationId = null;
    if (environment) {
      const application = resolveObservedApplication(environment, observation.page.url);
      if (application.status !== "matched") return { status: "unavailable", candidates: [], reasonCode: `application_identity_${application.status}` };
      applicationId = application.applicationId;
    }
    const documentIndex = evidence.documentIndex ?? buildDocumentIndex(evidence.domSnapshot);
    const indexedEvidence = { ...evidence, documentIndex };
    const discovery = discoverTableCapabilities({
      observation,
      domSnapshot: indexedEvidence.domSnapshot,
      environmentId: environment?.environmentId ?? environment?.id ?? null,
      applicationId,
      principalId,
      documentIndex
    });
    const candidates = discovery.candidates.map(candidate => {
      const candidateId = randomUUID();
      this.#remember(this.candidates, candidateId, {
        candidate,
        targetId: session.target?.id ?? null,
        principalId: principalId ?? null,
        environmentId: environment?.environmentId ?? environment?.id ?? null,
        observedBinding: {
          observationId: observation.evidenceId,
          documentGeneration: observation.documentGeneration,
          routeFingerprint: this.#fingerprint(`route\u0000${privateObservedUrl.href}`),
          sourceFingerprint: this.#fingerprint(JSON.stringify(candidateSourceProjection(candidate)))
        }
      });
      return { candidateId, ...candidate };
    });
    return { ...discovery, candidates, observation, evidence: indexedEvidence };
  }

  /**
   * Offer one-shot, policy-approved visible table reads to the ordinary
   * workflow planner. The returned closures stay local and are bound to the
   * exact target, principal, document generation, route, and observed source.
   */
  async #requestRunLocalPublicReadGrant({ session, environment, principalId, candidate, selectedFields, maxRecords, signal = null } = {}) {
    if (!this.approvePublicRead || !this.publicReadGrantStore) return null;
    const maxBytes = this.publicReadMaxBytes;
    const scope = this.#runLocalPublicReadScope({ session, environment, principalId, candidate, selectedFields, maxRecords, maxBytes });
    if (!scope) return null;
    const approvalPhrase = `APPROVE PUBLIC READ ${randomUUID().slice(0, 8).toUpperCase()}`;
    const proposal = Object.freeze({
      origin: candidate.origin,
      pagePath: candidate.pagePath,
      targetId: session.target.id,
      sourceFingerprint: scope.input.sourceFingerprint,
      fields: Object.freeze(scope.fields.map(field => Object.freeze({
        name: field.name,
        ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }),
        type: field.type
      }))),
      requestedOutput: Object.freeze(scope.fields.map(field => field.name)),
      maxRecords,
      maxBytes,
      expiresInMs: this.publicReadGrantTtlMs,
      approvalPhrase
    });
    let approved = false;
    try { approved = await this.approvePublicRead(proposal, { signal }) === true; }
    catch { approved = false; }
    if (!approved) return null;
    return this.publicReadGrantAuthority.issue(scope, {
      principalId, candidate, session, selectedFields
    });
  }

  async createObservedReadWorkflowCapabilities({ session, environment, principalId, observation, goal, maxRecords = 100, signal = null } = {}) {
    if (typeof goal !== "string" || goal.length > 4096
      || /\b(?:all|every|entire|complete|whole)\b/iu.test(goal)
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000
      || typeof principalId !== "string" || !principalId
      || session?.attached !== true || !session.target?.id
      || observation?.targetId !== session.target.id
      || observation?.documentGeneration !== session.documentGeneration) return [];

    const requestedTerms = new Set([...fieldTerms(goal), ...requestedLocalTransformFields(goal)]);
    if (!requestedTerms.size) return [];
    const discovery = await this.#discover({ session, environment, principalId }, observation);
    if (discovery.status !== "candidate") return [];
    const semanticPage = observation.semanticPage?.schemaVersion === 3
      && observation.semanticPage.evidence?.observationId === observation.evidenceId
      && observation.semanticPage.evidence?.targetId === session.target.id
      && observation.semanticPage.evidence?.documentGeneration === observation.documentGeneration
      ? observation.semanticPage : null;

    const approvedCandidates = [];
    for (const candidate of discovery.candidates) {
      if (candidate.kind !== "visible_html_table" && candidate.kind !== "visible_record_group") continue;
      let selectedFields = [];
      if (candidate.kind === "visible_html_table") {
        const names = new Set();
        let ambiguousFieldNames = false;
        for (const sourceHeader of candidate.headers) {
          const name = semanticFieldCode(sourceHeader);
          if (!name) continue;
          const sourceTerms = new Set(fieldTerms(sourceHeader));
          if (![...sourceTerms].some(term => requestedTerms.has(term))) continue;
          const sourceNumberQualifiers = [...sourceTerms].filter(term => /^\d{2,}$/u.test(term));
          if (sourceNumberQualifiers.length && !sourceNumberQualifiers.some(term => requestedTerms.has(term))) continue;
          if (names.has(name)) {
            // Two observed columns that normalize to the same semantic field
            // cannot be represented as separate object keys without silently
            // overwriting one another. Abstain on the source instead.
            ambiguousFieldNames = true;
            break;
          }
          names.add(name);
          selectedFields.push({ name, sourceHeader, type: "string", required: true });
        }
        if (ambiguousFieldNames) continue;
      } else {
        if (!semanticPage) continue;
        const semanticMatches = semanticPage.collections.filter(collection => semanticCollectionMatchesCandidate(collection, candidate));
        if (semanticMatches.length !== 1) continue;
        selectedFields = requestedSemanticRecordFields(goal, semanticMatches[0], candidate);
      }
      if (!selectedFields.length) continue;
      const publicScope = isPublicObservedReadScope(candidate, environment);
      const classifyField = publicScope ? this.classifyPublicField : this.classifyField;
      if (!publicScope && (typeof classifyField !== "function" || typeof this.authorizeRead !== "function" || typeof this.authorizeRelease !== "function")) continue;
      let requestedFieldDenied = false;
      let needsRunLocalGrant = false;
      const classifiedFields = [];
      for (const field of selectedFields) {
        const source = candidate.kind === "visible_html_table"
          ? { sourceHeader: field.sourceHeader }
          : {
            sourceKey: field.sourceKey,
            sourceTagName: candidate.fields.find(item => item.sourceKey === field.sourceKey)?.sourceTagName
          };
        const scoped = Object.freeze({
          environmentId: candidate.environmentId,
          applicationId: candidate.applicationId,
          origin: candidate.origin,
          fieldName: field.name,
          ...source,
          type: "string"
        });
        if (!publicScope) {
          const dataClass = classifyField(scoped);
          const trustedField = Object.freeze({ ...scoped, dataClass });
          if (!["public", "personal", "sensitive", "credential"].includes(dataClass)
            || this.authorizeRead(trustedField, { principalId, scopeKind: "ephemeral_observed_read" }) !== true
            || this.authorizeRelease(trustedField, { principalId, scopeKind: "ephemeral_observed_read" }) !== true) {
            requestedFieldDenied = true;
            continue;
          }
          classifiedFields.push(field);
          continue;
        }
        const policy = this.publicFieldPolicy?.(scoped) ?? null;
        const configuredClass = typeof classifyField === "function" ? classifyField(scoped) : null;
        const dataClass = policy?.dataClass ?? configuredClass ?? classifyObservedPublicField(scoped);
        if (dataClass !== "public") {
          requestedFieldDenied = true;
          continue;
        }
        if (policy) {
          if (policy.allowRead !== true || policy.allowRelease !== true) requestedFieldDenied = true;
          classifiedFields.push(field);
          continue;
        }
        const exactAllowlisted = typeof this.authorizePublicRead === "function"
          && this.authorizePublicRead(Object.freeze({ ...scoped, dataClass }), { principalId, scopeKind: "ephemeral_observed_read" }) === true
          && typeof this.authorizePublicRelease === "function"
          && this.authorizePublicRelease(Object.freeze({ ...scoped, dataClass }), { principalId, scopeKind: "ephemeral_observed_read" }) === true;
        if (!exactAllowlisted) needsRunLocalGrant = true;
        classifiedFields.push(field);
      }
      if (requestedFieldDenied) continue;
      if (!this.#get(this.candidates, candidate.candidateId)) continue;
      approvedCandidates.push({ candidate, selectedFields: classifiedFields, needsRunLocalGrant });
    }
    if (approvedCandidates.length !== 1) return [];
    const { candidate, selectedFields, needsRunLocalGrant } = approvedCandidates[0];
    let runLocalGrant = null;
    if (needsRunLocalGrant) {
      runLocalGrant = await this.#requestRunLocalPublicReadGrant({
        session, environment, principalId, candidate, selectedFields, maxRecords, signal
      });
      if (!runLocalGrant) return [];
    }
    const fingerprint = this.#fingerprint(JSON.stringify({
      source: candidateSourceProjection(candidate),
      fields: selectedFields.map(field => field.name)
    })).slice(0, 16);
    const capability = Object.freeze({
      id: `observed_read_${fingerprint}`,
      action: "extract",
      effectClass: "read",
      executionOrigin: "ephemeral_observed_read",
      intentBinding: "caller_required",
      targetRole: "observed_records",
      purposeCodes: Object.freeze(["extract_records"]),
      preconditionCodes: Object.freeze(["fresh_observed_source"]),
      postconditionCodes: Object.freeze(["observed_records_returned"]),
      verificationCodes: Object.freeze(["observed_records_verified"]),
      observedRoles: Object.freeze([]),
      observedTags: Object.freeze([]),
      outputCompleteness: "observed_partial",
      outputSchema: Object.freeze(selectedFields.map(field => Object.freeze({ name: field.name, type: field.type, required: field.required }))),
      async execute({ signal, observation: observedObservation = null } = {}) {
        if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_before_extraction" };
        const result = await thisService.readObservedRecords({
          session,
          environment,
          principalId,
          candidateId: candidate.candidateId,
          observedObservation,
          requestedFields: selectedFields,
          maxRecords,
          ...(runLocalGrant ? { runLocalGrantId: runLocalGrant.grantId, maxOutputBytes: thisService.publicReadMaxBytes } : {})
        }).catch(() => null);
        if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_extraction" };
        if (result?.status !== "observed_partial" || !result.output) return {
          status: result?.status === "blocked" ? "blocked" : "failed",
          reasonCode: result?.reasonCode ?? "ephemeral_extraction_unavailable",
          evidenceRefs: result?.evidenceRefs ?? []
        };
        if (runLocalGrant) {
          const consumed = thisService.publicReadGrantAuthority.consume(runLocalGrant.grantId, {
            principal: principalId,
            environmentId: runLocalGrant.environmentId,
            resource: session.target.id,
            operation: "read_public_observed_fields",
            input: runLocalGrant.input,
            effect: "return_result"
          });
          if (!consumed.ok) return { status: "blocked", reasonCode: "public_read_grant_expired_or_consumed" };
        }
        return {
          status: "verified",
          output: result.output,
          evidenceRefs: result.evidenceRefs,
          completeness: "observed_partial",
          reasonCode: result.reasonCode
        };
      }
    });
    const thisService = this;
    return [capability];
  }

  /** Read only the requested fields from one fresh visible source without registering a reusable capability. */
  /**
   * Offer a run-local read capability for a composite request whose visible
   * source may appear only after an authorized navigation step. Output fields
   * come from the caller request; execution resolves them against fresh page
   * evidence and the existing trusted field policy.
   */
  createDeferredObservedReadWorkflowCapabilities({ session, environment, principalId, goal, maxRecords = 100 } = {}) {
    if (typeof goal !== "string" || goal.length > 4096
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000
      || typeof principalId !== "string" || !principalId
      || session?.attached !== true || !session.target?.id
      || (typeof this.classifyField !== "function" && typeof this.classifyPublicField !== "function")) return [];
    const fieldNames = requestedSemanticFieldNames(goal);
    if (!fieldNames.length || fieldNames.length > 16) return [];
    const outputSchema = Object.freeze(fieldNames.map(name => Object.freeze({ name, type: "string", required: true })));
    const environmentId = environment?.environmentId ?? environment?.id ?? null;
    const fingerprint = this.#fingerprint(JSON.stringify({
      targetId: session.target.id,
      environmentId,
      principalId,
      fieldNames
    })).slice(0, 16);
    const thisService = this;
    const capability = Object.freeze({
      id: `observed_read_deferred_${fingerprint}`,
      action: "extract",
      effectClass: "read",
      intentBinding: "caller_required",
      targetRole: "observed_records",
      purposeCodes: Object.freeze(["extract_records"]),
      preconditionCodes: Object.freeze(["fresh_observed_source"]),
      postconditionCodes: Object.freeze(["observed_records_returned"]),
      verificationCodes: Object.freeze(["observed_records_verified"]),
      observedRoles: Object.freeze([]),
      observedTags: Object.freeze([]),
      outputCompleteness: "observed_partial",
      outputSchema,
      async execute({ signal, observation = null } = {}) {
        if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_before_extraction" };
        let current = observation;
        if (!current?.evidenceId || current.targetId !== session.target.id
          || current.documentGeneration !== session.documentGeneration) {
          current = await Promise.resolve().then(() => session.observe({ profile: "structural", selectionGoal: goal })).catch(() => null);
        }
        if (!current?.evidenceId || current.targetId !== session.target.id
          || current.documentGeneration !== session.documentGeneration) {
          return { status: "blocked", reasonCode: "fresh_observed_source_unavailable", records: [], evidenceRefs: [] };
        }
        const [resolved] = await thisService.createObservedReadWorkflowCapabilities({
          session, environment, principalId, observation: current, goal, maxRecords, signal
        });
        if (!resolved) return {
          status: "failed", reasonCode: "requested_observed_source_unavailable", records: [], evidenceRefs: [current.evidenceId]
        };
        const actualNames = resolved.outputSchema.map(field => field.name);
        if (actualNames.length !== fieldNames.length || fieldNames.some(name => !actualNames.includes(name))) {
          return {
            status: "failed", reasonCode: "requested_observed_fields_mismatch", records: [], evidenceRefs: [current.evidenceId]
          };
        }
        return await resolved.execute({ signal, observation: current });
      }
    });
    return [capability];
  }

  async readObservedRecords({ session, environment, principalId, candidateId = null, observedObservation = null, requestedFields, maxRecords = 100, uniqueBy = [], runLocalGrantId = null, maxOutputBytes = null } = {}) {
    if (!Array.isArray(requestedFields) || requestedFields.length < 1 || requestedFields.length > 32
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10_000
      || !Array.isArray(uniqueBy) || uniqueBy.length > 8
      || typeof principalId !== "string" || !principalId
      || requestedFields.some(field => !field || typeof field !== "object" || Array.isArray(field)
        || Object.keys(field).some(key => !["name", "sourceHeader", "sourceKey", "type", "required"].includes(key))
        || typeof field.name !== "string" || typeof field.type !== "string" || typeof field.required !== "boolean"
        || (typeof field.sourceHeader === "string") === (typeof field.sourceKey === "string"))) {
      return { status: "blocked", reasonCode: "ephemeral_extraction_policy_or_request_unavailable", records: [] };
    }
    let discovery;
    let candidates;
    if (candidateId !== null) {
      const entry = this.#get(this.candidates, candidateId);
      if (!entry || entry.targetId !== (session?.target?.id ?? null)
        || entry.principalId !== principalId
        || entry.environmentId !== (environment?.environmentId ?? environment?.id ?? null)) {
        return { status: "blocked", reasonCode: "observed_source_expired_or_scope_mismatch", records: [], evidenceRefs: [] };
      }
      discovery = { status: "candidate", candidates: [{ candidateId, ...entry.candidate }] };
      candidates = discovery.candidates.filter(candidate =>
        requestedFields.every(field => fieldMatchesCandidate(field, candidate)));
    } else {
      // Discovery already captured and retained a fresh immutable snapshot.
      // Reuse that exact evidence for a one-shot read instead of immediately
      // paying for a second full observation of the same page.
      discovery = await this.#discover({ session, environment, principalId });
      if (discovery.status !== "candidate") return {
        status: discovery.status === "empty" ? "incomplete" : discovery.status === "unavailable" ? "blocked" : "incomplete",
        reasonCode: discovery.reasonCode ?? "visible_structured_source_unavailable",
        records: [], evidenceRefs: []
      };
      candidates = discovery.candidates.filter(candidate =>
        requestedFields.every(field => fieldMatchesCandidate(field, candidate)));
    }
    if (candidates.length !== 1) return {
      status: candidates.length > 1 ? "incomplete" : "blocked",
      reasonCode: candidates.length > 1 ? "visible_source_ambiguous" : "requested_fields_not_observed",
      candidates: discovery.candidates.map(candidate => ({
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        headers: candidate.headers ?? [],
        fields: (candidate.fields ?? []).map(field => ({ sourceKey: field.sourceKey, tagName: field.sourceTagName })),
        visibleRowCount: candidate.visibleRowCount
      })),
      records: [], evidenceRefs: []
    };
    const selected = candidates[0];
    const entry = this.#get(this.candidates, selected.candidateId);
    if (!entry) return { status: "blocked", reasonCode: "observed_source_expired", records: [], evidenceRefs: [] };
    const publicScope = isPublicObservedReadScope(entry.candidate, environment);
    if (publicScope && typeof this.classifyPublicField !== "function") {
      return { status: "blocked", reasonCode: "public_observed_read_policy_unavailable", records: [], evidenceRefs: [] };
    }
    let effectiveGrantId = runLocalGrantId;
    let effectiveMaxOutputBytes = maxOutputBytes;
    let directRunLocalGrant = null;
    if (publicScope && !effectiveGrantId) {
      let requiresApproval = false;
      for (const field of requestedFields) {
        const scoped = Object.freeze({
          environmentId: entry.candidate.environmentId,
          applicationId: entry.candidate.applicationId,
          origin: entry.candidate.origin,
          fieldName: field.name,
          ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }),
          type: field.type
        });
        const policy = this.publicFieldPolicy?.(scoped) ?? null;
        const dataClass = policy?.dataClass ?? this.classifyPublicField?.(scoped) ?? classifyObservedPublicField(scoped);
        if (dataClass !== "public" || policy && (policy.allowRead !== true || policy.allowRelease !== true)) {
          return { status: "blocked", reasonCode: "field_read_policy_denied", deniedFields: [field.name], records: [], evidenceRefs: [] };
        }
        const exactAllowlisted = policy?.allowRead === true && policy?.allowRelease === true
          || this.authorizePublicRead?.(Object.freeze({ ...scoped, dataClass }), { principalId, scopeKind: "ephemeral_observed_read" }) === true
            && this.authorizePublicRelease?.(Object.freeze({ ...scoped, dataClass }), { principalId, scopeKind: "ephemeral_observed_read" }) === true;
        if (!exactAllowlisted) requiresApproval = true;
      }
      if (requiresApproval) {
        directRunLocalGrant = await this.#requestRunLocalPublicReadGrant({
          session, environment, principalId, candidate: selected,
          selectedFields: requestedFields, maxRecords
        });
        if (!directRunLocalGrant) return { status: "blocked", reasonCode: "public_read_operator_approval_required", records: [], evidenceRefs: [] };
        effectiveGrantId = directRunLocalGrant.grantId;
        effectiveMaxOutputBytes = directRunLocalGrant.input.maxBytes;
      }
    }
    if (!publicScope && (typeof this.classifyField !== "function" || typeof this.authorizeRead !== "function" || typeof this.authorizeRelease !== "function")) {
      return { status: "blocked", reasonCode: publicScope ? "public_observed_read_policy_unavailable" : "field_read_policy_unavailable", records: [], evidenceRefs: [] };
    }
    if (publicScope && typeof this.classifyPublicField !== "function") {
      return { status: "blocked", reasonCode: "public_observed_read_policy_unavailable", records: [], evidenceRefs: [] };
    }
    const classifyField = publicScope
      ? field => this.classifyPublicField(field) ?? classifyObservedPublicField(field)
      : this.classifyField;
    const publicAuthorizationContext = {
      principalId,
      scopeKind: "ephemeral_observed_read",
      targetId: session?.target?.id ?? null,
      candidateId: selected.candidateId,
      sourceFingerprint: entry.observedBinding.sourceFingerprint,
      environmentId: environmentKey(environment, entry.candidate.origin),
      applicationId: entry.candidate.applicationId ?? null,
      origin: entry.candidate.origin,
      maxRecords,
      maxOutputBytes: effectiveMaxOutputBytes,
      runLocalGrantId: effectiveGrantId
    };
    const authorizeRead = publicScope
      ? (field, context) => this.#authorizePublicField(field, { ...publicAuthorizationContext, ...context }, "read")
      : this.authorizeRead;
    const authorizeRelease = publicScope
      ? (field, context) => this.#authorizePublicField(field, { ...publicAuthorizationContext, ...context }, "release")
      : this.authorizeRelease;
    let extractionContract;
    try {
      const fields = requestedFields.map(field => ({
        name: field.name,
        ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : { sourceKey: field.sourceKey }),
        type: field.type,
        required: field.required
      }));
      extractionContract = compileEphemeralObservedReadContract({
        candidate: entry.candidate,
        fields,
        classifyField,
        maxRecords,
        uniqueBy
      });
    } catch (error) {
      return { status: "blocked", reasonCode: error?.message?.includes("sensitivity") || error?.message?.includes("classification")
        ? "field_classification_unavailable" : "observed_extraction_contract_invalid", records: [], evidenceRefs: [] };
    }
    const denied = extractionContract.fields.filter(field => {
      const scoped = Object.freeze({
        ...field,
        environmentId: extractionContract.environmentId,
        applicationId: extractionContract.applicationId,
        origin: extractionContract.origin,
        ...(publicScope ? publicAuthorizationContext : {})
      });
      return authorizeRead(scoped, { principalId, scopeKind: "ephemeral_observed_read" }) !== true;
    });
    if (denied.length) return { status: "blocked", reasonCode: "field_read_policy_denied", deniedFields: denied.map(field => field.name), records: [], evidenceRefs: [] };

    let observation;
    let evidence;
    if (candidateId === null) {
      observation = discovery.observation;
      evidence = discovery.evidence;
      if (session?.attached !== true || session.target?.id !== entry.targetId
        || observation?.targetId !== entry.targetId
        || observation?.documentGeneration !== session.documentGeneration
        || observation?.documentGeneration !== entry.observedBinding.documentGeneration) {
        return { status: "incomplete", reasonCode: "observed_source_stale", records: [], evidenceRefs: [] };
      }
    } else {
      try {
        ({ observation, evidence } = await this.#assertCurrentObservedReadCandidate(entry, {
          session, environment, principalId, observedObservation
        }));
      } catch (error) {
        return {
          status: "incomplete",
          reasonCode: typeof error?.reasonCode === "string" ? error.reasonCode : "observed_source_stale",
          records: [],
          evidenceRefs: []
        };
      }
    }
    if (evidence?.status !== "available" || !evidence.domSnapshot) return {
      status: "incomplete", reasonCode: "retained_dom_evidence_unavailable", records: [], evidenceRefs: [observation.evidenceId]
    };
    const documentIndex = evidence.documentIndex;
    const resolved = entry.candidate.kind === "visible_record_group"
      ? resolveVisibleRecordGroupRecords(evidence.domSnapshot, extractionContract, { index: documentIndex })
      : resolveVisibleTableRecords(evidence.domSnapshot, extractionContract, { index: documentIndex });
    if (resolved.status !== "available") return {
      status: "incomplete",
      reasonCode: `visible_source_${resolved.status}`,
      records: [], evidenceRefs: [observation.evidenceId]
    };
    const accumulator = new OutputAccumulator();
    const pageUrl = `${extractionContract.origin}${extractionContract.pagePath}`;
    accumulator.append("observed_records", "ephemeral.observed_records@1", {
      records: resolved.records,
      evidence: resolved.evidence,
      truncated: resolved.truncated === true
    }, { observationId: observation.evidenceId, pageUrl, maxRecords });
    const collected = accumulator.finalize("observed_records", extractionContract);
    const released = projectExtractionOutput(collected, authorizeRelease, {
      principalId, candidateId: selected.candidateId,
      ...(publicScope ? publicAuthorizationContext : {})
    });
    const retainedFieldCount = Object.keys(released.schema?.items ?? {}).length;
    if (retainedFieldCount === 0) return {
      status: "blocked", reasonCode: "no_fields_authorized_for_release", records: [], evidenceRefs: [observation.evidenceId]
    };
    const completionReasonCode = released.release?.status === "partial" ? "field_release_partial"
      : resolved.truncated === true ? "visible_record_limit_reached"
        : "collection_completeness_not_established";
    const output = Object.freeze({
      ...released,
      completeness: "observed_partial",
      verification: Object.freeze({
        ...released.verification,
        expectedRecords: null,
        completionPolicy: "observed_only",
        completenessStatus: "observed_partial",
        completionReasonCode,
        completenessClaimed: false
      })
    });
    if (effectiveMaxOutputBytes !== null && (!Number.isInteger(effectiveMaxOutputBytes) || effectiveMaxOutputBytes < 1
      || Buffer.byteLength(JSON.stringify(output), "utf8") > effectiveMaxOutputBytes)) {
      return { status: "blocked", reasonCode: "public_read_output_byte_limit_exceeded", records: [], evidenceRefs: [observation.evidenceId] };
    }
    if (directRunLocalGrant) {
      const consumed = this.publicReadGrantAuthority.consume(directRunLocalGrant.grantId, {
        principal: principalId,
        environmentId: directRunLocalGrant.environmentId,
        resource: session.target.id,
        operation: "read_public_observed_fields",
        input: directRunLocalGrant.input,
        effect: "return_result"
      });
      if (!consumed.ok) return { status: "blocked", reasonCode: "public_read_grant_expired_or_consumed", records: [], evidenceRefs: [observation.evidenceId] };
    }
    return {
      status: "observed_partial",
      reasonCode: completionReasonCode,
      records: output.records,
      schema: output.schema,
      completeness: output.completeness,
      verification: output.verification,
      output,
      evidenceRefs: [observation.evidenceId],
      candidateId: selected.candidateId
    };
  }

  async discoverObservedApis({ session, environment, principalId } = {}) {
    return this.#networkApiCapabilityService.discoverObservedApis({ session, environment, principalId });
  }

  async inspectObservedApi(candidateId, { session, environment, principalId } = {}) {
    return this.#networkApiCapabilityService.inspectObservedApi(candidateId, { session, environment, principalId });
  }

  async qualifyObservedApi(candidateId, { principalId = null, variants = 30, signal } = {}) {
    return this.#networkApiCapabilityService.qualifyObservedApi(candidateId, {
      principalId,
      variants,
      signal,
      runQualification: this.runApiQualification
    });
  }

  async compile({ candidateId, session, environment, principalId = null, ...input } = {}) {
    const entry = this.#get(this.candidates, candidateId);
    if (!entry) throw new Error("The discovered capability candidate is missing or expired; rediscover the current page.");
    if (entry.targetId !== (session?.target?.id ?? null)
      || entry.principalId !== (principalId ?? null)
      || entry.environmentId !== (environment?.environmentId ?? environment?.id ?? null)) {
      throw new Error("Capability candidate is bound to a different browser target, principal, or environment.");
    }
    await this.#assertCurrentCandidate(entry, { session, environment, principalId });
    const recipe = compileVisibleExtractionRecipe({
      ...input,
      candidate: entry.candidate,
      classifyField: this.classifyField,
      authorizePagination: this.authorizePagination
    });
    const recipeId = randomUUID();
    this.#remember(this.recipes, recipeId, { recipe, ...entry });
    return { recipeId, recipe };
  }

  async qualify(recipeId, options = {}) {
    if (!this.qualifier || typeof this.qualifier.qualify !== "function") return { status: "unavailable", reasonCode: "fixture_qualification_unavailable" };
    const entry = this.#get(this.recipes, recipeId);
    if (!entry) throw new Error("The compiled capability recipe is missing or expired; rediscover and compile it again.");
    if (entry.principalId !== (options.principalId ?? null)) throw new Error("Capability recipe is bound to a different principal.");
    await this.#assertCurrentCandidate(entry, options);
    const { session: _session, environment: _environment, principalId: _principalId, ...qualificationOptions } = options;
    const result = await this.qualifier.qualify(entry.recipe, qualificationOptions);
    if (result.status !== "qualified") return result;
    await this.#assertCurrentCandidate(entry, options);
    const registered = await this.registry.register(result.manifest);
    this.recipes.delete(recipeId);
    return { ...result, registered };
  }

  async execute(input) {
    return await executeExtractionCapability({ registry: this.registry, ...input });
  }

  async revoke(identity, options) {
    if (!this.registry || typeof this.registry.revoke !== "function") return { status: "unavailable", reasonCode: "capability_registry_revocation_unavailable" };
    return await this.registry.revoke(identity, options);
  }

  async #assertCurrentCandidate(entry, { session, environment, principalId = null } = {}) {
    if (session?.attached !== true || typeof session.target?.id !== "string"
      || session.target.id !== entry.targetId
      || principalId !== entry.principalId
      || (environment?.environmentId ?? environment?.id ?? null) !== entry.environmentId) {
      throw new Error("Capability candidate is no longer bound to the authorized target, principal, or environment.");
    }
    const observation = await session.observe?.();
    if (!observation?.evidenceId || observation.targetId !== entry.targetId
      || observation.documentGeneration !== session.documentGeneration) {
      throw new Error("Capability compilation and qualification require fresh evidence from the discovered target.");
    }
    let observedUrl;
    try { observedUrl = new URL(observation.page?.url); }
    catch { throw new Error("The capability candidate's current application route is unavailable."); }
    if (observedUrl.username || observedUrl.password || observedUrl.search || observedUrl.hash
      || observedUrl.origin !== entry.candidate.origin || observedUrl.pathname !== entry.candidate.pagePath) {
      throw new Error("The capability candidate's current route differs from the discovered exact route.");
    }
    const application = resolveObservedApplication(environment, observedUrl.href);
    if (application.status !== "matched" || application.applicationId !== entry.candidate.applicationId) {
      throw new Error("The current observed application identity differs from the discovered capability candidate.");
    }
    const retained = session.observer?.getEvidence?.(observation.evidenceId, { facets: ["domSnapshot"] });
    if (retained?.status !== "available" || !retained.domSnapshot) {
      throw new Error("Fresh retained DOM evidence is unavailable for the capability candidate.");
    }
    const discovered = discoverTableCapabilities({
      observation,
      domSnapshot: retained.domSnapshot,
      environmentId: entry.environmentId,
      applicationId: application.applicationId,
      principalId
    });
    const matchingSources = discovered.candidates.filter(candidate => sameCandidateSource(candidate, entry.candidate));
    if (matchingSources.length !== 1) {
      throw new Error("The discovered structured source is no longer uniquely present in fresh DOM evidence.");
    }
    return observation;
  }

  async #assertCurrentObservedReadCandidate(entry, { session, environment, principalId = null, observedObservation = null } = {}) {
    if (session?.attached !== true || typeof session.target?.id !== "string"
      || session.target.id !== entry.targetId
      || principalId !== entry.principalId
      || (environment?.environmentId ?? environment?.id ?? null) !== entry.environmentId
      || !entry.observedBinding) {
      throw observedReadFailure("observed_source_scope_mismatch", "Ephemeral read is no longer bound to its authorized target, principal, or environment.");
    }
    const observation = observedObservation ?? await session.observe?.();
    if (!observation?.evidenceId || observation.targetId !== entry.targetId
      || observation.documentGeneration !== session.documentGeneration
      || observation.documentGeneration !== entry.observedBinding.documentGeneration
      || (observedObservation !== null && observation.evidenceId !== entry.observedBinding.observationId)) {
      throw observedReadFailure("observed_source_generation_changed", "Ephemeral read requires the original current document generation.");
    }
    let observedUrl;
    try { observedUrl = new URL(observation.page?.url); }
    catch { throw observedReadFailure("observed_route_changed", "Ephemeral read requires a current HTTP(S) page."); }
    let privateObservedUrl;
    try { privateObservedUrl = new URL(retainedRouteUrl(session, observation)); }
    catch { throw observedReadFailure("observed_route_changed", "The private current-page route is unavailable."); }
    if (!["http:", "https:"].includes(observedUrl.protocol) || observedUrl.username || observedUrl.password
      || !["http:", "https:"].includes(privateObservedUrl.protocol) || privateObservedUrl.username || privateObservedUrl.password
      || observedUrl.origin !== entry.candidate.origin || observedUrl.pathname !== entry.candidate.pagePath
      || privateObservedUrl.origin !== observedUrl.origin || privateObservedUrl.pathname !== observedUrl.pathname
      || this.#fingerprint(`route\u0000${privateObservedUrl.href}`) !== entry.observedBinding.routeFingerprint) {
      throw observedReadFailure("observed_route_changed", "The query-bound ephemeral read route changed after discovery.");
    }
    let applicationId = null;
    if (environment) {
      const application = resolveObservedApplication(environment, observedUrl.href);
      if (application.status !== "matched" || application.applicationId !== entry.candidate.applicationId) {
        throw observedReadFailure("observed_application_changed", "The ephemeral read no longer matches its profile application scope.");
      }
      applicationId = application.applicationId;
    } else if (entry.candidate.environmentId !== null || entry.candidate.applicationId !== null) {
      throw observedReadFailure("observed_source_scope_mismatch", "A profile-bound candidate cannot be reused without its environment binding.");
    }
    const evidence = session.observer?.getEvidence?.(observation.evidenceId, { facets: ["domSnapshot"] });
    if (evidence?.status !== "available" || !evidence.domSnapshot) {
      throw observedReadFailure("observed_source_evidence_unavailable", "Fresh retained DOM evidence is unavailable for the ephemeral read.");
    }
    const documentIndex = buildDocumentIndex(evidence.domSnapshot);
    const discovered = discoverTableCapabilities({
      observation,
      domSnapshot: evidence.domSnapshot,
      environmentId: entry.environmentId,
      applicationId,
      principalId,
      documentIndex
    });
    const matchingSources = discovered.candidates.filter(candidate => sameCandidateSource(candidate, entry.candidate)
      && this.#fingerprint(JSON.stringify(candidateSourceProjection(candidate))) === entry.observedBinding.sourceFingerprint);
    if (matchingSources.length !== 1) {
      throw observedReadFailure("observed_source_changed_or_ambiguous", "The source structure changed or became ambiguous after discovery.");
    }
    return { observation, evidence: { ...evidence, documentIndex } };
  }

  #fingerprint(value) {
    return createHmac("sha256", this.routeFingerprintKey).update(String(value)).digest("hex");
  }

  #remember(map, id, value) {
    this.#prune(map);
    map.set(id, { ...value, expiresAt: Date.now() + this.candidateTtlMs });
    while (map.size > this.maxCandidates) map.delete(map.keys().next().value);
  }

  #get(map, id) {
    this.#prune(map);
    const entry = map.get(id);
    return entry ? { ...entry } : null;
  }

  #prune(map) {
    const now = Date.now();
    for (const [id, entry] of map) if (entry.expiresAt <= now) map.delete(id);
  }
}
