import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { EvidenceReleaseGrantStore } from "../src/runtime/evidenceReleaseGrants.js";

const selectors = {
  profileId: "fixture-profile", environmentId: "fixture-staging", applicationId: "fixture-app",
  authenticationRealm: null, requestId: "request-a", view: "markdown", sectionId: "section-diagnostics"
};

test("evidence release API requires independent operator auth and returns a grant token once", async t => {
  const releaseStore = new EvidenceReleaseGrantStore();
  const api = createApiServer({
    port: 0,
    navigationRunner: { run: async () => ({}) },
    operatorToken: "operator-secret",
    operatorId: "operator-alice",
    evidenceReleaseStore: releaseStore
  });
  const { url } = await api.start();
  t.after(async () => { await api.stop(); releaseStore.close(); });

  const request = releaseStore.request({
    targetId: "target-a", evidenceId: "evidence-a", facet: "response_body",
    principalId: "local_os_user:tester", callerInstanceId: "mcp-process-a", selectors,
    maxBytes: 100_000, expiresInMs: 60_000
  });
  const listPath = `${url}/v1/evidence/releases/requests`;
  const unauthenticated = await fetch(listPath);
  assert.equal(unauthenticated.status, 403);

  const list = await fetch(listPath, { headers: { "X-ActiveTab-Operator-Token": "operator-secret" } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.requests[0].requestId, request.requestId);
  assert.equal(JSON.stringify(listed).includes("token"), false);

  const approvalPath = `${url}/v1/evidence/releases/requests/${request.requestId}/approve`;
  const forged = await fetch(approvalPath, {
    method: "POST", headers: { Authorization: "Bearer operator-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: request.revision })
  });
  assert.equal(forged.status, 403, "the automation bearer channel is not operator approval");

  const approvedResponse = await fetch(approvalPath, {
    method: "POST", headers: { "X-ActiveTab-Operator-Token": "operator-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: request.revision, operatorId: "operator-bob" })
  });
  assert.equal(approvedResponse.status, 400, "operator identity and scope cannot be supplied in approval JSON");
  const approved = await fetch(approvalPath, {
    method: "POST", headers: { "X-ActiveTab-Operator-Token": "operator-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: request.revision })
  });
  assert.equal(approved.status, 200);
  const approvedResult = await approved.json();
  assert.match(approvedResult.token, /^[A-Za-z0-9_-]{40,100}$/u);
  assert.equal(approvedResult.grant.issuedBy, "operator-alice");
  assert.equal(releaseStore.getRequest(request.requestId).token, undefined);

  const audit = await fetch(`${url}/v1/evidence/releases/audit`, { headers: { "X-ActiveTab-Operator-Token": "operator-secret" } });
  const auditJson = await audit.json();
  assert.equal(JSON.stringify(auditJson).includes(approvedResult.token), false);

  const revoke = await fetch(`${url}/v1/evidence/releases/grants/${approvedResult.grant.grantId}/revoke`, {
    method: "POST", headers: { "X-ActiveTab-Operator-Token": "operator-secret", "Content-Type": "application/json" }, body: "{}"
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).state, "revoked");
});
