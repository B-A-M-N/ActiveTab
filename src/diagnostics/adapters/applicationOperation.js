/**
 * ApplicationOperationExecutor — registered, typed application API operations.
 * Operations must be declared with explicit authority, effect classification,
 * and scope. This is never an unrestricted API tool.
 *
 * Privilege levels are distinct:
 *   read_only   — never requires a grant;
 *   mutating    — requires a scoped grant when the operation is registered
 *                 as protected (shared resources) or a grant store is bound;
 *   destructive — ALWAYS requires a valid, exactly-scoped, single-use grant.
 *
 * A caller-supplied boolean is never accepted as authorization (P1-5).
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";

export const EFFECT_CLASSIFICATION = Object.freeze({
  READ_ONLY: "read_only",
  MUTATING: "mutating",
  DESTRUCTIVE: "destructive"
});

export class ApplicationOperationExecutor {
  constructor({ applicationId, environment, authority = AUTHORITY.APPLICATION_SESSION, principal = null, grantStore = null, maxBytes = 1_048_576, timeoutMs = 10_000 } = {}) {
    if (typeof applicationId !== "string" || !applicationId) throw new Error("ApplicationOperationExecutor requires an applicationId.");
    if (typeof environment !== "string" || !environment) throw new Error("ApplicationOperationExecutor requires an environment.");
    this.applicationId = applicationId;
    this.environment = environment;
    this.authority = authority;
    this.principal = principal;
    this.grantStore = grantStore;
    this.maxBytes = Math.max(1, Math.min(maxBytes, 8 * 1024 * 1024));
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs, 60_000));
    this.operations = new Map();
  }

  registerOperation({ operationId, sourceId, method = "GET", path, effect = EFFECT_CLASSIFICATION.READ_ONLY, contract = null, handler, scope, sensitivity = SENSITIVITY.METADATA_ONLY, requiresGrant = null } = {}) {
    if (typeof operationId !== "string" || !operationId) throw new Error("Operation requires an operationId.");
    if (typeof sourceId !== "string" || !sourceId) throw new Error("Operation requires a sourceId.");
    if (typeof path !== "string" && typeof handler !== "function") throw new Error(`Operation '${operationId}' requires a path or handler.`);
    if (typeof handler !== "function") throw new Error(`Operation '${operationId}' requires a handler function.`);
    if (!Object.values(EFFECT_CLASSIFICATION).includes(effect)) throw new Error(`Operation '${operationId}': unknown effect '${effect}'.`);
    if (this.operations.has(operationId)) throw new Error(`Operation '${operationId}' is already registered.`);
    const effectiveContract = contract ?? createDiagnosticContract({
      id: sourceId,
      authority: this.authority,
      operations: effect === EFFECT_CLASSIFICATION.READ_ONLY ? [OPERATION.READ] : [OPERATION.READ, OPERATION.READ_SCOPED],
      scope: scope ?? `${this.applicationId}:${this.environment}`,
      sensitivity
    });
    this.operations.set(operationId, {
      operationId, sourceId, method, path, effect,
      contract: effectiveContract, handler,
      // Defaults: destructive always requires a grant; mutating requires one
      // when a grant store is bound or the operation opts in explicitly.
      // Fail closed: mutating and destructive operations always require a
      // grant, regardless of whether a grant store is currently bound.
      requiresGrant: requiresGrant ?? (effect !== EFFECT_CLASSIFICATION.READ_ONLY)
    });
    return this;
  }

  listOperations() {
    return [...this.operations.values()].map(op => ({
      operationId: op.operationId,
      sourceId: op.sourceId,
      method: op.method,
      path: op.path,
      effect: op.effect,
      requiresGrant: op.requiresGrant,
      authority: op.contract.authority,
      sensitivity: op.contract.sensitivity
    }));
  }

  hasOperation(operationId) { return this.operations.has(operationId); }

  #authorize(operation, options) {
    if (!operation.requiresGrant) return { ok: true };
    if (options.explicitDestructiveApproval !== undefined) {
      throw new Error(
        `Operation '${operation.operationId}': caller-supplied approval booleans are not authority. ` +
        `Issue a scoped authorization grant and pass { grantId } instead.`
      );
    }
    if (!this.grantStore) {
      return { ok: false, reason: `Operation '${operation.operationId}' (${operation.effect}) requires a grant store; none is bound.` };
    }
    const grantId = options.grantId;
    if (typeof grantId !== "string" || !grantId) {
      return { ok: false, reason: `Operation '${operation.operationId}' (${operation.effect}) requires a scoped authorization grant (grantId).` };
    }
    const consumed = this.grantStore.consume(grantId, {
      principal: options.principal ?? this.principal ?? undefined,
      environmentId: this.environment,
      authenticationRealm: options.authenticationRealm ?? undefined,
      resource: options.resource ?? operation.sourceId,
      operation: operation.operationId,
      input: options.input ?? {},
      effect: options.effect ?? operation.effect
    });
    if (!consumed.ok) return { ok: false, reason: `Grant rejected: ${consumed.reason}` };
    return { ok: true, grant: consumed.grant };
  }

  async execute(operationId, options = {}) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`Application operation '${operationId}' is not registered.`);
    const authorization = this.#authorize(operation, options);
    if (!authorization.ok) {
      return {
        status: "refused",
        operationId,
        sourceId: operation.sourceId,
        effect: operation.effect,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: authorization.reason
      };
    }
    const startedAt = new Date().toISOString();
    try {
      const result = await Promise.race([
        operation.handler(options),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Operation '${operationId}' timed out after ${this.timeoutMs}ms.`)), this.timeoutMs))
      ]);
      return {
        status: "ok",
        operationId,
        sourceId: operation.sourceId,
        effect: operation.effect,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(authorization.grant ? { grantId: authorization.grant.grantId } : {}),
        result
      };
    } catch (error) {
      return {
        status: "error",
        operationId,
        sourceId: operation.sourceId,
        effect: operation.effect,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: String(error.message ?? error).slice(0, 500)
      };
    }
  }
}
