/**
 * Diagnostic collector — run-scoped, metadata-first retrieval from
 * registered, contract-authorized sources.
 *
 * The collector never infers authority. Every source registration requires
 * an explicit contract (see contracts.js) and a fetch function that the
 * collector invokes only after validating the requested operation.
 */

import { validateAccess } from "./contracts.js";

const MAX_SOURCES = 64;
const MAX_SNAPSHOTS = 256;

export class DiagnosticCollector {
  constructor({ runId, maxSources = 32, maxSnapshots = 128 } = {}) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("DiagnosticCollector requires a runId.");
    }
    this.runId = String(runId);
    this.sources = new Map();
    this.snapshots = [];
    this.maxSources = Math.max(1, Math.min(maxSources, MAX_SOURCES));
    this.maxSnapshots = Math.max(1, Math.min(maxSnapshots, MAX_SNAPSHOTS));
    this.sourceCallCounts = new Map();
  }

  /**
   * Register a diagnostic source.
   * @param {object} contract - Result of createDiagnosticContract().
   * @param {function} fetchFn - async (operation, options) => data
   */
  register(contract, fetchFn) {
    if (typeof fetchFn !== "function") {
      throw new Error(`Diagnostic source '${contract.id}' requires a fetch function.`);
    }
    if (this.sources.size >= this.maxSources) {
      throw new Error(`Diagnostic source limit (${this.maxSources}) reached.`);
    }
    if (this.sources.has(contract.id)) {
      throw new Error(`Diagnostic source '${contract.id}' is already registered.`);
    }
    this.sources.set(contract.id, { contract, fetchFn });
    this.sourceCallCounts.set(contract.id, 0);
    return this;
  }

  hasSource(id) {
    return this.sources.has(id);
  }

  listSources() {
    return [...this.sources.values()].map(({ contract }) => ({
      id: contract.id,
      authority: contract.authority,
      operations: contract.operations,
      scope: contract.scope,
      sensitivity: contract.sensitivity,
      rateLimit: contract.rateLimit,
      description: contract.description
    }));
  }

  /**
   * Collect from one registered source after contract validation.
   * @param {string} sourceId - Registered source id.
   * @param {string} operation - One of the contract's permitted operations.
   * @param {object} [options] - Source-specific options passed through to fetchFn.
   */
  async collect(sourceId, operation, options = {}) {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Diagnostic source '${sourceId}' is not registered.`);
    }
    const denial = validateAccess(source.contract, operation);
    if (denial) {
      throw new Error(`Diagnostic access denied: ${denial}`);
    }
    const count = this.sourceCallCounts.get(sourceId);
    const limit = source.contract.rateLimit?.maxCalls ?? null;
    if (limit !== null && count >= limit) {
      throw new Error(`Diagnostic source '${sourceId}' rate limit (${limit} calls) exceeded.`);
    }
    this.sourceCallCounts.set(sourceId, count + 1);
    const data = await source.fetchFn(operation, options);
    const snapshot = {
      snapshotId: crypto.randomUUID(),
      sourceId,
      operation,
      collectedAt: new Date().toISOString(),
      runId: this.runId,
      ...(data?.evidenceId ? { evidenceId: data.evidenceId } : {}),
      ...(data?.status ? { status: data.status } : {}),
      data
    };
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    return snapshot;
  }

  /**
   * Collect from multiple sources in parallel.
   */
  async collectAll(requests) {
    const results = await Promise.allSettled(
      requests.map(({ sourceId, operation, options }) => this.collect(sourceId, operation, options))
    );
    return results.map((result, index) => ({
      sourceId: requests[index].sourceId,
      ...(result.status === "fulfilled"
        ? { status: "ok", snapshot: result.value }
        : { status: "error", error: String(result.reason?.message ?? result.reason) })
    }));
  }

  getSnapshots({ sourceId = null, runId = null } = {}) {
    return this.snapshots.filter(snapshot =>
      (sourceId === null || snapshot.sourceId === sourceId) &&
      (runId === null || snapshot.runId === runId)
    );
  }

  clearSnapshots() {
    this.snapshots = [];
  }
}
