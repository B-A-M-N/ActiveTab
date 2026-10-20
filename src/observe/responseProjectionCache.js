const RESPONSE_PROJECTION_CACHE_TTL_MS = 5 * 60_000;
const RESPONSE_PROJECTION_CACHE_MAX_ENTRIES = 2;
const RESPONSE_PROJECTION_CACHE_MAX_BYTES = 18 * 1024 * 1024;
const RESPONSE_PROJECTION_CACHE_MAX_ENTRY_BYTES = 17 * 1024 * 1024;

/** Owns the short-lived redacted views derived from retained response evidence. */
export class ResponseProjectionCache {
  #entries = new Map();
  #bytes = 0;

  get size() {
    return this.#entries.size;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      this.#bytes -= entry.weightBytes;
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  store(key, projection) {
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      analysis: projection.analysis,
      credentialDetails: projection.credentialDetails,
      sections: projection.markdownIndex?.sections,
      blocks: projection.markdownIndex?.blocks
    })) + (projection.byteOffsets.checkpoints.length * 32);
    const weightBytes = metadataBytes + (projection.selectedView.length * 2);
    if (weightBytes > RESPONSE_PROJECTION_CACHE_MAX_ENTRY_BYTES) return false;
    const prior = this.#entries.get(key);
    if (prior) {
      this.#entries.delete(key);
      this.#bytes -= prior.weightBytes;
    }
    const entry = { projection, weightBytes, expiresAt: Date.now() + RESPONSE_PROJECTION_CACHE_TTL_MS };
    this.#entries.set(key, entry);
    this.#bytes += weightBytes;
    while (this.#entries.size > RESPONSE_PROJECTION_CACHE_MAX_ENTRIES || this.#bytes > RESPONSE_PROJECTION_CACHE_MAX_BYTES) {
      const oldestKey = this.#entries.keys().next().value;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#bytes -= oldest.weightBytes;
    }
    return this.#entries.has(key);
  }

  deleteForEvidence(evidenceId) {
    for (const [key, entry] of this.#entries) {
      if (entry.projection.evidenceId !== evidenceId) continue;
      this.#entries.delete(key);
      this.#bytes -= entry.weightBytes;
    }
  }
}
