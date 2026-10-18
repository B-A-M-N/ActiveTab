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
    for (const manifest of manifests) this.#add(manifest);
  }

  async init() {
    if (!this.directory) return this;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Capability registry path must be a real directory, not a symlink.");
    await chmod(this.directory, 0o700);
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isManifestFilename(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 256 * 1024) throw new Error("Capability manifest must be a bounded regular file.");
      await chmod(path, 0o600);
      const manifest = JSON.parse(await readFile(path, "utf8"));
      const stored = this.#add(manifest);
      if (manifestFilename(stored) !== entry.name) throw new Error("Capability manifest filename does not match its scoped identity.");
    }
    return this;
  }

  async register(manifest) {
    const stored = this.#validateAndClone(manifest);
    const key = manifestKey(stored);
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

  list() { return [...this.manifests.values()]; }
}

function manifestKey(manifest) {
  return `${manifest.capabilityId}@${manifest.capabilityVersion}:${manifest.environmentId}:${manifest.origin}:${manifest.applicationId}:${manifest.principalId ?? "*"}`;
}

function manifestFilename(manifest) {
  return `${createHash("sha256").update(manifestKey(manifest)).digest("hex")}.json`;
}

function isManifestFilename(filename) {
  if (!filename.endsWith(".json") || filename.length !== 69) return false;
  for (const character of filename.slice(0, 64)) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}
