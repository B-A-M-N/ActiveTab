/**
 * Persistent knowledge store — local, bounded, owner-restricted.
 *
 * Stores discovered application capability maps keyed by origin.
 * Knowledge obtained under one identity/role is scoped to that identity
 * and must be revalidated when authorization or application revision changes.
 */

import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MAX_STORES = 64;
const MAX_FILE_BYTES = 1024 * 1024;

export class KnowledgeStore {
  constructor(baseDir) {
    if (typeof baseDir !== "string" || !baseDir) throw new Error("KnowledgeStore requires a baseDir.");
    this.baseDir = String(baseDir);
  }

  #compositeKey({ origin, authority = null, principalScope = null }) {
    // Knowledge from one authorization realm must never be reused under
    // another without revalidation. Include authority and principal scope
    // in the storage key to enforce this boundary.
    const identity = JSON.stringify([origin, authority, principalScope]);
    return createHash("sha256").update(identity).digest("hex").slice(0, 32);
  }

  async #ensureDir() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  async save(capabilityMap, { authority = null, principalScope = null } = {}) {
    if (!capabilityMap || typeof capabilityMap !== "object" || !capabilityMap.origin) {
      throw new Error("KnowledgeStore.save requires a capabilityMap with origin.");
    }
    await this.#ensureDir();
    const key = this.#compositeKey({ origin: capabilityMap.origin, authority, principalScope });
    const path = join(this.baseDir, `${key}.json`);
    const payload = {
      ...capabilityMap,
      savedAt: new Date().toISOString(),
      authority: authority ?? null,
      principalScope: principalScope ?? null
    };
    const json = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(json) > MAX_FILE_BYTES) {
      throw new Error(`Capability map for '${capabilityMap.origin}' exceeds ${MAX_FILE_BYTES} bytes.`);
    }
    await writeFile(path, json, { mode: 0o600 });
    // Bounded store: remove oldest entries if over limit.
    const files = await readdir(this.baseDir).catch(() => []);
    if (files.length > MAX_STORES) {
      const sorted = await Promise.all(files.filter(f => f.endsWith(".json")).map(async f => {
        const stat = await readFile(join(this.baseDir, f), "utf8").catch(() => "{}");
        let savedAt = "";
        try { savedAt = JSON.parse(stat).savedAt ?? ""; } catch { /* ignore */ }
        return { f, savedAt };
      }));
      sorted.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      while (sorted.length > MAX_STORES) {
        const oldest = sorted.shift();
        await rm(join(this.baseDir, oldest.f), { force: true }).catch(() => {});
      }
    }
    return { origin: capabilityMap.origin, savedAt: payload.savedAt };
  }

  async load(origin, { authority = null, principalScope = null } = {}) {
    if (typeof origin !== "string" || !origin) throw new Error("KnowledgeStore.load requires an origin.");
    const key = this.#compositeKey({ origin, authority, principalScope });
    const path = join(this.baseDir, `${key}.json`);
    const raw = await readFile(path, "utf8").catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async list() {
    await this.#ensureDir().catch(() => {});
    const files = await readdir(this.baseDir).catch(() => []);
    const entries = [];
    for (const file of files.filter(f => f.endsWith(".json"))) {
      const raw = await readFile(join(this.baseDir, file), "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        entries.push({ origin: parsed.origin, savedAt: parsed.savedAt, revision: parsed.revision, observationCount: parsed.observationCount });
      } catch { /* skip invalid */ }
    }
    return entries;
  }

  async clear() {
    await rm(this.baseDir, { recursive: true, force: true }).catch(() => {});
  }
}
