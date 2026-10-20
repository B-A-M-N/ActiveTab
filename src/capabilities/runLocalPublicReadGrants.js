import { createHash } from "node:crypto";
import { AuthorizationGrantStore } from "../runtime/approvals.js";

function publicReadFieldIdentity(field) {
  return JSON.stringify({
    name: field?.name ?? null,
    sourceHeader: field?.sourceHeader ?? null,
    sourceKey: field?.sourceKey ?? null,
    type: field?.type ?? null,
    required: field?.required ?? null
  });
}

function grantEffect(kind, field) {
  return `${kind}_field:${createHash("sha256").update(publicReadFieldIdentity(field)).digest("hex")}`;
}

export class RunLocalPublicReadGrants {
  constructor({ enabled = false, now = () => Date.now(), expiresInMs = 5 * 60_000 } = {}) {
    this.now = now;
    this.expiresInMs = expiresInMs;
    this.store = enabled
      ? new AuthorizationGrantStore({ now, trustedIssuer: "activetab-run-local-public-read" })
      : null;
    this.bindings = new Map();
  }

  authorize(field, context, kind, policy) {
    if (typeof policy === "function" && policy(field, context) === true) return true;
    return this.verify(context.runLocalGrantId, field, context, kind);
  }

  verify(grantId, field, context = {}, kind = "read") {
    const binding = this.bindings.get(grantId);
    if (!binding || !this.store) return false;
    if (binding.expiresAt <= this.now()
      || context.targetId !== binding.input.targetId
      || context.origin !== binding.input.origin
      || context.sourceFingerprint !== binding.input.sourceFingerprint
      || context.principalId !== binding.principalId
      || context.environmentId !== binding.environmentId
      || context.applicationId !== binding.applicationId
      || !Number.isInteger(context.maxRecords) || context.maxRecords < 1 || context.maxRecords > binding.input.maxRecords
      || context.maxOutputBytes !== binding.input.maxBytes
      || !binding.input.fields.some(approved => publicReadFieldIdentity(approved) === publicReadFieldIdentity(field))) return false;
    const verification = this.store.verify(grantId, {
      principal: binding.principalId,
      environmentId: binding.environmentId,
      resource: binding.input.targetId,
      operation: "read_public_observed_fields",
      input: binding.input,
      effect: grantEffect(kind, field)
    });
    if (!verification.ok && verification.reason?.includes("expired")) {
      this.bindings.delete(grantId);
      this.store.grants.delete(grantId);
    }
    return verification.ok;
  }

  issue(scope, { principalId, candidate, session, selectedFields }) {
    if (!this.store || !scope) return null;
    const allowedEffects = selectedFields.flatMap(field => [grantEffect("read", field), grantEffect("release", field)]);
    allowedEffects.push("return_result");
    const grant = this.store.issue({
      principal: principalId,
      environmentId: scope.environmentId,
      resource: session.target.id,
      operation: "read_public_observed_fields",
      input: scope.input,
      allowedEffects,
      expiresInMs: this.expiresInMs,
      singleUse: true
    });
    const binding = {
      grantId: grant.grantId,
      principalId,
      environmentId: scope.environmentId,
      applicationId: candidate.applicationId ?? null,
      candidateId: candidate.candidateId,
      input: scope.input,
      expiresAt: Date.parse(grant.expiresAt)
    };
    this.bindings.set(grant.grantId, binding);
    while (this.bindings.size > 256) {
      const oldest = this.bindings.keys().next().value;
      this.bindings.delete(oldest);
      this.store.grants.delete(oldest);
    }
    return binding;
  }

  consume(grantId, authorization) {
    if (!this.store) return { ok: false, reason: "public_read_grant_unavailable" };
    const consumed = this.store.consume(grantId, authorization);
    this.bindings.delete(grantId);
    this.store.grants.delete(grantId);
    return consumed;
  }
}
