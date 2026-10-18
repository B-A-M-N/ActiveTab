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
import { randomUUID } from "node:crypto";

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
    if (requiresGrant === false && effect !== EFFECT_CLASSIFICATION.READ_ONLY) {
      throw new Error(`Operation '${operationId}': mutating and destructive operations cannot disable grant requirements.`);
    }
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
      requiresGrant: effect !== EFFECT_CLASSIFICATION.READ_ONLY || requiresGrant === true
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
    if (options.effect !== undefined && options.effect !== operation.effect) {
      return { ok: false, reason: `Operation '${operation.operationId}' is registered as '${operation.effect}'; callers cannot substitute an effect.` };
    }
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
      effect: operation.effect
    });
    if (!consumed.ok) return { ok: false, reason: `Grant rejected: ${consumed.reason}` };
    return { ok: true, grant: consumed.grant };
  }

  async execute(operationId, options = {}) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`Application operation '${operationId}' is not registered.`);
    if (options.signal?.aborted) {
      return {
        status: "canceled",
        operationId,
        sourceId: operation.sourceId,
        effect: operation.effect,
        effectStatus: "not_dispatched",
        verificationStatus: "not_verified",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      };
    }
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
    const executionId = randomUUID();
    const controller = new AbortController();
    let timeout;
    let callerCanceled = false;
    let timedOut = false;
    const callerSignal = options.signal;
    let resolveAbortResult = null;
    const abortResult = callerSignal ? new Promise(resolveAbort => { resolveAbortResult = resolveAbort; }) : new Promise(() => {});
    const onCallerAbort = () => {
      callerCanceled = true;
      controller.abort();
      resolveAbortResult?.({ kind: "uncertain" });
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const handlerResult = Promise.resolve().then(() => {
      if (controller.signal.aborted) return { kind: "not_dispatched" };
      return operation.handler({ ...options, executionId, signal: controller.signal });
    }).then(value => value?.kind === "not_dispatched" ? value : ({ kind: "result", value }), error => ({ kind: "error", error }));
    const timeoutResult = new Promise(resolveTimeout => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolveTimeout({ kind: "uncertain" });
      }, this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([handlerResult, timeoutResult, abortResult]);
      if (outcome.kind === "not_dispatched") {
        return {
          status: "canceled",
          operationId,
          executionId,
          sourceId: operation.sourceId,
          effect: operation.effect,
          effectStatus: "not_dispatched",
          verificationStatus: "not_verified",
          startedAt,
          finishedAt: new Date().toISOString()
        };
      }
      if (outcome.kind === "uncertain") {
        return {
          status: "uncertain",
          operationId,
          executionId,
          sourceId: operation.sourceId,
          effect: operation.effect,
          effectStatus: "uncertain",
          verificationStatus: "not_verified",
          startedAt,
          finishedAt: new Date().toISOString(),
          reason: timedOut ? `Operation '${operationId}' timed out after ${this.timeoutMs}ms; handler cancellation was requested and the effect must be reconciled before retry.`
            : `Operation '${operationId}' was canceled after dispatch began; the effect must be reconciled before retry.`
        };
      }
      if (outcome.kind === "error") {
        const uncertain = operation.effect !== EFFECT_CLASSIFICATION.READ_ONLY;
        return {
          status: uncertain ? "uncertain" : "error",
          operationId,
          executionId,
          sourceId: operation.sourceId,
          effect: operation.effect,
          effectStatus: uncertain ? "uncertain" : "failed",
          verificationStatus: "not_verified",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: String(outcome.error?.message ?? outcome.error).slice(0, 500),
          ...(uncertain ? { reason: "A mutating handler failed after invocation; reconcile target state before retry." } : {})
        };
      }
      return {
        status: "ok",
        operationId,
        executionId,
        sourceId: operation.sourceId,
        effect: operation.effect,
        effectStatus: "completed",
        verificationStatus: "not_verified",
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(authorization.grant ? { grantId: authorization.grant.grantId } : {}),
        result: outcome.value
      };
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
