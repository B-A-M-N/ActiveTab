import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_CHARGE_BYTES = 8 * 1024 * 1024;
const FACET_MAX_BYTES = Object.freeze({
  screenshot: 4 * 1024 * 1024,
  form_values: 4 * 1024 * 1024,
  runtime_values: 1024 * 1024,
  response_body: 8 * 1024 * 1024,
  response_credential_values: 8 * 1024 * 1024
});

function ensurePrivateDatabase(databasePath) {
  const absolutePath = resolve(databasePath);
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())
    || (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)) {
    throw new Error("Evidence-release database directory must be an owner-only directory owned by the current user.");
  }
  try {
    if (lstatSync(absolutePath).isSymbolicLink()) throw new Error("Evidence-release database cannot be a symbolic link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return absolutePath;
}

function requiredId(value, name) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Evidence-release scope requires a valid ${name}.`);
  }
  return value;
}

function normalizeSelectors(facet, selectors = {}) {
  if (!selectors || typeof selectors !== "object" || Array.isArray(selectors)) throw new Error("Evidence-release selectors must be an object.");
  const bindingKeys = ["profileId", "environmentId", "applicationId", "authenticationRealm"];
  const allowed = {
    screenshot: [],
    form_values: ["facets"],
    runtime_values: ["path", "frameTargetId"],
    response_body: ["requestId", "view", "sectionId", "blockId"],
    response_credential_values: ["requestId", "view", "sectionId", "blockId"]
  }[facet];
  if (!allowed || Object.keys(selectors).some(key => !allowed.includes(key) && !bindingKeys.includes(key))) throw new Error("Evidence-release selector is unsupported for this facet.");
  for (const key of ["profileId", "environmentId", "applicationId"]) requiredId(selectors[key], key);
  if (selectors.authenticationRealm !== undefined && selectors.authenticationRealm !== null) requiredId(selectors.authenticationRealm, "authentication realm");
  if (facet.startsWith("response_")) requiredId(selectors.requestId, "selected request id");
  if (facet.startsWith("response_")) {
    if (!Object.hasOwn({ markdown: true, source: true, normalized: true }, selectors.view)) throw new Error("Response release requires an exact markdown, source, or normalized view.");
    if (selectors.sectionId !== undefined && selectors.blockId !== undefined) throw new Error("Response release may select a section or a block, not both.");
    if ((selectors.sectionId !== undefined || selectors.blockId !== undefined) && selectors.view !== "markdown") throw new Error("Markdown sections and blocks require the markdown view.");
    if (selectors.sectionId !== undefined) requiredId(selectors.sectionId, "Markdown section id");
    if (selectors.blockId !== undefined) requiredId(selectors.blockId, "Markdown block id");
  }
  if (facet === "form_values") {
    const validFacets = new Set(["domSnapshot", "accessibilityTree", "outOfProcessFrames"]);
    if (!Array.isArray(selectors.facets) || !selectors.facets.length || selectors.facets.length > 3
      || selectors.facets.some(value => !validFacets.has(value))) throw new Error("Form-value release requires one or more exact form-capable evidence facets.");
    selectors = { ...selectors, facets: [...new Set(selectors.facets)].sort() };
  }
  if (facet === "runtime_values") {
    if (!Array.isArray(selectors.path) || selectors.path.length > 8 || selectors.path.some(segment => typeof segment !== "string" || segment.length > 128)) {
      throw new Error("Runtime-value release requires an exact bounded property path.");
    }
    if (selectors.frameTargetId !== undefined) requiredId(selectors.frameTargetId, "frame target id");
  }
  return Object.freeze(Object.fromEntries(Object.entries(selectors).sort(([left], [right]) => left.localeCompare(right))));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function tokenDigest(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,100}$/u.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

function rowJson(row, prefix = "") {
  const value = name => row[`${prefix}${name}`];
  return {
    requestId: value("request_id"),
    state: value("state"),
    targetId: value("target_id"),
    evidenceId: value("evidence_id"),
    facet: value("facet"),
    principalId: value("principal_id"),
    callerInstanceId: value("caller_instance_id"),
    selectors: JSON.parse(value("selectors_json")),
    requestedBytes: value("requested_bytes"),
    requestedTtlMs: value("requested_ttl_ms"),
    createdAt: value("created_at"),
    requestExpiresAt: new Date(Date.parse(value("created_at")) + value("requested_ttl_ms")).toISOString(),
    revision: value("revision"),
    ...(value("resolved_at") ? { resolvedAt: value("resolved_at") } : {}),
    ...(value("resolved_by") ? { resolvedBy: value("resolved_by") } : {})
  };
}

function assertBudget(facet, maxBytes, expiresInMs) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FACET_MAX_BYTES[facet]) {
    throw new Error(`Evidence-release byte budget must be from 1 to ${FACET_MAX_BYTES[facet] ?? 0} for ${facet}.`);
  }
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > MAX_TTL_MS) {
    throw new Error(`Evidence-release lifetime must be from 1000 to ${MAX_TTL_MS} milliseconds.`);
  }
}

/**
 * Durable, independently approved evidence-release requests and byte-budgeted grants.
 * MCP can request access, but only the authenticated operator API can approve or revoke it.
 */
export class EvidenceReleaseGrantStore {
  constructor({ databasePath = ":memory:", now = () => Date.now() } = {}) {
    if (typeof databasePath !== "string" || !databasePath) throw new Error("EvidenceReleaseGrantStore requires a database path.");
    if (typeof now !== "function") throw new Error("EvidenceReleaseGrantStore clock must be a function.");
    this.databasePath = databasePath === ":memory:" ? databasePath : ensurePrivateDatabase(databasePath);
    this.now = now;
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      ${this.databasePath === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      CREATE TABLE IF NOT EXISTS evidence_release_requests (
        request_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        target_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        caller_instance_id TEXT NOT NULL,
        selectors_json TEXT NOT NULL,
        requested_bytes INTEGER NOT NULL,
        requested_ttl_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence_release_grants (
        grant_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES evidence_release_requests(request_id),
        token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        target_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        facet TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        caller_instance_id TEXT NOT NULL,
        selectors_json TEXT NOT NULL,
        max_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL DEFAULT 0,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence_release_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        byte_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS evidence_release_requests_state_idx ON evidence_release_requests(state, created_at);
      CREATE INDEX IF NOT EXISTS evidence_release_audit_entity_idx ON evidence_release_audit(entity_id, audit_id);
    `);
    if (this.databasePath !== ":memory:") chmodSync(this.databasePath, 0o600);
  }

  #audit(eventType, entityId, actor, scope, byteCount = 0) {
    this.db.prepare(`INSERT INTO evidence_release_audit(event_type, entity_id, occurred_at, actor, scope_json, byte_count)
      VALUES (?, ?, ?, ?, ?, ?)`).run(eventType, entityId, new Date(this.now()).toISOString(), actor, stableJson(scope), byteCount);
  }

  #transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the transaction error. */ }
      throw error;
    }
  }

  request({ targetId, evidenceId, facet, principalId, callerInstanceId, selectors = {}, maxBytes, expiresInMs = 5 * 60 * 1000 }) {
    requiredId(targetId, "target id");
    requiredId(evidenceId, "evidence id");
    requiredId(principalId, "principal id");
    requiredId(callerInstanceId, "caller instance id");
    if (!Object.hasOwn(FACET_MAX_BYTES, facet)) throw new Error("Evidence-release facet is unsupported.");
    const normalizedSelectors = normalizeSelectors(facet, selectors);
    assertBudget(facet, maxBytes, expiresInMs);
    const requestId = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const request = {
      requestId, state: "pending", targetId, evidenceId, facet, principalId, callerInstanceId,
      selectors: normalizedSelectors, requestedBytes: maxBytes, requestedTtlMs: expiresInMs,
      createdAt, requestExpiresAt: new Date(Date.parse(createdAt) + expiresInMs).toISOString(), revision: 1
    };
    this.#transaction(() => {
      this.db.prepare(`INSERT INTO evidence_release_requests(request_id, state, target_id, evidence_id, facet,
        principal_id, caller_instance_id, selectors_json, requested_bytes, requested_ttl_ms, created_at, revision)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
        requestId, targetId, evidenceId, facet, principalId, callerInstanceId, stableJson(normalizedSelectors), maxBytes, expiresInMs, createdAt
      );
      this.#audit("requested", requestId, principalId, request);
    });
    return request;
  }

  getRequest(requestId) {
    const row = this.db.prepare("SELECT * FROM evidence_release_requests WHERE request_id = ?").get(requestId);
    return row ? rowJson(row) : null;
  }

  listRequests({ states = ["pending"], limit = 100 } = {}) {
    if (!Array.isArray(states) || states.some(state => !["pending", "approved", "rejected", "expired"].includes(state))) throw new Error("Evidence-release request states are invalid.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Evidence-release request limit must be from 1 to 500.");
    if (!states.length) return [];
    const placeholders = states.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM evidence_release_requests WHERE state IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
      .all(...states, limit).map(row => rowJson(row));
  }

  approveRequest(requestId, { operatorId, expectedRevision } = {}) {
    requiredId(operatorId, "authenticated operator id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Approval requires the current request revision.");
    const token = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    const outcome = this.#transaction(() => {
      const raw = this.db.prepare("SELECT * FROM evidence_release_requests WHERE request_id = ?").get(requestId);
      if (!raw) throw new Error("Evidence-release request was not found.");
      const request = rowJson(raw);
      if (request.state !== "pending") throw new Error(`Evidence-release request is already ${request.state}.`);
      if (request.revision !== expectedRevision) throw new Error("Evidence-release request revision changed; inspect it again before approval.");
      const now = this.now();
      if (Date.parse(request.requestExpiresAt) <= now) {
        const resolvedAt = new Date(now).toISOString();
        this.db.prepare("UPDATE evidence_release_requests SET state = 'expired', revision = revision + 1, resolved_at = ?, resolved_by = ? WHERE request_id = ?")
          .run(resolvedAt, operatorId, requestId);
        this.#audit("request_expired", requestId, operatorId, request);
        return { expired: true };
      }
      const issuedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + request.requestedTtlMs).toISOString();
      this.db.prepare(`INSERT INTO evidence_release_grants(grant_id, request_id, token_hash, state, target_id, evidence_id,
        facet, principal_id, caller_instance_id, selectors_json, max_bytes, issued_at, expires_at, issued_by)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        grantId, requestId, tokenDigest(token), request.targetId, request.evidenceId, request.facet,
        request.principalId, request.callerInstanceId, stableJson(request.selectors), request.requestedBytes,
        issuedAt, expiresAt, operatorId
      );
      this.db.prepare("UPDATE evidence_release_requests SET state = 'approved', revision = revision + 1, resolved_at = ?, resolved_by = ? WHERE request_id = ?")
        .run(issuedAt, operatorId, requestId);
      this.#audit("approved", requestId, operatorId, { ...request, grantId, expiresAt });
      return { expired: false, value: {
        request: { ...request, state: "approved", revision: request.revision + 1, resolvedAt: issuedAt, resolvedBy: operatorId },
        grant: { grantId, requestId, state: "active", facet: request.facet, targetId: request.targetId, evidenceId: request.evidenceId,
          principalId: request.principalId, callerInstanceId: request.callerInstanceId, selectors: request.selectors,
          maxBytes: request.requestedBytes, usedBytes: 0, expiresAt, issuedBy: operatorId },
        token
      } };
    });
    if (outcome.expired) throw new Error("Evidence-release request has expired; create a new request.");
    return outcome.value;
  }

  rejectRequest(requestId, { operatorId, expectedRevision } = {}) {
    requiredId(operatorId, "authenticated operator id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Rejection requires the current request revision.");
    return this.#transaction(() => {
      const raw = this.db.prepare("SELECT * FROM evidence_release_requests WHERE request_id = ?").get(requestId);
      if (!raw) throw new Error("Evidence-release request was not found.");
      const request = rowJson(raw);
      if (request.state !== "pending") throw new Error(`Evidence-release request is already ${request.state}.`);
      if (request.revision !== expectedRevision) throw new Error("Evidence-release request revision changed; inspect it again before rejection.");
      const resolvedAt = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE evidence_release_requests SET state = 'rejected', revision = revision + 1, resolved_at = ?, resolved_by = ? WHERE request_id = ?")
        .run(resolvedAt, operatorId, requestId);
      this.#audit("rejected", requestId, operatorId, request);
      return { ...request, state: "rejected", revision: request.revision + 1, resolvedAt, resolvedBy: operatorId };
    });
  }

  revokeGrant(grantId, { operatorId } = {}) {
    requiredId(operatorId, "authenticated operator id");
    return this.#transaction(() => {
      const grant = this.db.prepare(`SELECT grant_id, request_id, state, target_id, evidence_id, facet, principal_id,
        caller_instance_id, selectors_json, max_bytes, used_bytes, expires_at, issued_by FROM evidence_release_grants WHERE grant_id = ?`).get(grantId);
      if (!grant) throw new Error("Evidence-release grant was not found.");
      if (grant.state !== "active") throw new Error(`Evidence-release grant is already ${grant.state}.`);
      const revokedAt = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE evidence_release_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = ?").run(revokedAt, grantId);
      this.#audit("revoked", grantId, operatorId, {
        requestId: grant.request_id, targetId: grant.target_id, evidenceId: grant.evidence_id, facet: grant.facet,
        principalId: grant.principal_id, callerInstanceId: grant.caller_instance_id, selectors: JSON.parse(grant.selectors_json),
        maxBytes: grant.max_bytes, usedBytes: grant.used_bytes, expiresAt: grant.expires_at
      });
      return { grantId, state: "revoked", revokedAt };
    });
  }

  #checkGrant(token, expected) {
    const digest = tokenDigest(token);
    if (!digest) return { ok: false, reason: "A valid evidence-release grant token is required." };
    const grant = this.db.prepare("SELECT * FROM evidence_release_grants WHERE token_hash = ?").get(digest);
    if (!grant) return { ok: false, reason: "Evidence-release grant was not found." };
    if (grant.state !== "active") return { ok: false, reason: `Evidence-release grant is ${grant.state}.` };
    if (Date.parse(grant.expires_at) <= this.now()) {
      const expired = this.db.prepare("UPDATE evidence_release_grants SET state = 'expired' WHERE grant_id = ? AND state = 'active'").run(grant.grant_id);
      if (expired.changes) this.#audit("expired", grant.grant_id, grant.principal_id, {
        requestId: grant.request_id, targetId: grant.target_id, evidenceId: grant.evidence_id, facet: grant.facet,
        principalId: grant.principal_id, callerInstanceId: grant.caller_instance_id,
        selectors: JSON.parse(grant.selectors_json), maxBytes: grant.max_bytes, usedBytes: grant.used_bytes,
        expiresAt: grant.expires_at
      });
      return { ok: false, reason: "Evidence-release grant has expired." };
    }
    const actualSelectors = normalizeSelectors(expected.facet, expected.selectors ?? {});
    const mismatches = [];
    for (const [actual, required] of [
      [expected.targetId, grant.target_id], [expected.evidenceId, grant.evidence_id], [expected.facet, grant.facet],
      [expected.principalId, grant.principal_id], [expected.callerInstanceId, grant.caller_instance_id]
    ]) if (actual !== required) mismatches.push("scope");
    if (stableJson(actualSelectors) !== grant.selectors_json) mismatches.push("selector");
    if (mismatches.length) return { ok: false, reason: "Evidence-release grant scope does not match this caller, target, evidence, facet, or selector." };
    const view = {
      grantId: grant.grant_id, facet: grant.facet, targetId: grant.target_id, evidenceId: grant.evidence_id,
      principalId: grant.principal_id, callerInstanceId: grant.caller_instance_id, selectors: JSON.parse(grant.selectors_json),
      maxBytes: grant.max_bytes, usedBytes: grant.used_bytes, expiresAt: grant.expires_at
    };
    return { ok: true, grant: view };
  }

  verifyMany(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 2) return { ok: false, reason: "One or two exact evidence-release grants are required." };
    const digests = entries.map(entry => tokenDigest(entry?.token));
    if (digests.some(digest => !digest) || new Set(digests).size !== digests.length) return { ok: false, reason: "Evidence-release grant tokens are invalid or duplicated." };
    const scopes = entries.map(entry => entry?.scope);
    if (scopes.some(scope => scope?.facet === "response_credential_values")) {
      const credential = scopes.find(scope => scope?.facet === "response_credential_values");
      const body = scopes.find(scope => scope?.facet === "response_body");
      if (entries.length !== 2 || !body || stableJson({ ...credential, facet: "response_body" }) !== stableJson(body)) {
        return { ok: false, reason: "Raw response credentials require a matching response-body grant with identical target, evidence, principal, process, and Markdown selection." };
      }
    }
    for (const entry of entries) {
      const check = this.#checkGrant(entry.token, entry.scope);
      if (!check.ok) return check;
    }
    return { ok: true };
  }

  chargeMany(entries, byteCount) {
    if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > MAX_CHARGE_BYTES) return { ok: false, reason: "Released evidence byte count is outside the grant budget contract." };
    return this.#transaction(() => {
      const verified = this.verifyMany(entries);
      if (!verified.ok) return verified;
      const digests = entries.map(entry => tokenDigest(entry.token));
      const grants = digests.map(digest => this.db.prepare("SELECT * FROM evidence_release_grants WHERE token_hash = ?").get(digest));
      for (const grant of grants) {
        if (grant.max_bytes - grant.used_bytes < byteCount) return { ok: false, reason: "Evidence-release byte budget is exhausted." };
      }
      for (const grant of grants) {
        const usedBytes = grant.used_bytes + byteCount;
        const state = usedBytes >= grant.max_bytes ? "exhausted" : "active";
        this.db.prepare("UPDATE evidence_release_grants SET used_bytes = ?, state = ? WHERE grant_id = ? AND state = 'active'").run(usedBytes, state, grant.grant_id);
        this.#audit("released", grant.grant_id, grant.principal_id, {
          targetId: grant.target_id, evidenceId: grant.evidence_id, facet: grant.facet,
          principalId: grant.principal_id, callerInstanceId: grant.caller_instance_id,
          selectors: JSON.parse(grant.selectors_json), usedBytes, maxBytes: grant.max_bytes
        }, byteCount);
      }
      return { ok: true, byteCount };
    });
  }

  audit({ entityId = null, limit = 200 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Evidence-release audit limit must be from 1 to 1000.");
    const rows = entityId
      ? this.db.prepare("SELECT * FROM evidence_release_audit WHERE entity_id = ? ORDER BY audit_id DESC LIMIT ?").all(entityId, limit)
      : this.db.prepare("SELECT * FROM evidence_release_audit ORDER BY audit_id DESC LIMIT ?").all(limit);
    return rows.reverse().map(row => ({ auditId: row.audit_id, eventType: row.event_type, entityId: row.entity_id,
      occurredAt: row.occurred_at, actor: row.actor, scope: JSON.parse(row.scope_json), byteCount: row.byte_count }));
  }

  close() { this.db.close(); }
}

export const EVIDENCE_RELEASE_FACETS = Object.freeze(Object.keys(FACET_MAX_BYTES));
export const EVIDENCE_RELEASE_LIMITS = Object.freeze({ maxTtlMs: MAX_TTL_MS, maxChargeBytes: MAX_CHARGE_BYTES, facetMaxBytes: FACET_MAX_BYTES });
