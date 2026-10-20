import { jsonByteLength } from "./evidenceSizing.js";

const MAX_RUNTIME_RECORD_BYTES = 512 * 1024;
const MAX_RUNTIME_RECORDS_PER_EVIDENCE = 8;
const MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE = 1024 * 1024;

/** Owns retained observation entries and every retained-byte adjustment. */
export class EvidenceStore {
  #entries = new Map();
  #onEvict;
  #bytes = 0;
  #peakBytes = 0;

  constructor({ limit = 12, maxBytes = 64 * 1024 * 1024, onEvict = null } = {}) {
    this.limit = Math.max(1, Math.min(limit, 100));
    this.maxBytes = Math.max(1024 * 1024, Math.min(maxBytes, 256 * 1024 * 1024));
    this.#onEvict = typeof onEvict === "function" ? onEvict : null;
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  get size() {
    return this.#entries.size;
  }

  get bytes() {
    return this.#bytes;
  }

  get peakBytes() {
    return this.#peakBytes;
  }

  retain(id, entry) {
    if (typeof id !== "string" || !id) throw new TypeError("Evidence ID must be a non-empty string.");
    if (!entry || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new TypeError("Evidence entry must include a non-negative safe byteLength.");
    }
    if (this.#entries.has(id)) throw new Error("Evidence ID is already retained.");
    if (entry.byteLength > this.maxBytes) return false;
    this.#entries.set(id, entry);
    this.#bytes += entry.byteLength;
    while (this.#entries.size > this.limit || this.#bytes > this.maxBytes) {
      const oldestId = this.#entries.keys().next().value;
      const oldest = this.#entries.get(oldestId);
      this.#entries.delete(oldestId);
      this.#bytes -= oldest.byteLength;
      this.#onEvict?.(oldestId);
      if (oldestId === id) return false;
    }
    this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
    return true;
  }

  appendRuntimeRecord(id, record) {
    const stored = this.#entries.get(id);
    if (!stored) return false;

    const recordBytes = jsonByteLength(record);
    const currentRuntimeBytes = stored.evidence.runtimeStateBytes ?? 0;
    if (recordBytes > MAX_RUNTIME_RECORD_BYTES
      || stored.byteLength - currentRuntimeBytes + recordBytes > this.maxBytes
      || this.#bytes - currentRuntimeBytes + recordBytes > this.maxBytes) return false;

    const records = stored.evidence.runtimeStateRecords;
    const originalRecords = records.slice();
    const originalRuntimeBytes = currentRuntimeBytes;
    const originalEntryBytes = stored.byteLength;
    const originalSerializedBytes = stored.serializedByteLength;
    const originalTotalBytes = this.#bytes;
    while (records.length && (records.length >= MAX_RUNTIME_RECORDS_PER_EVIDENCE
      || (stored.evidence.runtimeStateBytes ?? 0) + recordBytes > MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE)) {
      const removed = records.shift();
      const removedBytes = jsonByteLength(removed);
      stored.evidence.runtimeStateBytes = Math.max(0, (stored.evidence.runtimeStateBytes ?? 0) - removedBytes);
      stored.byteLength -= removedBytes;
      this.#bytes -= removedBytes;
    }
    if ((stored.evidence.runtimeStateBytes ?? 0) + recordBytes > MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE) return false;

    records.push(record);
    stored.evidence.runtimeStateBytes = (stored.evidence.runtimeStateBytes ?? 0) + recordBytes;
    stored.serializedByteLength = jsonByteLength(stored.evidence);
    stored.byteLength = stored.serializedByteLength + (stored.lookupIndexBytes ?? 0);
    this.#bytes = originalTotalBytes + stored.byteLength - originalEntryBytes;
    if (stored.byteLength <= this.maxBytes && this.#bytes <= this.maxBytes) {
      this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
      return true;
    }

    records.splice(0, records.length, ...originalRecords);
    stored.evidence.runtimeStateBytes = originalRuntimeBytes;
    stored.byteLength = originalEntryBytes;
    stored.serializedByteLength = originalSerializedBytes;
    this.#bytes = originalTotalBytes;
    return false;
  }
}
