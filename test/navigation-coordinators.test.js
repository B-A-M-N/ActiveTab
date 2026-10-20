import test from "node:test";
import assert from "node:assert/strict";
import { RecoveryCoordinator } from "../src/navigation/recoveryCoordinator.js";
import { ReplayCoordinator } from "../src/navigation/replayCoordinator.js";
import { ActionAttemptCoordinator } from "../src/navigation/actionAttemptCoordinator.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import {
  routeFingerprint,
  observationStateFingerprint,
  scrollTargetSignature,
  targetSignature,
  visibleCandidatesFingerprint
} from "../src/state/workflows.js";

const neverAborted = () => {};
const isAbortError = error => error?.name === "AbortError" || error?.code === 20;

test("ActionAttemptCoordinator journals pending metadata before dispatch and settles canonical state", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const journalSnapshots = [];
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {
      journalSnapshots.push({ pendingAction: taskState.pendingAction, attempts: [...taskState.attempts] });
    },
    async reserveOperation() {},
    async onDispatch() {}
  });
  const attempt = { action: "click", targetIdentity: "observed-link" };

  await coordinator.begin(attempt);
  assert.equal(runContext.pendingAttempt, attempt);
  assert.equal(taskState.pendingAction, attempt);
  assert.deepEqual(journalSnapshots, [{ pendingAction: attempt, attempts: [] }]);

  coordinator.finish(attempt);
  assert.equal(runContext.pendingAttempt, null);
  assert.equal(Object.hasOwn(taskState, "pendingAction"), false);
  assert.deepEqual(taskState.attempts, [attempt]);
  assert.equal(runContext.counters.actions, 1);
});

test("ActionAttemptCoordinator owns write-ahead reservation and dispatch disposition ordering", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const order = [];
  const attempt = { action: "click", operationId: "operation-1" };
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {
      order.push("journal");
      assert.equal(taskState.pendingAction, attempt);
      assert.deepEqual(taskState.attempts, []);
    },
    async reserveOperation(receivedAttempt, actionType) {
      order.push("reserve");
      assert.equal(receivedAttempt, attempt);
      assert.equal(actionType, "click");
      assert.equal(taskState.pendingAction, attempt);
    },
    async onDispatch(receivedAttempt, actionType, dispatchStatus) {
      order.push("record");
      assert.equal(receivedAttempt, attempt);
      assert.equal(actionType, "click");
      assert.equal(dispatchStatus, "refused");
      assert.equal(attempt.dispatchStatus, "refused");
      assert.equal(taskState.pendingAction, attempt);
    }
  });

  const result = await coordinator.coordinateDispatch(attempt, "click", async () => {
    order.push("dispatch");
    assert.equal(taskState.pendingAction, attempt);
    assert.deepEqual(taskState.attempts, []);
    return {
      dispatchDisposition: "refused_pre_dispatch",
      reasonCode: "target_lease_lost",
      error: new Error("lease expired")
    };
  });

  assert.equal(result.dispatchStatus, "refused");
  assert.equal(result.dispatchDisposition, "refused_pre_dispatch");
  assert.deepEqual(order, ["journal", "reserve", "dispatch", "record", "journal"]);
  assert.deepEqual(attempt.error, { name: "Error", message: "lease expired" });
  assert.equal(taskState.pendingAction, attempt);
  coordinator.finish(attempt);
  assert.equal(runContext.pendingAttempt, null);
  assert.deepEqual(taskState.attempts, [attempt]);
  assert.equal(runContext.counters.actions, 1);
});

test("ActionAttemptCoordinator leaves the write-ahead attempt pending when dispatch callback reports cancellation", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  let dispatchRecords = 0;
  const attempt = { action: "click" };
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {},
    async reserveOperation() {},
    async onDispatch(_attempt, _actionType, dispatchStatus) {
      dispatchRecords++;
      assert.equal(dispatchStatus, "refused");
    }
  });
  const abort = Object.assign(new Error("canceled during dispatch"), { name: "AbortError" });

  const result = await coordinator.coordinateDispatch(attempt, "click", async () => ({
    cancelled: true,
    dispatchDisposition: "refused_pre_dispatch",
    error: abort
  }));
  assert.equal(result.cancelled, true);
  assert.equal(result.error, abort);
  assert.equal(result.dispatchStatus, "refused");
  assert.equal(taskState.pendingAction, attempt);
  assert.equal(runContext.pendingAttempt, attempt);
  assert.deepEqual(taskState.attempts, []);
  assert.equal(dispatchRecords, 1, "the coordinator records cancellation as a definite pre-dispatch refusal");
});

test("ActionAttemptCoordinator records callback failures as uncertain dispatch outcomes", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const attempt = { action: "click" };
  const failure = new Error("observation transport failed during stale recovery");
  let dispatchRecords = 0;
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {},
    async reserveOperation() {},
    async onDispatch() { dispatchRecords++; }
  });

  const result = await coordinator.coordinateDispatch(attempt, "click", async () => { throw failure; });
  assert.equal(result.dispatchDisposition, "uncertain");
  assert.equal(result.dispatchStatus, "uncertain");
  assert.equal(result.error, failure);
  assert.equal(taskState.pendingAction, attempt);
  assert.equal(runContext.pendingAttempt, attempt);
  assert.equal(dispatchRecords, 1);
  assert.equal(attempt.uncertainOutcome, true);
  assert.equal(attempt.browserEffectPossible, true);
  assert.equal(attempt.retryWithoutReconciliation, false);
});

test("ActionAttemptCoordinator preserves a definite refusal when dispatch telemetry fails", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const attempt = { action: "click" };
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {},
    async reserveOperation() {},
    async onDispatch() { throw new Error("telemetry storage unavailable"); }
  });

  const result = await coordinator.coordinateDispatch(attempt, "click", async () => ({
    dispatchDisposition: "refused_pre_dispatch",
    reasonCode: "target_lease_lost"
  }));
  assert.equal(result.dispatchDisposition, "refused_pre_dispatch");
  assert.equal(attempt.dispatchStatus, "refused");
  assert.equal(attempt.telemetryIncomplete, true);
  assert.equal(attempt.browserEffectPossible, false);
  assert.equal(taskState.pendingAction, attempt, "the attempt stays pending until the engine records its observed refusal");
});

test("ActionAttemptCoordinator leaves a write-ahead record when post-dispatch journaling fails", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const attempt = { action: "click" };
  const journalError = new Error("journal storage failed after dispatch");
  let writes = 0;
  let durableSnapshot;
  let dispatches = 0;
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {
      writes++;
      if (writes === 1) {
        durableSnapshot = structuredClone({ pendingAction: taskState.pendingAction });
        return;
      }
      throw journalError;
    },
    async reserveOperation() {},
    async onDispatch() {}
  });

  await assert.rejects(coordinator.coordinateDispatch(attempt, "click", async () => {
    dispatches++;
    return { dispatchDisposition: "dispatched_unverified", reasonCode: "dispatch_sent" };
  }), error => error === journalError);
  assert.equal(dispatches, 1);
  assert.equal(attempt.dispatchDisposition, "dispatched_unverified");
  assert.equal(attempt.dispatchStatus, "dispatched");
  assert.equal(durableSnapshot.pendingAction.action, "click", "the pre-dispatch write-ahead record remains available for restart reconciliation");
  assert.equal(durableSnapshot.pendingAction.dispatchDisposition, undefined, "a failed post-dispatch write cannot claim a durable outcome");
  assert.equal(taskState.pendingAction, attempt, "the in-memory action remains pending and cannot be treated as settled");
});

test("ActionAttemptCoordinator does not dispatch when write-ahead operation reservation fails", async () => {
  const taskState = { attempts: [] };
  const runContext = { pendingAttempt: null, counters: { actions: 0 } };
  const attempt = { action: "click" };
  const reservationError = new Error("reservation unavailable");
  let dispatches = 0;
  const coordinator = new ActionAttemptCoordinator({
    taskState,
    runContext,
    async updateJournal() {},
    async reserveOperation() { throw reservationError; },
    async onDispatch() {}
  });

  const result = await coordinator.coordinateDispatch(attempt, "click", async () => { dispatches++; });
  assert.equal(result.dispatchDisposition, "refused_pre_dispatch");
  assert.equal(result.dispatchStatus, "refused");
  assert.equal(result.error, reservationError);
  assert.equal(taskState.pendingAction, attempt);
  assert.equal(runContext.pendingAttempt, attempt);
  assert.equal(dispatches, 0);
  assert.deepEqual(taskState.attempts, []);
});

test("NavigationEngine enters one inference budget without recursively invoking run", async () => {
  const targetId = "budget-target";
  const session = {
    target: { id: targetId, endpoint: "local-cdp" },
    async observe() {
      return {
        targetId,
        evidenceId: "budget-observation",
        page: { url: "https://app.example.test/" },
        candidates: [],
        scrollTargets: [],
        observationProfile: "interaction"
      };
    }
  };
  let budgetEntries = 0;
  let budgetRunId;
  const engine = new NavigationEngine(session, {
    planner: { async plan() { return { status: "ambiguous", candidates: [], reason: "No visible target." }; } },
    decisionRuntime: {
      async withInferenceBudget(binding, callback) {
        budgetEntries++;
        budgetRunId = binding.runId;
        return callback();
      },
      startEpisode() { return { episodeId: "budget-episode" }; },
      completeEpisode() {},
      inferenceBudgetSnapshot() { return { attempts: 0, maxAttempts: 3 }; }
    }
  });
  const run = engine.run.bind(engine);
  let publicRunCalls = 0;
  engine.run = (...args) => {
    publicRunCalls++;
    return run(...args);
  };

  const result = await engine.run("Open account history", {
    _executionState: { taskId: "forged-task-id", attempts: [] },
    _inferenceBudgeted: true
  });
  assert.equal(budgetEntries, 1);
  assert.notEqual(budgetRunId, "forged-task-id", "public run options cannot replace canonical task state");
  assert.equal(publicRunCalls, 1);
  assert.equal(result.status, "unresolved");
});

test("ReplayCoordinator enforces action budgets and resolves only one fresh signed target", async () => {
  const candidate = {
    identity: "candidate-current",
    targetId: "target-a",
    tag: "a",
    role: "link",
    name: "Account history",
    contextName: "Primary navigation",
    href: "https://app.example.test/account/history",
    visible: true,
    disabled: false
  };
  const observation = {
    page: { url: "https://app.example.test/" },
    candidates: [candidate]
  };
  const workflow = {
    steps: [{
      action: "click",
      routeFingerprint: routeFingerprint(observation.page.url),
      target: targetSignature(candidate)
    }]
  };
  const coordinator = new ReplayCoordinator({
    workflowStore: { async find() { return workflow; }, async invalidate() { return true; } },
    goal: "Open account history",
    initialRouteFingerprint: routeFingerprint(observation.page.url)
  });

  const loaded = await coordinator.load({ observation, remainingActions: 1, remainingScrolls: 0 });
  assert.equal(loaded.status, "replaying");
  assert.equal(loaded.workflow, workflow);
  assert.equal((await coordinator.load({ observation, remainingActions: 0, remainingScrolls: 0 })).status, "budget-skipped");

  const resolved = coordinator.resolveStep(workflow.steps[0], observation);
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.target, candidate);
  assert.equal(coordinator.resolveStep(workflow.steps[0], {
    ...observation,
    candidates: [candidate, { ...candidate, identity: "duplicate-current" }]
  }).status, "stale");
  assert.equal(coordinator.resolveStep(workflow.steps[0], {
    ...observation,
    page: { url: "https://app.example.test/other" }
  }).reasonCode, "route_changed");

  const changedObservation = { ...observation, page: { ...observation.page, title: "Account history" } };
  assert.equal(coordinator.clickChanged(observationStateFingerprint(observation), changedObservation), true);
  assert.equal(await coordinator.invalidate(), true);
});

test("ReplayCoordinator validates scroll preconditions and observed trace outcome", () => {
  const scrollTarget = {
    identity: "invoice-list",
    kind: "container",
    tag: "div",
    role: "region",
    name: "Invoices",
    contextName: "Invoice history",
    visible: true,
    canScrollDown: true,
    scrollTop: 0,
    maxScrollTop: 100
  };
  const observation = {
    page: { url: "https://app.example.test/invoices" },
    candidates: [],
    scrollTargets: [scrollTarget]
  };
  const step = {
    action: "scroll",
    routeFingerprint: routeFingerprint(observation.page.url),
    scrollTarget: scrollTargetSignature(scrollTarget),
    beforePositionFraction: 0,
    afterPositionFraction: 0.3,
    beforeCandidatesFingerprint: visibleCandidatesFingerprint(observation),
    afterCandidatesFingerprint: visibleCandidatesFingerprint(observation)
  };
  const coordinator = new ReplayCoordinator();
  const resolved = coordinator.resolveStep(step, observation);
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.target, scrollTarget);

  const afterTarget = { ...scrollTarget, scrollTop: 30 };
  const evaluation = coordinator.evaluateScrollStep(step, scrollTarget, {}, {
    ...observation,
    scrollTargets: [afterTarget]
  });
  assert.equal(evaluation.matchesTrace, true);
  assert.equal(evaluation.moved, true);
  assert.equal(evaluation.afterTarget, afterTarget);
  assert.equal(coordinator.resolveStep(step, {
    ...observation,
    candidates: [{ tag: "button", role: "button", name: "New candidate", visible: true }]
  }).status, "stale");
});

test("RecoveryCoordinator makes one fresh observation retry and never dispatches an action", async () => {
  let waits = 0;
  let observations = 0;
  let dispatches = 0;
  const session = {
    attached: true,
    targetLifecycle: "attached",
    async waitForChange() { waits++; throw new Error("temporary lifecycle observation race"); },
    async observe() { observations++; return { evidenceId: "fresh-after-retry", page: { url: "https://app.example.test/" } }; },
    async click() { dispatches++; }
  };
  const coordinator = new RecoveryCoordinator({
    getSession: () => session,
    setSession() {},
    getLatestObservation: () => null,
    isAbortError,
    throwIfAborted: neverAborted
  });

  const observation = await coordinator.observeAfterChange(500, {}, { action: "click", dispatchStatus: "dispatched" });
  assert.equal(observation.evidenceId, "fresh-after-retry");
  assert.equal(waits, 1);
  assert.equal(observations, 1);
  assert.equal(dispatches, 0);
});

test("RecoveryCoordinator reattaches only a dispatched click to the exact target and environment", async () => {
  const targetId = "leased-target";
  const endpoint = "http://127.0.0.1:9222";
  let currentSession = {
    target: { id: targetId, endpoint, url: "https://shop.example.test/" },
    attached: false,
    targetLifecycle: "detached",
    async waitForChange() { throw new Error("Target detached during post-navigation observation."); }
  };
  let commits = 0;
  let leaseChecks = 0;
  let dispatches = 0;
  const freshObservation = {
    evidenceId: "fresh-reattached-evidence",
    targetId,
    page: { url: "https://shop.example.test/account" }
  };
  const replacementSession = {
    target: { id: targetId, endpoint: `${endpoint}/` },
    attached: true,
    async close() {}
  };
  const coordinator = new RecoveryCoordinator({
    getSession: () => currentSession,
    setSession: session => { currentSession = session; },
    getLatestObservation: () => ({ page: { url: "https://shop.example.test/" } }),
    environment: { authorizedOrigins: ["https://shop.example.test"] },
    reattachSameTarget: async binding => {
      assert.equal(binding.targetId, targetId);
      assert.equal(binding.endpoint, endpoint);
      return { session: replacementSession, observation: freshObservation, commit() { commits++; } };
    },
    assertExecutionLease: async () => { leaseChecks++; },
    selectionGoal: "Open the account page",
    isAbortError,
    throwIfAborted: neverAborted
  });
  const attempt = { action: "click", dispatchStatus: "dispatched" };

  const observation = await coordinator.observeAfterChange(2_000, {}, attempt);
  assert.equal(observation, freshObservation);
  assert.equal(currentSession, replacementSession);
  assert.equal(attempt.reconnectedObservation, true);
  assert.equal(commits, 1);
  assert.equal(leaseChecks, 1);
  assert.equal(dispatches, 0);
});

test("RecoveryCoordinator does not reattach after uncertain non-click effects", async () => {
  const error = new Error("Target detached during scroll observation.");
  const session = {
    attached: false,
    targetLifecycle: "detached",
    async waitForChange() { throw error; }
  };
  let reattachCalls = 0;
  const coordinator = new RecoveryCoordinator({
    getSession: () => session,
    setSession() {},
    reattachSameTarget: async () => { reattachCalls++; },
    isAbortError,
    throwIfAborted: neverAborted
  });

  await assert.rejects(
    coordinator.observeAfterChange(1_000, {}, { action: "scroll", dispatchStatus: "dispatched" }),
    caught => caught === error && caught.observationAttempts === 1
  );
  assert.equal(reattachCalls, 0);
});
