import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAuthorizedAction } from "../src/runtime/authorizedExecutor.js";
import { FileUploadGrantStore } from "../src/runtime/fileUploadGrants.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-upload-grants-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const scope = Object.freeze({
  approvalRef: "operator-confirmation-1",
  principalId: "operator:local",
  targetId: "upload-target",
  candidateIdentity: "file-input-1",
  operationId: "shop_upload_attachment",
  environmentId: "shop-test",
  applicationId: "shop"
});

test("file upload grants stage exact bytes and bind principal, target, operation, app, and expiry", async () => withDirectory(async directory => {
  const sourcePath = join(directory, "report.txt");
  await writeFile(sourcePath, "approved bytes");
  const store = new FileUploadGrantStore({ stagingDirectory: join(directory, "stage"), allowedRoots: [directory], trustedIssuer: "operator-authenticator" });
  const issued = await store.issue({ ...scope, filePath: sourcePath });
  assert.deepEqual(Object.keys(issued).sort(), ["approvalRef", "expiresAt", "grantId", "operationId", "targetId"].sort());
  assert.equal(JSON.stringify(issued).includes(sourcePath), false);
  const good = { ...scope };
  assert.equal((await store.verify(issued.grantId, good)).ok, true);
  assert.equal((await store.verify(issued.grantId, { ...good, targetId: "other-target" })).reasonCode, "upload_grant_scope_mismatch");
  assert.equal((await store.verify(issued.grantId, { ...good, principalId: "other-principal" })).reasonCode, "upload_grant_scope_mismatch");
  assert.equal((await store.verify(issued.grantId, { ...good, applicationId: "other-app" })).reasonCode, "upload_grant_scope_mismatch");
  const dispatch = await store.beginDispatch(issued.grantId, good);
  assert.equal(dispatch.ok, true);
  assert.deepEqual(await readFile(dispatch.stagedPaths[0], "utf8"), "approved bytes");
  assert.equal((await store.beginDispatch(issued.grantId, good)).ok, false, "a grant cannot dispatch twice");
  await store.complete(issued.grantId);
  assert.equal(store.get(issued.grantId).state, "consumed");
}));

test("file upload grant refuses modified or replaced source files and symlinks", async () => withDirectory(async directory => {
  const sourcePath = join(directory, "report.txt");
  const replacementPath = join(directory, "replacement.txt");
  await writeFile(sourcePath, "approved bytes");
  await writeFile(replacementPath, "replacement bytes");
  const store = new FileUploadGrantStore({ stagingDirectory: join(directory, "stage"), allowedRoots: [directory], trustedIssuer: "operator-authenticator" });
  const issued = await store.issue({ ...scope, filePath: sourcePath });
  await writeFile(sourcePath, "changed bytes");
  assert.equal((await store.verify(issued.grantId, scope)).reasonCode, "upload_source_changed");

  const secondPath = join(directory, "second.txt");
  await writeFile(secondPath, "approved second bytes");
  const second = await store.issue({ ...scope, filePath: secondPath });
  const moved = join(directory, "original-second.txt");
  await rename(secondPath, moved);
  await symlink(replacementPath, secondPath);
  assert.equal((await store.verify(second.grantId, scope)).reasonCode, "upload_source_unavailable");

  await assert.rejects(() => store.issue({ ...scope, filePath: secondPath }), /regular file|symbolic link/u);
}));

test("file upload grants require a configured source root and reject paths outside its boundary", async () => withDirectory(async directory => {
  const allowed = join(directory, "allowed");
  const outside = join(directory, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  const insidePath = join(allowed, "inside.txt");
  const outsidePath = join(outside, "outside.txt");
  await writeFile(insidePath, "allowed");
  await writeFile(outsidePath, "outside");
  const disabled = new FileUploadGrantStore({ stagingDirectory: join(directory, "disabled-stage"), trustedIssuer: "operator-authenticator" });
  await assert.rejects(() => disabled.issue({ ...scope, filePath: insidePath }), /disabled until an operator configures/u);

  const store = new FileUploadGrantStore({ stagingDirectory: join(directory, "stage"), allowedRoots: [allowed], trustedIssuer: "operator-authenticator" });
  await assert.rejects(() => store.issue({ ...scope, filePath: outsidePath }), /outside the configured source directories/u);
  await assert.rejects(() => store.issue({ ...scope, filePath: join(allowed, "..", "outside", "outside.txt") }), /outside the configured source directories/u);
  const issued = await store.issue({ ...scope, filePath: insidePath });
  assert.equal((await store.verify(issued.grantId, scope)).ok, true);
}));

function makeEnvironment() {
  return {
    environmentId: scope.environmentId,
    authorizedOrigins: ["https://shop.example"],
    applications: [{ applicationId: scope.applicationId, authenticationRealm: "shop-session", candidateEntry: "https://shop.example/upload" }]
  };
}

function makeSession(candidate, uploads) {
  let observations = 0;
  return {
    attached: true,
    target: { id: scope.targetId, endpoint: "fixture", url: "https://shop.example/upload" },
    documentGeneration: 1,
    observer: { getEvidence: () => ({ status: "available", page: { url: "https://shop.example/upload" } }) },
    async observe() {
      observations++;
      return { evidenceId: `upload-evidence-${observations}`, targetId: scope.targetId, documentGeneration: 1,
        page: { url: "https://shop.example/upload" }, candidates: [candidate] };
    },
    async validateObservedCandidate(current) {
      return { status: "valid", targetId: scope.targetId, documentGeneration: 1,
        backendNodeId: current.backendNodeId, url: "https://shop.example/upload" };
    },
    async uploadFile(current, paths, options) {
      uploads.push({ paths, current });
      await options.beforeDispatch();
      return { dispatched: true, fileCount: paths.length };
    }
  };
}

const fileCandidate = Object.freeze({ identity: scope.candidateIdentity, backendNodeId: 31,
  targetId: scope.targetId, documentGeneration: 1, tag: "input", type: "file", role: "button",
  name: "Attachment", visible: true, disabled: false, submitsForm: false });

test("authorized upload refuses missing grants before reservation or CDP dispatch", async () => withDirectory(async directory => {
  const uploads = [];
  let reservations = 0;
  const session = makeSession(fileCandidate, uploads);
  const result = await executeAuthorizedAction({
    session, environment: makeEnvironment(), action: "upload", candidate: fileCandidate,
    principalId: scope.principalId, operationId: scope.operationId,
    operationAuthorizer: { async authorize() { return { allowed: true }; } },
    assertExecutionLease: async () => {},
    onReserve: async () => { reservations++; return { allowed: true }; }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "upload_grant_required");
  assert.equal(reservations, 0);
  assert.deepEqual(uploads, []);
}));

test("authorized upload uses only approved staged bytes and rechecks scope immediately before dispatch", async () => withDirectory(async directory => {
  const sourcePath = join(directory, "report.txt");
  await writeFile(sourcePath, "approved bytes");
  const grants = new FileUploadGrantStore({ stagingDirectory: join(directory, "stage"), allowedRoots: [directory], trustedIssuer: "operator-authenticator" });
  const issued = await grants.issue({ ...scope, filePath: sourcePath });
  const uploads = [];
  const session = makeSession(fileCandidate, uploads);
  const result = await executeAuthorizedAction({
    session, environment: makeEnvironment(), action: "upload", candidate: fileCandidate,
    principalId: scope.principalId, operationId: scope.operationId,
    uploadGrantStore: grants, uploadGrantId: issued.grantId,
    operationAuthorizer: { async authorize() { return { allowed: true }; } },
    assertExecutionLease: async () => {}
  });
  assert.equal(result.dispatched, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].paths.length, 1);
  assert.equal(uploads[0].paths[0].startsWith(join(directory, "stage")), true);
  assert.equal(result.fileCount, undefined, "the executor result does not expose a local path");
  assert.equal(grants.get(issued.grantId).state, "consumed");
}));
