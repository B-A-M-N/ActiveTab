/**
 * Durable run state (P1-4) — survives process restarts and serializes updates
 * across local ActiveTab processes. The state is recovery metadata only: raw
 * goals, workflow inputs, browser evidence, form values, cookies, and auth
 * material are never written here.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rename, open, lstat, chmod, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { hostname } from "node:os";

const MAX_RUN_STATE_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 2500;
const IMMUTABLE_FIELDS = Object.freeze([
  "runId", "schemaVersion", "createdAt", "workflowId", "workflowVersion", "workflowHash",
  "environmentId", "authenticationRealm", "profileId", "principalId", "policyVersion", "goalFingerprint",
  "executionContract"
]);

function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function safeIdentifier(value, label, { allowSlash = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || value.includes("/") || value.includes("\\")) {
    if (!allowSlash || typeof value !== "string" || value.length < 1 || value.length > 160 || value.includes("\\")) {
      throw new Error(`${label} must be a bounded identifier.`);
    }
  }
  if ([...value].some(character => character.charCodeAt(0) < 32)) {
    throw new Error(`${label} contains an unsupported control character.`);
  }
  return value;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

/** Returns unfinished runs that still prevent a replacement qualification. */
export function blockingQualificationRuns(runs, { selectedDiscardId = null } = {}) {
  return runs.filter(run => run.runId !== selectedDiscardId);
}

/** Persist cancellation even when no live worker object survived a restart. */
export async function requestRunCancellation(store, runId, { abort, runPromise } = {}) {
  if (!store || typeof store.getFresh !== "function" || typeof store.requestCancellation !== "function") {
    throw new Error("Durable run cancellation requires a RunStateStore.");
  }
  const before = await store.getFresh(runId);
  if (!before) {
    if (typeof abort !== "function") return null;
    await abort();
    if (runPromise && typeof runPromise.then === "function") {
      const persistAfterStartup = async () => {
        const started = await store.getFresh(runId);
        if (started && !["passed", "failed", "blocked", "canceled", "expired"].includes(started.status)) {
          await store.requestCancellation(runId);
        }
      };
      void Promise.resolve(runPromise)
        .then(persistAfterStartup, persistAfterStartup)
        .catch(() => {});
    }
    return { run: null, requested: true, requiresReconciliation: false, durabilityPending: true };
  }
  const terminal = ["passed", "failed", "blocked", "canceled", "expired"].includes(before.status);
  if (terminal) return { run: before, requested: false, requiresReconciliation: false };
  const run = await store.requestCancellation(runId);
  if (!run) return null;
  const requested = run.cancellationRequested === true;
  if (requested && typeof abort === "function") await abort();
  return {
    run,
    requested,
    requiresReconciliation: (run.pendingOperations ?? []).some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status))
  };
}

export class RunStateStore {
  constructor(baseDir, { lockWaitMs = LOCK_WAIT_MS } = {}) {
    if (typeof baseDir !== "string" || !baseDir) throw new Error("RunStateStore requires a baseDir.");
    this.baseDir = resolve(baseDir);
    this.lockWaitMs = Math.max(100, Math.min(30_000, Number(lockWaitMs) || LOCK_WAIT_MS));
    this.runs = new Map();
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.baseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Run state directory must be a real directory, not a symlink.");
    await chmod(this.baseDir, 0o700);
    await this.#reload();
  }

  async #reload() {
    let entries;
    try { entries = await readdir(this.baseDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        if (run?.runId && entry.name === `${run.runId}.json`) {
          safeIdentifier(run.runId, "runId");
          this.runs.set(run.runId, run);
        }
      } catch { /* Unreadable records are left for explicit local inspection. */ }
    }
  }

  #runPath(runId) { return join(this.baseDir, `${safeIdentifier(runId, "runId")}.json`); }

  async #readRun(runId) {
    try {
      const path = this.#runPath(runId);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Run state must be a regular file, not a symlink.");
      const run = JSON.parse(await readFile(path, "utf8"));
      return run?.runId === runId ? run : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeAtomic(run) {
    const path = this.#runPath(run.runId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      const serialized = JSON.stringify(run, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_STATE_BYTES) throw new Error("Run state exceeds the 64 KiB local storage limit.");
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temp).catch(() => {});
      throw error;
    }
    await file.close();
    await rename(temp, path);
    await chmod(path, 0o600);
  }

  async #acquireLock(runId) {
    const lockPath = `${this.#runPath(runId)}.lock`;
    const owner = { ownerId: randomUUID(), pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
    const deadline = Date.now() + this.lockWaitMs;
    while (Date.now() <= deadline) {
      try {
        const lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(JSON.stringify(owner), "utf8");
        await lock.sync();
        await lock.close();
        return async () => {
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8"));
            if (current.ownerId === owner.ownerId) await unlink(lockPath);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }

      let current = null;
      try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* An incomplete lock is treated as live. */ }
      if (current?.host === hostname() && processIsAlive(current.pid) === false) {
        try {
          const confirmed = JSON.parse(await readFile(lockPath, "utf8"));
          if (confirmed.ownerId === current.ownerId) await unlink(lockPath);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        continue;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 15));
    }
    throw new Error(`Timed out waiting for the local run-state lease for '${runId}'.`);
  }

  /** Hold one process-wide lease for the full workflow execution/resume. */
  async acquireExecutionLease(runId) {
    const lockPath = `${this.#runPath(runId)}.execution.lock`;
    const owner = { ownerId: randomUUID(), pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
    try {
      const lock = await open(lockPath, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify(owner), "utf8");
        await lock.sync();
      } finally { await lock.close(); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current = null;
      try { current = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* An incomplete lease remains held. */ }
      if (current?.host === hostname() && processIsAlive(current.pid) === false) {
        try {
          const confirmed = JSON.parse(await readFile(lockPath, "utf8"));
          if (confirmed.ownerId === current.ownerId) await unlink(lockPath);
        } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
        return await this.acquireExecutionLease(runId);
      }
      const conflict = new Error(`Run '${runId}' already has an active execution owner.`);
      conflict.code = "RUN_EXECUTION_LEASE_HELD";
      throw conflict;
    }
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (current.ownerId === owner.ownerId) await unlink(lockPath);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  }

  async #mutate(runId, mutate, { expectedRevision } = {}) {
    const release = await this.#acquireLock(runId);
    try {
      const latest = await this.#readRun(runId);
      if (!latest) return null;
      const revision = Number.isSafeInteger(latest.revision) ? latest.revision : 0;
      if (expectedRevision !== undefined && revision !== expectedRevision) {
        const error = new Error(`Run state revision conflict: expected ${expectedRevision}, found ${revision}.`);
        error.code = "RUN_STATE_REVISION_CONFLICT";
        throw error;
      }
      const next = clone(latest);
      await mutate(next);
      next.revision = revision + 1;
      next.updatedAt = new Date().toISOString();
      await this.#writeAtomic(next);
      const cached = this.runs.get(runId);
      if (cached && cached !== next) Object.assign(cached, clone(next));
      else this.runs.set(runId, next);
      return this.runs.get(runId);
    } finally { await release(); }
  }

  async create({ runId = randomUUID(), workflowId, workflowName, workflowVersion = null, workflowHash = null, environmentId = null, authenticationRealm = null, targetId = null, principalId = null, goalFingerprint = null, budget = {}, mode = null, profileId = null, policyVersion = "active_policy_v1", episodeId = null }) {
    runId = safeIdentifier(String(runId), "runId");
    if (await this.#readRun(runId)) throw new Error(`Run '${runId}' already exists.`);
    const now = new Date().toISOString();
    const run = {
      schemaVersion: 2,
      revision: 1,
      runId,
      workflowId: safeIdentifier(String(workflowId), "workflowId"),
      workflowName: String(workflowName),
      workflowVersion: workflowVersion === null ? null : safeIdentifier(String(workflowVersion), "workflowVersion"),
      workflowHash: workflowHash === null ? null : String(workflowHash),
      mode: mode ? String(mode) : null,
      profileId: profileId ? safeIdentifier(String(profileId), "profileId") : null,
      principalId: principalId ? safeIdentifier(String(principalId), "principalId") : null,
      policyVersion: policyVersion ? safeIdentifier(String(policyVersion), "policyVersion") : null,
      episodeId: episodeId ? safeIdentifier(String(episodeId), "episodeId") : null,
      status: "created",
      environmentId: environmentId === null ? null : safeIdentifier(String(environmentId), "environmentId"),
      authenticationRealm: authenticationRealm === null ? null : safeIdentifier(String(authenticationRealm), "authenticationRealm"),
      target: targetId ? { targetId: safeIdentifier(String(targetId), "targetId"), attached: false } : null,
      currentStepId: null,
      completedSteps: [],
      latestVerifiedEvidenceId: null,
      pendingInterventionId: null,
      resumeCursor: null,
      authorizationState: { grants: [], realm: authenticationRealm },
      testOwnedResources: [],
      expectedPostconditions: [],
      pendingOperations: [],
      uncertainOperations: [],
      diagnosticProgress: { collectedSources: [], lastCollectedAt: null },
      budget: { stepsTotal: budget.stepsTotal ?? null, stepsRemaining: budget.stepsRemaining ?? null },
      goalFingerprint,
      executionContract: null,
      suspendedStepId: null,
      createdAt: now,
      updatedAt: now
    };
    await this.#writeAtomic(run);
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId) { return clone(this.runs.get(runId) ?? null); }

  async getFresh(runId) {
    const run = await this.#readRun(runId);
    if (!run) { this.runs.delete(runId); return null; }
    this.runs.set(runId, run);
    return clone(run);
  }

  /** Bind the exact executable workflow and authority tuple once, without storing inputs. */
  async bindExecutionContract(runId, {
    workflowId,
    workflowVersion = null,
    workflowHash,
    environmentId = null,
    targetId = null,
    principalId = null,
    profileId = null,
    policyVersion = null
  } = {}) {
    const contract = {
      workflowId: safeIdentifier(String(workflowId ?? ""), "execution workflowId"),
      workflowVersion: workflowVersion === null ? null : safeIdentifier(String(workflowVersion), "execution workflowVersion"),
      workflowHash: safeIdentifier(String(workflowHash ?? ""), "workflowHash"),
      environmentId: environmentId === null ? null : safeIdentifier(String(environmentId), "execution environmentId"),
      targetId: targetId === null ? null : safeIdentifier(String(targetId), "execution targetId"),
      principalId: principalId === null ? null : safeIdentifier(String(principalId), "execution principalId"),
      profileId: profileId === null ? null : safeIdentifier(String(profileId), "execution profileId"),
      policyVersion: policyVersion === null ? null : safeIdentifier(String(policyVersion), "execution policyVersion")
    };
    return await this.#mutate(runId, run => {
      if (run.executionContract) {
        if (JSON.stringify(run.executionContract) !== JSON.stringify(contract)) {
          throw new Error("The workflow or authority binding differs from the contract already attached to this run.");
        }
        return;
      }
      const hasPriorExecution = run.completedSteps?.length > 0
        || run.pendingOperations?.length > 0
        || run.uncertainOperations?.length > 0;
      if (hasPriorExecution) throw new Error("A legacy run with execution history cannot acquire a new workflow contract during resume.");
      if (contract.environmentId !== run.environmentId
        || contract.targetId !== (run.target?.targetId ?? null)
        || contract.profileId !== run.profileId
        || contract.principalId !== run.principalId
        || contract.policyVersion !== run.policyVersion) {
        throw new Error("Execution contract authority does not match the immutable run binding.");
      }
      run.executionContract = contract;
    });
  }

  async refresh() {
    this.runs.clear();
    await this.#reload();
    return this.runs.size;
  }

  /** Suspended runs survive restarts and are never auto-failed. */
  listSuspended() {
    return clone([...this.runs.values()]
      .filter(run => run.status.startsWith("waiting_for_") || run.status === "resume_validation" || run.status === "reconciling")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)));
  }

  listActive() {
    return clone([...this.runs.values()].filter(run => ["created", "running", "discovering", "dispatching", "uncertain"].includes(run.status)));
  }

  async update(runId, patch, options = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Run-state update requires a patch object.");
    return await this.#mutate(runId, run => {
      for (const field of IMMUTABLE_FIELDS) {
        if (Object.hasOwn(patch, field) && patch[field] !== run[field]) throw new Error(`Run binding '${field}' is immutable after creation.`);
      }
      if (Object.hasOwn(patch, "target") && patch.target?.targetId) {
        if (run.target?.targetId && patch.target.targetId !== run.target.targetId) throw new Error("A run cannot change its authorized browser target.");
      }
      Object.assign(run, clone(patch));
    }, options);
  }

  async requestCancellation(runId) {
    return await this.#mutate(runId, run => {
      if (["passed", "failed", "blocked", "canceled", "expired"].includes(run.status)) return;
      run.cancellationRequested = true;
      run.cancellationRequestedAt ??= new Date().toISOString();
      const unresolved = run.pendingOperations?.some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status));
      if (!unresolved) run.status = "cancel_requested";
    });
  }

  async updateCheckpoint(runId, { currentStepId = null, stepId, type = null, status, evidenceIds = [], resumeCursor = undefined } = {}) {
    const safeStep = stepId === undefined || stepId === null ? null : safeIdentifier(String(stepId), "stepId", { allowSlash: true });
    if (!status || typeof status !== "string") throw new Error("A checkpoint requires a typed step status.");
    return await this.#mutate(runId, run => {
      run.currentStepId = currentStepId === null ? safeStep : safeIdentifier(String(currentStepId), "currentStepId", { allowSlash: true });
      const existing = run.completedSteps.find(item => item.stepId === safeStep);
      const record = { stepId: safeStep, ...(type ? { type: String(type) } : {}), status, evidenceIds: [...new Set(evidenceIds.filter(id => typeof id === "string"))].slice(0, 20), updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, record);
      else if (safeStep) run.completedSteps.push(record);
      if (run.completedSteps.length > 256) run.completedSteps.splice(0, run.completedSteps.length - 256);
      if (resumeCursor !== undefined) run.resumeCursor = clone(resumeCursor);
    });
  }

  /** Persist a redacted reservation before dispatch. Input values are omitted. */
  async reserveOperation(runId, { operationId, stepId, action, effectDigest, environmentId = null, targetId = null } = {}) {
    for (const [value, label] of [[operationId, "operationId"], [action, "action"], [effectDigest, "effectDigest"]]) safeIdentifier(String(value ?? ""), label);
    safeIdentifier(String(stepId ?? ""), "stepId", { allowSlash: true });
    return await this.#mutate(runId, run => {
      if (environmentId !== null && environmentId !== run.environmentId) throw new Error("Operation reservation environment does not match its run binding.");
      if (targetId !== null && targetId !== run.target?.targetId) throw new Error("Operation reservation target does not match its run binding.");
      const existing = run.pendingOperations.find(item => item.operationId === operationId)
        ?? run.uncertainOperations.find(item => item.operationId === operationId);
      if (existing) {
        if (existing.stepId !== stepId || existing.action !== action || existing.effectDigest !== effectDigest) throw new Error("Operation identity was reused with a different effect contract.");
        if (["DISPATCHED", "UNCERTAIN", "VERIFIED", "REFUSED"].includes(existing.status)) throw new Error(`Operation '${operationId}' already reached ${existing.status}; it cannot be dispatched again.`);
        return;
      }
      run.pendingOperations.push({
        operationId, stepId, action, effectDigest, status: "RESERVED",
        environmentId: run.environmentId, targetId: run.target?.targetId ?? null,
        reservedAt: new Date().toISOString()
      });
    });
  }

  async recordOperationDispatch(runId, { operationId, status, receiptId = null } = {}) {
    if (!operationId || !["DISPATCHED", "UNCERTAIN", "REFUSED"].includes(status)) throw new Error("Operation dispatch transition is invalid.");
    return await this.#mutate(runId, run => {
      const operationIndex = run.pendingOperations.findIndex(item => item.operationId === operationId);
      if (operationIndex < 0) throw new Error("No durable operation reservation exists for dispatch.");
      const operation = run.pendingOperations[operationIndex];
      if (operation.status !== "RESERVED") throw new Error(`Operation cannot transition from ${operation.status} to ${status}.`);
      operation.status = status;
      operation.dispatchedAt = status === "REFUSED" ? null : new Date().toISOString();
      operation.receiptId = typeof receiptId === "string" ? receiptId : null;
      if (status === "UNCERTAIN") run.uncertainOperations.push(clone(operation));
    });
  }

  async reconcileOperation(runId, { operationId, status, evidenceIds = [], summary = "" } = {}) {
    if (!["OBSERVED", "VERIFIED", "FAILED", "UNCERTAIN"].includes(status)) throw new Error("Operation reconciliation status is invalid.");
    return await this.#mutate(runId, run => {
      const operation = run.uncertainOperations.find(item => item.operationId === operationId)
        ?? run.pendingOperations.find(item => item.operationId === operationId && ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status));
      if (!operation) throw new Error("No reserved or uncertain operation exists for reconciliation.");
      run.completedSteps ??= [];
      run.pendingOperations ??= [];
      operation.status = status;
      operation.evidenceIds = [...new Set(evidenceIds.filter(id => typeof id === "string"))].slice(0, 20);
      operation.summary = String(summary).slice(0, 500);
      operation.reconciledAt = new Date().toISOString();
      const checkpointStatus = status === "VERIFIED" ? "PASS"
        : status === "FAILED" ? "FAIL" : "UNCERTAIN";
      const checkpoint = run.completedSteps.find(item => item.stepId === operation.stepId);
      const checkpointRecord = {
        stepId: operation.stepId,
        type: "interact",
        status: checkpointStatus,
        evidenceIds: operation.evidenceIds,
        updatedAt: operation.reconciledAt
      };
      if (checkpoint) Object.assign(checkpoint, checkpointRecord);
      else run.completedSteps.push(checkpointRecord);
      if (status === "VERIFIED" || status === "FAILED") {
        const pending = run.pendingOperations.find(item => item.operationId === operationId);
        if (pending) { pending.status = status; pending.reconciledAt = operation.reconciledAt; }
        if (run.currentStepId === operation.stepId) run.currentStepId = null;
      }
      if (!run.pendingOperations.some(item => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status))) run.status = "resume_validation";
    });
  }

  /** Record a test-owned resource and its explicit lifecycle contract. */
  async registerTestOwnedResource(runId, { resourceId, type, cleanupAction = null, allowedEffects = [], expiresAt = null } = {}) {
    safeIdentifier(String(resourceId ?? ""), "resourceId");
    return await this.#mutate(runId, run => {
      const existing = run.testOwnedResources.find(resource => resource.resourceId === resourceId);
      if (existing) {
        if (existing.type !== type) throw new Error("Resource identity is already registered with a different type.");
        return;
      }
      run.testOwnedResources.push({
        resourceId: String(resourceId), type: String(type), ownerRunId: runId,
        allowedEffects: [...new Set(allowedEffects.filter(effect => typeof effect === "string"))].slice(0, 16),
        cleanupAction,
        expiresAt: expiresAt ? String(expiresAt) : null,
        cleanupStatus: "required",
        createdAt: new Date().toISOString()
      });
    });
  }

  async markResourceCleaned(runId, resourceId, { evidenceIds = [], verified = false } = {}) {
    return await this.#mutate(runId, run => {
      const resource = run.testOwnedResources.find(item => item.resourceId === resourceId);
      if (!resource) throw new Error("Cannot mark an unregistered resource as cleaned.");
      resource.cleanupStatus = verified ? "verified" : "observed";
      resource.cleanedAt = new Date().toISOString();
      if (verified) resource.cleanupVerifiedAt = resource.cleanedAt;
      resource.cleanupEvidenceIds = [...new Set(evidenceIds.filter(id => typeof id === "string"))].slice(0, 20);
    });
  }

  /** Restart reconciliation rechecks the exact attachment and environment. */
  async reconcileRestart(runId, { attachmentCheck = null, environmentCheck = null } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.#readRun(runId);
      if (!before) return null;
      const targetAttached = typeof attachmentCheck === "function" && before.target
        ? await attachmentCheck(before.target.targetId) === true
        : false;
      const environment = typeof environmentCheck === "function" && before.environmentId
        ? await environmentCheck(before.environmentId)
        : null;
      try {
        return await this.#mutate(runId, run => {
          if (run.target && typeof attachmentCheck === "function") run.target.attached = targetAttached;
          if (run.target && !targetAttached) run.status = "waiting_for_tab_authorization";
          if (before.environmentId && environment?.ok !== true) {
            run.authorizationState.grants = [];
            run.status = "waiting_for_human_decision";
          }
          if (run.pendingOperations.some(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status))) {
            run.status = "reconciling";
            for (const operation of run.pendingOperations.filter(item => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(item.status))) {
              operation.status = "UNCERTAIN";
              const existing = run.uncertainOperations.find(item => item.operationId === operation.operationId);
              if (existing) Object.assign(existing, clone(operation));
              else run.uncertainOperations.push(clone(operation));
            }
          }
        }, { expectedRevision: before.revision });
      } catch (error) {
        if (error.code !== "RUN_STATE_REVISION_CONFLICT" || attempt === 2) throw error;
      }
    }
    return await this.get(runId);
  }
}
