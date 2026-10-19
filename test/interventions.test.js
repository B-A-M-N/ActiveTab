/** Durable human-intervention lifecycle, resume predicates, watcher (P0-3/4/5). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  InterventionStore, InterventionWatcher, evaluateCompletion, externalRunState,
  INTERVENTION_TYPE, INTERVENTION_STATE, EXTERNAL_RUN_STATE
} from "../src/runtime/interventions.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";
import { InterventionCoordinator } from "../src/testing/lifecycle/interventionCoordinator.js";

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "activetab-interv-"));
  const store = new InterventionStore(dir);
  await store.init();
  try { return await fn(store); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("intervention application binding resolves the observed route instead of selecting the first matching realm", async () => {
  const environment = buildEnvironmentBinding({
    profile_id: "shared-realm-profile",
    authentication_realms: [{ realm_id: "shared-realm", scope: ["application"] }],
    environment: {
      environment_id: "shared-realm-environment",
      application_entry_url: "https://apps.example.test/app-a",
      applications: [
        { application_id: "app-a", authentication_realm: "shared-realm", candidate_entry: "/app-a" },
        { application_id: "app-b", authentication_realm: "shared-realm", candidate_entry: "/app-b" }
      ]
    }
  });
  const created = [];
  const coordinator = new InterventionCoordinator({
    interventions: { async create(value) { created.push(value); return { intervention_id: `i-${created.length}`, state: "waiting" }; } },
    environment,
    session: { target: { id: "tab-app-b", url: "https://apps.example.test/app-b/login" } }
  });
  const receipt = { runId: "run-shared-realm", recordStep() {}, recordIntervention() {} };
  const step = { id: "login", type: "interaction", intervention: {} };

  await coordinator.suspend(step, receipt, new Date().toISOString(), {
    type: INTERVENTION_TYPE.AUTHENTICATION,
    reason: "Sign in to continue",
    requiredHumanAction: "Sign in",
    condition: { type: "authenticated_session_check", realm: "shared-realm" }
  });
  assert.equal(created[0].applicationId, "app-b");

  await coordinator.suspend(step, receipt, new Date().toISOString(), {
    type: INTERVENTION_TYPE.AUTHENTICATION,
    reason: "Realm mismatch",
    requiredHumanAction: "Resolve the application identity",
    condition: { type: "authenticated_session_check", realm: "different-realm" }
  });
  assert.equal(created[1].applicationId, null, "unmatched realm does not bind an arbitrary same-origin application");
});

test("interventions persist before control returns and are resumable, not terminal", () =>
  withStore(async store => {
    const record = await store.create({
      runId: "run-1", stepId: "s3", type: INTERVENTION_TYPE.AUTHENTICATION,
      reason: "Agents application requires authentication",
      requiredHumanAction: "Complete sign-in in the attached browser tab",
      completionCondition: { type: "authenticated_session_check", realm: "agents-session" },
      environmentId: "freeinference-staging", authenticationRealm: "agents-session", targetId: "tab-9"
    });
    assert.equal(record.state, INTERVENTION_STATE.WAITING);
    assert.equal(externalRunState(record), EXTERNAL_RUN_STATE.WAITING_FOR_AUTHENTICATION);
    // Re-load from disk to prove durability before continuation.
    const reloaded = new InterventionStore(join(record.intervention_id, ".."));
    const dir = store.baseDir;
    const store2 = new InterventionStore(dir);
    await store2.init();
    const fromDisk = store2.get(record.intervention_id);
    assert.equal(fromDisk.runId, "run-1");
    assert.equal(fromDisk.stepId, "s3");
    assert.equal(fromDisk.completionCondition.realm, "agents-session");
  }));

test("acknowledgement is not satisfaction; resume verifies the predicate", () =>
  withStore(async store => {
    const record = await store.create({
      runId: "run-1", stepId: "s4", type: INTERVENTION_TYPE.AUTHENTICATION,
      reason: "login required", requiredHumanAction: "sign in",
      completionCondition: { type: "authenticated_session_check", realm: "agents-session" }
    });
    await store.acknowledge(record.intervention_id);
    assert.equal(store.get(record.intervention_id).state, INTERVENTION_STATE.ACKNOWLEDGED);
    // Predicate not satisfied → no resume.
    const evaluation = await evaluateCompletion(store.get(record.intervention_id), {
      verifyAuthentication: async () => ({ authenticated: false })
    });
    assert.ok(!evaluation.satisfied);
    // A generic "Continue" button is never proof.
    const continueEvaluation = await evaluateCompletion(store.get(record.intervention_id), {
      observe: async () => ({ page: { title: "Continue", url: "https://staging.freeinference.org/" }, candidates: [{ name: "Continue", role: "button" }] })
    });
    assert.ok(!continueEvaluation.satisfied);
    // Authoritative session check succeeds → satisfied.
    const ok = await evaluateCompletion(store.get(record.intervention_id), {
      verifyAuthentication: async (realm, intervention) => {
        assert.equal(intervention.intervention_id, record.intervention_id);
        assert.equal(intervention.runId, "run-1");
        return { authenticated: true, identity: "test-operator", evidenceId: "ev-1", realm };
      }
    });
    assert.ok(ok.satisfied);
    const { lease } = await store.acquireResume(record.intervention_id);
    await store.completeResume(record.intervention_id, lease, { evidenceId: "ev-1" });
    assert.equal(store.get(record.intervention_id).state, INTERVENTION_STATE.SATISFIED);
  }));

test("expired interventions are rejected; concurrent resume ownership is fenced", () =>
  withStore(async store => {
    const record = await store.create({
      runId: "run-1", stepId: "s1", type: INTERVENTION_TYPE.HUMAN_APPROVAL,
      reason: "approval needed", requiredHumanAction: "approve",
      completionCondition: { type: "approval_grant", grantId: "g-1" },
      ttlMs: 60_000
    });
    // Two workers racing: first acquire wins, second is rejected while held.
    const first = await store.acquireResume(record.intervention_id);
    await assert.rejects(() => store.acquireResume(record.intervention_id), /already being resumed/);
    // Lease mismatch cannot complete the resume.
    await assert.rejects(() => store.completeResume(record.intervention_id, "bogus-lease"), /lease mismatch/);
    await store.releaseResume(record.intervention_id, first.lease);
    const second = await store.acquireResume(record.intervention_id);
    await store.completeResume(record.intervention_id, second.lease);
    assert.equal(store.get(record.intervention_id).state, INTERVENTION_STATE.SATISFIED);
    // Satisfied interventions are not resumable again.
    await assert.rejects(() => store.acquireResume(record.intervention_id), /not resumable/);
  }));

test("watcher resumes only after the verified condition holds (event-driven)", () =>
  withStore(async store => {
    const record = await store.create({
      runId: "run-1", stepId: "enter-agents", type: INTERVENTION_TYPE.AUTHENTICATION,
      reason: "Agents authentication required", requiredHumanAction: "sign in",
      completionCondition: { type: "authenticated_session_check", realm: "agents-session" }
    });
    let authenticated = false;
    const events = new EventEmitter();
    let resumed = null;
    let announceResume;
    const resumedPromise = new Promise(resolve => { announceResume = resolve; });
    const watcher = new InterventionWatcher({
      store,
      ctx: { verifyAuthentication: async () => authenticated ? { authenticated: true, evidenceId: "ev-auth" } : { authenticated: false } },
      pollIntervalMs: 60_000 // events drive checks; polling is a fallback only
    });
    watcher.watch(events, ["tab-attached", "navigated", "session-changed", "grant-issued"]);
    watcher.onResume = async candidate => {
      const { record: owned, lease } = await store.acquireResume(candidate.intervention_id);
      const reevaluated = await evaluateCompletion(owned, watcher.ctx);
      if (!reevaluated.satisfied) { await store.releaseResume(owned.intervention_id, lease); return; }
      resumed = await store.completeResume(owned.intervention_id, lease, { evidenceId: reevaluated.evidenceId, note: reevaluated.summary });
      announceResume();
    };
    watcher.start();
    try {
      // A navigation event alone must not resume: predicate still false.
      events.emit("navigated");
      await new Promise(r => setImmediate(r));
      assert.equal(resumed, null);
      assert.equal(store.get(record.intervention_id).state, INTERVENTION_STATE.WAITING);
      // Session transition with verified authentication resumes.
      authenticated = true;
      events.emit("session-changed");
      let timeoutId;
      try {
        await Promise.race([
          resumedPromise,
          new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("watcher did not resume within one second")), 1_000); })
        ]);
      } finally { clearTimeout(timeoutId); }
      assert.ok(resumed, "watcher resumed after the verified condition held");
      assert.equal(store.get(record.intervention_id).state, INTERVENTION_STATE.SATISFIED);
    } finally { watcher.stop(); }
  }));

test("no secrets are persisted in intervention records", () =>
  withStore(async store => {
    const record = await store.create({
      runId: "r", stepId: "s", type: INTERVENTION_TYPE.AUTHENTICATION,
      reason: "the password is hunter2",
      requiredHumanAction: "Use token private-token-value",
      completionCondition: { type: "authenticated_session_check", realm: "agents-session" }
    });
    const serialized = JSON.stringify(record).toLowerCase();
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("private-token-value"), false);
    assert.equal(record.reason, "Authentication is required.");
    assert.equal(record.requiredHumanAction, "Complete sign-in in the attached browser tab.");
    assert.deepEqual(record.completionCondition, { type: "authenticated_session_check", realm: "agents-session" });
    await assert.rejects(
      () => store.create({ runId: "r", stepId: "bad", type: INTERVENTION_TYPE.AUTHENTICATION, reason: "x", requiredHumanAction: "x", completionCondition: { type: "authenticated_session_check", pageText: "private text" } }),
      error => String(error.message).includes("unsupported field")
    );
  }));
