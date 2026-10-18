import { randomUUID } from "node:crypto";
import { discoverTableCapabilities } from "./capabilityDiscovery.js";
import { compileTableRecipe } from "./recipeCompiler.js";
import { executeExtractionCapability } from "./recipeExecutor.js";

/** Native ActiveTab facade for discovery, candidate compilation, qualification, and reuse. */
export class CapabilityService {
  constructor({ registry, qualifier, classifyField, authorizePagination = null, maxCandidates = 100, candidateTtlMs = 15 * 60_000 } = {}) {
    this.registry = registry;
    this.qualifier = qualifier;
    this.classifyField = classifyField;
    this.authorizePagination = authorizePagination;
    this.maxCandidates = Math.max(1, Math.min(1000, Number(maxCandidates) || 100));
    this.candidateTtlMs = Math.max(60_000, Math.min(60 * 60_000, Number(candidateTtlMs) || 15 * 60_000));
    this.candidates = new Map();
    this.recipes = new Map();
  }

  async discover({ session, environment, principalId } = {}) {
    const observation = await session?.observe?.();
    if (!observation?.evidenceId || observation.documentGeneration !== session.documentGeneration) {
      return { status: "unavailable", candidates: [], reasonCode: "fresh_observation_required" };
    }
    const evidence = session.observer?.getEvidence?.(observation.evidenceId, { facets: ["domSnapshot"] });
    if (evidence?.status !== "available" || !evidence.domSnapshot) {
      return { status: "unavailable", candidates: [], reasonCode: "retained_dom_evidence_unavailable" };
    }
    let origin;
    try { origin = new URL(observation.page.url).origin; }
    catch { return { status: "unavailable", candidates: [], reasonCode: "page_origin_unavailable" }; }
    const discovery = discoverTableCapabilities({
      observation,
      domSnapshot: evidence.domSnapshot,
      environmentId: environment?.environmentId ?? environment?.id ?? null,
      applicationId: environment?.applications?.find(application => application.origin === origin)?.applicationId ?? null,
      principalId
    });
    const candidates = discovery.candidates.map(candidate => {
      const candidateId = randomUUID();
      this.#remember(this.candidates, candidateId, {
        candidate,
        targetId: session.target?.id ?? null,
        principalId: principalId ?? null,
        environmentId: environment?.environmentId ?? environment?.id ?? null
      });
      return { candidateId, ...candidate };
    });
    return { ...discovery, candidates };
  }

  compile({ candidateId, session, environment, principalId = null, ...input } = {}) {
    const entry = this.#get(this.candidates, candidateId);
    if (!entry) throw new Error("The discovered capability candidate is missing or expired; rediscover the current page.");
    if (entry.targetId !== (session?.target?.id ?? null)
      || entry.principalId !== (principalId ?? null)
      || entry.environmentId !== (environment?.environmentId ?? environment?.id ?? null)) {
      throw new Error("Capability candidate is bound to a different browser target, principal, or environment.");
    }
    const recipe = compileTableRecipe({
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
    const result = await this.qualifier.qualify(entry.recipe, options);
    if (result.status !== "qualified") return result;
    const registered = await this.registry.register(result.manifest);
    this.recipes.delete(recipeId);
    return { ...result, registered };
  }

  async execute(input) {
    return await executeExtractionCapability({ registry: this.registry, ...input });
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
