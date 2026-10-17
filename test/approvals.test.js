/** Scoped authorization grants (P1-5). */
import test from "node:test";
import assert from "node:assert/strict";
import { AuthorizationGrantStore, GRANT_STATE } from "../src/runtime/approvals.js";

test("grants bind principal, environment, realm, resource, operation, input hash, effects, expiry", () => {
  const store = new AuthorizationGrantStore();
  const grant = store.issue({
    principal: "operator-1", environmentId: "freeinference-staging",
    authenticationRealm: "agents-session", resource: "agents/connectors",
    operation: "create_connector", input: { name: "test-connector-7" },
    allowedEffects: ["create:test_connector"]
  });
  assert.equal(grant.state, GRANT_STATE.ACTIVE);
  assert.equal(grant.singleUse, true);
  // Exact scope verifies.
  assert.ok(store.verify(grant.grantId, {
    principal: "operator-1", environmentId: "freeinference-staging",
    authenticationRealm: "agents-session", resource: "agents/connectors",
    operation: "create_connector", input: { name: "test-connector-7" },
    effect: "create:test_connector"
  }).ok);
});

test("grants are single-use, atomically consumed, and reject scope drift", () => {
  const store = new AuthorizationGrantStore();
  const grant = store.issue({
    principal: "operator-1", environmentId: "freeinference-staging",
    resource: "agents/connectors", operation: "create_connector",
    input: { name: "x" }, allowedEffects: ["create:test_connector"]
  });
  // Wrong input hash → rejected.
  assert.ok(!store.verify(grant.grantId, { input: { name: "y" } }).ok);
  // Wrong effect → rejected.
  assert.ok(!store.verify(grant.grantId, { effect: "delete:connector" }).ok);
  // Wrong principal → rejected.
  assert.ok(!store.verify(grant.grantId, { principal: "operator-2" }).ok);
  // Omitted required fields are rejected (fail closed).
  assert.ok(!store.verify(grant.grantId, { principal: "operator-1" }).ok, "Omitted environmentId/resource/operation/input must be rejected.");
  assert.ok(!store.verify(grant.grantId, { input: { name: "x" } }).ok, "Omitted principal must be rejected.");
  // Correct consume → ok, then reuse blocked.
  assert.ok(store.consume(grant.grantId, {
    principal: "operator-1", environmentId: "freeinference-staging",
    resource: "agents/connectors", operation: "create_connector",
    input: { name: "x" }, effect: "create:test_connector"
  }).ok);
  assert.equal(grant.state, GRANT_STATE.CONSUMED);
  assert.ok(!store.verify(grant.grantId, {
    principal: "operator-1", environmentId: "freeinference-staging",
    resource: "agents/connectors", operation: "create_connector",
    input: { name: "x" }, effect: "create:test_connector"
  }).ok);
});

test("grants expire and can be revoked", () => {
  let clock = 1_000_000;
  const store = new AuthorizationGrantStore({ now: () => clock });
  const grant = store.issue({
    principal: "op", environmentId: "env", resource: "r", operation: "o",
    input: {}, allowedEffects: ["e"], expiresInMs: 5_000
  });
  clock += 6_000;
  assert.ok(!store.verify(grant.grantId, { principal: "op", environmentId: "env", resource: "r", operation: "o", input: {}, effect: "e" }).ok);
  const grant2 = store.issue({ principal: "op", environmentId: "env", resource: "r", operation: "o", input: {}, allowedEffects: ["e"] });
  store.revoke(grant2.grantId);
  assert.ok(!store.verify(grant2.grantId, { principal: "op", environmentId: "env", resource: "r", operation: "o", input: {}, effect: "e" }).ok);
});
