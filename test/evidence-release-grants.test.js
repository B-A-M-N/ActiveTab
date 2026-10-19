import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceReleaseGrantStore } from "../src/runtime/evidenceReleaseGrants.js";

async function fixture(t, { now = () => Date.UTC(2026, 9, 18) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-evidence-grants-"));
  const databasePath = join(directory, "release.sqlite");
  let store = new EvidenceReleaseGrantStore({ databasePath, now });
  t.after(async () => {
    try { store.close(); } catch { /* Already closed before reopening. */ }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    get store() { return store; },
    reopen() {
      store.close();
      store = new EvidenceReleaseGrantStore({ databasePath, now });
      return store;
    }
  };
}

const scope = Object.freeze({
  targetId: "target-a",
  evidenceId: "evidence-a",
  facet: "response_body",
  principalId: "principal-a",
  callerInstanceId: "mcp-instance-a",
  selectors: {
    profileId: "profile-a", environmentId: "env-a", applicationId: "app-a", authenticationRealm: null,
    requestId: "request-a", view: "markdown"
  }
});

test("evidence release requires independent operator approval and binds every scope field", async t => {
  const env = await fixture(t);
  const pending = env.store.request({ ...scope, maxBytes: 300, expiresInMs: 60_000 });
  assert.equal(pending.state, "pending");
  assert.equal(env.store.audit({ entityId: pending.requestId })[0].eventType, "requested");
  assert.throws(() => env.store.approveRequest(pending.requestId, { expectedRevision: 1 }), /authenticated operator/u);

  const approved = env.store.approveRequest(pending.requestId, { operatorId: "operator-a", expectedRevision: 1 });
  assert.equal(approved.request.state, "approved");
  assert.match(approved.token, /^[A-Za-z0-9_-]{40,100}$/u);
  assert.equal(env.store.getRequest(pending.requestId).token, undefined);
  assert.equal(JSON.stringify(env.store.audit({ entityId: pending.requestId })).includes(approved.token), false);

  const release = { token: approved.token, scope };
  assert.equal(env.store.verifyMany([release]).ok, true);
  assert.equal(env.store.verifyMany([{ token: approved.token, scope: { ...scope, targetId: "target-b" } }]).ok, false);
  assert.equal(env.store.verifyMany([{ token: approved.token, scope: { ...scope, selectors: { ...scope.selectors, requestId: "request-b" } } }]).ok, false);
  assert.equal(env.store.chargeMany([release], 200).ok, true);
  assert.equal(env.store.chargeMany([release], 101).ok, false, "the cumulative byte budget blocks a later overage");

  const mode = (await stat(env.databasePath)).mode & 0o777;
  assert.equal(mode, 0o600, "the durable grant database is owner-only");
  const events = env.store.audit({ entityId: approved.grant.grantId });
  assert.equal(events.at(-1).eventType, "released");
  assert.equal(events.at(-1).byteCount, 200);

  const reopened = env.reopen();
  assert.equal(reopened.verifyMany([release]).ok, true, "durable scope and token hashes survive store restart for the same caller instance");
  assert.equal(reopened.verifyMany([{
    token: approved.token,
    scope: { ...scope, callerInstanceId: "mcp-instance-b" }
  }]).ok, false, "a new MCP process identity cannot reuse the prior process's release grant");
  assert.equal(reopened.revokeGrant(approved.grant.grantId, { operatorId: "operator-a" }).state, "revoked");
  assert.equal(reopened.verifyMany([release]).ok, false);
});

test("evidence release request validation and revisions fail closed", async t => {
  const env = await fixture(t);
  assert.throws(() => env.store.request({ ...scope, maxBytes: 9 * 1024 * 1024 }), /byte budget/u);
  assert.throws(() => env.store.request({ ...scope, facet: "all_evidence", maxBytes: 100 }), /facet/u);
  const runtimeScope = {
    ...scope,
    selectors: { profileId: "profile-a", environmentId: "env-a", applicationId: "app-a", authenticationRealm: null, path: ["secret"] }
  };
  assert.throws(() => env.store.request({ ...runtimeScope, facet: "runtime_values", selectors: { ...runtimeScope.selectors, extra: true }, maxBytes: 100 }), /selector/u);
  assert.throws(() => env.store.request({ ...runtimeScope, facet: "runtime_values", maxBytes: 100, expiresInMs: 900_001 }), /lifetime/u);

  const request = env.store.request({ ...scope, maxBytes: 100, expiresInMs: 60_000 });
  assert.throws(() => env.store.approveRequest(request.requestId, { operatorId: "operator-a", expectedRevision: 2 }), /revision changed/u);
  const rejected = env.store.rejectRequest(request.requestId, { operatorId: "operator-a", expectedRevision: 1 });
  assert.equal(rejected.state, "rejected");
  assert.equal(env.store.audit({ entityId: request.requestId }).at(-1).eventType, "rejected");
});

test("expired evidence release grants cannot release data", async t => {
  let now = Date.UTC(2026, 9, 18);
  const env = await fixture(t, { now: () => now });
  const request = env.store.request({ ...scope, maxBytes: 100, expiresInMs: 1_000 });
  const approved = env.store.approveRequest(request.requestId, { operatorId: "operator-a", expectedRevision: 1 });
  now += 1_001;
  assert.equal(env.store.verifyMany([{ token: approved.token, scope }]).ok, false);
  assert.equal(env.store.chargeMany([{ token: approved.token, scope }], 10).ok, false);
  assert.equal(env.store.audit({ entityId: approved.grant.grantId }).at(-1).eventType, "expired");
});

test("an unreviewed evidence release request expires instead of issuing a stale grant", async t => {
  let now = Date.UTC(2026, 9, 18);
  const env = await fixture(t, { now: () => now });
  const request = env.store.request({ ...scope, maxBytes: 100, expiresInMs: 1_000 });
  now += 1_001;
  assert.throws(() => env.store.approveRequest(request.requestId, { operatorId: "operator-a", expectedRevision: 1 }), /request has expired/u);
  assert.equal(env.store.getRequest(request.requestId).state, "expired");
  assert.equal(env.store.audit({ entityId: request.requestId }).at(-1).eventType, "request_expired");
});

test("raw response credentials require two matching independent grants", async t => {
  const env = await fixture(t);
  const bodyRequest = env.store.request({ ...scope, facet: "response_body", maxBytes: 100_000, expiresInMs: 60_000 });
  const credentialsRequest = env.store.request({ ...scope, facet: "response_credential_values", maxBytes: 100_000, expiresInMs: 60_000 });
  const body = env.store.approveRequest(bodyRequest.requestId, { operatorId: "operator-a", expectedRevision: 1 });
  const credentials = env.store.approveRequest(credentialsRequest.requestId, { operatorId: "operator-a", expectedRevision: 1 });
  const bodyScope = { ...scope, facet: "response_body" };
  const credentialScope = { ...scope, facet: "response_credential_values" };
  assert.equal(env.store.verifyMany([{ token: credentials.token, scope: credentialScope }]).ok, false);
  assert.equal(env.store.verifyMany([
    { token: body.token, scope: bodyScope },
    { token: credentials.token, scope: { ...credentialScope, selectors: { ...credentialScope.selectors, blockId: "another-block" } } }
  ]).ok, false);
  assert.equal(env.store.verifyMany([
    { token: body.token, scope: bodyScope },
    { token: credentials.token, scope: credentialScope }
  ]).ok, true);
});
