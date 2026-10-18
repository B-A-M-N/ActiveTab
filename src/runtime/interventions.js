/**
 * Durable human-intervention lifecycle (P0-3 / P0-4 / P0-5).
 *
 * Waiting states are resumable, not terminal. An intervention record is
 * persisted BEFORE control returns to the caller, suspends all future
 * mutating actions for the run, and carries an explicit completion
 * condition. Acknowledgement ("the operator believes the action is done")
 * and satisfaction ("the condition is verified with fresh evidence") are
 * different states: only satisfaction admits execution.
 *
 * Guarantees:
 *  - Atomic durable records (temp + fsync + rename), 0o600.
 *  - Run/step identity preserved; resume continues from the suspended step.
 *  - Continuation ownership via generation fencing tokens: two workers can
 *    never resume the same run simultaneously.
 *  - Expired or revoked grants/interventions are rejected on resume.
 *  - Cancellation is permitted during suspension.
 *  - No passwords, tokens, MFA codes, or raw session credentials persist.
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rename, open, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

export const INTERVENTION_TYPE = Object.freeze({
  TAB_AUTHORIZATION: "tab_authorization",
  AUTHENTICATION: "authentication",
  MFA: "mfa",
  HUMAN_APPROVAL: "human_approval",
  EXTERNAL_AUTHORIZATION: "external_authorization",
  HUMAN_DECISION: "human_decision"
});

export const INTERVENTION_STATE = Object.freeze({
  WAITING: "waiting_for_human",
  ACKNOWLEDGED: "acknowledged",     // operator believes the action is complete
  SATISFIED: "satisfied",           // completion predicate verified with fresh evidence
  EXPIRED: "expired",
  REVOKED: "revoked",
  CANCELED: "canceled"
});

/** External run vocabulary; the internal suspension reason stays explicit. */
export const EXTERNAL_RUN_STATE = Object.freeze({
  WAITING_FOR_TAB_AUTHORIZATION: "waiting_for_tab_authorization",
  WAITING_FOR_AUTHENTICATION: "waiting_for_authentication",
  WAITING_FOR_MFA: "waiting_for_mfa",
  WAITING_FOR_HUMAN_APPROVAL: "waiting_for_human_approval",
  WAITING_FOR_EXTERNAL_AUTHORIZATION: "waiting_for_external_authorization",
  WAITING_FOR_HUMAN_DECISION: "waiting_for_human_decision",
  RESUME_VALIDATION: "resume_validation",
  RECONCILING: "reconciling",
  RUNNING: "running"
});

const TYPE_TO_EXTERNAL = Object.freeze({
  [INTERVENTION_TYPE.TAB_AUTHORIZATION]: EXTERNAL_RUN_STATE.WAITING_FOR_TAB_AUTHORIZATION,
  [INTERVENTION_TYPE.AUTHENTICATION]: EXTERNAL_RUN_STATE.WAITING_FOR_AUTHENTICATION,
  [INTERVENTION_TYPE.MFA]: EXTERNAL_RUN_STATE.WAITING_FOR_MFA,
  [INTERVENTION_TYPE.HUMAN_APPROVAL]: EXTERNAL_RUN_STATE.WAITING_FOR_HUMAN_APPROVAL,
  [INTERVENTION_TYPE.EXTERNAL_AUTHORIZATION]: EXTERNAL_RUN_STATE.WAITING_FOR_EXTERNAL_AUTHORIZATION,
  [INTERVENTION_TYPE.HUMAN_DECISION]: EXTERNAL_RUN_STATE.WAITING_FOR_HUMAN_DECISION
});

export function externalRunState(intervention) {
  if (!intervention) return null;
  return TYPE_TO_EXTERNAL[intervention.type] ?? EXTERNAL_RUN_STATE.WAITING_FOR_HUMAN_DECISION;
}

const MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const INTERVENTION_COPY = Object.freeze({
  [INTERVENTION_TYPE.TAB_AUTHORIZATION]: ["Browser tab authorization is required.", "Authorize this exact tab using the ActiveTab extension."],
  [INTERVENTION_TYPE.AUTHENTICATION]: ["Authentication is required.", "Complete sign-in in the attached browser tab."],
  [INTERVENTION_TYPE.MFA]: ["Multi-factor authentication is required.", "Complete the requested MFA step in the attached browser tab."],
  [INTERVENTION_TYPE.HUMAN_APPROVAL]: ["A scoped operation approval is required.", "Review the exact operation, target, environment, and effect before deciding."],
  [INTERVENTION_TYPE.EXTERNAL_AUTHORIZATION]: ["External authorization is required.", "Obtain authorization through the application's approved process."],
  [INTERVENTION_TYPE.HUMAN_DECISION]: ["A human decision is required.", "Review the current evidence and resolve the ambiguity." ]
});
const INTERVENTION_REASON_COPY = Object.freeze({
  [INTERVENTION_TYPE.HUMAN_DECISION]: Object.freeze({
    environment_identity_mismatch: "The observed page is not authorized for the selected environment."
  })
});

function normalizeCompletionCondition(condition) {
  const fieldsByType = {
    tab_attachment: ["targetId"],
    authenticated_session_check: ["realm"],
    challenge_cleared: [],
    approval_grant: ["grantId", "operation", "resource", "inputHash", "allowedEffects", "reversible"],
    ambiguity_resolved: ["resolutionId"]
  };
  const fields = fieldsByType[condition?.type];
  if (!fields) throw new Error("Intervention requires a supported typed completion condition.");
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("Intervention completion condition must be a typed object.");
  const allowed = new Set(["type", ...fields]);
  if (Object.keys(condition).some(key => !allowed.has(key))) throw new Error("Intervention completion condition contains an unsupported field.");
  const normalized = { type: condition.type };
  for (const key of fields) {
    if (!Object.hasOwn(condition, key)) continue;
    const value = condition[key];
    if (["realm", "targetId", "grantId", "operation", "resource", "resolutionId"].includes(key)) {
      if (value === null && key === "realm") { normalized[key] = null; continue; }
      if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`Intervention completion condition '${key}' must be a bounded string.`);
      normalized[key] = value;
    } else if (key === "inputHash") {
      if (!isLowercaseDigest(value)) throw new Error("Approval inputHash must be a lowercase SHA-256 digest.");
      normalized[key] = value;
    } else if (key === "allowedEffects") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(effect => typeof effect !== "string" || effect.length === 0 || effect.length > 128)) {
        throw new Error("Approval allowedEffects must contain 1–32 bounded effect codes.");
      }
      normalized[key] = [...value];
    } else if (key === "reversible") {
      if (typeof value !== "boolean") throw new Error("Approval reversibility must be boolean.");
      normalized[key] = value;
    }
  }
  return normalized;
}

function isLowercaseDigest(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

export class InterventionStore {
  constructor(baseDir) {
    if (typeof baseDir !== "string" || !baseDir) throw new Error("InterventionStore requires a baseDir.");
    this.baseDir = baseDir;
    this.records = new Map(); // interventionId → record (also keyed secondarily by runId)
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await this.#reload();
  }

  async #reload() {
    let entries;
    try { entries = await readdir(this.baseDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        if (record?.intervention_id) {
          // Revision is a monotonic compare-and-set fence for operator
          // decisions. Older intervention files start at revision one.
          if (!Number.isInteger(record.revision) || record.revision < 1) record.revision = 1;
          if (!Object.hasOwn(record, "approvalResolution")) record.approvalResolution = null;
          this.records.set(record.intervention_id, record);
        }
      } catch { /* Unreadable records are left for explicit local inspection. */ }
    }
  }

  async #writeAtomic(record) {
    const path = join(this.baseDir, `${record.intervention_id}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record, null, 2), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  }

  /**
   * Persist an intervention before returning control. The record binds the
   * exact run/step, the reason for suspension, the required human action,
   * and the completion predicate used on resume.
   */
  async create({
    runId, stepId, type, reason, reasonCode = null, requiredHumanAction, completionCondition,
    environmentId = null, authenticationRealm = null, targetId = null,
    applicationId = null, ttlMs = DEFAULT_TTL_MS, resumePolicy = "verify_before_continue"
  }) {
    if (!Object.values(INTERVENTION_TYPE).includes(type)) throw new Error(`Unknown intervention type '${type}'.`);
    const safeCondition = normalizeCompletionCondition(completionCondition);
    const safeReason = reasonCode === null
      ? INTERVENTION_COPY[type][0]
      : INTERVENTION_REASON_COPY[type]?.[reasonCode];
    if (!safeReason) throw new Error("Intervention reasonCode is unsupported for this intervention type.");
    const safeRequiredHumanAction = INTERVENTION_COPY[type][1];
    const now = Date.now();
    const record = {
      schemaVersion: 1,
      intervention_id: randomUUID(),
      revision: 1,
      runId: String(runId),
      stepId: String(stepId),
      type,
      state: INTERVENTION_STATE.WAITING,
      ...(reasonCode ? { reasonCode } : {}),
      environmentId,
      authenticationRealm,
      targetId,
      applicationId,
      reason: safeReason,
      requiredHumanAction: safeRequiredHumanAction,
      completionCondition: safeCondition,
      approvalResolution: null,
      resumePolicy,
      generation: randomBytes(8).toString("hex"),  // fencing token for continuation ownership
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1_000, ttlMs)).toISOString(),
      acknowledgedAt: null,
      satisfiedAt: null,
      resumedAt: null,
      resumeEvidence: null       // bounded evidence reference, never raw credentials
    };
    this.records.set(record.intervention_id, record);
    await this.#writeAtomic(record);
    return record;
  }

  get(interventionId) { return this.records.get(interventionId) ?? null; }

  listPending() {
    return [...this.records.values()]
      .filter(r => r.state === INTERVENTION_STATE.WAITING || r.state === INTERVENTION_STATE.ACKNOWLEDGED)
      .filter(r => Date.parse(r.expiresAt) > Date.now())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listForRun(runId) {
    return [...this.records.values()].filter(r => r.runId === runId);
  }

  async #transition(record, patch) {
    Object.assign(record, patch, {
      revision: (Number.isInteger(record.revision) ? record.revision : 1) + 1,
      updatedAt: new Date().toISOString()
    });
    this.records.set(record.intervention_id, record);
    await this.#writeAtomic(record);
    return record;
  }

  /** Reserve one exact human decision against the current intervention revision. */
  async reserveApprovalResolution(interventionId, expectedRevision, operatorId, decision) {
    const record = this.get(interventionId);
    if (!record) throw new Error(`No intervention '${interventionId}'.`);
    if (record.type !== INTERVENTION_TYPE.HUMAN_APPROVAL) throw new Error("This intervention is not an operation-approval request.");
    if (record.state !== INTERVENTION_STATE.WAITING && record.state !== INTERVENTION_STATE.ACKNOWLEDGED) {
      throw new Error(`Intervention '${interventionId}' is '${record.state}'; approval is no longer pending.`);
    }
    if (!Number.isInteger(expectedRevision) || record.revision !== expectedRevision) {
      throw new Error("Approval request revision is stale; reload the exact pending request before resolving it.");
    }
    if (record.approvalResolution) throw new Error("This approval request already has a resolution in progress or recorded.");
    if (decision !== "approve" && decision !== "reject") throw new Error("Approval decision must be approve or reject.");
    const resolution = {
      status: decision === "approve" ? "resolving" : "rejected",
      decision,
      operatorId: String(operatorId).slice(0, 160),
      decidedAt: new Date().toISOString()
    };
    return await this.#transition(record, {
      approvalResolution: resolution,
      ...(decision === "reject" ? { state: INTERVENTION_STATE.CANCELED } : {})
    });
  }

  /** Bind the issued grant to the reserved approval decision. */
  async completeApprovalResolution(interventionId, expectedRevision, grant) {
    const record = this.get(interventionId);
    if (!record || record.revision !== expectedRevision || record.approvalResolution?.status !== "resolving") {
      throw new Error("Approval resolution reservation changed before the grant could be bound.");
    }
    if (!grant?.grantId) throw new Error("Approval resolution requires the issued grant identity.");
    return await this.#transition(record, {
      approvalResolution: { ...record.approvalResolution, status: "approved", grantId: grant.grantId, expiresAt: grant.expiresAt },
      completionCondition: { ...record.completionCondition, grantId: grant.grantId }
    });
  }

  /** Operator acknowledgement: NOT a resume. */
  async acknowledge(interventionId) {
    const record = this.get(interventionId);
    if (!record) throw new Error(`No intervention '${interventionId}'.`);
    if (record.state !== INTERVENTION_STATE.WAITING) {
      throw new Error(`Intervention '${interventionId}' is '${record.state}'; cannot acknowledge.`);
    }
    return await this.#transition(record, { state: INTERVENTION_STATE.ACKNOWLEDGED, acknowledgedAt: new Date().toISOString() });
  }

  async cancel(interventionId) {
    const record = this.get(interventionId);
    if (!record) throw new Error(`No intervention '${interventionId}'.`);
    return await this.#transition(record, { state: INTERVENTION_STATE.CANCELED });
  }

  /**
   * Acquire continuation ownership of a run's pending intervention.
   * The returned fencing token must be presented to completeResume(); a
   * second concurrent acquirer is rejected while the first holds it.
   */
  async acquireResume(interventionId) {
    const record = this.get(interventionId);
    if (!record) throw new Error(`No intervention '${interventionId}'.`);
    if (record.state !== INTERVENTION_STATE.WAITING && record.state !== INTERVENTION_STATE.ACKNOWLEDGED) {
      throw new Error(`Intervention '${interventionId}' is '${record.state}'; not resumable.`);
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.#transition(record, { state: INTERVENTION_STATE.EXPIRED });
      throw new Error(`Intervention '${interventionId}' expired at ${record.expiresAt}.`);
    }
    if (record.resumeHeldBy && record.resumeHeldBy !== record.generation && Date.parse(record.resumeHeldUntil ?? 0) > Date.now()) {
      throw new Error(`Intervention '${interventionId}' is already being resumed by another worker.`);
    }
    const lease = randomBytes(8).toString("hex");
    await this.#transition(record, {
      resumeHeldBy: lease,
      resumeHeldUntil: new Date(Date.now() + 60_000).toISOString()
    });
    return { record, lease };
  }

  /**
   * Complete a resume after the completion predicate was verified with
   * fresh evidence. Consumes the fencing lease atomically.
   */
  async completeResume(interventionId, lease, { evidenceId = null, note = null } = {}) {
    const record = this.get(interventionId);
    if (!record) throw new Error(`No intervention '${interventionId}'.`);
    if (record.resumeHeldBy !== lease) {
      throw new Error(`Resume lease mismatch for '${interventionId}'; another worker owns continuation.`);
    }
    return await this.#transition(record, {
      state: INTERVENTION_STATE.SATISFIED,
      satisfiedAt: new Date().toISOString(),
      resumedAt: new Date().toISOString(),
      resumeHeldBy: null,
      resumeHeldUntil: null,
      resumeEvidence: evidenceId ? String(evidenceId).slice(0, 120) : null,
      ...(note ? { resumeNote: String(note).slice(0, 300) } : {})
    });
  }

  /** Release a resume lease without completing (verification failed). */
  async releaseResume(interventionId, lease) {
    const record = this.get(interventionId);
    if (!record || record.resumeHeldBy !== lease) return record;
    return await this.#transition(record, { resumeHeldBy: null, resumeHeldUntil: null });
  }

  /** Expire stale waiting records; returns the expired records. */
  async expireStale() {
    const expired = [];
    for (const record of this.records.values()) {
      const waiting = record.state === INTERVENTION_STATE.WAITING || record.state === INTERVENTION_STATE.ACKNOWLEDGED;
      if (waiting && Date.parse(record.expiresAt) <= Date.now()) {
        expired.push(await this.#transition(record, { state: INTERVENTION_STATE.EXPIRED }));
      }
    }
    return expired;
  }

  async remove(interventionId) {
    this.records.delete(interventionId);
    await rm(join(this.baseDir, `${interventionId}.json`), { force: true });
  }
}

/**
 * Verified resume predicates (P0-4). Each predicate re-checks the ACTUAL
 * condition with fresh evidence; a button labeled "Continue", an OAuth
 * redirect, or a disappeared login form is never sufficient on its own.
 * `ctx` supplies the live objects a predicate needs.
 */
export const RESUME_PREDICATES = Object.freeze({
  /** The extension broker or session manager reports a valid attachment grant. */
  async tab_attachment({ ctx, intervention }) { // eslint-disable-line
    const targetId = intervention?.targetId ?? ctx.intervention?.targetId;
    if (!targetId || typeof ctx.hasAttachmentGrant !== "function") {
      return { satisfied: false, reason: "No attachment verifier available." };
    }
    const grant = await ctx.hasAttachmentGrant(targetId, intervention);
    if (!grant?.ok) return { satisfied: false, reason: grant?.reason ?? "No valid attachment grant for the expected browser target." };
    return { satisfied: true, summary: `Attachment grant verified for target ${targetId}.` };
  },

  /** An authoritative identity/session check succeeds for the named realm. */
  async authenticated_session_check({ ctx, intervention }) {
    const realm = intervention?.completionCondition?.realm ?? intervention?.authenticationRealm ?? ctx.intervention?.completionCondition?.realm;
    if (typeof ctx.verifyAuthentication !== "function") {
      return { satisfied: false, reason: "No authentication verifier available." };
    }
    const result = await ctx.verifyAuthentication(realm, intervention);
    if (!result?.authenticated) {
      return { satisfied: false, reason: result?.reason ?? `Realm '${realm}' is not verifiably authenticated.` };
    }
    return { satisfied: true, summary: `Realm '${realm}' authenticated as ${result.identity ?? "verified principal"}.`, evidenceId: result.evidenceId ?? null };
  },

  /** A challenge is no longer present AND the intended application is accessible. */
  async challenge_cleared(args) {
    const observe = args?.ctx?.observe;
    if (typeof observe !== "function") return { satisfied: false, reason: "No observation source available." };
    const observation = await observe(args?.intervention);
    const { classifyHumanHandoff } = await import("../navigation/handoff.js");
    const handoff = classifyHumanHandoff(observation);
    if (handoff?.category === "anti_automation") {
      return { satisfied: false, reason: "Anti-automation challenge is still present." };
    }
    const verifyEnvironment = args?.ctx?.verifyEnvironment;
    if (typeof verifyEnvironment === "function") {
      const env = await verifyEnvironment(observation.page?.url, args?.intervention);
      if (!env?.ok) return { satisfied: false, reason: env?.reason ?? "Application identity not verified after challenge." };
    }
    return { satisfied: true, summary: "Challenge cleared and application identity verified.", evidenceId: observation.evidenceId ?? null };
  },

  /** A scoped approval grant exists, matches exactly, and is still valid. */
  async approval_grant(args) {
    const intervention = args?.intervention;
    const verifyApprovalGrant = args?.ctx?.verifyApprovalGrant;
    if (typeof verifyApprovalGrant !== "function") {
      return { satisfied: false, reason: "No approval-grant verifier available." };
    }
    const grantId = intervention?.completionCondition?.grantId;
    const result = await verifyApprovalGrant(grantId, intervention);
    if (!result?.ok) return { satisfied: false, reason: result?.reason ?? "No valid approval grant for this operation." };
    return { satisfied: true, summary: "Approval grant verified for the exact operation." };
  },

  /** An ambiguous situation was resolved using fresh evidence. */
  async ambiguity_resolved(args) {
    const intervention = args?.intervention;
    const resolveAmbiguity = args?.ctx?.resolveAmbiguity;
    if (typeof resolveAmbiguity !== "function") {
      return { satisfied: false, reason: "No ambiguity resolver available." };
    }
    const result = await resolveAmbiguity(intervention);
    return result?.resolved === true
      ? { satisfied: true, summary: "Ambiguity resolved with fresh evidence.", evidenceId: result.evidenceId ?? null }
      : { satisfied: false, reason: result?.reason ?? "Ambiguity is not yet resolved." };
  }
});

/**
 * Evaluate an intervention's completion predicate with fresh evidence.
 * Never resumes on acknowledgement alone.
 */
export async function evaluateCompletion(intervention, ctx) {
  const predicate = RESUME_PREDICATES[intervention.completionCondition?.type];
  if (!predicate) return { satisfied: false, reason: `Unknown completion predicate '${intervention.completionCondition?.type}'.` };
  try {
    return await predicate({ ctx: ctx ?? {}, intervention });
  } catch (error) {
    return { satisfied: false, reason: `Predicate evaluation failed: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/**
 * Intervention watcher (P0-5): event-driven resumption. Subscribes to
 * relevant change events (tab attach/detach, navigation, lifecycle, DOM
 * mutations, authentication transitions, grant issuance/revocation), and
 * on each event re-evaluates the exact pending completion condition with
 * a fresh observation. Bounded low-frequency polling is used only when no
 * authoritative event source exists. Login attempts are never retried and
 * authentication requests are never re-sent.
 */
export class InterventionWatcher {
  constructor({ store, ctx, pollIntervalMs = 5_000, signal } = {}) {
    if (!store) throw new Error("InterventionWatcher requires an InterventionStore.");
    this.store = store;
    this.ctx = ctx ?? {};
    this.pollIntervalMs = Math.max(1_000, Math.min(pollIntervalMs, 60_000));
    this.signal = signal;
    this.disposers = [];
    this.timer = null;
    this.onResume = null; // async continuation owner; it acquires the resume lease.
    this.#checking = new Set();
  }

  #checking;

  /**
   * Subscribe an event emitter-ish source. Events trigger re-evaluation of
   * the exact pending completion conditions; they are hints, never proof.
   */
  watch(source, events) {
    if (!source?.on) return;
    for (const event of events) {
      const listener = () => { void this.checkPending(); };
      source.on(event, listener);
      this.disposers.push(() => source.off?.(event, listener));
    }
  }

  /** Watch the surfaces the spec names; each is optional. */
  watchBrowser(session) {
    if (!session) return;
    // Navigation and document lifecycle transitions.
    this.watch(session, ["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.lifecycleEvent"]);
    if (session.transport?.on) this.watch(session.transport, ["Target.attachedToTarget", "Target.detachedFromTarget"]);
    if (session.client?.on) this.watch(session.client, ["Page.frameNavigated", "Inspector.detached"]);
  }

  watchBroker(broker) {
    if (!broker?.on) return;
    this.watch(broker, ["attached", "detached", "cdpEvent"]);
  }

  start() {
    if (this.timer || this.signal?.aborted) return;
    // Bounded low-frequency verification polling only as a fallback for
    // state changes with no authoritative event source.
    this.timer = setInterval(() => { void this.checkPending(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const dispose of this.disposers.splice(0)) { try { dispose(); } catch { /* best-effort */ } }
  }

  async checkPending() {
    if (this.signal?.aborted) return;
    await this.store.expireStale();
    for (const intervention of this.store.listPending()) {
      if (typeof this.onResume !== "function") continue;
      if (this.#checking.has(intervention.intervention_id)) continue; // one checker per run
      this.#checking.add(intervention.intervention_id);
      try {
        // This is only a trigger. The continuation owner re-evaluates under
        // its own fencing lease before committing satisfaction.
        const evaluation = await evaluateCompletion(intervention, this.ctx);
        if (!evaluation.satisfied) continue;
        await this.onResume(intervention, evaluation);
      } catch { /* A failed check leaves the intervention pending. */ }
      finally { this.#checking.delete(intervention.intervention_id); }
    }
  }
}
