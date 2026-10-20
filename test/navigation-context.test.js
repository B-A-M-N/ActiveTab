import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationRunContext } from "../src/navigation/runContext.js";

test("navigation run context preserves resumed counters, exclusions, bindings, and observation", () => {
  const preservedSignature = { identity: "uncertain-click-signature" };
  const taskState = {
    taskId: "run-context-fixture",
    recoveryCount: 2,
    scrollRecoveryBlocked: true,
    attempts: [
      { action: "click", error: "unchanged", targetIdentity: "failed-click", targetSignature: { identity: "unchanged-click" }, sameTargetRemained: true },
      { action: "click", error: "uncertain", targetIdentity: "uncertain-click", targetSignature: preservedSignature, uncertainOutcome: true },
      { action: "click", error: "changed", targetIdentity: "changed-click", targetSignature: { identity: "changed-click" }, beforeStateFingerprint: "a".repeat(64), afterStateFingerprint: "b".repeat(64) },
      { action: "fill", error: "failed-fill", targetIdentity: "failed-fill" },
      { action: "scroll", error: "no-progress", targetIdentity: "failed-scroll", scrollProgressObserved: false },
      { action: "scroll", targetIdentity: "successful-scroll", scrollProgressObserved: true }
    ]
  };
  const observation = { scrollTargets: [{ identity: "current-scroll-a" }, { identity: "current-scroll-b" }] };
  const context = createNavigationRunContext({
    taskState,
    observation,
    limits: { actions: 8, recoveries: 3, scrolls: 5 },
    executionBinding: { targetId: "target-a", endpoint: "local-cdp", environmentFingerprint: "env-fingerprint" }
  });

  assert.equal(context.taskState, taskState);
  assert.equal(context.latestObservation, observation);
  assert.equal(context.journalIdentity, "run-context-fixture");
  assert.deepEqual(context.counters, { actions: 6, recoveries: 2, scrolls: 2 });
  assert.deepEqual([...context.exclusions.candidateIdentities].sort(), ["changed-click", "failed-click", "failed-fill", "uncertain-click"]);
  assert.deepEqual(context.exclusions.targetSignatures, [taskState.attempts[0].targetSignature, preservedSignature]);
  assert.deepEqual([...context.exclusions.scrollIdentities].sort(), ["current-scroll-a", "current-scroll-b", "failed-scroll"]);
  assert.equal(context.scrollConvergenceStates.size, 0);
  assert.equal(context.pendingAttempt, null);
  assert.equal(Object.isFrozen(context.limits), true);
  assert.equal(Object.isFrozen(context.executionBinding), true);

  const nextObservation = { evidenceId: "fresh-evidence", scrollTargets: [] };
  assert.equal(context.setLatestObservation(nextObservation), nextObservation);
  assert.equal(context.latestObservation, nextObservation);

  const dynamicSignature = { identity: "new-uncertain-signature" };
  context.excludeFailedAttempt({
    action: "click",
    error: "uncertain-after-dispatch",
    targetIdentity: "newly-failed-click",
    targetSignature: dynamicSignature,
    uncertainOutcome: true
  });
  context.excludeFailedAttempt({ action: "scroll", targetIdentity: "not-failed" });
  assert.equal(context.exclusions.candidateIdentities.has("newly-failed-click"), true);
  assert.equal(context.exclusions.targetSignatures.includes(dynamicSignature), true);
  assert.equal(context.exclusions.scrollIdentities.has("not-failed"), false);
});
