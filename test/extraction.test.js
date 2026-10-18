import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverVisibleNextPage, discoverVisibleTables, resolveVisibleTableRecords } from "../src/extraction/recordResolver.js";
import { discoverVisibleRecordGroups, resolveVisibleRecordGroupRecords } from "../src/extraction/recordGroupResolver.js";
import { normalizeFieldValue, validateExtractionContract } from "../src/extraction/extractionContract.js";
import { verifyExtractionResult } from "../src/extraction/extractionVerifier.js";
import { CapabilityRegistry } from "../src/capabilities/capabilityRegistry.js";
import { discoverTableCapabilities } from "../src/capabilities/capabilityDiscovery.js";
import { compileTableRecipe, compileVisibleExtractionRecipe } from "../src/capabilities/recipeCompiler.js";
import { CapabilityQualifier } from "../src/capabilities/capabilityQualifier.js";
import { CapabilityService } from "../src/capabilities/capabilityService.js";
import { createExtractionFieldPolicy } from "../src/capabilities/fieldPolicy.js";
import { projectExtractionOutput } from "../src/extraction/outputRelease.js";
import { executeExtractionCapability } from "../src/capabilities/recipeExecutor.js";
import { qualifyExtractionManifest } from "../test-lab/fixtures/extractionQualification.js";
import { TestRunner } from "../src/testing/runner.js";
import { validateWorkflow } from "../src/testing/schema.js";

function tableSnapshot(rows, { nextHref = null } = {}) {
  const strings = [];
  const intern = value => { strings.push(value); return strings.length - 1; };
  const nodeName = [];
  const nodeValue = [];
  const textValue = [];
  const parentIndex = [];
  const attributes = [];
  const layoutIndexes = [];
  const add = (tag, parent, text = null) => {
    const index = nodeName.length;
    nodeName.push(intern(tag));
    nodeValue.push(-1);
    textValue.push(text === null ? -1 : intern(text));
    parentIndex.push(parent);
    attributes.push([]);
    if (tag !== "#text") layoutIndexes.push(index);
    return index;
  };
  const html = add("HTML", -1);
  const body = add("BODY", html);
  const table = add("TABLE", body);
  const thead = add("THEAD", table);
  const headerRow = add("TR", thead);
  for (const header of ["Name", "Price"]) {
    const cell = add("TH", headerRow);
    add("#text", cell, header);
  }
  const tbody = add("TBODY", table);
  for (const [name, price] of rows) {
    const row = add("TR", tbody);
    for (const value of [name, price]) {
      const cell = add("TD", row);
      add("#text", cell, value);
    }
  }
  if (nextHref) {
    const link = add("A", body);
    attributes[link] = [intern("rel"), intern("next"), intern("href"), intern(nextHref)];
    add("#text", link, "Next");
  }
  return {
    strings,
    documents: [{
      documentURL: intern("https://shop.example/products"),
      nodes: { nodeName, nodeValue, textValue, parentIndex, attributes },
      layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
    }]
  };
}

function recordGroupSnapshot(records, { containerClass = "mail-list", itemClass = "mail-item", senderClass = "mail-sender", subjectClass = "mail-subject", nextHref = null } = {}) {
  const strings = [];
  const intern = value => { strings.push(value); return strings.length - 1; };
  const nodeName = [];
  const nodeValue = [];
  const textValue = [];
  const parentIndex = [];
  const attributes = [];
  const layoutIndexes = [];
  const add = (tag, parent, text = null, attrs = []) => {
    const index = nodeName.length;
    nodeName.push(intern(tag));
    nodeValue.push(-1);
    textValue.push(text === null ? -1 : intern(text));
    parentIndex.push(parent);
    attributes.push(attrs.flatMap(([name, value]) => [intern(name), intern(value)]));
    if (tag !== "#text") layoutIndexes.push(index);
    return index;
  };
  const html = add("HTML", -1);
  const body = add("BODY", html);
  const list = add("DIV", body, null, [["class", containerClass]]);
  for (const record of records) {
    const row = add("DIV", list, null, [["class", itemClass]]);
    const sender = add("SPAN", row, null, [["class", senderClass]]);
    add("#text", sender, record.sender);
    const subject = add("SPAN", row, null, [["class", subjectClass]]);
    add("#text", subject, record.subject);
  }
  if (nextHref) {
    const link = add("A", body);
    attributes[link] = [intern("rel"), intern("next"), intern("href"), intern(nextHref)];
    add("#text", link, "Next");
  }
  return {
    strings,
    documents: [{
      documentURL: intern("https://mail.example/inbox"),
      nodes: { nodeName, nodeValue, textValue, parentIndex, attributes },
      layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
    }]
  };
}

function candidateAndRecipe(snapshot, { expectedRecords = 2, maxRecords = 10, pagination = undefined, completionPolicy = "exact_count" } = {}) {
  const observation = {
    evidenceId: "observation-1",
    documentGeneration: 1,
    page: { url: "https://shop.example/products", title: "Products" }
  };
  const discovery = discoverTableCapabilities({
    observation,
    domSnapshot: snapshot,
    environmentId: "staging",
    applicationId: "shop",
    principalId: "operator-1"
  });
  assert.equal(discovery.status, "candidate");
  return {
    observation,
    candidate: discovery.candidates[0],
    recipe: compileTableRecipe({
      candidate: discovery.candidates[0],
      capabilityId: "shop.products",
      fields: [
        { name: "name", sourceHeader: "Name", type: "string", required: true },
        { name: "price", sourceHeader: "Price", type: "number", required: true }
      ],
      classifyField: () => "public",
      maxRecords,
      ...(completionPolicy === "pagination_exhausted" ? { completionPolicy } : { expectedRecords, completionPolicy }),
      uniqueBy: ["name"],
      ...(pagination ? { pagination, authorizePagination: () => true } : {})
    })
  };
}

function candidateAndRecordGroupRecipe(snapshot, { expectedRecords = 2, maxRecords = 10, pagination = undefined, completionPolicy = "exact_count" } = {}) {
  const observation = {
    evidenceId: "mail-observation-1",
    documentGeneration: 1,
    page: { url: "https://mail.example/inbox", title: "Inbox" }
  };
  const discovery = discoverTableCapabilities({
    observation,
    domSnapshot: snapshot,
    environmentId: "webarena-infinity-local",
    applicationId: "webarena-infinity-gmail",
    principalId: "fixture-operator"
  });
  const candidate = discovery.candidates.find(item => item.kind === "visible_record_group"
    && item.fields.some(field => field.sourceKey === "mail-sender")
    && item.fields.some(field => field.sourceKey === "mail-subject"));
  assert.ok(candidate, "visible repeated mail rows should be discovered");
  const recipe = compileVisibleExtractionRecipe({
    candidate,
    capabilityId: "webarena.gmail.inbox",
    fields: [
      { name: "sender", sourceKey: "mail-sender", type: "string", required: true },
      { name: "subject", sourceKey: "mail-subject", type: "string", required: true }
    ],
    classifyField: () => "public",
    maxRecords,
    ...(completionPolicy === "exact_count" ? { expectedRecords } : {}),
    completionPolicy,
    uniqueBy: ["subject"],
    ...(pagination ? { pagination, authorizePagination: () => true } : {})
  });
  return { observation, candidate, recipe };
}

async function qualifiedRegistry(candidate) {
  const qualifier = new CapabilityQualifier({
    runQualification: async ({ variants }) => ({
      oracleIndependent: true,
      variants: Array.from({ length: variants }, (_, index) => ({
        scenarioId: `variant-${index}`,
        evidenceRef: `fixture-evidence-${index}`,
        status: "complete",
        schemaMatch: true,
        completenessVerified: true,
        privacyBoundaryPassed: true
      }))
    })
  });
  const result = await qualifier.qualify(candidate, { variants: 3 });
  assert.equal(result.status, "qualified");
  const registry = new CapabilityRegistry();
  await registry.register(result.manifest);
  return registry;
}

test("visible-table discovery returns headers and counts without page records", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  assert.deepEqual(discoverVisibleTables(snapshot), [{ tableIndex: 0, headers: ["Name", "Price"], visibleRowCount: 2 }]);
});

test("pagination discovery accepts only one same-origin same-path rel=next link", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]], { nextHref: "?page=2" });
  const discovered = discoverVisibleTables(snapshot);
  assert.equal(discovered.length, 1);
  assert.deepEqual(discoverVisibleNextPage(snapshot, "https://shop.example/products?page=1"), {
    status: "available",
    url: "https://shop.example/products?page=2"
  });
  const unsafe = tableSnapshot([["Widget A", "1.25"]], { nextHref: "https://elsewhere.example/products?page=2" });
  assert.equal(discoverVisibleNextPage(unsafe, "https://shop.example/products?page=1").status, "not_found");
});

test("extraction contracts require exact counts and typed, classified fields", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]]);
  const { recipe } = candidateAndRecipe(snapshot, { expectedRecords: 1 });
  assert.equal(validateExtractionContract(recipe.extractionContract).valid, true);
  assert.equal(validateExtractionContract({ ...recipe.extractionContract, expectedRecords: undefined }).valid, false);
  assert.deepEqual(normalizeFieldValue("1,234.50", { type: "number", required: true }), { valid: true, value: 1234.5 });
  assert.equal(normalizeFieldValue("12,34", { type: "number", required: true }).valid, false);
});

test("recipe compilation refuses caller-supplied sensitivity labels", () => {
  const observation = { evidenceId: "observation-1", page: { url: "https://shop.example/products" } };
  const discovery = discoverTableCapabilities({
    observation,
    domSnapshot: tableSnapshot([["Widget A", "1.25"]]),
    environmentId: "staging",
    applicationId: "shop",
    principalId: "operator-1"
  });
  assert.throws(() => compileTableRecipe({
    candidate: discovery.candidates[0],
    capabilityId: "shop.products",
    fields: [{ name: "name", sourceHeader: "Name", type: "string", required: true, dataClass: "public" }],
    maxRecords: 1,
    expectedRecords: 1
  }), /trusted field-classification policy/);
});

test("capability registry rejects unqualified recipes and enforces exact application scope", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const registry = new CapabilityRegistry();
  await assert.rejects(() => registry.register(recipe), /fixture-qualified/);
  const unboundRecipe = structuredClone(recipe);
  delete unboundRecipe.principalId;
  delete unboundRecipe.extractionContract.principalId;
  await assert.rejects(() => registry.register(unboundRecipe), /principalId/);
  const qualified = await qualifiedRegistry(recipe);
  assert.ok(qualified.resolve("shop.products", {
    origin: "https://shop.example", environmentId: "staging", applicationId: "shop", principalId: "operator-1"
  }));
  assert.equal(qualified.resolve("shop.products", {
    origin: "https://shop.example", environmentId: "production", applicationId: "shop", principalId: "operator-1"
  }), null);
  assert.equal(qualified.resolve("shop.products", {
    origin: "https://shop.example", environmentId: "staging", applicationId: "shop", principalId: "other-operator"
  }), null);
});

test("Fixture Lab qualifies a recipe across seeded layouts and detects faults", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const result = await new CapabilityQualifier({ runQualification: qualifyExtractionManifest }).qualify(recipe, { variants: 3 });
  assert.equal(result.status, "qualified");
  assert.equal(result.manifest.qualification.variantCount, 3);
  assert.equal(result.manifest.qualification.evidenceRefs.length, 3);
});

test("Fixture Lab qualification exercises non-public field withholding", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const privateFieldRecipe = structuredClone(recipe);
  privateFieldRecipe.extractionContract.fields[0].dataClass = "personal";
  const result = await new CapabilityQualifier({ runQualification: qualifyExtractionManifest }).qualify(privateFieldRecipe, { variants: 3 });
  assert.equal(result.status, "qualified");
  assert.ok(result.manifest.qualification.evidenceRefs.length);
});

test("field policy binds classification and release to exact application scope", () => {
  const policy = createExtractionFieldPolicy([{
    environmentId: "staging",
    applicationId: "shop",
    origin: "https://shop.example",
    sourceHeader: "Name",
    dataClass: "public",
    allowRead: true,
    allowRelease: true
  }]);
  assert.equal(policy.classifyField({ environmentId: "staging", applicationId: "shop", origin: "https://shop.example", sourceHeader: "Name" }), "public");
  assert.equal(policy.classifyField({ environmentId: "production", applicationId: "shop", origin: "https://shop.example", sourceHeader: "Name" }), null);
  assert.equal(policy.authorizeRead({ environmentId: "staging", applicationId: "shop", origin: "https://shop.example", sourceHeader: "Name" }), true);
  assert.equal(policy.authorizeRelease({ environmentId: "staging", applicationId: "shop", origin: "https://shop.example", sourceHeader: "Session token", dataClass: "credential" }), false);
});

test("unapproved extraction fields are withheld and cannot retain complete status", () => {
  const output = {
    scope: { environmentId: "staging", applicationId: "shop", origin: "https://shop.example" },
    schema: { type: "array", items: {
      name: { type: "string", required: true, dataClass: "public" },
      email: { type: "string", required: true, dataClass: "personal" },
      token: { type: "string", required: true, dataClass: "credential" }
    } },
    records: [{ name: "Widget", email: "person@example.com", token: "secret-value" }],
    fieldProvenance: [{ recordIndex: 0, fields: { name: {}, email: {}, token: {} } }],
    completeness: "complete",
    verification: { recordCount: 1 }
  };
  const released = projectExtractionOutput(output, field => (field.dataClass === "public" || field.name === "email") && field.origin === "https://shop.example");
  assert.deepEqual(released.records, [{ name: "Widget", email: "person@example.com" }]);
  assert.equal(released.schema.items.token, undefined);
  assert.equal(released.completeness, "incomplete");
  assert.deepEqual(released.release.omittedFields, ["token"]);
  const publicOnly = projectExtractionOutput(output);
  assert.deepEqual(publicOnly.records, [{ name: "Widget" }]);
  assert.deepEqual(publicOnly.release.omittedFields, ["email", "token"]);
});

test("discovery compiles, Fixture Lab qualifies, and reuses one scoped recipe", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const session = {
    attached: true,
    target: { id: "fixture-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "observation-service", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const environment = { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] };
  const registry = new CapabilityRegistry();
  const service = new CapabilityService({
    registry,
    qualifier: new CapabilityQualifier({ runQualification: qualifyExtractionManifest }),
    classifyField: () => "public"
  });
  const discovered = await service.discover({ session, environment, principalId: "operator-1" });
  assert.equal(discovered.candidates.length, 1);
  const { recipeId, recipe } = service.compile({
    candidateId: discovered.candidates[0].candidateId,
    session,
    environment,
    principalId: "operator-1",
    capabilityId: "shop.products",
    fields: [
      { name: "name", sourceHeader: "Name", type: "string", required: true },
      { name: "price", sourceHeader: "Price", type: "number", required: true }
    ],
    maxRecords: 10,
    expectedRecords: 2,
    uniqueBy: ["name"]
  });
  assert.equal(recipe.qualification.status, "candidate");
  const qualified = await service.qualify(recipeId, { variants: 3, principalId: "operator-1" });
  assert.equal(qualified.status, "qualified");
  assert.ok(registry.resolve("shop.products", { origin: "https://shop.example", environmentId: "staging", applicationId: "shop", principalId: "operator-1" }));
  const result = await service.execute({
    capabilityId: "shop.products",
    registry,
    session,
    environment,
    principalId: "operator-1",
    authorizeField: () => true
  });
  assert.equal(result.status, "available");
  assert.deepEqual(result.records.map(item => item.values), [{ name: "Widget A", price: 1.25 }, { name: "Widget B", price: 2.5 }]);
});

test("qualified capability manifests persist owner-only and reload with their scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-capability-registry-"));
  try {
    const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
    const { recipe } = candidateAndRecipe(snapshot);
    const qualification = await new CapabilityQualifier({ runQualification: qualifyExtractionManifest }).qualify(recipe, { variants: 3 });
    const registry = await new CapabilityRegistry({ directory }).init();
    await registry.register(qualification.manifest);
    const [filename] = await readdir(directory);
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
    const restored = await new CapabilityRegistry({ directory }).init();
    assert.ok(restored.resolve("shop.products", { origin: "https://shop.example", environmentId: "staging", applicationId: "shop", principalId: "operator-1" }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualified repeated-record capabilities persist their observed field mappings for later reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-record-group-registry-"));
  try {
    const records = [
      { sender: "Synthetic Sender A", subject: "Fixture Roadmap A" },
      { sender: "Synthetic Sender B", subject: "Fixture Roadmap B" }
    ];
    const snapshot = recordGroupSnapshot(records);
    const { recipe } = candidateAndRecordGroupRecipe(snapshot);
    const qualified = await new CapabilityQualifier({ runQualification: qualifyExtractionManifest })
      .qualify(recipe, { variants: 3 });
    assert.equal(qualified.status, "qualified");

    const firstRegistry = await new CapabilityRegistry({ directory }).init();
    await firstRegistry.register(qualified.manifest);
    const [filename] = await readdir(directory);
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);

    const restored = await new CapabilityRegistry({ directory }).init();
    const manifest = restored.resolve("webarena.gmail.inbox", {
      origin: "https://mail.example",
      environmentId: "webarena-infinity-local",
      applicationId: "webarena-infinity-gmail",
      principalId: "fixture-operator"
    });
    assert.equal(manifest.kind, "visible_record_group");
    assert.equal(manifest.extractionContract.fields[0].sourceTagName, "SPAN");
    const session = {
      target: { id: "mail-persistent-target" },
      documentGeneration: 1,
      async observe() { return { evidenceId: "mail-persistent-observation", documentGeneration: 1, page: { url: "https://mail.example/inbox" } }; },
      observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
    };
    const result = await executeExtractionCapability({
      capabilityId: "webarena.gmail.inbox",
      registry: restored,
      session,
      environment: {
        environmentId: "webarena-infinity-local",
        applications: [{ applicationId: "webarena-infinity-gmail", origin: "https://mail.example" }]
      },
      principalId: "fixture-operator",
      authorizeField: () => true
    });
    assert.equal(result.status, "available");
    assert.deepEqual(result.records.map(record => record.values), records);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visible rows normalize into typed records with observation provenance", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const resolved = resolveVisibleTableRecords(snapshot, recipe.extractionContract);
  assert.equal(resolved.status, "available");
  assert.deepEqual(resolved.records.map(row => row.values), [
    { name: "Widget A", price: 1.25 },
    { name: "Widget B", price: 2.5 }
  ]);
  assert.equal(resolved.records[0].fieldEvidence.price.validation, "valid");
});

test("observed repeated record groups compile and verify structured outputs without returning discovery values", async () => {
  const records = [
    { sender: "Synthetic Sender A", subject: "Fixture Roadmap A" },
    { sender: "Synthetic Sender B", subject: "Fixture Roadmap B" }
  ];
  const snapshot = recordGroupSnapshot(records);
  const discovered = discoverVisibleRecordGroups(snapshot);
  assert.ok(discovered.some(group => group.recordGroup.itemClassToken === "mail-item"));
  const { recipe } = candidateAndRecordGroupRecipe(snapshot);
  const serializedCandidate = JSON.stringify(discovered);
  assert.equal(serializedCandidate.includes("Synthetic Sender A"), false);
  assert.equal(serializedCandidate.includes("Fixture Roadmap A"), false);
  const resolved = resolveVisibleRecordGroupRecords(snapshot, recipe.extractionContract);
  assert.equal(resolved.status, "available");
  assert.deepEqual(resolved.records.map(item => item.values), records.map(({ sender, subject }) => ({ sender, subject })));
  assert.equal(resolved.records[0].fieldEvidence.sender.method, "visible_record_group_text");

  const capabilityRegistry = await qualifiedRegistry(recipe);
  const session = {
    attached: true,
    target: { id: "mail-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "mail-observation-live", documentGeneration: 1, page: { url: "https://mail.example/inbox", title: "Inbox" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const runner = new TestRunner({
    session,
    environment: { environmentId: "webarena-infinity-local", applications: [{ applicationId: "webarena-infinity-gmail", origin: "https://mail.example" }] },
    principalId: "fixture-operator",
    capabilityRegistry
  });
  const receipt = await runner.run({
    id: "extract-mail",
    name: "Extract visible messages",
    steps: [
      { id: "collect", type: "collect_records", capabilityId: "webarena.gmail.inbox", outputName: "messages" },
      { id: "emit", type: "emit_output", capabilityId: "webarena.gmail.inbox", outputName: "messages" }
    ]
  }, { runId: "mail-extraction-run" });
  assert.equal(receipt.status, "PASSED", JSON.stringify(receipt.toObject()));
  const output = runner.outputResults.messages;
  assert.equal(output.completeness, "complete");
  assert.deepEqual(output.records, records.map(({ sender, subject }) => ({ sender, subject })));
  assert.equal(output.fieldProvenance[0].fields.sender.sourceKey, "mail-sender");
  assert.equal(verifyExtractionResult(output).status, "complete");

  const drifted = recordGroupSnapshot(records, { subjectClass: "mail-subject-drift" });
  const driftedResult = resolveVisibleRecordGroupRecords(drifted, recipe.extractionContract);
  assert.equal(driftedResult.status, "available");
  assert.equal(driftedResult.records.every(record => record.valid), false);
});

test("repeated visible record extraction verifies exact totals across pages and rejects missing, duplicate, and drifted pages", async () => {
  const makeRecords = start => Array.from({ length: 10 }, (_, offset) => ({
    sender: `Sender ${start + offset}`,
    subject: `Message ${start + offset}`
  }));
  const makePages = ({ missingNextAt = -1, duplicateAt = -1, driftAt = -1 } = {}) => Array.from({ length: 10 }, (_, page) => {
    const records = makeRecords(page * 10);
    if (page === duplicateAt) records[0] = { sender: "Sender 0", subject: "Message 0" };
    return recordGroupSnapshot(records, {
      ...(page < 9 && page !== missingNextAt ? { nextHref: `?page=${page + 2}` } : {}),
      ...(page === driftAt ? { subjectClass: "mail-subject-changed" } : {})
    });
  });

  async function runPages(pages, runId) {
    const { recipe } = candidateAndRecordGroupRecipe(pages[0], {
      expectedRecords: 100,
      maxRecords: 100,
      pagination: { kind: "rel_next_same_path", maxPages: 10 }
    });
    const registry = await qualifiedRegistry(recipe);
    let pageIndex = 0;
    const session = {
      attached: true,
      target: { id: `mail-pagination-${runId}` },
      documentGeneration: 1,
      async observe() {
        return {
          evidenceId: `mail-page-${pageIndex}`,
          documentGeneration: 1,
          page: { url: `https://mail.example/inbox?page=${pageIndex + 1}`, title: "Inbox" }
        };
      },
      observer: {
        getEvidence(evidenceId) {
          const index = Number(evidenceId.split("-").at(-1));
          return { status: "available", domSnapshot: pages[index] };
        }
      }
    };
    const runner = new TestRunner({
      session,
      environment: { environmentId: "webarena-infinity-local", applications: [{ applicationId: "webarena-infinity-gmail", origin: "https://mail.example" }] },
      principalId: "fixture-operator",
      capabilityRegistry: registry
    });
    runner.browserStepHandler.executeNavigate = async (step, receipt, startedAt) => {
      pageIndex++;
      receipt.recordStep({ stepId: step.id, type: step.type, status: "PASS", reason: "Scoped pagination was observed.", startedAt });
      return { status: "PASS" };
    };
    const receipt = await runner.run({
      id: "extract-mail-pages",
      name: "Extract mail across pages",
      steps: [
        { id: "collect", type: "collect_records", capabilityId: "webarena.gmail.inbox", outputName: "messages" },
        { id: "emit", type: "emit_output", capabilityId: "webarena.gmail.inbox", outputName: "messages" }
      ]
    }, { runId });
    return { receipt, output: runner.outputResults.messages };
  }

  const complete = await runPages(makePages(), "mail-pages-complete");
  assert.equal(complete.receipt.status, "PASSED", JSON.stringify(complete.receipt.toObject()));
  assert.equal(complete.output.records.length, 100);
  assert.equal(complete.output.completeness, "complete");
  assert.equal(verifyExtractionResult(complete.output).status, "complete");

  const missing = await runPages(makePages({ missingNextAt: 4 }), "mail-pages-missing");
  assert.equal(missing.receipt.status, "FAILED");
  assert.equal(missing.output.completeness, "incomplete");
  assert.equal(missing.output.records.length, 50);

  const duplicated = await runPages(makePages({ duplicateAt: 5 }), "mail-pages-duplicate");
  assert.equal(duplicated.receipt.status, "FAILED");
  assert.equal(duplicated.output.completeness, "incomplete");
  assert.ok(duplicated.output.verification.duplicateKeys > 0);

  const drifted = await runPages(makePages({ driftAt: 4 }), "mail-pages-drift");
  assert.equal(drifted.receipt.status, "FAILED");
  assert.equal(drifted.output.completeness, "incomplete");
  assert.equal(drifted.output.records.length, 100);
  assert.ok(drifted.output.verification.invalidRows > 0);
});

test("runner extracts and emits a verified output only through a qualified capability", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const capabilityRegistry = await qualifiedRegistry(recipe);
  const session = {
    attached: true,
    target: { id: "fixture-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "observation-1", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const runner = new TestRunner({
    session,
    environment: { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
    principalId: "operator-1",
    capabilityRegistry
  });
  const workflow = {
    id: "extract-products",
    name: "Extract products",
    steps: [
      { id: "extract", type: "extract_records", capabilityId: "shop.products", capabilityVersion: 1, outputName: "products" },
      { id: "emit", type: "emit_output", capabilityId: "shop.products", capabilityVersion: 1, outputName: "products" }
    ]
  };
  assert.equal(validateWorkflow(workflow).valid, true);
  const receipt = await runner.run(workflow, { runId: "extract-run-1" });
  assert.equal(receipt.status, "PASSED", JSON.stringify(receipt.toObject()));
  assert.equal(runner.outputResults.products.completeness, "complete");
  assert.equal(verifyExtractionResult(runner.outputResults.products).status, "complete");
  assert.equal(runner.outputResults.products.records.length, 2);
  assert.equal(runner.outputResults.products.fieldProvenance[0].fields.name.observationId, "observation-1");
  const wrongRoute = structuredClone(runner.outputResults.products);
  wrongRoute.fieldProvenance[0].fields.name.pageUrl = "https://elsewhere.example/products";
  assert.equal(verifyExtractionResult(wrongRoute).status, "incomplete");
  const extraField = structuredClone(runner.outputResults.products);
  extraField.records[0].unregistered = "unexpected";
  assert.equal(verifyExtractionResult(extraField).status, "incomplete");

  const deniedReleaseRunner = new TestRunner({
    session,
    environment: { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
    principalId: "operator-1",
    capabilityRegistry,
    authorizeExtractionRelease: () => false
  });
  const deniedReleaseReceipt = await deniedReleaseRunner.run(workflow, { runId: "extract-run-denied-release" });
  assert.equal(deniedReleaseReceipt.status, "FAILED");
  assert.equal(deniedReleaseRunner.outputResults.products.completeness, "incomplete");
});

test("registered extraction refuses route drift within the same origin", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const registry = await qualifiedRegistry(recipe);
  const session = {
    target: { id: "route-target" },
    documentGeneration: 1,
    async observe() { return { evidenceId: "route-evidence", documentGeneration: 1, page: { url: "https://shop.example/admin", title: "Other route" } }; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const result = await executeExtractionCapability({
    capabilityId: "shop.products",
    registry,
    session,
    environment: { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
    principalId: "operator-1",
    authorizeField: () => true
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "capability_route_mismatch");
});

test("runner verifies 100 records across pages and refuses missing, duplicate, and drifted collections", async () => {
  const makeRows = start => Array.from({ length: 10 }, (_, offset) => [`Item ${start + offset}`, String(start + offset + 0.5)]);
  const completePages = Array.from({ length: 10 }, (_, page) => tableSnapshot(makeRows(page * 10)));

  async function runPages(pages, expectedRecords, { changedPage = -1 } = {}) {
    const { candidate, recipe } = candidateAndRecipe(completePages[0], { expectedRecords, maxRecords: 100 });
    const capabilityRegistry = await qualifiedRegistry(recipe);
    let pageIndex = 0;
    const session = {
      attached: true,
      target: { id: "fixture-target" },
      documentGeneration: 1,
      async observe() {
        const index = pageIndex++;
        return {
          evidenceId: `observation-${index}`,
          documentGeneration: 1,
          page: { url: `https://shop.example/products?page=${index}`, title: "Products" }
        };
      },
      observer: {
        getEvidence(evidenceId) {
          const index = Number(evidenceId.split("-").at(-1));
          return { status: "available", domSnapshot: pages[index] };
        }
      }
    };
    if (changedPage >= 0) {
      const changed = tableSnapshot([["Item drifted", "1.00"]]);
      const headerIndex = changed.documents[0].nodes.textValue.findIndex(index => changed.strings[index] === "Name");
      changed.strings[changed.documents[0].nodes.textValue[headerIndex]] = "Display name";
      session.observer.getEvidence = evidenceId => {
        const index = Number(evidenceId.split("-").at(-1));
        return { status: "available", domSnapshot: index === changedPage ? changed : pages[index] };
      };
    }
    const runner = new TestRunner({
      session,
      environment: { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
      principalId: "operator-1",
      capabilityRegistry
    });
    const steps = pages.map((_, index) => ({
      id: `extract-${index}`,
      type: "extract_records",
      capabilityId: "shop.products",
      capabilityVersion: 1,
      outputName: "products"
    }));
    steps.push({ id: "emit", type: "emit_output", capabilityId: "shop.products", capabilityVersion: 1, outputName: "products" });
    const receipt = await runner.run({ id: "pages", name: "Paged extraction", steps }, { runId: `paged-${expectedRecords}-${changedPage}` });
    return { receipt, output: runner.outputResults.products };
  }

  const complete = await runPages(completePages, 100);
  assert.equal(complete.receipt.status, "PASSED");
  assert.equal(complete.output.records.length, 100);
  assert.equal(complete.output.completeness, "complete");
  assert.equal(complete.output.verification.pageCount, 10);

  const missing = await runPages(completePages.slice(0, 9), 100);
  assert.equal(missing.receipt.status, "FAILED");
  assert.equal(missing.output.completeness, "incomplete");
  assert.equal(missing.output.records.length, 90);

  const duplicatedPages = completePages.map((page, index) => index === 5 ? tableSnapshot([["Item 0", "0.5"], ...makeRows(51)]) : page);
  const duplicated = await runPages(duplicatedPages, 100);
  assert.equal(duplicated.receipt.status, "FAILED");
  assert.equal(duplicated.output.completeness, "incomplete");
  assert.ok(duplicated.output.verification.duplicateKeys > 0);

  const drifted = await runPages(completePages, 100, { changedPage: 4 });
  assert.equal(drifted.receipt.status, "FAILED");
  assert.equal(drifted.output.completeness, "incomplete");
  assert.equal(drifted.output.records.length, 40);
});

test("collect_records follows authorized pagination through the browser navigation handler", async () => {
  const rowsForPage = page => Array.from({ length: 10 }, (_, offset) => [`Item ${page * 10 + offset}`, String(page * 10 + offset)]);
  const pages = Array.from({ length: 10 }, (_, index) => tableSnapshot(rowsForPage(index), {
    ...(index < 9 ? { nextHref: `?page=${index + 2}` } : {})
  }));
  const { recipe } = candidateAndRecipe(pages[0], {
    maxRecords: 100,
    pagination: { kind: "rel_next_same_path", maxPages: 10 },
    completionPolicy: "pagination_exhausted"
  });
  const capabilityRegistry = await qualifiedRegistry(recipe);
  let pageIndex = 0;
  const session = {
    attached: true,
    target: { id: "pagination-target" },
    documentGeneration: 1,
    async observe() {
      return {
        evidenceId: `pagination-observation-${pageIndex}`,
        documentGeneration: 1,
        page: { url: `https://shop.example/products?page=${pageIndex + 1}`, title: "Products" }
      };
    },
    observer: {
      getEvidence(evidenceId) {
        const index = Number(evidenceId.split("-").at(-1));
        return { status: "available", domSnapshot: pages[index] };
      }
    }
  };
  const runner = new TestRunner({
    session,
    environment: { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
    principalId: "operator-1",
    capabilityRegistry
  });
  const navigations = [];
  runner.browserStepHandler.executeNavigate = async (step, receipt, startedAt) => {
    navigations.push(step.url);
    pageIndex++;
    receipt.recordStep({ stepId: step.id, type: step.type, status: "PASS", reason: "Authorized navigation was observed.", startedAt });
    return { status: "PASS" };
  };
  const receipt = await runner.run({
    id: "automatic-pagination",
    name: "Automatically paginate and extract",
    steps: [
      { id: "collect", type: "collect_records", capabilityId: "shop.products", capabilityVersion: 1, outputName: "products" },
      { id: "emit", type: "emit_output", capabilityId: "shop.products", capabilityVersion: 1, outputName: "products" }
    ]
  }, { runId: "automatic-pagination-run" });
  assert.equal(receipt.status, "PASSED", JSON.stringify(receipt.toObject()));
  assert.equal(navigations.length, 9);
  assert.equal(runner.outputResults.products.records.length, 100);
  assert.equal(runner.outputResults.products.verification.pageCount, 10);
  assert.equal(runner.outputResults.products.verification.paginationExhausted, true);
  assert.equal(runner.outputResults.products.completeness, "complete");
  assert.ok(navigations.every(url => url.startsWith("https://shop.example/products?page=")));
  assert.ok(receipt.steps.filter(step => step.type === "navigate").every(step => !String(step.reason).includes("?page=")));
});

test("missing rows, duplicate keys, and invalid layouts cannot produce complete outputs", () => {
  const snapshot = tableSnapshot([["Widget A", "bad"], ["Widget A", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const resolved = resolveVisibleTableRecords(snapshot, recipe.extractionContract);
  assert.equal(resolved.records[0].valid, false);
  assert.equal(resolved.records[0].fieldEvidence.price.validation, "invalid");
});

test("workflow requires extraction output finalization", () => {
  const workflow = {
    id: "unfinished-extraction",
    name: "Unfinished extraction",
    steps: [{ id: "extract", type: "extract_records", capabilityId: "shop.products", outputName: "products" }]
  };
  const result = validateWorkflow(workflow);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("emit_output")));
});
