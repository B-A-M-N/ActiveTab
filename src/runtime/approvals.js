/**
 * Scoped authorization grants (P1-5).
 *
 * Replaces caller-supplied booleans ("explicitDestructiveApproval: true")
 * with independently issued, narrowly scoped grants. A grant binds the
 * principal, environment, authentication realm, resource, operation,
 * canonical input hash, allowed effects, expiry, and single-use semantics.
 * Grants are verified and consumed atomically; approving one operation
 * never grants general administrator autonomy.
 */

import { randomUUID, createHash } from "node:crypto";

export const GRANT_STATE = Object.freeze({
  ACTIVE: "active",
  CONSUMED: "consumed",
  REVOKED: "revoked",
  EXPIRED: "expired"
});

export function canonicalInputHash(input) {
  const stable = JSON.stringify(input ?? {}, Object.keys(JSON.parse(JSON.stringify(input ?? {}))).sort());
  // Deterministic stringify across nested shapes:
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(normalize(input ?? {}))).digest("hex") ?? stable;
}

export class AuthorizationGrantStore {
  constructor({ now = () => Date.now() } = {}) {
    this.grants = new Map();
    this.now = now;
  }

  /**
   * Issue a grant. `allowedEffects` must be explicit (e.g. ["create:test_connector"]).
   */
  issue({
    principal, environmentId, authenticationRealm, resource, operation,
    input, allowedEffects, expiresInMs = 15 * 60 * 1000, singleUse = true, issuedBy = "human_operator"
  }) {
    for (const [name, value] of Object.entries({ principal, environmentId, resource, operation })) {
      if (typeof value !== "string" || !value) throw new Error(`Grant requires '${name}'.`);
    }
    if (!Array.isArray(allowedEffects) || allowedEffects.length === 0) {
      throw new Error("Grant requires explicit allowedEffects.");
    }
    const now = this.now();
    const grant = {
      grantId: randomUUID(),
      principal: String(principal),
      environmentId: String(environmentId),
      authenticationRealm: authenticationRealm ?? null,
      resource: String(resource),
      operation: String(operation),
      inputHash: canonicalInputHash(input ?? {}),
      allowedEffects: allowedEffects.map(String),
      state: GRANT_STATE.ACTIVE,
      singleUse,
      useCount: 0,
      issuedBy: String(issuedBy),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1_000, expiresInMs)).toISOString()
    };
    this.grants.set(grant.grantId, grant);
    return grant;
  }

  get(grantId) { return this.grants.get(grantId) ?? null; }

  /** Read-only check; does not consume. */
  verify(grantId, { principal, environmentId, authenticationRealm = undefined, resource, operation, input, effect = null } = {}) {
    const grant = this.grants.get(grantId);
    if (!grant) return { ok: false, reason: "No such grant." };
    if (grant.state === GRANT_STATE.CONSUMED) return { ok: false, reason: "Grant was already consumed." };
    if (grant.state === GRANT_STATE.REVOKED) return { ok: false, reason: "Grant was revoked." };
    if (grant.state !== GRANT_STATE.ACTIVE) return { ok: false, reason: `Grant is '${grant.state}'.` };
    if (Date.parse(grant.expiresAt) <= this.now()) {
      grant.state = GRANT_STATE.EXPIRED;
      return { ok: false, reason: `Grant expired at ${grant.expiresAt}.` };
    }
    if (grant.singleUse && grant.useCount > 0) return { ok: false, reason: "Single-use grant already used." };
    const mismatch = [];
    if (principal !== undefined && principal !== grant.principal) mismatch.push("principal");
    if (environmentId !== undefined && environmentId !== grant.environmentId) mismatch.push("environment");
    if (authenticationRealm !== undefined && grant.authenticationRealm !== null && authenticationRealm !== grant.authenticationRealm) mismatch.push("realm");
    if (resource !== undefined && resource !== grant.resource) mismatch.push("resource");
    if (operation !== undefined && operation !== grant.operation) mismatch.push("operation");
    if (input !== undefined && canonicalInputHash(input) !== grant.inputHash) mismatch.push("input");
    if (mismatch.length > 0) return { ok: false, reason: `Grant scope mismatch: ${mismatch.join(", ")}.` };
    if (effect !== null && !grant.allowedEffects.includes(effect)) {
      return { ok: false, reason: `Effect '${effect}' is not in the grant's allowed effects.` };
    }
    return { ok: true, grant };
  }

  /** Atomic consume: verifies then marks used/consumed in one step. */
  consume(grantId, context) {
    const check = this.verify(grantId, context);
    if (!check.ok) return check;
    const grant = check.grant;
    grant.useCount += 1;
    if (grant.singleUse || grant.useCount >= 1) grant.state = GRANT_STATE.CONSUMED;
    return { ok: true, grant };
  }

  revoke(grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    if (grant.state === GRANT_STATE.ACTIVE) grant.state = GRANT_STATE.REVOKED;
    return true;
  }
}
