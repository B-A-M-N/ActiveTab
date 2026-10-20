import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolveObservedApplication } from "../environments/model.js";
import { discoverTableCapabilities } from "./capabilityDiscovery.js";
import { compileVisibleExtractionRecipe } from "./recipeCompiler.js";
import { executeExtractionCapability } from "./recipeExecutor.js";
import { NetworkApiCapabilityService } from "./network/networkApiCapabilityService.js";
import { ObservedReadService } from "./observedReadService.js";
import { buildDocumentIndex } from "../observe/documentIndex.js";
import { candidateSourceProjection, retainedRouteUrl, sameCandidateSource } from "./observedReadSupport.js";

/** Native ActiveTab facade for discovery, candidate compilation, qualification, and reuse. */
export class CapabilityService {
  #networkApiCapabilityService;
  #observedReadService;

  constructor({ registry, qualifier, classifyField, authorizeRead = null, authorizeRelease = null, authorizePublicRead = null, authorizePublicRelease = null, classifyPublicField = null, publicFieldPolicy = null, approvePublicRead = null, publicReadGrantNow = () => Date.now(), publicReadGrantTtlMs = 5 * 60_000, publicReadMaxBytes = 64 * 1024, authorizePagination = null, runApiQualification = null, maxCandidates = 100, candidateTtlMs = 15 * 60_000 } = {}) {
    this.registry = registry;
    this.qualifier = qualifier;
    this.classifyField = classifyField;
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
    this.#observedReadService = new ObservedReadService({
      discover: (...args) => this.#discover(...args),
      getCandidate: candidateId => this.#get(this.candidates, candidateId),
      fingerprint: value => this.#fingerprint(value),
      classifyField,
      authorizeRead,
      authorizeRelease,
      authorizePublicRead,
      authorizePublicRelease,
      classifyPublicField,
      publicFieldPolicy,
      approvePublicRead,
      publicReadGrantNow,
      publicReadGrantTtlMs,
      publicReadMaxBytes
    });
    // Preserve the existing inspection surface while observed-read ownership moves to its service.
    this.publicReadGrantAuthority = this.#observedReadService.publicReadGrantAuthority;
    this.publicReadGrantStore = this.#observedReadService.publicReadGrantStore;
    this.publicReadGrantBindings = this.#observedReadService.publicReadGrantBindings;
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
  async createObservedReadWorkflowCapabilities(input = {}) {
    return await this.#observedReadService.createObservedReadWorkflowCapabilities(input);
  }

  createDeferredObservedReadWorkflowCapabilities(input = {}) {
    return this.#observedReadService.createDeferredObservedReadWorkflowCapabilities(input);
  }

  async readObservedRecords(input = {}) {
    return await this.#observedReadService.readObservedRecords(input);
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
