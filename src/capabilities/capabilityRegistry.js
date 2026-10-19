import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cloneCapabilityManifest, validateSiteCapabilityManifest } from "./siteCapabilityManifest.js";

/** In-memory registry populated only by trusted application composition. */
export class CapabilityRegistry {
  constructor(options = {}) {
    const normalized = Array.isArray(options) ? { manifests: options } : options;
    const manifests = normalized.manifests ?? [];
    this.directory = normalized.directory ? resolve(normalized.directory) : null;
    this.manifests = new Map();
    this.revocations = new Map();
    for (const manifest of manifests) this.#add(manifest);
  }

  async init() {
    if (!this.directory) return this;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Capability registry path must be a real directory, not a symlink.");
    await chmod(this.directory, 0o700);
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isRevocationFilename(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 16 * 1024) throw new Error("Capability revocation must be a bounded regular file.");
      await chmod(path, 0o600);
      const revocation = validateRevocationRecord(JSON.parse(await readFile(path, "utf8")));
      const key = manifestKey(revocation);
      if (revocationFilename(revocation) !== entry.name) throw new Error("Capability revocation filename does not match its scoped identity.");
      if (this.revocations.has(key)) throw new Error("Capability revocation is duplicated for its scoped identity.");
      this.revocations.set(key, revocation);
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isManifestFilename(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 256 * 1024) throw new Error("Capability manifest must be a bounded regular file.");
      await chmod(path, 0o600);
      const manifest = JSON.parse(await readFile(path, "utf8"));
      const stored = this.#validateAndClone(manifest);
      if (manifestFilename(stored) !== entry.name) throw new Error("Capability manifest filename does not match its scoped identity.");
      if (!this.revocations.has(manifestKey(stored))) this.#add(stored);
    }
    return this;
  }

  async register(manifest) {
    const stored = this.#validateAndClone(manifest);
    const key = manifestKey(stored);
    if (this.revocations.has(key)) throw new Error(`Capability '${stored.capabilityId}@${stored.capabilityVersion}' has been revoked for this scope.`);
    if (this.manifests.has(key)) throw new Error(`Capability '${stored.capabilityId}@${stored.capabilityVersion}' is already registered for this scope.`);
    if (this.directory) {
      const path = join(this.directory, manifestFilename(stored));
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(stored, null, 2), "utf8");
        await file.sync();
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      await file.close();
      if (this.revocations.has(key)) {
        await unlink(path).catch(() => {});
        throw new Error(`Capability '${stored.capabilityId}@${stored.capabilityVersion}' was revoked while registration was completing.`);
      }
    }
    this.manifests.set(key, stored);
    return stored;
  }

  #add(manifest) {
    const stored = this.#validateAndClone(manifest);
    const key = manifestKey(stored);
    if (this.manifests.has(key)) throw new Error(`Capability '${stored.capabilityId}@${stored.capabilityVersion}' is duplicated for this scope.`);
    this.manifests.set(key, stored);
    return stored;
  }

  #validateAndClone(manifest) {
    const validation = validateSiteCapabilityManifest(manifest, { requireQualified: true });
    if (!validation.valid) throw new Error(`Capability cannot be registered: ${validation.errors.join(" ")}`);
    return cloneCapabilityManifest(manifest);
  }

  resolve(capabilityId, { capabilityVersion = 1, origin, environmentId, applicationId, principalId = null } = {}) {
    if (typeof capabilityId !== "string") return null;
    const candidates = [...this.manifests.values()].filter(manifest => manifest.capabilityId === capabilityId);
    const matches = candidates.filter(manifest => manifest.capabilityVersion === capabilityVersion
      && manifest.origin === origin
      && manifest.environmentId === environmentId
      && manifest.applicationId === applicationId
      && manifest.principalId === principalId);
    return matches.length === 1 ? matches[0] : null;
  }

  async revoke(identity, { reasonCode } = {}) {
    const scoped = normalizeCapabilityIdentity(identity);
    if (typeof reasonCode !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(reasonCode)) {
      throw new Error("Capability revocation requires a bounded reason code.");
    }
    const key = manifestKey(scoped);
    if (this.revocations.has(key)) return { status: "already_revoked", capabilityId: scoped.capabilityId, capabilityVersion: scoped.capabilityVersion };
    if (!this.manifests.has(key)) return { status: "not_found", capabilityId: scoped.capabilityId, capabilityVersion: scoped.capabilityVersion };
    const revocation = Object.freeze({
      schemaVersion: 1,
      ...scoped,
      reasonCode,
      revokedAt: new Date().toISOString()
    });
    if (this.directory) {
      const path = join(this.directory, revocationFilename(revocation));
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(revocation, null, 2), "utf8");
        await file.sync();
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      await file.close();
    }
    this.revocations.set(key, revocation);
    this.manifests.delete(key);
    return { status: "revoked", capabilityId: scoped.capabilityId, capabilityVersion: scoped.capabilityVersion, revokedAt: revocation.revokedAt };
  }

  list() { return [...this.manifests.values()]; }
}

function manifestKey(manifest) {
  return `${manifest.capabilityId}@${manifest.capabilityVersion}:${manifest.environmentId}:${manifest.origin}:${manifest.applicationId}:${manifest.principalId ?? "*"}`;
}

function manifestFilename(manifest) {
  return `${identityDigest(manifest)}.json`;
}

function revocationFilename(identity) {
  return `${identityDigest(identity)}.revoked.json`;
}

function identityDigest(identity) {
  return createHash("sha256").update(manifestKey(identity)).digest("hex");
}

function isManifestFilename(filename) {
  if (!filename.endsWith(".json") || filename.length !== 69) return false;
  for (const character of filename.slice(0, 64)) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

function isRevocationFilename(filename) {
  if (!filename.endsWith(".revoked.json") || filename.length !== 77) return false;
  for (const character of filename.slice(0, 64)) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

function normalizeCapabilityIdentity(identity) {
  const allowed = ["capabilityId", "capabilityVersion", "origin", "environmentId", "applicationId", "principalId"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(identity, key))) {
    throw new Error("Capability revocation requires the exact registered scope.");
  }
  if (typeof identity.capabilityId !== "string" || !identity.capabilityId || identity.capabilityId.length > 96
    || !Number.isInteger(identity.capabilityVersion) || identity.capabilityVersion < 1 || identity.capabilityVersion > 1000
    || typeof identity.environmentId !== "string" || !identity.environmentId || identity.environmentId.length > 128
    || typeof identity.applicationId !== "string" || !identity.applicationId || identity.applicationId.length > 96
    || typeof identity.principalId !== "string" || !identity.principalId || identity.principalId.length > 128) {
    throw new Error("Capability revocation scope contains invalid identity fields.");
  }
  let origin;
  try { origin = new URL(identity.origin); } catch { throw new Error("Capability revocation origin must be an exact HTTP(S) origin."); }
  if (!new Set(["http:", "https:"]).has(origin.protocol) || origin.origin !== identity.origin) {
    throw new Error("Capability revocation origin must be an exact HTTP(S) origin.");
  }
  return {
    capabilityId: identity.capabilityId,
    capabilityVersion: identity.capabilityVersion,
    origin: identity.origin,
    environmentId: identity.environmentId,
    applicationId: identity.applicationId,
    principalId: identity.principalId
  };
}

function validateRevocationRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1
    || Object.keys(value).some(key => !new Set(["schemaVersion", "capabilityId", "capabilityVersion", "origin", "environmentId", "applicationId", "principalId", "reasonCode", "revokedAt"]).has(key))) {
    throw new Error("Capability revocation record is malformed.");
  }
  const identity = normalizeCapabilityIdentity(Object.fromEntries(["capabilityId", "capabilityVersion", "origin", "environmentId", "applicationId", "principalId"].map(key => [key, value[key]])));
  if (typeof value.reasonCode !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(value.reasonCode)
    || typeof value.revokedAt !== "string" || !Number.isFinite(Date.parse(value.revokedAt))
    || new Date(value.revokedAt).toISOString() !== value.revokedAt) {
    throw new Error("Capability revocation record has an invalid reason or timestamp.");
  }
  return Object.freeze({ schemaVersion: 1, ...identity, reasonCode: value.reasonCode, revokedAt: value.revokedAt });
}
