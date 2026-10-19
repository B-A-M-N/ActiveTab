import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DISPATCH_TOKENS = new WeakSet();
const TOKEN_BINDINGS = new WeakMap();

function assertOwnedDirectory(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Upload staging must be a real directory owned by the current user.");
  }
}

function metadata(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}

async function hashHandle(handle, maxBytes = MAX_UPLOAD_BYTES) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > maxBytes) throw new Error("Approved upload exceeds the local byte limit.");
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { digest: hash.digest("hex"), size: position };
}

async function inspectSource(path) {
  const fullPath = resolve(path);
  const before = await lstat(fullPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > MAX_UPLOAD_BYTES
    || typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("Upload source must be a regular file owned by the current user and within the byte limit.");
  }
  const actualPath = await realpath(fullPath);
  if (actualPath !== fullPath) throw new Error("Upload source path must not traverse a symbolic link.");
  const handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || JSON.stringify(metadata(opened)) !== JSON.stringify(metadata(before))) {
      throw new Error("Upload source changed while it was being approved.");
    }
    const content = await hashHandle(handle);
    const after = await handle.stat();
    const finalLstat = await lstat(fullPath);
    if (JSON.stringify(metadata(after)) !== JSON.stringify(metadata(before))
      || JSON.stringify(metadata(finalLstat)) !== JSON.stringify(metadata(before)) || content.size !== before.size) {
      throw new Error("Upload source changed while it was being read.");
    }
    return { fullPath, metadata: metadata(before), digest: content.digest, size: content.size };
  } finally { await handle.close(); }
}

async function copyApprovedFile(sourcePath, targetPath) {
  const input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const output = await open(targetPath, "wx", 0o600);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > MAX_UPLOAD_BYTES) throw new Error("Approved upload exceeds the local byte limit.");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await output.write(chunk, 0, chunk.length, position - bytesRead);
    }
    await output.sync();
    return { digest: hash.digest("hex"), size: position };
  } finally {
    await input.close();
    await output.close();
  }
}

/**
 * One-use, exact-file upload grants. Issuing a grant is a trusted composition
 * operation; the opaque grant ID is never accepted from model output.
 */
export class FileUploadGrantStore {
  constructor({ stagingDirectory, trustedIssuer, now = () => Date.now() } = {}) {
    if (typeof stagingDirectory !== "string" || !stagingDirectory
      || typeof trustedIssuer !== "string" || !trustedIssuer
      || typeof now !== "function") throw new Error("File upload grants require a private staging directory and trusted issuer.");
    this.stagingDirectory = resolve(stagingDirectory);
    this.trustedIssuer = trustedIssuer;
    this.now = now;
    this.grants = new Map();
    this.ready = null;
  }

  async #ensureDirectory() {
    this.ready ??= (async () => {
      await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
      assertOwnedDirectory(await lstat(this.stagingDirectory));
      await chmod(this.stagingDirectory, 0o700);
    })();
    await this.ready;
  }

  async issue({ approvalRef, filePath, principalId, targetId, candidateIdentity, operationId, environmentId, applicationId,
    expiresInMs = 120_000 } = {}) {
    if (typeof approvalRef !== "string" || !approvalRef || approvalRef.length > 160
      || ![principalId, targetId, candidateIdentity, operationId, environmentId, applicationId].every(value => typeof value === "string" && value)
      || !Number.isInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > 600_000) {
      throw new Error("Upload grant requires an explicit approval reference, exact scope, and bounded expiry.");
    }
    await this.#ensureDirectory();
    const source = await inspectSource(filePath);
    const grantId = randomUUID();
    const grantDirectory = join(this.stagingDirectory, grantId);
    await mkdir(grantDirectory, { mode: 0o700 });
    const stagedPath = join(grantDirectory, basename(source.fullPath));
    try {
      const staged = await copyApprovedFile(source.fullPath, stagedPath);
      const afterCopy = await inspectSource(source.fullPath);
      if (afterCopy.digest !== source.digest || afterCopy.size !== source.size
        || JSON.stringify(afterCopy.metadata) !== JSON.stringify(source.metadata)
        || staged.digest !== source.digest || staged.size !== source.size) {
        throw new Error("Upload source changed while the approved copy was staged.");
      }
      this.grants.set(grantId, {
        grantId, approvalRef, principalId, targetId, candidateIdentity, operationId, environmentId, applicationId,
        sourcePath: source.fullPath, sourceMetadata: source.metadata, contentDigest: source.digest, size: source.size,
        stagedPath, grantDirectory, state: "active", createdAt: this.now(), expiresAt: this.now() + expiresInMs
      });
      return Object.freeze({ grantId, approvalRef, targetId, operationId, expiresAt: new Date(this.now() + expiresInMs).toISOString() });
    } catch (error) {
      await rm(grantDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  get(grantId) {
    const grant = this.grants.get(grantId);
    return grant ? Object.freeze({ grantId, state: grant.state, targetId: grant.targetId, operationId: grant.operationId, expiresAt: new Date(grant.expiresAt).toISOString() }) : null;
  }

  async #checkSourceAndStage(grant) {
    const source = await inspectSource(grant.sourcePath);
    if (source.digest !== grant.contentDigest || source.size !== grant.size
      || JSON.stringify(source.metadata) !== JSON.stringify(grant.sourceMetadata)) return false;
    const stagedStat = await lstat(grant.stagedPath);
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink()
      || typeof process.getuid === "function" && stagedStat.uid !== process.getuid()) return false;
    const staged = await open(grant.stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const hash = await hashHandle(staged);
      return hash.digest === grant.contentDigest && hash.size === grant.size;
    } finally { await staged.close(); }
  }

  async verify(grantId, context = {}) {
    const grant = this.grants.get(grantId);
    if (!grant) return { ok: false, reasonCode: "upload_grant_unavailable" };
    if (grant.state !== "active") return { ok: false, reasonCode: "upload_grant_not_active" };
    if (grant.expiresAt <= this.now()) { grant.state = "expired"; return { ok: false, reasonCode: "upload_grant_expired" }; }
    for (const key of ["principalId", "targetId", "operationId", "environmentId", "applicationId", "candidateIdentity"]) {
      if (!context[key] || context[key] !== grant[key]) return { ok: false, reasonCode: "upload_grant_scope_mismatch" };
    }
    try {
      if (!await this.#checkSourceAndStage(grant)) return { ok: false, reasonCode: "upload_source_changed" };
    } catch { return { ok: false, reasonCode: "upload_source_unavailable" }; }
    return { ok: true, expiresAt: grant.expiresAt };
  }

  async beginDispatch(grantId, context = {}) {
    const grant = this.grants.get(grantId);
    if (!grant || grant.state !== "active") return { ok: false, reasonCode: "upload_grant_not_active" };
    grant.state = "validating";
    const check = await this.verifyWhileValidating(grant, context);
    if (!check.ok) {
      grant.state = check.reasonCode === "upload_grant_expired" ? "expired" : "active";
      return check;
    }
    grant.state = "dispatching";
    const token = Object.freeze({});
    DISPATCH_TOKENS.add(token);
    TOKEN_BINDINGS.set(token, { grantId, ...context, filePaths: [grant.stagedPath] });
    return { ok: true, grantId, stagedPaths: [grant.stagedPath], dispatchToken: token };
  }

  async verifyWhileValidating(grant, context) {
    if (grant.expiresAt <= this.now()) return { ok: false, reasonCode: "upload_grant_expired" };
    for (const key of ["principalId", "targetId", "operationId", "environmentId", "applicationId", "candidateIdentity"]) {
      if (!context[key] || context[key] !== grant[key]) return { ok: false, reasonCode: "upload_grant_scope_mismatch" };
    }
    try {
      if (!await this.#checkSourceAndStage(grant)) return { ok: false, reasonCode: "upload_source_changed" };
    } catch { return { ok: false, reasonCode: "upload_source_unavailable" }; }
    return { ok: true };
  }

  async assertDispatchToken(token, context = {}) {
    if (!DISPATCH_TOKENS.has(token)) return { ok: false, reasonCode: "upload_dispatch_token_invalid" };
    const binding = TOKEN_BINDINGS.get(token);
    if (binding?.targetId !== context.targetId || binding?.candidateIdentity !== context.candidateIdentity) {
      return { ok: false, reasonCode: "upload_grant_scope_mismatch" };
    }
    const grant = this.grants.get(binding.grantId);
    if (!grant || grant.state !== "dispatching") return { ok: false, reasonCode: "upload_grant_not_active" };
    const check = await this.verifyWhileValidating(grant, binding);
    return check;
  }

  async complete(grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.state = "consumed";
    await rm(grant.grantDirectory, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async revoke(grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    if (grant.state === "active") grant.state = "revoked";
    await rm(grant.grantDirectory, { recursive: true, force: true }).catch(() => {});
    return true;
  }
}

export function isFileUploadDispatchToken(token, binding = {}) {
  if (!DISPATCH_TOKENS.has(token)) return false;
  const current = TOKEN_BINDINGS.get(token);
  return current?.targetId === binding.targetId && current?.candidateIdentity === binding.candidateIdentity
    && Array.isArray(binding.filePaths) && JSON.stringify(current.filePaths) === JSON.stringify(binding.filePaths);
}
