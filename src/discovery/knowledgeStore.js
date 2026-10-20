/**
 * Persistent knowledge store — local, bounded, owner-restricted.
 *
 * Stores discovered application capability maps under an explicitly
 * configured, canonical, owner-private directory. Retention and clear only
 * remove entries whose filename and stored identity validate as this store's.
 */

import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

const MAX_STORES = 64;
const MAX_FILE_BYTES = 1024 * 1024;
const STORE_FORMAT = "activetab.discovery.knowledge";
const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const FILE_NAME = /^[a-f0-9]{32}\.json$/u;
const writeQueues = new Map();

async function serializeByRoot(root, operation) {
  const previous = writeQueues.get(root) ?? Promise.resolve();
  let release;
  const current = new Promise(resolveCurrent => { release = resolveCurrent; });
  writeQueues.set(root, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(root) === current) writeQueues.delete(root);
  }
}

function assertPrivatePath(stat, path, kind) {
  if (stat.isSymbolicLink()) throw new Error(`KnowledgeStore ${kind} must not be a symlink: ${path}`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`KnowledgeStore ${kind} has the wrong file type: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`KnowledgeStore ${kind} is not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`KnowledgeStore ${kind} must be owner-only: ${path}`);
  }
}

function validScopeValue(value) {
  return value === null || typeof value === "string";
}

function validCapabilityMap(value, scope) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.origin === scope.origin
    && value.applicationId === scope.applicationId
    && (value.environmentId ?? null) === scope.environmentId
    && Array.isArray(value.pages)
    && Array.isArray(value.controls)
    && Array.isArray(value.networkOperations));
}

function validLegacyCapabilityMap(value, origin) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.origin === origin
    && Array.isArray(value.pages)
    && Array.isArray(value.controls)
    && Array.isArray(value.networkOperations));
}

function optionalScopeId(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`KnowledgeStore ${name} must be a non-empty stable identifier or null.`);
  }
  return value;
}

export function canonicalDiscoveryKnowledgeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("KnowledgeStore requires a trusted discovery knowledge scope.");
  }
  const { origin, environmentId, applicationId, authenticationRealm, principalId } = scope;
  if (typeof origin !== "string") throw new Error("KnowledgeStore scope requires a canonical HTTP(S) origin.");
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); }
  catch { throw new Error("KnowledgeStore scope requires a canonical HTTP(S) origin."); }
  if (!["http:", "https:"].includes(parsedOrigin.protocol)
    || parsedOrigin.origin !== origin
    || parsedOrigin.username
    || parsedOrigin.password) {
    throw new Error("KnowledgeStore scope requires a canonical HTTP(S) origin.");
  }
  if (typeof applicationId !== "string" || !applicationId.trim()
    || applicationId !== applicationId.trim() || applicationId.length > 256) {
    throw new Error("KnowledgeStore scope requires a stable applicationId.");
  }
  if (typeof principalId !== "string" || !principalId.trim()
    || principalId !== principalId.trim() || principalId.length > 256) {
    throw new Error("KnowledgeStore scope requires a stable principalId.");
  }
  return Object.freeze({
    origin,
    environmentId: optionalScopeId(environmentId, "environmentId"),
    applicationId,
    authenticationRealm: optionalScopeId(authenticationRealm, "authenticationRealm"),
    principalId
  });
}

export class KnowledgeStore {
  constructor(baseDir) {
    if (typeof baseDir !== "string" || !baseDir.trim()) {
      throw new Error("KnowledgeStore requires an explicitly configured baseDir.");
    }
    if (!isAbsolute(baseDir)) {
      throw new Error("KnowledgeStore baseDir must be an absolute canonical path.");
    }
    this.baseDir = resolve(baseDir);
    this.rootInitialized = false;
  }

  #compositeKey(scope) {
    const identity = JSON.stringify([
      STORE_VERSION,
      scope.origin,
      scope.environmentId,
      scope.applicationId,
      scope.authenticationRealm,
      scope.principalId
    ]);
    return createHash("sha256").update(identity).digest("hex").slice(0, 32);
  }

  #legacyCompositeKey({ origin, authority = null, principalScope = null }) {
    const identity = JSON.stringify([origin, authority, principalScope]);
    return createHash("sha256").update(identity).digest("hex").slice(0, 32);
  }

  async #assertNoSymlinkComponents() {
    const { root } = parse(this.baseDir);
    let current = root;
    const components = this.baseDir.slice(root.length).split(sep).filter(Boolean);
    for (const component of components) {
      current = join(current, component);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`KnowledgeStore path must not contain symlinks: ${current}`);
      }
    }
  }

  async #ensureDir() {
    if (!this.rootInitialized) {
      await this.#assertNoSymlinkComponents();
      await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    }
    const stat = await lstat(this.baseDir);
    assertPrivatePath(stat, this.baseDir, "directory");
    const canonicalPath = await realpath(this.baseDir);
    const pathsMatch = process.platform === "win32"
      ? canonicalPath.toLowerCase() === this.baseDir.toLowerCase()
      : canonicalPath === this.baseDir;
    if (!pathsMatch) throw new Error("KnowledgeStore baseDir must resolve to its canonical path.");
    this.rootInitialized = true;
  }

  async #readFile(path) {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, owned: false };
      throw error;
    }

    try {
      const stat = await file.stat();
      assertPrivatePath(stat, path, "file");
      if (stat.size > MAX_FILE_BYTES) return { exists: true, owned: false };
      return { exists: true, contents: await file.readFile("utf8") };
    } finally {
      await file.close();
    }
  }

  #identifyEntry(parsed, key) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    if (parsed.store === STORE_FORMAT) {
      if (parsed.key !== key) return null;
      if (parsed.version === STORE_VERSION) {
        let scope;
        try { scope = canonicalDiscoveryKnowledgeScope(parsed.identity); }
        catch { return null; }
        if (this.#compositeKey(scope) !== key
          || typeof parsed.savedAt !== "string"
          || !Number.isFinite(Date.parse(parsed.savedAt))
          || !validCapabilityMap(parsed.capabilityMap, scope)) return null;
        return {
          identity: scope,
          capabilityMap: parsed.capabilityMap,
          savedAt: parsed.savedAt,
          reusable: true
        };
      }
      if (parsed.version !== LEGACY_STORE_VERSION) return null;

      // Version 1 entries used only origin/authority/principalScope. Keep
      // recognizing them for safe retention and clear, but never reuse them.
      const identity = parsed.identity;
      if (typeof identity?.origin !== "string" || !identity.origin
        || !validScopeValue(identity.authority)
        || !validScopeValue(identity.principalScope)
        || this.#legacyCompositeKey(identity) !== key
        || typeof parsed.savedAt !== "string"
        || !Number.isFinite(Date.parse(parsed.savedAt))
        || !validLegacyCapabilityMap(parsed.capabilityMap, identity.origin)) return null;
      return {
        identity,
        capabilityMap: parsed.capabilityMap,
        savedAt: parsed.savedAt,
        reusable: false,
        legacy: true
      };
    }

    // Strictly recognize entries written by the pre-envelope format so they
    // can be removed safely, but never reuse them under a scoped key.
    const identity = {
      origin: parsed.origin,
      authority: parsed.authority ?? null,
      principalScope: parsed.principalScope ?? null
    };
    const capabilityMap = parsed;
    if (typeof identity.origin !== "string" || !identity.origin
      || !validScopeValue(identity.authority)
      || !validScopeValue(identity.principalScope)
      || typeof parsed.savedAt !== "string" || !Number.isFinite(Date.parse(parsed.savedAt))
      || !validLegacyCapabilityMap(capabilityMap, identity.origin)
      || this.#legacyCompositeKey(identity) !== key) return null;
    return {
      identity,
      capabilityMap,
      savedAt: parsed.savedAt,
      reusable: false,
      legacy: true
    }
  }

  async #readEntry(path, key) {
    const result = await this.#readFile(path);
    if (!result.exists) return { exists: false, owned: false };
    if (typeof result.contents !== "string") return { exists: true, owned: false };
    let parsed;
    try { parsed = JSON.parse(result.contents); }
    catch { return { exists: true, owned: false }; }
    const entry = this.#identifyEntry(parsed, key);
    return entry
      ? { exists: true, owned: true, ...entry }
      : { exists: true, owned: false };
  }

  async #ownedEntries() {
    const files = await readdir(this.baseDir, { withFileTypes: true });
    const entries = [];
    for (const file of files) {
      if (!file.isFile() || !FILE_NAME.test(file.name)) continue;
      const key = file.name.slice(0, -5);
      const path = join(this.baseDir, file.name);
      const entry = await this.#readEntry(path, key);
      if (entry.owned) entries.push({ key, path, ...entry });
    }
    return entries;
  }

  async #writeAtomic(path, key, json) {
    const temporaryPath = join(this.baseDir, `.${key}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(json, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
      created = false;
    } finally {
      if (created) await unlink(temporaryPath).catch(() => {});
    }
  }

  async #enforceRetention() {
    const candidates = (await readdir(this.baseDir, { withFileTypes: true }))
      .filter(file => file.isFile() && FILE_NAME.test(file.name));
    if (candidates.length <= MAX_STORES) return;
    const entries = [];
    for (const file of candidates) {
      const key = file.name.slice(0, -5);
      const path = join(this.baseDir, file.name);
      const entry = await this.#readEntry(path, key);
      if (entry.owned) entries.push({ key, path, ...entry });
    }
    entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    while (entries.length > MAX_STORES) {
      const oldest = entries.shift();
      await unlink(oldest.path);
    }
  }

  async save(capabilityMap, scopeInput) {
    if (!capabilityMap || typeof capabilityMap !== "object" || !capabilityMap.origin) {
      throw new Error("KnowledgeStore.save requires a capabilityMap with origin.");
    }
    const scope = canonicalDiscoveryKnowledgeScope(scopeInput);
    if (capabilityMap.origin !== scope.origin || capabilityMap.applicationId !== scope.applicationId
      || (capabilityMap.environmentId ?? null) !== scope.environmentId
      || !validCapabilityMap(capabilityMap, scope)) {
      throw new Error("KnowledgeStore scope must match a complete capability map's origin, environment, and application.");
    }

    return await serializeByRoot(this.baseDir, async () => {
      await this.#ensureDir();
      const key = this.#compositeKey(scope);
      const path = join(this.baseDir, `${key}.json`);
      const existing = await this.#readEntry(path, key);
      if (existing.exists && !existing.owned) {
        throw new Error("KnowledgeStore refuses to replace an unowned entry.");
      }

      const savedAt = new Date().toISOString();
      const record = {
        store: STORE_FORMAT,
        version: STORE_VERSION,
        key,
        identity: scope,
        savedAt,
        capabilityMap
      };
      const json = JSON.stringify(record, null, 2);
      if (Buffer.byteLength(json) > MAX_FILE_BYTES) {
        throw new Error(`Capability map for '${capabilityMap.origin}' exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      await this.#writeAtomic(path, key, json);
      await this.#enforceRetention();
      return {
        origin: capabilityMap.origin,
        environmentId: scope.environmentId,
        applicationId: scope.applicationId,
        authenticationRealm: scope.authenticationRealm,
        savedAt
      };
    });
  }

  async load(scopeInput) {
    const scope = canonicalDiscoveryKnowledgeScope(scopeInput);
    await this.#ensureDir();
    const key = this.#compositeKey(scope);
    const entry = await this.#readEntry(join(this.baseDir, `${key}.json`), key);
    if (!entry.owned || !entry.reusable) return null;
    return {
      ...entry.capabilityMap,
      savedAt: entry.savedAt,
      knowledgeScope: entry.identity
    };
  }

  async list() {
    await this.#ensureDir();
    const entries = await this.#ownedEntries();
    return entries.filter(entry => entry.reusable).map(({ identity, savedAt, capabilityMap }) => ({
      origin: capabilityMap.origin,
      environmentId: identity.environmentId,
      applicationId: identity.applicationId,
      authenticationRealm: identity.authenticationRealm,
      savedAt,
      revision: capabilityMap.revision,
      observationCount: capabilityMap.observationCount
    }));
  }

  async clear() {
    await serializeByRoot(this.baseDir, async () => {
      await this.#ensureDir();
      const entries = await this.#ownedEntries();
      for (const entry of entries) await unlink(entry.path);
    });
  }
}
