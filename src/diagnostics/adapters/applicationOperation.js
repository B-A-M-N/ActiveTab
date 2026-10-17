/**
 * ApplicationOperationExecutor — registered, typed application API operations.
 * Operations must be declared with explicit authority, effect classification,
 * and scope. This is never an unrestricted API tool.
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";

export const EFFECT_CLASSIFICATION = Object.freeze({
  READ_ONLY: "read_only",
  MUTATING: "mutating",
  DESTRUCTIVE: "destructive"
});

export class ApplicationOperationExecutor {
  constructor({ applicationId, environment, authority = AUTHORITY.APPLICATION_SESSION, principal = null, maxBytes = 1_048_576, timeoutMs = 10_000 } = {}) {
    if (typeof applicationId !== "string" || !applicationId) throw new Error("ApplicationOperationExecutor requires an applicationId.");
    if (typeof environment !== "string" || !environment) throw new Error("ApplicationOperationExecutor requires an environment.");
    this.applicationId = applicationId;
    this.environment = environment;
    this.authority = authority;
    this.principal = principal;
    this.maxBytes = Math.max(1, Math.min(maxBytes, 8 * 1024 * 1024));
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs, 60_000));
    this.operations = new Map();
  }

  registerOperation({ operationId, sourceId, method = "GET", path, effect = EFFECT_CLASSIFICATION.READ_ONLY, contract = null, handler, scope, sensitivity = SENSITIVITY.METADATA_ONLY } = {}) {
    if (typeof operationId !== "string" || !operationId) throw new Error("Operation requires an operationId.");
    if (typeof sourceId !== "string" || !sourceId) throw new Error("Operation requires a sourceId.");
    if (typeof path !== "string" || !path) throw new Error(`Operation '${operationId}' requires a path.`);
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
      contract: effectiveContract, handler
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
      authority: op.contract.authority,
      sensitivity: op.contract.sensitivity
    }));
  }

  hasOperation(operationId) { return this.operations.has(operationId); }

  async execute(operationId, options = {}) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`Application operation '${operationId}' is not registered.`);
    if (operation.effect === EFFECT_CLASSIFICATION.DESTRUCTIVE && options.explicitDestructiveApproval !== true) {
      throw new Error(`Destructive operation '${operationId}' requires explicitDestructiveApproval:true.`);
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
