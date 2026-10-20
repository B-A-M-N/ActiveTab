import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpTaskJournalStore } from "../src/state/mcpTaskJournals.js";
import { TaskJournal, taskGoalFingerprint } from "../src/state/journal.js";
import { persistWorkflowResultArtifact, runMcpGoal, resolveWorkflowStoreOption } from "../src/mcp/runGoal.js";
import { environmentBindingFingerprint } from "../src/navigation/engine.js";
import { WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { createRunStateFixture } from "./runStateFixture.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-mcp-journal-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("MCP reuses an explicitly configured local workflow store by default and supports a per-run opt out", () => {
  const store = { async find() {}, async record() {} };
  assert.equal(resolveWorkflowStoreOption({}, store), store);
  assert.equal(resolveWorkflowStoreOption({ reuseWorkflows: false }, store), null);
  assert.throws(() => resolveWorkflowStoreOption({ reuseWorkflows: true }, null), /ACTIVETAB_WORKFLOW_STORE/u);
});

function verifiedProductOutput() {
  const pageUrl = "https://shop.example.test/products";
  return {
    schema: { type: "array", items: {
      name: { type: "string", required: true, dataClass: "public", sourceHeader: "Name" }
    } },
    records: [{ name: "Widget" }],
    fieldProvenance: [{ recordIndex: 0, fields: {
      name: { observationId: "ev-products-1", validation: "valid", method: "visible_html_table_cell", sourceHeader: "Name", pageUrl }
    } }],
    scope: { origin: "https://shop.example.test", pagePath: "/products", environmentId: "shop-staging", applicationId: "shop" },
    completeness: "complete",
    verification: {
      recordCount: 1, expectedRecords: 1, completionPolicy: "exact_count", pageCount: 1,
      invalidRows: 0, duplicateKeys: 0, invalidUniqueKeys: 0, overflow: false, failures: [],
      uniqueBy: ["name"], evidenceIds: ["ev-products-1"]
    }
  };
}

test("MCP task journals use private files and opaque keys without persisting the raw goal", async () => withDirectory(async directory => {
  const goal = "Open the account page for private-user-734";
  const target = { id: "authorized-tab-id", endpoint: "local-cdp" };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const first = await store.forTask(target, goal);
  const repeated = await store.forTask(target, goal);
  assert.equal(first.key, repeated.key);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.equal(first.journal.path, repeated.journal.path);

  const directoryStat = await stat(join(directory, "tasks"));
  assert.equal(directoryStat.mode & 0o777, 0o700);
  await first.journal.write({
    schemaVersion: 1,
    taskId: "task-1",
    goal: "[redacted task goal]",
    goalFingerprint: taskGoalFingerprint(goal),
    requiresGoalInput: true,
    targetId: target.id,
    endpoint: target.endpoint,
    status: "unresolved",
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const fileStat = await stat(first.journal.path);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const contents = await readFile(first.journal.path, "utf8");
  assert.equal(contents.includes(goal), false);
  assert.equal(contents.includes("private-user-734"), false);
  assert.equal((await readdir(join(directory, "tasks"))).length, 1);
}));

test("Chrome auto-connect keeps the existing journal key while leases use the exact loopback endpoint", async () => withDirectory(async directory => {
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const goal = "Open the account page";
  const before = await store.forTask({ id: "authorized-tab", endpoint: "chrome-auto-connect" }, goal);
  const after = await store.forTask({
    id: "authorized-tab",
    endpoint: "http://127.0.0.1:43127",
    reattachEndpoint: "http://127.0.0.1:43127",
    journalEndpoint: "chrome-auto-connect"
  }, goal);
  assert.equal(after.key, before.key, "adding the exact network endpoint does not orphan an unresolved task journal");
  assert.equal(after.journal.path, before.journal.path);
}));

test("MCP partial collection checkpoints retain released rows privately and strip query URLs", async () => withDirectory(async directory => {
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { resultArtifact } = await store.forTask({ id: "checkpoint-target", endpoint: "local-cdp" }, "list public product names");
  const fingerprint = value => createHash("sha256").update(value).digest("hex");
  const output = verifiedProductOutput();
  output.completeness = "incomplete";
  output.verification.pageCount = 1;
  output.fieldProvenance[0].fields.name.pageUrl = "https://shop.example.test/products?search=private+phrase&cursor=secret#page";
  await resultArtifact.writeCheckpoint({
    schemaVersion: 1,
    kind: "partial_collection_checkpoint",
    taskId: "checkpoint-task",
    targetId: "checkpoint-target",
    endpoint: "local-cdp",
    goalFingerprint: fingerprint("goal"),
    environmentFingerprint: null,
    principalId: "operator-1",
    intentFingerprint: fingerprint("intent"),
    capabilityId: "products.read",
    capabilityVersion: 1,
    capabilityBindings: { "products.read": {} },
    contractFingerprint: fingerprint("contract"),
    fieldPolicyFingerprint: fingerprint("field-policy"),
    releasePolicyFingerprint: fingerprint("release-policy"),
    sourceObservationRef: fingerprint("observation-id"),
    pageIdentityFingerprints: [fingerprint("page-identity")],
    cursorFingerprint: fingerprint("cursor"),
    nextCursorFingerprint: null,
    nextPageStatus: "not_found",
    duplicateRecordCount: 0,
    pageCount: 1,
    pageEvidence: [{ observationId: "evidence-1", pageUrl: "https://shop.example.test/products?cursor=secret", maxRecords: 10 }],
    unresolvedOperationIds: [],
    output
  });

  const checkpoint = await resultArtifact.readCheckpoint();
  assert.deepEqual(checkpoint.output.records, [{ name: "Widget" }]);
  assert.equal(checkpoint.pageEvidence[0].pageUrl, "https://shop.example.test/products");
  assert.equal(checkpoint.output.fieldProvenance[0].fields.name.pageUrl, "https://shop.example.test/products");
  const contents = await readFile(resultArtifact.checkpointPath, "utf8");
  assert.equal(contents.includes("private phrase"), false);
  assert.equal(contents.includes("cursor=secret"), false);
  assert.equal((await stat(resultArtifact.checkpointPath)).mode & 0o777, 0o600);
}));

test("MCP run_goal defaults to auto and returns verified current-page observed_partial records", async () => withDirectory(async directory => {
  const targetId = "mcp-auto-read-target";
  const pageUrl = "https://catalog.example.test/products";
  const goal = "List the visible product names";
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const fixture = await createRunStateFixture("activetab-mcp-auto-read-");
  const output = {
    schema: { type: "array", items: { name: { type: "string", required: true, dataClass: "public", sourceHeader: "Name" } } },
    records: [{ name: "Widget" }],
    fieldProvenance: [{ recordIndex: 0, fields: { name: {
      observationId: "mcp-auto-read-evidence", validation: "valid", method: "visible_html_table_cell",
      sourceHeader: "Name", pageUrl
    } } }],
    scope: { origin: "https://catalog.example.test", pagePath: "/products" },
    completeness: "observed_partial",
    verification: {
      recordCount: 1, expectedRecords: null, completionPolicy: "observed_only", pageCount: 1,
      invalidRows: 0, duplicateKeys: 0, invalidUniqueKeys: 0, overflow: false, failures: [], uniqueBy: ["name"],
      completenessStatus: "observed_partial", completionReasonCode: "collection_completeness_not_established", completenessClaimed: false
    }
  };
  const capabilityId = "observed_read_mcp_auto_12345678";
  const capability = {
    id: capabilityId, action: "extract", executionOrigin: "ephemeral_observed_read", effectClass: "read",
    intentBinding: "caller_required", targetRole: "observed_records", purposeCodes: ["extract_records"],
    preconditionCodes: ["fresh_observed_source"], postconditionCodes: ["observed_records_returned"],
    verificationCodes: ["observed_records_verified"], outputCompleteness: "observed_partial",
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output, completeness: "observed_partial" }; }
  };
  const session = {
    attached: true,
    target: { id: targetId, endpoint: "fixture", url: pageUrl },
    async observe() { return {
      evidenceId: "mcp-auto-read-evidence", targetId, documentGeneration: 1,
      page: { url: pageUrl, title: "Products" }, headings: [], candidates: [], scrollTargets: []
    }; }
  };

  try {
    const result = await runMcpGoal(session, { goal }, {
      journalStore: store,
      runStateStore: fixture.store,
      capabilityService: {
        async createObservedReadWorkflowCapabilities({ goal: requestedGoal }) {
          assert.equal(requestedGoal, goal);
          return [capability];
        }
      }
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.workflowOutputs[capabilityId].records, [{ name: "Widget" }]);
    assert.equal(result.workflowOutputs[capabilityId].completeness, "observed_partial");
    assert.equal(result.workflowOutputs[capabilityId].verification.completenessClaimed, false);
  } finally {
    await fixture.cleanup();
  }
}));

test("MCP run_goal defaults to the guarded search-and-read workflow without plannerMode", async () => withDirectory(async directory => {
  const targetId = "mcp-auto-search-read-target";
  const pageUrl = "https://search.example.test/";
  const query = "rare public phrase";
  const goal = `Search for ${query} and return the titles`;
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const fixture = await createRunStateFixture("activetab-mcp-auto-search-read-");
  const candidates = [
    {
      identity: "query-field", backendNodeId: 11, targetId, documentGeneration: 1,
      tag: "input", type: "search", role: "searchbox", name: "Search", visible: true, disabled: false, readOnly: false,
      formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true
    },
    {
      identity: "submit-search", backendNodeId: 12, targetId, documentGeneration: 1,
      tag: "button", role: "button", name: "Search", visible: true, disabled: false, submitsForm: true,
      formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true
    }
  ];
  const readCapability = {
    id: "observed_read_mcp_search_12345678", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "observed_records", purposeCodes: ["extract_records"], preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"], verificationCodes: ["observed_records_verified"],
    outputCompleteness: "observed_partial", outputSchema: [{ name: "title", type: "string", required: true }],
    async execute() { throw new Error("search results must be verified before extraction"); }
  };
  const session = {
    attached: true, documentGeneration: 1,
    target: { id: targetId, endpoint: "fixture", url: pageUrl },
    async observe() { return {
      evidenceId: "mcp-auto-search-read-evidence", targetId, documentGeneration: 1,
      page: { url: pageUrl, title: "Search" }, headings: [], candidates, scrollTargets: []
    }; }
  };
  let providerInput;

  try {
    const result = await runMcpGoal(session, { goal }, {
      journalStore: store,
      runStateStore: fixture.store,
      capabilityService: {
        async createDeferredObservedReadWorkflowCapabilities({ goal: readGoal }) {
          assert.equal(readGoal, "the titles");
          return [readCapability];
        }
      },
      workflowSynthesizer: new WorkflowSynthesizer({
        allowPageEvidence: true,
        provider: { async requestStructured(request) {
          providerInput = request.input;
          return { result: { version: 1, steps: [] } };
        } }
      })
    });
    assert.equal(result.status, "unresolved");
    assert.ok(providerInput, "the omitted plannerMode selected workflow synthesis");
    assert.equal(providerInput.task.cardinality, "compound");
    assert.ok(providerInput.task.requiredCapabilityIds.includes(readCapability.id));
    assert.equal(JSON.stringify(providerInput).includes(query), false, "the caller query stays out of the planning projection");
  } finally {
    await fixture.cleanup();
  }
}));

test("MCP extraction artifacts are private, separately stored, and bound to the task fingerprint", async () => withDirectory(async directory => {
  const goal = "Extract the public product names";
  const target = { id: "artifact-tab", endpoint: "local-cdp" };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { resultArtifact, key } = await store.forTask(target, goal);
  const value = {
    schemaVersion: 1,
    taskId: "task-artifact-1",
    targetId: target.id,
    endpoint: target.endpoint,
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint: null,
    principalId: "local_mcp_automation",
    intentFingerprint: "a".repeat(64),
    capabilityBindings: { shop_products: {
      capabilityVersion: 1, environmentId: "shop-staging", origin: "https://shop.example.test",
      applicationId: "shop", pagePath: "/products", principalId: "local_mcp_automation", manifestFingerprint: "c".repeat(64)
    } },
    requiredCapabilityIds: ["shop_products"],
    outputs: { shop_products: { records: [{ name: "Widget" }] } },
    createdAt: new Date().toISOString()
  };
  await resultArtifact.write(value);

  const artifactPath = join(directory, "tasks", "result-artifacts", `${key}.json`);
  assert.equal((await stat(join(directory, "tasks", "result-artifacts"))).mode & 0o777, 0o700);
  assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
  assert.deepEqual(await resultArtifact.read(), value);
  assert.equal((await readFile(artifactPath, "utf8")).includes(goal), false);
  await resultArtifact.clear();
  assert.equal(await resultArtifact.read(), null);
}));

test("MCP persists inferred extraction output only under a qualified manifest and current release policy", async () => withDirectory(async directory => {
  const target = { id: "inferred-persist-tab", endpoint: "local-cdp" };
  const goal = "Extract product names";
  const environment = {
    environmentId: "shop-staging",
    authorizedOrigins: ["https://shop.example.test"],
    applications: [{ applicationId: "shop", origin: "https://shop.example.test" }]
  };
  const manifest = {
    capabilityId: "shop_products", capabilityVersion: 1, environmentId: "shop-staging",
    origin: "https://shop.example.test", applicationId: "shop", pagePath: "/products",
    principalId: "local_mcp_automation"
  };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { resultArtifact } = await store.forTask(target, goal);
  const shared = {
    resultArtifact,
    taskId: "task-inferred-persist",
    target,
    goal,
    environment,
    environmentFingerprint: environmentBindingFingerprint(environment),
    principalId: "local_mcp_automation",
    intentFingerprint: "a".repeat(64),
    requiredCapabilityIds: [],
    capabilityRegistry: { list: () => [manifest] },
    outputs: { shop_products: verifiedProductOutput() }
  };
  assert.equal(await persistWorkflowResultArtifact({ ...shared, authorizeExtractionRelease: () => true }), true);
  const artifact = await resultArtifact.read();
  assert.deepEqual(artifact.requiredCapabilityIds, ["shop_products"]);
  assert.deepEqual(artifact.outputs.shop_products.records, [{ name: "Widget" }]);

  await assert.rejects(
    persistWorkflowResultArtifact({ ...shared, authorizeExtractionRelease: () => false }),
    /current release policy and independent verification/u
  );
  await assert.rejects(
    persistWorkflowResultArtifact({ ...shared, capabilityRegistry: { list: () => [] }, authorizeExtractionRelease: () => true }),
    /currently qualified capability manifests/u
  );
}));

test("completed MCP extraction tasks replay only verified artifacts under the same scope and release policy", async () => withDirectory(async directory => {
  const target = { id: "artifact-replay-tab", endpoint: "local-cdp", url: "https://shop.example.test/products" };
  const goal = "Extract product names";
  const environment = {
    profileId: "shop-staging",
    environmentId: "shop-staging",
    applicationEntryUrl: "https://shop.example.test/",
    authorizedOrigins: ["https://shop.example.test"],
    applications: [{ applicationId: "shop", origin: "https://shop.example.test" }]
  };
  const workflowIntent = {
    purposeCode: "extract_products",
    outcomeCode: "complete_product_records",
    requiredCapabilityIds: ["shop_products"]
  };
  const manifest = {
    capabilityId: "shop_products", capabilityVersion: 1, environmentId: "shop-staging",
    origin: "https://shop.example.test", applicationId: "shop", pagePath: "/products",
    principalId: "local_mcp_automation"
  };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { key, journal, resultArtifact } = await store.forTask(target, goal);
  const taskId = "task-artifact-replay";
  await journal.write({
    schemaVersion: 1,
    taskId,
    goal: "[redacted task goal]",
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint: environmentBindingFingerprint(environment),
    requiresGoalInput: true,
    targetId: target.id,
    endpoint: target.endpoint,
    status: "succeeded",
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const intentFingerprint = createHash("sha256").update(JSON.stringify({
    purposeCode: workflowIntent.purposeCode,
    outcomeCode: workflowIntent.outcomeCode,
    cardinality: "unknown",
    targetRoles: [],
    constraints: [],
    requiredCapabilityIds: workflowIntent.requiredCapabilityIds
  })).digest("hex");
  await resultArtifact.write({
    schemaVersion: 1,
    taskId,
    targetId: target.id,
    endpoint: target.endpoint,
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint: environmentBindingFingerprint(environment),
    principalId: "local_mcp_automation",
    intentFingerprint,
    capabilityBindings: { shop_products: {
      capabilityVersion: manifest.capabilityVersion,
      environmentId: manifest.environmentId,
      origin: manifest.origin,
      applicationId: manifest.applicationId,
      pagePath: manifest.pagePath,
      principalId: manifest.principalId,
      manifestFingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
    } },
    requiredCapabilityIds: ["shop_products"],
    outputs: { shop_products: verifiedProductOutput() },
    createdAt: new Date().toISOString()
  });

  const runState = await createRunStateFixture("activetab-mcp-artifact-replay-");
  const session = { target, attached: true };
  const args = { goal, plannerMode: "workflow", workflowIntent };
  try {
    await assert.rejects(
      runMcpGoal(session, { goal, workflowIntent }, { journalStore: store }),
      /requires plannerMode=workflow/
    );
    const replayed = await runMcpGoal(session, args, {
      journalStore: store,
      environment,
      capabilityRegistry: { list: () => [manifest] },
      authorizeExtractionRelease: () => true,
      runStateStore: runState.store
    });
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.alreadySucceeded, true);
    assert.deepEqual(replayed.workflowOutputs.shop_products.records, [{ name: "Widget" }]);

    const withheld = await runMcpGoal(session, args, {
      journalStore: store,
      environment,
      capabilityRegistry: { list: () => [manifest] },
      authorizeExtractionRelease: () => false,
      runStateStore: runState.store
    });
    assert.equal(withheld.status, "unresolved", "a changed release policy cannot return a previously stored value");

    const wrongIntent = await runMcpGoal(session, {
      ...args,
      workflowIntent: { ...workflowIntent, outcomeCode: "different_outcome" }
    }, {
      journalStore: store,
      environment,
      capabilityRegistry: { list: () => [manifest] },
      authorizeExtractionRelease: () => true,
      runStateStore: runState.store
    });
    assert.equal(wrongIntent.status, "unresolved", "stored outputs are bound to the original typed intent");
  } finally {
    await runState.cleanup();
  }
  assert.match(key, /^[a-f0-9]{64}$/);
}));

test("MCP replays a verified extraction artifact when its task contract was inferred from an opted-in goal", async () => withDirectory(async directory => {
  const target = { id: "inferred-artifact-tab", endpoint: "local-cdp", url: "https://shop.example.test/products" };
  const goal = "Extract product names";
  const environment = {
    profileId: "shop-staging",
    environmentId: "shop-staging",
    applicationEntryUrl: "https://shop.example.test/",
    authorizedOrigins: ["https://shop.example.test"],
    applications: [{ applicationId: "shop", origin: "https://shop.example.test" }]
  };
  const manifest = {
    capabilityId: "shop_products", capabilityVersion: 1, environmentId: "shop-staging",
    origin: "https://shop.example.test", applicationId: "shop", pagePath: "/products",
    principalId: "local_mcp_automation"
  };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { journal, resultArtifact } = await store.forTask(target, goal);
  const taskId = "task-inferred-artifact-replay";
  await journal.write({
    schemaVersion: 1,
    taskId,
    goal: "[redacted task goal]",
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint: environmentBindingFingerprint(environment),
    requiresGoalInput: true,
    targetId: target.id,
    endpoint: target.endpoint,
    status: "succeeded",
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const capabilityBindings = { shop_products: {
    capabilityVersion: manifest.capabilityVersion,
    environmentId: manifest.environmentId,
    origin: manifest.origin,
    applicationId: manifest.applicationId,
    pagePath: manifest.pagePath,
    principalId: manifest.principalId,
    manifestFingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
  } };
  const intentFingerprint = createHash("sha256").update(JSON.stringify({
    purposeCode: "", outcomeCode: "", cardinality: "unknown", targetRoles: [], constraints: [], requiredCapabilityIds: []
  })).digest("hex");
  await resultArtifact.write({
    schemaVersion: 1,
    taskId,
    targetId: target.id,
    endpoint: target.endpoint,
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint: environmentBindingFingerprint(environment),
    principalId: "local_mcp_automation",
    intentFingerprint,
    capabilityBindings,
    requiredCapabilityIds: ["shop_products"],
    outputs: { shop_products: verifiedProductOutput() },
    createdAt: new Date().toISOString()
  });

  const runState = await createRunStateFixture("activetab-mcp-inferred-artifact-");
  try {
    const replayed = await runMcpGoal({ target, attached: true }, { goal }, {
      journalStore: store,
      environment,
      capabilityRegistry: { list: () => [manifest] },
      authorizeExtractionRelease: () => true,
      runStateStore: runState.store
    });
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.alreadySucceeded, true);
    assert.deepEqual(replayed.workflowOutputs.shop_products.records, [{ name: "Widget" }]);
  } finally {
    await runState.cleanup();
  }
}));

test("MCP journal capacity prunes completed tasks and preserves resumable tasks", async () => withDirectory(async directory => {
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks"), maxEntries: 1 });
  const completed = await store.forTask({ id: "tab-1" }, "Open the completed page");
  await completed.journal.write({ schemaVersion: 1, goal: "[redacted task goal]", targetId: "tab-1", status: "succeeded", attempts: [] });
  await completed.resultArtifact.write({
    schemaVersion: 1, taskId: "completed-task", targetId: "tab-1", endpoint: "local-cdp",
    goalFingerprint: taskGoalFingerprint("Open the completed page"), environmentFingerprint: null,
    principalId: "local_mcp_automation", intentFingerprint: "b".repeat(64),
    capabilityBindings: { products: {
      capabilityVersion: 1, environmentId: "local", origin: "https://shop.example.test",
      applicationId: "shop", pagePath: "/products", principalId: "local_mcp_automation", manifestFingerprint: "d".repeat(64)
    } },
    requiredCapabilityIds: ["products"], outputs: { products: { records: [] } }
  });
  const active = await store.forTask({ id: "tab-2" }, "Open the active page");
  await active.journal.write({ schemaVersion: 1, goal: "[redacted task goal]", targetId: "tab-2", status: "unresolved", attempts: [] });

  await assert.rejects(store.forTask({ id: "tab-3" }, "Open another page"), /capacity.*full of resumable or invalid tasks/);
  assert.equal((await active.journal.read()).status, "unresolved");
  assert.equal(await completed.resultArtifact.read(), null, "pruning a completed journal also removes its released output artifact");
  assert.equal((await readdir(join(directory, "tasks"))).filter(name => name.endsWith(".json")).length, 1);
}));

test("task journals enforce a byte cap and reject unapproved pending-action fields", async () => withDirectory(async directory => {
  const journal = new TaskJournal(join(directory, "task.json"));
  const state = {
    schemaVersion: 1,
    goal: "[redacted task goal]",
    targetId: "target",
    status: "running",
    attempts: [],
    pendingAction: {
      action: "type",
      targetIdentity: "search-field",
      beforeStateFingerprint: "a".repeat(64),
      beforeRouteFingerprint: "b".repeat(64),
      beforeEvidenceId: "evidence",
      startedAt: new Date().toISOString(),
      dispatchDisposition: "uncertain",
      dispatchStatus: "uncertain",
      browserEffectPossible: true,
      retryWithoutReconciliation: false,
      dispatchReasonCode: "dispatch_exception",
      uncertainOutcome: true,
      error: { name: "Error", message: "raw browser error text must stay out of pending metadata" }
    }
  };
  await journal.write(state);
  const persisted = await journal.read();
  assert.equal(persisted.pendingAction.action, "type");
  assert.equal(persisted.pendingAction.dispatchDisposition, "uncertain");
  assert.equal(persisted.pendingAction.dispatchStatus, "uncertain");
  assert.equal(persisted.pendingAction.error, undefined, "free-form exception text is excluded from pending-action metadata");
  await assert.rejects(journal.write({ ...state, unbounded: "x".repeat(65 * 1024) }), /64 KiB local storage limit/);

  await journal.write({ ...state, pendingAction: { ...state.pendingAction, value: "private search phrase" } });
  await assert.rejects(journal.read(), /Task journal is invalid or unsupported/);

  await journal.write({ ...state, pendingAction: { ...state.pendingAction, dispatchReasonCode: "an error with page text" } });
  await assert.rejects(journal.read(), /Task journal is invalid or unsupported/);
}));

test("MCP run_goal survives process termination after dispatch and resumes without repeating the action", { timeout: 15_000 }, async () => withDirectory(async directory => {
  const target = { id: "resume-target", endpoint: "local-cdp", url: "https://shop.example.test/" };
  const goal = "Open the account page";
  const runChild = stage => {
    const storeModule = new URL("../src/state/mcpTaskJournals.js", import.meta.url).href;
    const runStateModule = new URL("../src/testing/runState.js", import.meta.url).href;
    const runnerModule = new URL("../src/mcp/runGoal.js", import.meta.url).href;
    const code = `
      import { writeSync } from "node:fs";
      import { McpTaskJournalStore } from ${JSON.stringify(storeModule)};
      import { RunStateStore } from ${JSON.stringify(runStateModule)};
      import { runMcpGoal } from ${JSON.stringify(runnerModule)};
      const target = { id: "resume-target", endpoint: "local-cdp", url: "https://shop.example.test/" };
      const goal = "Open the account page";
      const workflowIntent = { cardinality: "atomic" };
      const stage = process.env.ACTIVETAB_TEST_STAGE;
      const runStateStore = new RunStateStore(process.env.ACTIVETAB_TEST_RUN_STATE_DIR);
      await runStateStore.init();
      const account = { page: { url: "https://shop.example.test/account", title: "Account" }, headings: [{ level: 1, text: "Account" }], candidates: [] };
      const session = stage === "first" ? {
        target,
        attached: true,
        clicks: 0,
        state: { page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [{ identity: "account-link", targetId: target.id, documentGeneration: 1, backendNodeId: 1, name: "Open account", role: "link", tag: "a", href: "https://shop.example.test/account", visible: true, disabled: false }] },
        async observe() { return { evidenceId: "before-interruption", targetId: target.id, ...structuredClone(this.state) }; },
        async click() { this.clicks++; this.state = account; },
        async waitForChange() { process.exit(73); }
      } : {
        target,
        attached: true,
        async observe() { return { evidenceId: "after-process-restart", targetId: target.id, ...structuredClone(account) }; },
        async click() { throw new Error("A resumed completed navigation must not click again."); },
        async waitForChange() {}
      };
      try {
        const result = await runMcpGoal(session, { goal, workflowIntent, maxActions: 2 }, {
          journalStore: new McpTaskJournalStore({ directory: process.env.ACTIVETAB_TEST_JOURNAL_DIR }),
          runStateStore
        });
        writeSync(1, JSON.stringify(result));
      } finally {
        runStateStore.close();
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        ACTIVETAB_TEST_STAGE: stage,
        ACTIVETAB_TEST_JOURNAL_DIR: join(directory, "tasks"),
        ACTIVETAB_TEST_RUN_STATE_DIR: join(directory, "run-state")
      }
    });
    return child;
  };

  const first = runChild("first");
  assert.equal(first.status, 73, first.stderr || first.error?.message);
  assert.equal(first.stdout, "", "the process should terminate before returning a tool result");

  const interruptedStore = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { journal } = await interruptedStore.forTask(target, goal);
  const interruptedState = await journal.read();
  assert.equal(interruptedState.attempts.length, 0);
  assert.equal(interruptedState.pendingAction.action, "click");
  assert.equal(interruptedState.pendingAction.targetIdentity, "account-link");

  const resumed = runChild("resume");
  assert.equal(resumed.status, 0, resumed.stderr || resumed.error?.message);
  const resumedResult = JSON.parse(resumed.stdout);
  assert.equal(resumedResult.status, "succeeded");
  assert.equal(resumedResult.taskId, interruptedState.taskId);
  assert.equal(resumedResult.resumed, true);
  assert.equal(resumedResult.attempts, 1);

  const alreadySucceeded = runChild("complete");
  assert.equal(alreadySucceeded.status, 0, alreadySucceeded.stderr || alreadySucceeded.error?.message);
  const completedResult = JSON.parse(alreadySucceeded.stdout);
  assert.equal(completedResult.status, "succeeded");
  assert.equal(completedResult.alreadySucceeded, true);
  assert.equal(completedResult.taskId, interruptedState.taskId);
}));

test("MCP run_goal rejects concurrent tasks on the same browser target", async () => withDirectory(async directory => {
  const target = { id: "locked-target", endpoint: "local-cdp" };
  const runState = await createRunStateFixture("activetab-mcp-journal-run-state-");
  let releaseObservation;
  const observationGate = new Promise(resolve => { releaseObservation = resolve; });
  let enteredObservation;
  const observationStarted = new Promise(resolve => { enteredObservation = resolve; });
  const session = {
    target,
    attached: true,
    async observe() {
      enteredObservation();
      await observationGate;
      return { evidenceId: "locked", page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [] };
    }
  };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  try {
    const running = runMcpGoal(session, { goal: "Open the account page" }, { journalStore: store, runStateStore: runState.store });
    await observationStarted;
    await assert.rejects(runMcpGoal(session, { goal: "Open the billing page" }, { journalStore: store, runStateStore: runState.store }), /already active on this browser target/);
    releaseObservation();
    assert.equal((await running).status, "unresolved");
  } finally {
    await runState.cleanup();
  }
}));
