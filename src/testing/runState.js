/**
 * Durable run state (P1-4) — survives process restarts.
 *
 * Persists run/step identity, the current application/authentication
 * realm, browser target identity and attachment state, the latest verified
 * evidence reference, pending human interventions, authorization state,
 * test-owned resources, expected postconditions, pending/uncertain
 * operations, diagnostic collection progress, and remaining budgets.
 *
 * On restart the loader returns suspended runs so the caller can:
 *   1. reload suspended runs; 2. check whether the original browser is
 *   still attached; 3. request attachment if necessary; 4. re-establish
 *   authentication/environment identity; 5. re-evaluate pending
 *   interventions; 6. reconcile uncertain operations; 7. resume from the
 *   correct step. Suspended runs are never marked failed merely because
 *   the process restarted.
 *
 * Never persists raw goals, browser evidence payloads, form values,
 * cookies, or authentication material.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rename, open } from "node:fs/promises";
import { join, dirname } from "node:path";

const MAX_RUN_STATE_BYTES = 64 * 1024;

export class RunStateStore {
  constructor(baseDir) {
    if (typeof baseDir !== "string" || !baseDir) throw new Error("RunStateStore requires a baseDir.");
    this.baseDir = baseDir;
    this.runs = new Map();
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
        const run = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        if (run?.runId) this.runs.set(run.runId, run);
      } catch { /* Unreadable records are left for explicit local inspection. */ }
    }
  }

  async #writeAtomic(run) {
    const path = join(this.baseDir, `${run.runId}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      const serialized = JSON.stringify(run, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_STATE_BYTES) throw new Error("Run state exceeds the 64 KiB local storage limit.");
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  }

  async create({ workflowId, workflowName, environmentId = null, authenticationRealm = null, targetId = null, goalFingerprint = null, budget = {}, mode = null, profileId = null }) {
    const run = {
      schemaVersion: 1,
      runId: randomUUID(),
      workflowId: String(workflowId),
      workflowName: String(workflowName),
      mode: mode ? String(mode) : null,
      profileId: profileId ? String(profileId) : null,
      status: "created",
      environmentId,
      authenticationRealm,
      target: targetId ? { targetId, attached: false } : null,
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
      suspendedStepId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.runs.set(run.runId, run);
    await this.#writeAtomic(run);
    return run;
  }

  get(runId) { return this.runs.get(runId) ?? null; }

  /** Suspended (resumable) runs surviving a restart; never auto-failed. */
  listSuspended() {
    return [...this.runs.values()]
      .filter(run => run.status.startsWith("waiting_for_") || run.status === "resume_validation" || run.status === "reconciling")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  listActive() {
    return [...this.runs.values()].filter(run => ["created", "running", "discovering"].includes(run.status));
  }

  async update(runId, patch) {
    const run = this.runs.get(runId);
    if (!run) return null;
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    this.runs.set(runId, run);
    await this.#writeAtomic(run);
    return run;
  }

  /** Record a test-owned resource so cleanup obligations survive restarts. */
  async registerTestOwnedResource(runId, { resourceId, type, cleanupAction = null }) {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.testOwnedResources.push({ resourceId: String(resourceId), type: String(type), cleanupAction, createdAt: new Date().toISOString() });
    await this.#writeAtomic(run);
    return run;
  }

  async markResourceCleaned(runId, resourceId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const resource = run.testOwnedResources.find(r => r.resourceId === resourceId);
    if (resource) resource.cleanedAt = new Date().toISOString();
    await this.#writeAtomic(run);
    return run;
  }

  /**
   * Restart recovery: re-validate the original browser attachment and
   * re-establish identity; invalid grants for the new session/principal are
   * dropped rather than retained.
   */
  async reconcileRestart(runId, { attachmentCheck = null, environmentCheck = null } = {}) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const patch = { status: run.status };
    if (typeof attachmentCheck === "function" && run.target) {
      const attached = await attachmentCheck(run.target.targetId);
      run.target.attached = attached === true;
      if (!attached) patch.status = "waiting_for_tab_authorization";
    }
    if (typeof environmentCheck === "function" && run.environmentId) {
      const env = await environmentCheck(run.environmentId);
      if (env?.ok === false) {
        // Stale administrative grants must not carry into an unverified environment.
        run.authorizationState.grants = [];
        patch.status = "waiting_for_human_decision";
      }
    }
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    await this.#writeAtomic(run);
    return run;
  }
}
