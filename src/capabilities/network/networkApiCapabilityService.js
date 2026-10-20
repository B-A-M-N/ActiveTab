import { discoverObservedApiRequests, inspectObservedApiCandidate, qualifyObservedApiCandidate } from "./apiDiscovery.js";

/** Owns bounded candidate lifecycle for observed, read-only network API shapes. */
export class NetworkApiCapabilityService {
  constructor({ maxCandidates = 100, candidateTtlMs = 15 * 60_000 } = {}) {
    this.maxCandidates = Math.max(1, Math.min(1000, Number(maxCandidates) || 100));
    this.candidateTtlMs = Math.max(60_000, Math.min(60 * 60_000, Number(candidateTtlMs) || 15 * 60_000));
    this.candidates = new Map();
  }

  async discoverObservedApis({ session, environment, principalId } = {}) {
    const observation = await session?.observe?.();
    if (!observation?.evidenceId || observation.documentGeneration !== session.documentGeneration
      || typeof session.target?.id !== "string" || observation.targetId !== session.target.id) {
      return { status: "unavailable", candidates: [], reasonCode: "fresh_observation_required" };
    }
    const evidence = session.observer?.getEvidence?.(observation.evidenceId, { facets: ["networkActivity"] });
    if (evidence?.status !== "available" || !Array.isArray(evidence.networkActivity)) {
      return { status: "unavailable", candidates: [], reasonCode: "network_activity_unavailable" };
    }
    const discovery = discoverObservedApiRequests({
      observation,
      networkActivity: evidence.networkActivity,
      environment,
      principalId
    });
    for (const candidate of discovery.candidates) {
      this.#remember(candidate.candidateId, {
        candidate,
        observation: {
          evidenceId: observation.evidenceId,
          targetId: observation.targetId,
          documentGeneration: observation.documentGeneration,
          page: { url: observation.page?.url }
        },
        targetId: session.target.id,
        principalId: principalId ?? null,
        environmentId: environment?.environmentId ?? environment?.id ?? null
      });
    }
    return discovery;
  }

  async inspectObservedApi(candidateId, { session, environment, principalId } = {}) {
    const entry = this.#get(candidateId);
    if (!entry) return { status: "unavailable", reasonCode: "api_candidate_missing_or_expired" };
    if (entry.targetId !== session?.target?.id || entry.principalId !== (principalId ?? null)
      || entry.environmentId !== (environment?.environmentId ?? environment?.id ?? null)) {
      return { status: "blocked", reasonCode: "api_candidate_scope_mismatch" };
    }
    const current = await session?.observe?.();
    if (!current?.evidenceId || current.targetId !== entry.targetId
      || current.documentGeneration !== entry.observation.documentGeneration
      || current.documentGeneration !== session.documentGeneration
      || current.page?.url !== entry.observation.page.url) {
      return { status: "blocked", reasonCode: "api_candidate_observation_stale" };
    }
    const inspected = await inspectObservedApiCandidate({
      candidate: entry.candidate,
      observation: entry.observation,
      observer: session.observer
    });
    if (inspected.status !== "candidate") return inspected;
    for (const candidate of inspected.candidates) {
      this.#remember(candidate.candidateId, {
        candidate,
        observation: entry.observation,
        targetId: entry.targetId,
        principalId: entry.principalId,
        environmentId: entry.environmentId
      });
    }
    return inspected;
  }

  async qualifyObservedApi(candidateId, { principalId = null, variants = 30, signal, runQualification } = {}) {
    const entry = this.#get(candidateId);
    if (!entry) return { status: "unavailable", reasonCode: "api_candidate_missing_or_expired" };
    if (entry.principalId !== principalId) return { status: "blocked", reasonCode: "api_candidate_principal_mismatch" };
    if (!Array.isArray(entry.candidate.fields)) return { status: "blocked", reasonCode: "api_candidate_inspection_required" };
    if (entry.candidate.qualificationStatus === "qualified") return { status: "qualified", candidate: entry.candidate };
    const result = await qualifyObservedApiCandidate(entry.candidate, {
      variants,
      signal,
      runQualification
    });
    if (result.status === "qualified") {
      this.#remember(candidateId, { ...entry, candidate: result.candidate });
    }
    return result;
  }

  #remember(id, value) {
    this.#prune();
    this.candidates.set(id, { ...value, expiresAt: Date.now() + this.candidateTtlMs });
    while (this.candidates.size > this.maxCandidates) this.candidates.delete(this.candidates.keys().next().value);
  }

  #get(id) {
    this.#prune();
    const entry = this.candidates.get(id);
    return entry ? { ...entry } : null;
  }

  #prune() {
    const now = Date.now();
    for (const [id, entry] of this.candidates) if (entry.expiresAt <= now) this.candidates.delete(id);
  }
}
