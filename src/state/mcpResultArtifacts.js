import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

function assertOwnedDirectory(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("MCP result artifact directory must be a real directory owned by the current user.");
  }
}

function stripCheckpointUrlDetails(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function redactCheckpointRoutes(checkpoint) {
  for (const page of checkpoint.pageEvidence ?? []) {
    const pageUrl = stripCheckpointUrlDetails(page.pageUrl);
    if (!pageUrl) throw new Error("MCP collection checkpoint contains an unsupported page route.");
    page.pageUrl = pageUrl;
  }
  for (const provenance of checkpoint.output?.fieldProvenance ?? []) {
    for (const field of Object.values(provenance.fields ?? {})) {
      if (typeof field.pageUrl !== "string") continue;
      const pageUrl = stripCheckpointUrlDetails(field.pageUrl);
      if (!pageUrl) throw new Error("MCP collection checkpoint contains an unsupported source route.");
      field.pageUrl = pageUrl;
    }
  }
}

/** Stores only verified, policy-released extraction outputs beside MCP journals. */
export class McpResultArtifactStore {
  constructor({ directory, key } = {}) {
    if (typeof directory !== "string" || !directory || !/^[a-f0-9]{64}$/.test(key ?? "")) {
      throw new Error("MCP result artifacts require a directory and opaque task key.");
    }
    this.directory = join(directory, "result-artifacts");
    this.path = join(this.directory, `${key}.json`);
    this.checkpointPath = join(this.directory, `${key}.checkpoint.json`);
    this.directoryReady = undefined;
  }

  async #ensureDirectory() {
    this.directoryReady ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      assertOwnedDirectory(await lstat(this.directory));
      await chmod(this.directory, 0o700);
    })();
    await this.directoryReady;
  }

  async read() {
    try { await this.#ensureDirectory(); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const fileStat = await lstat(this.path).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!fileStat) return null;
    if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
        (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Refusing to read an unsafe MCP result artifact.");
    }
    if (fileStat.size > MAX_ARTIFACT_BYTES) throw new Error("MCP result artifact exceeds the 5 MiB local storage limit.");
    await chmod(this.path, 0o600);
    const contents = await readFile(this.path, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("MCP result artifact exceeds the 5 MiB local storage limit.");
    const value = JSON.parse(contents);
    if (value?.schemaVersion !== 1 || typeof value.taskId !== "string" || typeof value.targetId !== "string" ||
        value.taskId.length > 128 || value.targetId.length > 256 || typeof value.endpoint !== "string" || value.endpoint.length > 256 ||
        typeof value.goalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.goalFingerprint) ||
        (value.environmentFingerprint !== null && !/^[a-f0-9]{64}$/.test(value.environmentFingerprint ?? "")) ||
        typeof value.principalId !== "string" || value.principalId.length > 128 || typeof value.intentFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.intentFingerprint) || !value.outputs || typeof value.outputs !== "object" || Array.isArray(value.outputs)) {
      throw new Error("MCP result artifact is invalid or unsupported.");
    }
    if (!Array.isArray(value.requiredCapabilityIds) || value.requiredCapabilityIds.length < 1 || value.requiredCapabilityIds.length > 24 ||
        value.requiredCapabilityIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id)) ||
        Object.keys(value.outputs).length !== value.requiredCapabilityIds.length ||
        value.requiredCapabilityIds.some(id => !Object.hasOwn(value.outputs, id)) ||
        !value.capabilityBindings || typeof value.capabilityBindings !== "object" || Array.isArray(value.capabilityBindings) ||
        Object.keys(value.capabilityBindings).length !== value.requiredCapabilityIds.length ||
        value.requiredCapabilityIds.some(id => {
          const binding = value.capabilityBindings[id];
          return !binding || !Number.isInteger(binding.capabilityVersion) || binding.capabilityVersion < 1 ||
            typeof binding.environmentId !== "string" || typeof binding.origin !== "string" ||
            typeof binding.applicationId !== "string" || typeof binding.pagePath !== "string" ||
            typeof binding.principalId !== "string" || !/^[a-f0-9]{64}$/.test(binding.manifestFingerprint ?? "");
        })) {
      throw new Error("MCP result artifact capability binding is invalid.");
    }
    return value;
  }

  async write(value) {
    await this.#ensureDirectory();
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_BYTES) {
      throw new Error("MCP result artifact exceeds the 5 MiB local storage limit.");
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, this.path);
    }
    catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
  }

  async writeCheckpoint(value) {
    await this.#ensureDirectory();
    const checkpoint = { ...value };
    delete checkpoint.checkpointFingerprint;
    redactCheckpointRoutes(checkpoint);
    const checkpointFingerprint = createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
    const serialized = `${JSON.stringify({ ...checkpoint, checkpointFingerprint }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_BYTES) {
      throw new Error("MCP partial-result checkpoint exceeds the 5 MiB local storage limit.");
    }
    const temp = `${this.checkpointPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, this.checkpointPath);
      await chmod(this.checkpointPath, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async readCheckpoint() {
    try { await this.#ensureDirectory(); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const fileStat = await lstat(this.checkpointPath).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!fileStat) return null;
    if (!fileStat.isFile() || fileStat.isSymbolicLink()
      || (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Refusing to read an unsafe MCP partial-result checkpoint.");
    }
    if (fileStat.size > MAX_ARTIFACT_BYTES) throw new Error("MCP partial-result checkpoint exceeds the 5 MiB local storage limit.");
    await chmod(this.checkpointPath, 0o600);
    const contents = await readFile(this.checkpointPath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("MCP partial-result checkpoint exceeds the 5 MiB local storage limit.");
    const value = JSON.parse(contents);
    const { checkpointFingerprint, ...unsigned } = value ?? {};
    const expectedFingerprint = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    if (checkpointFingerprint !== expectedFingerprint
      || value?.schemaVersion !== 1 || value.kind !== "partial_collection_checkpoint"
      || typeof value.taskId !== "string" || typeof value.targetId !== "string" || typeof value.endpoint !== "string"
      || typeof value.goalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.goalFingerprint)
      || (value.environmentFingerprint !== null && !/^[a-f0-9]{64}$/.test(value.environmentFingerprint ?? ""))
      || typeof value.principalId !== "string" || typeof value.intentFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.intentFingerprint)
      || typeof value.capabilityId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value.capabilityId)
      || !Number.isInteger(value.capabilityVersion) || value.capabilityVersion < 1
      || !/^[a-f0-9]{64}$/.test(value.contractFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(value.fieldPolicyFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(value.releasePolicyFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(value.sourceObservationRef ?? "")
      || !Array.isArray(value.pageIdentityFingerprints) || value.pageIdentityFingerprints.length < 1 || value.pageIdentityFingerprints.length > 100
      || value.pageIdentityFingerprints.some(item => !/^[a-f0-9]{64}$/.test(item))
      || !/^[a-f0-9]{64}$/.test(value.cursorFingerprint ?? "")
      || (value.nextCursorFingerprint !== null && !/^[a-f0-9]{64}$/.test(value.nextCursorFingerprint ?? ""))
      || !new Set(["available", "not_found"]).has(value.nextPageStatus)
      || !Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 100
      || !Number.isInteger(value.duplicateRecordCount) || value.duplicateRecordCount < 0 || value.duplicateRecordCount > 100_000
      || !Array.isArray(value.unresolvedOperationIds) || value.unresolvedOperationIds.length !== 0
      || !value.capabilityBindings || typeof value.capabilityBindings !== "object" || Array.isArray(value.capabilityBindings)
      || Object.keys(value.capabilityBindings).length !== 1 || !value.capabilityBindings[value.capabilityId]
      || !Array.isArray(value.pageEvidence) || value.pageEvidence.length !== value.pageCount
      || value.pageEvidence.some(item => !item || typeof item.observationId !== "string" || typeof item.pageUrl !== "string" || !Number.isInteger(item.maxRecords))
      || !value.output || typeof value.output !== "object" || Array.isArray(value.output)
      || value.output.completeness !== "incomplete" || value.output.release?.status === "partial"
      || !value.output.scope || !Array.isArray(value.output.records) || !Array.isArray(value.output.fieldProvenance)
      || !value.output.verification || value.output.verification.pageCount !== value.pageCount) {
      throw new Error("MCP partial-result checkpoint is invalid or unsupported.");
    }
    return value;
  }

  async clearCheckpoint() {
    try { await this.#ensureDirectory(); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const fileStat = await lstat(this.checkpointPath).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!fileStat) return;
    if (!fileStat.isFile() || fileStat.isSymbolicLink()
      || (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Refusing to remove an unsafe MCP partial-result checkpoint.");
    }
    await rm(this.checkpointPath, { force: true });
  }

  async clear() {
    await this.clearCheckpoint();
    try { await this.#ensureDirectory(); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const fileStat = await lstat(this.path).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!fileStat) return;
    if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
        (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Refusing to remove an unsafe MCP result artifact.");
    }
    await rm(this.path, { force: true });
  }
}
