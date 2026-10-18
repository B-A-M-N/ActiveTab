import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationOperationExecutor, EFFECT_CLASSIFICATION } from "../src/diagnostics/adapters/applicationOperation.js";
import { AuthorizationGrantStore, GRANT_STATE } from "../src/runtime/approvals.js";

test("mutating application operations cannot opt out of scoped grants", () => {
  const executor = new ApplicationOperationExecutor({ applicationId: "fixture-app", environment: "fixture-staging" });
  assert.throws(() => executor.registerOperation({
    operationId: "mutate_fixture",
    sourceId: "fixture-api",
    method: "POST",
    path: "/fixture",
    effect: EFFECT_CLASSIFICATION.MUTATING,
    requiresGrant: false,
    handler: async () => ({ changed: true })
  }), /cannot disable grant requirements/);
});

test("grant consumption uses the registered effect and refuses caller substitution before the handler", async () => {
  const grants = new AuthorizationGrantStore({ trustedIssuer: "test-operator" });
  const grant = grants.issue({
    principal: "operator-1",
    environmentId: "fixture-staging",
    resource: "fixture-1",
    operation: "mutate_fixture",
    input: { fixtureId: "fixture-1" },
    allowedEffects: [EFFECT_CLASSIFICATION.MUTATING]
  });
  let calls = 0;
  const executor = new ApplicationOperationExecutor({ applicationId: "fixture-app", environment: "fixture-staging", grantStore: grants });
  executor.registerOperation({
    operationId: "mutate_fixture",
    sourceId: "fixture-api",
    method: "POST",
    path: "/fixture",
    effect: EFFECT_CLASSIFICATION.MUTATING,
    handler: async () => { calls++; return { changed: true }; }
  });
  const result = await executor.execute("mutate_fixture", {
    grantId: grant.grantId,
    principal: "operator-1",
    resource: "fixture-1",
    input: { fixtureId: "fixture-1" },
    effect: EFFECT_CLASSIFICATION.READ_ONLY
  });
  assert.equal(result.status, "refused");
  assert.equal(calls, 0);
  assert.equal(grants.get(grant.grantId).state, GRANT_STATE.ACTIVE);
});

test("a timed out mutating handler is canceled and reported uncertain", { timeout: 5000 }, async () => {
  const grants = new AuthorizationGrantStore({ trustedIssuer: "test-operator" });
  const grant = grants.issue({
    principal: "operator-1",
    environmentId: "fixture-staging",
    resource: "fixture-1",
    operation: "mutate_fixture",
    input: {},
    allowedEffects: [EFFECT_CLASSIFICATION.MUTATING]
  });
  let calls = 0;
  let receivedSignal;
  const executor = new ApplicationOperationExecutor({ applicationId: "fixture-app", environment: "fixture-staging", grantStore: grants, timeoutMs: 1000 });
  executor.registerOperation({
    operationId: "mutate_fixture",
    sourceId: "fixture-api",
    method: "POST",
    path: "/fixture",
    effect: EFFECT_CLASSIFICATION.MUTATING,
    handler: async ({ signal }) => {
      calls++;
      receivedSignal = signal;
      await new Promise(resolve => setTimeout(resolve, 1200));
      return { changed: true };
    }
  });
  const result = await executor.execute("mutate_fixture", {
    grantId: grant.grantId,
    principal: "operator-1",
    resource: "fixture-1",
    input: {}
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.effectStatus, "uncertain");
  assert.equal(result.verificationStatus, "not_verified");
  assert.equal(receivedSignal.aborted, true);
  assert.equal(calls, 1);
});
