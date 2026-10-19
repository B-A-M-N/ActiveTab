import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/local-server.js";
import { RunLocalPublicReadApprovalBroker } from "../src/capabilities/publicReadApprovalBroker.js";

function proposal(overrides = {}) {
  return {
    origin: "https://catalog.example",
    pagePath: "/search",
    targetId: "authorized-tab-1",
    sourceFingerprint: "a".repeat(64),
    fields: [{ name: "title", sourceHeader: "Title", type: "string" }],
    requestedOutput: ["title"],
    maxRecords: 50,
    maxBytes: 32_768,
    expiresInMs: 60_000,
    approvalPhrase: "APPROVE PUBLIC READ A1B2C3D4",
    ...overrides
  };
}

test("run-local public-read broker requires operator identity, exact revision, and phrase", async () => {
  const broker = new RunLocalPublicReadApprovalBroker();
  const waiting = broker.request(proposal());
  const pending = broker.listPending()[0];
  assert.equal(pending.status, "pending");
  assert.equal(pending.proposal.fields[0].dataClass, "public");
  assert.throws(() => broker.create(proposal({ fields: [{ name: "email", sourceHeader: "Email", type: "string" }], requestedOutput: ["email"] })), /Unclassified or explicitly denied/);
  assert.throws(() => broker.resolve(pending.requestId, {
    decision: "approve", operatorId: "operator-1", expectedRevision: pending.revision, approvalPhrase: "wrong"
  }), /exact public-read approval phrase/);
  const resolved = broker.resolve(pending.requestId, {
    decision: "approve", operatorId: "operator-1", expectedRevision: pending.revision, approvalPhrase: pending.approvalPhrase
  });
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.operatorId, "operator-1");
  assert.equal(await waiting, true);
});

test("HTTP public-read approval is separated between API callers and authenticated operators", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-public-read-approval-"));
  const broker = new RunLocalPublicReadApprovalBroker();
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(directory, "tasks"),
    apiToken: "api-token",
    operatorAuthenticator: async req => req.headers["x-operator"] === "yes" ? "human-operator" : null,
    publicReadApprovalBroker: broker
  });
  t.after(async () => { await api.stop(); await rm(directory, { recursive: true, force: true }); });
  const { url } = await api.start();
  const waiting = broker.request(proposal());
  const request = broker.listPending()[0];
  const unauthorized = await fetch(`${url}/v1/public-reads/requests/${request.requestId}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer api-token" },
    body: JSON.stringify({ expectedRevision: request.revision, approvalPhrase: request.approvalPhrase })
  });
  assert.equal(unauthorized.status, 403, "the API token cannot approve its own request");
  const wrongPhrase = await fetch(`${url}/v1/public-reads/requests/${request.requestId}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-operator": "yes" },
    body: JSON.stringify({ expectedRevision: request.revision, approvalPhrase: "wrong" })
  });
  assert.equal(wrongPhrase.status, 409);
  const approved = await fetch(`${url}/v1/public-reads/requests/${request.requestId}/approve`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-operator": "yes" },
    body: JSON.stringify({ expectedRevision: request.revision, approvalPhrase: request.approvalPhrase })
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "approved");
  assert.equal(await waiting, true);
  const status = await fetch(`${url}/v1/public-reads/requests/${request.requestId}/status`, {
    headers: { Authorization: "Bearer api-token" }
  });
  assert.equal((await status.json()).status, "approved");
});
