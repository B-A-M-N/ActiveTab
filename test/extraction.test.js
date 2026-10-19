import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPageNumberQueryParameters, discoverVirtualizedListScrollTarget, discoverVisibleNextPage, discoverVisibleTables, discoverVisibleTableSources, resolveVisibleTableRecords } from "../src/extraction/recordResolver.js";
import { discoverVisibleRecordGroups, resolveVisibleRecordGroupRecords } from "../src/extraction/recordGroupResolver.js";
import { buildDocumentIndex } from "../src/observe/documentIndex.js";
import { buildEphemeralCurrentOriginBinding } from "../src/environments/model.js";
import { compileSemanticPageModel } from "../src/observe/semanticPageCompiler.js";
import { normalizeFieldValue, validateExtractionContract } from "../src/extraction/extractionContract.js";
import { verifyExtractionResult, verifyObservedPartialExtractionResult } from "../src/extraction/extractionVerifier.js";
import { CapabilityRegistry } from "../src/capabilities/capabilityRegistry.js";
import { discoverTableCapabilities } from "../src/capabilities/capabilityDiscovery.js";
import { compileTableRecipe, compileVisibleExtractionRecipe } from "../src/capabilities/recipeCompiler.js";
import { CapabilityQualifier } from "../src/capabilities/capabilityQualifier.js";
import { validateSiteCapabilityManifest } from "../src/capabilities/siteCapabilityManifest.js";
import { CapabilityService } from "../src/capabilities/capabilityService.js";
import { createExtractionFieldPolicy } from "../src/capabilities/fieldPolicy.js";
import { projectExtractionOutput } from "../src/extraction/outputRelease.js";
import { executeExtractionCapability } from "../src/capabilities/recipeExecutor.js";
import { createExtractionWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { WorkflowGraphPlanner } from "../src/navigation/workflowPlanner.js";
import { qualifyExtractionManifest } from "../test-lab/fixtures/extractionQualification.js";
import { TestRunner } from "../src/testing/runner.js";
import { validateWorkflow } from "../src/testing/schema.js";

function tableSnapshot(rows, { nextHref = null, nestedCellText = null, headers = ["Name", "Price"] } = {}) {
  const strings = [];
  const intern = value => { strings.push(value); return strings.length - 1; };
  const nodeName = [];
  const nodeValue = [];
  const textValue = [];
  const parentIndex = [];
  const attributes = [];
  const backendNodeId = [];
  const layoutIndexes = [];
  const add = (tag, parent, text = null) => {
    const index = nodeName.length;
    nodeName.push(intern(tag));
    nodeValue.push(-1);
    textValue.push(text === null ? -1 : intern(text));
    parentIndex.push(parent);
    attributes.push([]);
    backendNodeId.push(index + 1);
    if (tag !== "#text") layoutIndexes.push(index);
    return index;
  };
  const html = add("HTML", -1);
  const body = add("BODY", html);
  const table = add("TABLE", body);
  const thead = add("THEAD", table);
  const headerRow = add("TR", thead);
  for (const header of headers) {
    const cell = add("TH", headerRow);
    add("#text", cell, header);
  }
  const tbody = add("TBODY", table);
  for (const [rowIndex, values] of rows.entries()) {
    const row = add("TR", tbody);
    for (const [columnIndex, value] of values.entries()) {
      const cell = add("TD", row);
      add("#text", cell, value);
      if (nestedCellText && rowIndex === 0 && columnIndex === 0) {
        const nestedTable = add("TABLE", cell);
        const nestedRow = add("TR", nestedTable);
        const nestedCell = add("TD", nestedRow);
        add("#text", nestedCell, nestedCellText);
      }
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
      nodes: { nodeName, nodeValue, textValue, parentIndex, attributes, backendNodeId },
      layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
    }]
  };
}

function recordGroupSnapshot(records, { containerClass = "mail-list", itemClass = "mail-item", senderClass = "mail-sender", subjectClass = "mail-subject", fieldClasses = {}, nextHref = null } = {}) {
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
    const fields = record.fields
      ? Object.entries(record.fields).map(([key, value]) => [key, value, fieldClasses[key] ?? key])
      : [["sender", record.sender, senderClass], ["subject", record.subject, subjectClass]];
    for (const [_key, value, className] of fields) {
      const field = add("SPAN", row, null, [["class", className]]);
      add("#text", field, value);
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

test("synthesized extraction handles execute only a registered exact-scope read and release verified output", async () => {
  const snapshot = tableSnapshot([["Widget", "1.25"], ["Gadget", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot, { expectedRecords: 2 });
  const registry = await qualifiedRegistry(recipe);
  const session = {
    attached: true,
    target: { id: "workflow-extraction-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "workflow-extraction-observation", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const environment = {
    environmentId: "staging",
    authorizedOrigins: ["https://shop.example"],
    applications: [{ applicationId: "shop", origin: "https://shop.example" }]
  };
  const capabilityOptions = {
    registry,
    session,
    environment,
    principalId: "operator-1",
    authorizeField: () => true,
    authorizeRelease: field => field.dataClass === "public"
  };
  const [capability] = createExtractionWorkflowCapabilities(capabilityOptions);
  assert.equal(capability.id, "shop.products");
  assert.equal(capability.action, "extract");
  assert.deepEqual(capability.outputSchema, [
    { name: "name", type: "string", required: true },
    { name: "price", type: "number", required: true }
  ]);
  const result = await capability.execute();
  assert.equal(result.status, "verified");
  assert.deepEqual(result.output.records, [{ name: "Widget", price: 1.25 }, { name: "Gadget", price: 2.5 }]);
  assert.equal(verifyExtractionResult(result.output).status, "complete");
  assert.equal(verifyExtractionResult({
    ...result.output,
    verification: { ...result.output.verification, overflow: true }
  }).status, "incomplete", "complete extraction still rejects record-limit overflow");

  const wrongPrincipal = createExtractionWorkflowCapabilities({ ...capabilityOptions, principalId: "another-operator" });
  assert.deepEqual(wrongPrincipal, [], "other principals do not see this capability handle");
  const withheld = createExtractionWorkflowCapabilities({ ...capabilityOptions, authorizeRelease: () => false })[0];
  const deniedRelease = await withheld.execute();
  assert.equal(deniedRelease.status, "failed");
  assert.equal(deniedRelease.reasonCode, "extraction_release_incomplete");
  assert.equal(Object.hasOwn(deniedRelease, "output"), false, "withheld fields are not returned as workflow output");
});

test("synthesized extraction uses the shared collector for registered pagination and requires a non-empty explicit terminal page", async () => {
  const snapshots = [
    tableSnapshot([["Widget A", "1.25"]], { nextHref: "?page=2" }),
    tableSnapshot([["Widget B", "2.50"]])
  ];
  const { recipe } = candidateAndRecipe(snapshots[0], {
    maxRecords: 10,
    completionPolicy: "pagination_exhausted",
    pagination: { kind: "rel_next_same_path", maxPages: 4 }
  });
  const registry = await qualifiedRegistry(recipe);
  let pageIndex = 0;
  const session = {
    attached: true,
    target: { id: "workflow-paged-target" },
    documentGeneration: 1,
    async observe() {
      return {
        evidenceId: `workflow-paged-observation-${pageIndex}`,
        documentGeneration: 1,
        targetId: this.target.id,
        page: { url: `https://shop.example/products?page=${pageIndex + 1}`, title: "Products" }
      };
    },
    observer: {
      getEvidence(evidenceId) {
        const index = Number(evidenceId.split("-").at(-1));
        return { status: "available", domSnapshot: snapshots[index] };
      }
    }
  };
  const environment = {
    environmentId: "staging",
    authorizedOrigins: ["https://shop.example"],
    applications: [{ applicationId: "shop", origin: "https://shop.example" }]
  };
  const navigationCalls = [];
  const [capability] = createExtractionWorkflowCapabilities({
    registry,
    session,
    environment,
    principalId: "operator-1",
    authorizeField: () => true,
    authorizeRelease: field => field.dataClass === "public",
    assertExecutionLease: async () => {},
    advancePage: async ({ url, fromPageUrl }) => {
      navigationCalls.push({ url, fromPageUrl });
      pageIndex++;
      return { status: "verified" };
    }
  });
  assert.ok(capability, "the trusted paginated manifest is exposed as an extraction capability");
  const result = await capability.execute();
  assert.equal(result.status, "verified");
  assert.equal(result.output.completeness, "complete");
  assert.deepEqual(result.output.records, [{ name: "Widget A", price: 1.25 }, { name: "Widget B", price: 2.5 }]);
  assert.equal(result.output.verification.pageCount, 2);
  assert.equal(result.output.verification.paginationExhausted, true);
  assert.deepEqual(navigationCalls, [{
    url: "https://shop.example/products?page=2",
    fromPageUrl: "https://shop.example/products?page=1"
  }]);

  const emptySnapshots = [snapshots[0], tableSnapshot([])];
  const emptyRegistry = await qualifiedRegistry(recipe);
  pageIndex = 0;
  session.observer.getEvidence = evidenceId => {
    const index = Number(evidenceId.split("-").at(-1));
    return { status: "available", domSnapshot: emptySnapshots[index] };
  };
  const [emptyCapability] = createExtractionWorkflowCapabilities({
    registry: emptyRegistry,
    session,
    environment,
    principalId: "operator-1",
    authorizeField: () => true,
    authorizeRelease: () => true,
    assertExecutionLease: async () => {},
    advancePage: async () => { pageIndex++; return { status: "verified" }; }
  });
  const emptyResult = await emptyCapability.execute();
  assert.equal(emptyResult.status, "failed");
  assert.equal(emptyResult.reasonCode, "empty_terminal_page_not_proof_of_exhaustion");
  assert.equal(Object.hasOwn(emptyResult, "output"), false);
});

test("registered collection checkpoints resume after an interrupted page advance without duplicating saved rows", async () => {
  const snapshots = [
    tableSnapshot([["Widget A", "1.25"]], { nextHref: "?page=2" }),
    tableSnapshot([["Widget B", "2.50"]])
  ];
  const { recipe } = candidateAndRecipe(snapshots[0], {
    maxRecords: 10,
    completionPolicy: "pagination_exhausted",
    pagination: { kind: "rel_next_same_path", maxPages: 4 }
  });
  const registry = await qualifiedRegistry(recipe);
  let pageIndex = 0;
  const session = {
    attached: true,
    target: { id: "workflow-resume-target", endpoint: "fixture" },
    documentGeneration: 1,
    async observe() {
      return {
        evidenceId: `workflow-resume-observation-${pageIndex}`,
        documentGeneration: 1,
        targetId: this.target.id,
        page: { url: `https://shop.example/products?page=${pageIndex + 1}`, title: "Products" }
      };
    },
    observer: {
      getEvidence(evidenceId) {
        const index = Number(evidenceId.split("-").at(-1));
        return { status: "available", domSnapshot: snapshots[index] };
      }
    }
  };
  const environment = {
    environmentId: "staging",
    authorizedOrigins: ["https://shop.example"],
    applications: [{ applicationId: "shop", origin: "https://shop.example" }]
  };
  let checkpoint;
  const options = {
    registry,
    session,
    environment,
    principalId: "operator-1",
    authorizeField: () => true,
    authorizeRelease: () => true,
    assertExecutionLease: async () => {},
    persistCheckpoint: async value => { checkpoint = structuredClone(value); }
  };
  const [firstCapability] = createExtractionWorkflowCapabilities({
    ...options,
    advancePage: async () => {
      pageIndex = 1; // Navigation reached page two, then its confirmation was interrupted.
      return { status: "uncertain", reasonCode: "simulated_interruption" };
    }
  });
  const interrupted = await firstCapability.execute();
  assert.equal(interrupted.status, "uncertain");
  assert.ok(checkpoint, "the released page-one batch was checkpointed before navigation");
  assert.deepEqual(checkpoint.output.records, [{ name: "Widget A", price: 1.25 }]);
  assert.equal(checkpoint.pageCount, 1);
  assert.equal(checkpoint.nextPageStatus, "available");
  assert.equal(JSON.stringify(checkpoint).includes("?page=2"), false, "cursor URLs are not persisted in the checkpoint");

  const [resumedCapability] = createExtractionWorkflowCapabilities({
    ...options,
    resumeCheckpoint: checkpoint,
    advancePage: async () => { throw new Error("the browser is already on the checkpoint's next page"); }
  });
  const resumed = await resumedCapability.execute();
  assert.equal(resumed.status, "verified", JSON.stringify(resumed));
  assert.deepEqual(resumed.output.records, [
    { name: "Widget A", price: 1.25 },
    { name: "Widget B", price: 2.5 }
  ]);
  assert.equal(resumed.output.verification.pageCount, 2);
  assert.equal(resumed.output.verification.paginationProgress.progressVerified, true);
  assert.equal(resumed.output.verification.paginationProgress.completeness, "complete");
});

test("visible-table discovery returns headers and counts without page records", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  assert.deepEqual(discoverVisibleTables(snapshot), [{ tableIndex: 0, headers: ["Name", "Price"], visibleRowCount: 2 }]);
});

test("shared observation index preserves table, record-group, and pagination resolver output", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]], { nextHref: "?page=2" });
  const index = buildDocumentIndex(snapshot);
  const groupsSnapshot = recordGroupSnapshot([{ sender: "Alerts", subject: "One" }, { sender: "Ops", subject: "Two" }]);
  const groupsIndex = buildDocumentIndex(groupsSnapshot);

  assert.deepEqual(discoverVisibleTables(snapshot, { index }), discoverVisibleTables(snapshot));
  assert.deepEqual(discoverVisibleTableSources(snapshot, { maxRecords: 1, index }), discoverVisibleTableSources(snapshot, { maxRecords: 1 }));
  assert.deepEqual(discoverVisibleRecordGroups(groupsSnapshot, { index: groupsIndex }), discoverVisibleRecordGroups(groupsSnapshot));
  assert.deepEqual(discoverVisibleNextPage(snapshot, "https://shop.example/products?page=1", { index }), discoverVisibleNextPage(snapshot, "https://shop.example/products?page=1"));
  assert.throws(() => discoverVisibleTables(tableSnapshot([]), { index }), /exact source snapshot/u);
});

test("semantic table sources retain exact DOM locators and bound row content without changing public discovery", () => {
  const snapshot = tableSnapshot(Array.from({ length: 80 }, (_, index) => ["Item " + index, "Price " + index]));
  snapshot.documents[0].nodes.backendNodeId = snapshot.documents[0].nodes.nodeName.map((_, index) => index + 100);
  const source = discoverVisibleTableSources(snapshot)[0];
  const tableNodeIndex = snapshot.documents[0].nodes.nodeName.findIndex(index => snapshot.strings[index] === "TABLE");

  assert.equal(source.documentIndex, 0);
  assert.equal(source.nodeIndex, tableNodeIndex);
  assert.equal(source.backendNodeId, snapshot.documents[0].nodes.backendNodeId[tableNodeIndex]);
  assert.equal(source.visibleRowCount, 80);
  assert.equal(source.rows.length, 64);
  assert.equal(source.rows[63].cells[0].value, "Item 63");
  assert.equal(JSON.stringify(source).includes("Item 64"), false);
  assert.deepEqual(Object.keys(discoverVisibleTables(snapshot)[0]), ["tableIndex", "headers", "visibleRowCount"]);
});

test("nested table cells do not shift outer table columns during extraction", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]], { nestedCellText: "nested detail" });
  const { recipe } = candidateAndRecipe(snapshot, { expectedRecords: 1 });

  const resolved = resolveVisibleTableRecords(snapshot, recipe.extractionContract);
  assert.equal(resolved.status, "available");
  assert.deepEqual(resolved.records.map(row => row.values), [
    { name: "Widget A nested detail", price: 1.25 }
  ]);
  assert.equal(resolved.records[0].fieldEvidence.price.validation, "valid");
});

test("pagination discovery accepts only one same-origin same-path rel=next link", () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]], { nextHref: "?page=2" });
  const discovered = discoverVisibleTables(snapshot);
  assert.equal(discovered.length, 1);
  assert.deepEqual(discoverVisibleNextPage(snapshot, "https://shop.example/products?page=1"), {
    status: "available",
    url: "https://shop.example/products?page=2",
    kind: "rel_next_same_path"
  });
  assert.deepEqual(discoverVisibleNextPage(snapshot, "https://shop.example/products?page=1", { kind: "page_number_query", queryParameter: "page" }), {
    status: "available", url: "https://shop.example/products?page=2", kind: "page_number_query"
  });
  assert.deepEqual(discoverPageNumberQueryParameters(snapshot, "https://shop.example/products?page=1"), ["page"]);
  const explicit = structuredClone(snapshot);
  const document = explicit.documents[0];
  const linkIndex = document.nodes.nodeName.length;
  explicit.strings.push("A", "aria-label", "Next page", "href", "?page=2");
  document.nodes.nodeName.push(explicit.strings.length - 5);
  document.nodes.nodeValue.push(-1);
  document.nodes.textValue.push(-1);
  document.nodes.parentIndex.push(1);
  document.nodes.attributes.push([explicit.strings.length - 4, explicit.strings.length - 3, explicit.strings.length - 2, explicit.strings.length - 1]);
  document.nodes.backendNodeId.push(500);
  document.layout.nodeIndex.push(linkIndex);
  document.layout.bounds.push([0, 25, 30, 10]);
  assert.deepEqual(discoverVisibleNextPage(explicit, "https://shop.example/products?page=1", { kind: "explicit_next_same_path" }), {
    status: "available", url: "https://shop.example/products?page=2", kind: "explicit_next_same_path"
  });
  const explicitButton = structuredClone(snapshot);
  const buttonDocument = explicitButton.documents[0];
  const buttonIndex = buttonDocument.nodes.nodeName.length;
  explicitButton.strings.push("BUTTON", "aria-label", "Next page");
  buttonDocument.nodes.nodeName.push(explicitButton.strings.length - 3);
  buttonDocument.nodes.nodeValue.push(-1);
  buttonDocument.nodes.textValue.push(-1);
  buttonDocument.nodes.parentIndex.push(1);
  buttonDocument.nodes.attributes.push([explicitButton.strings.length - 2, explicitButton.strings.length - 1]);
  buttonDocument.nodes.backendNodeId.push(501);
  buttonDocument.layout.nodeIndex.push(buttonIndex);
  buttonDocument.layout.bounds.push([0, 25, 30, 10]);
  assert.deepEqual(discoverVisibleNextPage(explicitButton, "https://shop.example/products?page=1", { kind: "explicit_next_same_path" }), {
    status: "available", kind: "explicit_next_same_path", action: "click",
    target: { frameId: "unknown", backendNodeId: 501, tag: "button" }
  });
  const table = resolveVisibleTableRecords(snapshot, candidateAndRecipe(snapshot).recipe.extractionContract);
  const scrollObservation = {
    targetId: "tab", documentGeneration: 2, coverage: { scrollTargets: true },
    scrollTargets: [{
      identity: "list-scroll", targetId: "tab", documentGeneration: 2, visible: true, canScrollDown: true,
      frameTargetId: null, scrollTop: 0, maxScrollTop: 100, bounds: { x: 0, y: 0, width: 200, height: 200 }
    }]
  };
  assert.deepEqual(discoverVirtualizedListScrollTarget(scrollObservation, table.evidence[0].bounds), {
    status: "available", identity: "list-scroll", beforeScrollTop: 0, maxScrollTop: 100
  });
  const unsafe = tableSnapshot([["Widget A", "1.25"]], { nextHref: "https://elsewhere.example/products?page=2" });
  assert.equal(discoverVisibleNextPage(unsafe, "https://shop.example/products?page=1").status, "unavailable");
  const incompleteEvidence = discoverVisibleNextPage(null, "https://shop.example/products?page=1");
  assert.deepEqual(incompleteEvidence, { status: "unavailable", reasonCode: "pagination_dom_evidence_unavailable" });
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
  assert.equal(result.manifest.qualification.level, "resolver");
  assert.equal(result.manifest.qualification.independentApplicationOutcome, false);
  assert.equal(result.manifest.qualification.scenarioSeed, 0);
  assert.equal(result.manifest.qualification.variantCount, 3);
  assert.equal(result.manifest.qualification.evidenceRefs.length, 3);
});

test("resolver qualification cannot be promoted by adapter-supplied application or live claims", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const { recipe } = candidateAndRecipe(snapshot);
  const qualifier = new CapabilityQualifier({
    runQualification: async ({ variants }) => ({
      level: "live",
      independentApplicationOutcome: true,
      oracleIndependent: true,
      variants: Array.from({ length: variants }, (_, index) => ({
        scenarioId: `variant-${index}`, evidenceRef: `fixture-evidence-${index}`, status: "complete",
        schemaMatch: true, completenessVerified: true, privacyBoundaryPassed: true
      }))
    })
  });
  const result = await qualifier.qualify(recipe, { variants: 3 });
  assert.equal(result.status, "qualified");
  assert.equal(result.manifest.qualification.level, "resolver");
  assert.equal(result.manifest.qualification.independentApplicationOutcome, false);
  const forged = structuredClone(result.manifest);
  forged.qualification.level = "outcome";
  forged.qualification.independentApplicationOutcome = true;
  const forgedOutcome = validateSiteCapabilityManifest(forged, { requireQualified: true });
  assert.equal(forgedOutcome.valid, false);
  assert.ok(forgedOutcome.errors.some(error => /application outcomes require a separate benchmark receipt/u.test(error)));
  forged.qualification.level = "resolver";
  const forgedResolver = validateSiteCapabilityManifest(forged, { requireQualified: true });
  assert.equal(forgedResolver.valid, false);
  assert.ok(forgedResolver.errors.some(error => /cannot claim an independent application outcome/u.test(error)));
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

test("unprofiled public-read policy requires exact public sources and explicit read and release grants", () => {
  const policy = createExtractionFieldPolicy([], [], [{
    origin: "https://catalog.example",
    sourceHeader: "Name",
    dataClass: "public",
    allowRead: true,
    allowRelease: true
  }]);
  const allowed = { origin: "https://catalog.example", sourceHeader: "Name" };
  assert.equal(policy.classifyPublicField(allowed), "public");
  assert.equal(policy.authorizePublicRead(allowed), true);
  assert.equal(policy.authorizePublicRelease(allowed), true);
  assert.equal(policy.classifyPublicField({ ...allowed, origin: "https://other.example" }), null);
  assert.equal(policy.classifyPublicField({ ...allowed, sourceHeader: "Email" }), null);
  assert.throws(() => createExtractionFieldPolicy([], [], [{
    origin: "https://catalog.example/path",
    sourceHeader: "Name",
    dataClass: "public",
    allowRead: true,
    allowRelease: true
  }]), /exact HTTP\(S\) origins/u);
  assert.throws(() => createExtractionFieldPolicy([], [], [{
    origin: "https://catalog.example",
    sourceHeader: "Email",
    dataClass: "personal",
    allowRead: true,
    allowRelease: true
  }]), /public classification/u);
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
      return { evidenceId: "observation-service", targetId: "fixture-target", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const environment = { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] };
  const registry = new CapabilityRegistry();
  const service = new CapabilityService({
    registry,
    qualifier: new CapabilityQualifier({ runQualification: qualifyExtractionManifest }),
    classifyField: () => "public"
  });
  const discovered = await service.discover({ session, environment, principalId: "operator-1" });
  assert.equal(discovered.candidates.length, 1);
  const { recipeId, recipe } = await service.compile({
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
  const qualified = await service.qualify(recipeId, { variants: 3, session, environment, principalId: "operator-1" });
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

test("ephemeral extraction returns typed observed rows without promoting an incomplete read", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  const session = {
    attached: true,
    target: { id: "ephemeral-read-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "ephemeral-read-observation", targetId: "ephemeral-read-target", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const environment = { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] };
  const service = new CapabilityService({
    classifyField: () => "public",
    authorizeRead: () => true,
    authorizeRelease: () => true
  });
  const discovered = await service.discover({ session, environment, principalId: "operator-1" });
  assert.equal(discovered.status, "candidate");
  const result = await service.readObservedRecords({
    session,
    environment,
    principalId: "operator-1",
    candidateId: discovered.candidates[0].candidateId,
    requestedFields: [
      { name: "name", sourceHeader: "Name", type: "string", required: true },
      { name: "price", sourceHeader: "Price", type: "number", required: true }
    ],
    maxRecords: 10,
    uniqueBy: ["name"]
  });
  assert.equal(result.status, "observed_partial");
  assert.equal(result.completeness, "observed_partial");
  assert.equal(result.reasonCode, "collection_completeness_not_established");
  assert.deepEqual(result.records, [{ name: "Widget A", price: 1.25 }, { name: "Widget B", price: 2.5 }]);
  assert.equal(result.output.verification.completenessClaimed, false);
  assert.equal(result.output.verification.completionPolicy, "observed_only");
  assert.equal(result.output.verification.evidenceIds[0], "ephemeral-read-observation");
  assert.equal(result.candidateId, discovered.candidates[0].candidateId, "a selected discovery candidate remains bound through the fresh read");
  assert.equal(service.registry, undefined, "an ephemeral read does not register or persist a reusable capability");
  const rebound = await service.readObservedRecords({
    session: { ...session, target: { id: "different-target" } },
    environment,
    principalId: "operator-1",
    candidateId: discovered.candidates[0].candidateId,
    requestedFields: [{ name: "name", sourceHeader: "Name", type: "string", required: true }]
  });
  assert.equal(rebound.status, "blocked", "a discovery candidate cannot be rebound to another authorized tab");
  assert.equal(rebound.reasonCode, "observed_source_expired_or_scope_mismatch");
});

test("ephemeral extraction blocks when the trusted read policy denies a requested field", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]]);
  const session = {
    attached: true,
    target: { id: "ephemeral-read-denied-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "ephemeral-read-denied-observation", targetId: "ephemeral-read-denied-target", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const environment = { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] };
  const service = new CapabilityService({
    classifyField: () => "personal",
    authorizeRead: () => false,
    authorizeRelease: () => false
  });
  const result = await service.readObservedRecords({
    session, environment, principalId: "operator-1",
    requestedFields: [{ name: "name", sourceHeader: "Name", type: "string", required: true }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "field_read_policy_denied");
  assert.deepEqual(result.records, []);
});

test("unprofiled public one-shot reads are query-bound, allowlisted, and never release query values", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"], ["Widget B", "2.50"]]);
  let currentUrl = "https://catalog.example/search?q=widget&page=1";
  let observationNumber = 0;
  const session = {
    attached: true,
    target: { id: "public-read-target" },
    documentGeneration: 4,
    async observe() {
      observationNumber++;
      return {
        evidenceId: `public-read-observation-${observationNumber}`,
        targetId: "public-read-target",
        documentGeneration: 4,
        page: { url: "https://catalog.example/search", title: "Public catalog" }
      };
    },
    observer: { getEvidence(_id, options = {}) {
      if (options.facets?.includes("page")) return { status: "available", page: { url: currentUrl } };
      return { status: "available", domSnapshot: snapshot };
    } }
  };
  const fieldPolicy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: fieldPolicy.classifyPublicField,
    authorizePublicRead: fieldPolicy.authorizePublicRead,
    authorizePublicRelease: fieldPolicy.authorizePublicRelease
  });
  const discovered = await service.discover({ session, principalId: "operator-1" });
  assert.equal(discovered.status, "candidate");
  assert.equal(discovered.candidates.length, 1);
  assert.equal(new URL((await session.observe()).page.url).search, "", "the public observation continues to redact query parameters");
  assert.equal(JSON.stringify(discovered).includes("q=widget"), false, "discovery metadata does not expose the query string");
  const result = await service.readObservedRecords({
    session,
    principalId: "operator-1",
    candidateId: discovered.candidates[0].candidateId,
    requestedFields: [
      { name: "name", sourceHeader: "Name", type: "string", required: true },
      { name: "price", sourceHeader: "Price", type: "number", required: true }
    ],
    maxRecords: 10
  });
  assert.equal(result.status, "observed_partial");
  assert.deepEqual(result.records, [{ name: "Widget A", price: 1.25 }, { name: "Widget B", price: 2.5 }]);
  assert.equal(JSON.stringify(result).includes("q=widget"), false, "the query string is not copied into the read result");
  assert.equal(service.registry, undefined, "one-shot public reads never create a reusable capability");

  currentUrl = "https://catalog.example/search?q=another-query&page=1";
  const stale = await service.readObservedRecords({
    session,
    principalId: "operator-1",
    candidateId: discovered.candidates[0].candidateId,
    requestedFields: [{ name: "name", sourceHeader: "Name", type: "string", required: true }]
  });
  assert.equal(stale.status, "incomplete");
  assert.equal(stale.reasonCode, "observed_route_changed");
  assert.deepEqual(stale.records, []);
});

test("operator-authorized current-origin scope can use the exact public-read allowlist", async () => {
  const snapshot = tableSnapshot([
    ["Widget A", "$1.25"],
    ["Widget B", "$2.50"]
  ]);
  const targetId = "current-origin-public-read-target";
  const environment = buildEphemeralCurrentOriginBinding("https://catalog.example/search?q=widget");
  const currentUrl = "https://catalog.example/search?q=widget";
  const observation = {
    evidenceId: "current-origin-public-read-evidence",
    targetId,
    documentGeneration: 3,
    page: { url: "https://catalog.example/search", title: "Widget catalog" }
  };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration: 3,
    async observe() { return observation; },
    observer: { getEvidence(_evidenceId, options = {}) {
      if (options.facets?.includes("page")) return { status: "available", page: { url: currentUrl } };
      return { status: "available", domSnapshot: snapshot };
    } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });

  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session,
    environment,
    principalId: "operator-1",
    observation,
    goal: "Read the product names and prices"
  });
  assert.ok(capability, "the synthetic current-origin application uses public field policy, not an absent profile policy");
  const result = await capability.execute();
  assert.equal(result.status, "verified");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.output.records, [
    { name: "Widget A", price: "$1.25" },
    { name: "Widget B", price: "$2.50" }
  ]);
  assert.equal(JSON.stringify(result).includes("q=widget"), false);
});

test("one-shot extraction without a candidate reuses its discovery observation", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]]);
  let observationCount = 0;
  const session = {
    attached: true,
    target: { id: "public-read-single-observation-target" },
    documentGeneration: 7,
    async observe() {
      observationCount++;
      return {
        evidenceId: `public-read-single-observation-${observationCount}`,
        targetId: "public-read-single-observation-target",
        documentGeneration: 7,
        page: { url: "https://catalog.example/search?q=widget", title: "Public catalog" }
      };
    },
    observer: { getEvidence(evidenceId) {
      return { status: "available", evidenceId, domSnapshot: snapshot };
    } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const result = await service.readObservedRecords({
    session,
    principalId: "operator-1",
    requestedFields: [{ name: "name", sourceHeader: "Name", type: "string", required: true }]
  });
  assert.equal(result.status, "observed_partial");
  assert.deepEqual(result.records, [{ name: "Widget A" }]);
  assert.equal(observationCount, 1, "discovery and extraction share one fresh immutable observation");
  assert.deepEqual(result.evidenceRefs, ["public-read-single-observation-1"]);
});

test("ordinary read goals receive only an exact-policy ephemeral table capability", async () => {
  const snapshot = tableSnapshot([["Widget A", "$1.25"], ["Widget B", "$2.50"]]);
  let observationNumber = 0;
  const session = {
    attached: true,
    target: { id: "ordinary-read-target" },
    documentGeneration: 11,
    async observe() {
      observationNumber++;
      const evidenceId = `ordinary-read-evidence-${observationNumber}`;
      return {
        evidenceId,
        targetId: "ordinary-read-target",
        documentGeneration: 11,
        page: { url: "https://catalog.example/search?q=widget", title: "Widget catalog" }
      };
    },
    observer: { getEvidence(evidenceId) {
      return { status: "available", evidenceId, domSnapshot: snapshot };
    } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const observation = {
    evidenceId: "ordinary-read-evidence-0",
    targetId: "ordinary-read-target",
    documentGeneration: 11,
    page: { url: "https://catalog.example/search?q=widget", title: "Widget catalog" }
  };
  session.observer.getEvidence = evidenceId => ({ status: "available", evidenceId, domSnapshot: snapshot });
  const capabilities = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the product names and prices"
  });
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].action, "extract");
  assert.equal(capabilities[0].effectClass, "read");
  assert.deepEqual(capabilities[0].outputSchema.map(field => field.name), ["name", "price"]);
  const result = await capabilities[0].execute();
  assert.equal(result.status, "verified");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.output.records, [{ name: "Widget A", price: "$1.25" }, { name: "Widget B", price: "$2.50" }]);
  assert.equal(verifyExtractionResult(result.output).status, "incomplete", "partial visible reads never pass the complete-collection verifier");
  assert.equal(verifyObservedPartialExtractionResult(result.output).status, "valid_observed_partial");
  const boundedPartial = {
    ...result.output,
    verification: {
      ...result.output.verification,
      overflow: true,
      maxRecords: result.output.records.length,
      completionReasonCode: "visible_record_limit_reached"
    }
  };
  assert.equal(verifyObservedPartialExtractionResult(boundedPartial).status, "valid_observed_partial",
    "bounded visible rows can be released as partial when overflow is explicit and completeness remains unclaimed");
  assert.equal(verifyObservedPartialExtractionResult({
    ...boundedPartial,
    verification: { ...boundedPartial.verification, completionReasonCode: "collection_completeness_not_established" }
  }).status, "incomplete", "overflow without the record-limit reason is rejected");
  assert.equal(service.registry, undefined, "ordinary read goals do not promote ephemeral results into reusable capabilities");

  const deniedPolicy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: false, allowRelease: false }
  ]);
  const deniedService = new CapabilityService({
    classifyPublicField: deniedPolicy.classifyPublicField,
    authorizePublicRead: deniedPolicy.authorizePublicRead,
    authorizePublicRelease: deniedPolicy.authorizePublicRelease
  });
  assert.deepEqual(await deniedService.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the product names and prices"
  }), [], "a denied requested field cannot be silently omitted");
  assert.deepEqual(await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read all product names and prices"
  }), [], "one-page observations cannot claim an all-records request");
});

test("run-local public read approval binds an unfamiliar table to exact fields and the approving operator", async () => {
  const snapshot = tableSnapshot([
    ["The Example Story", "A. Writer", "2025-10-01", "writer@example.test"]
  ], { headers: ["Title", "Author", "Date", "Email"] });
  const targetId = "run-local-public-read-target";
  const observation = {
    evidenceId: "run-local-public-read-evidence",
    targetId,
    documentGeneration: 3,
    page: { url: "https://unfamiliar.example/articles", title: "Articles" }
  };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration: 3,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy();
  let proposal;
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    publicFieldPolicy: policy.publicFieldPolicy,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease,
    approvePublicRead: async request => { proposal = request; return true; }
  });
  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the article titles, authors, and dates"
  });

  assert.ok(capability);
  assert.equal(proposal.origin, "https://unfamiliar.example");
  assert.equal(proposal.targetId, targetId);
  assert.deepEqual(proposal.requestedOutput, ["name", "author", "date"]);
  assert.deepEqual(proposal.fields.map(field => field.sourceHeader), ["Title", "Author", "Date"]);
  assert.ok(proposal.maxRecords > 0 && proposal.maxRecords <= 100);
  assert.ok(proposal.maxBytes > 0 && proposal.maxBytes <= 64 * 1024);
  assert.ok(proposal.expiresInMs <= 5 * 60_000);
  assert.match(proposal.approvalPhrase, /^APPROVE PUBLIC READ [A-F0-9]{8}$/u);
  const result = await capability.execute({ observation });
  assert.equal(result.status, "verified", JSON.stringify({ result, grants: [...service.publicReadGrantBindings.values()], store: [...service.publicReadGrantStore.grants.values()] }));
  assert.deepEqual(result.output.records, [{ name: "The Example Story", author: "A. Writer", date: "2025-10-01" }]);
  assert.equal(result.completeness, "observed_partial");
  assert.equal(JSON.stringify(result.output).includes("writer@example.test"), false, "the unrequested personal field never enters released output");
  assert.equal(verifyObservedPartialExtractionResult(result.output).status, "valid_observed_partial");
});

test("run-local public read grants refuse added sensitive fields and cannot move to another target", async () => {
  let snapshot = tableSnapshot([["The Example Story"]], { headers: ["Title"] });
  const targetId = "run-local-public-read-stale-target";
  let observation = {
    evidenceId: "run-local-public-read-stale-evidence",
    targetId,
    documentGeneration: 4,
    page: { url: "https://unfamiliar.example/articles", title: "Articles" }
  };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration: 4,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy();
  let approvalCount = 0;
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    publicFieldPolicy: policy.publicFieldPolicy,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease,
    approvePublicRead: async () => { approvalCount++; return true; }
  });
  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session, principalId: "operator-1", observation, goal: "Read the article titles"
  });
  assert.ok(capability);

  snapshot = tableSnapshot([["The Example Story", "writer@example.test"]], { headers: ["Title", "Email"] });
  observation = { ...observation, evidenceId: "run-local-public-read-stale-evidence-2", documentGeneration: 5 };
  session.documentGeneration = 5;
  const changedSource = await capability.execute({ observation });
  assert.notEqual(changedSource.status, "verified");
  assert.deepEqual(changedSource.output?.records ?? [], [], "a source change cannot add an unapproved field to an existing grant");

  const denied = await service.createObservedReadWorkflowCapabilities({
    session, principalId: "operator-1", observation,
    goal: "Read the article titles and email addresses"
  });
  assert.deepEqual(denied, [], "sensitive and personal fields cannot be made public by the approval callback");
  assert.equal(approvalCount, 1);

  session.target.id = "different-target";
  const movedTarget = await capability.execute({ observation });
  assert.notEqual(movedTarget.status, "verified");
  assert.deepEqual(movedTarget.output?.records ?? [], []);
});

test("ordinary read goals match qualified table headers without treating adjacent years as requested", async () => {
  const snapshot = tableSnapshot([
    ["Example Republic", "12", "13"],
    ["Sample Federation", "24", "25"]
  ], { headers: ["Country or territory", "Population (1 July 2022)", "Population (1 July 2023)"] });
  const session = {
    attached: true,
    target: { id: "year-qualified-read-target" },
    documentGeneration: 3,
    async observe() {
      return { evidenceId: "year-qualified-read-evidence", targetId: "year-qualified-read-target", documentGeneration: 3, page: { url: "https://data.example/population" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://data.example", sourceHeader: "Country or territory", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://data.example", sourceHeader: "Population (1 July 2023)", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const observation = {
    evidenceId: "year-qualified-read-evidence",
    targetId: "year-qualified-read-target",
    documentGeneration: 3,
    page: { url: "https://data.example/population" }
  };
  const semanticPage = compileSemanticPageModel({
    observationId: observation.evidenceId,
    targetId: observation.targetId,
    documentGeneration: observation.documentGeneration,
    page: observation.page,
    domSnapshot: snapshot
  });
  const semanticFields = semanticPage.collections.find(collection => collection.kind === "html_table").fields;
  assert.equal(semanticFields[0].semanticRole, "country");
  assert.equal(semanticFields[1].semanticRole, "population");
  assert.equal(semanticFields[2].semanticRole, "population");

  const capabilities = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the country names and 2023 population values"
  });
  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0].outputSchema.map(field => field.name), ["country", "population"]);
  const result = await capabilities[0].execute();
  assert.deepEqual(result.output.records, [
    { country: "Example Republic", population: "13" },
    { country: "Sample Federation", population: "25" }
  ]);
});

test("ordinary table and card reads normalize equivalent observed fields to the same semantic keys", async () => {
  const snapshot = tableSnapshot([
    ["Widget A", "$1.25"],
    ["Widget B", "$2.50"]
  ], { headers: ["Product name", "Price"] });
  const targetId = "semantic-table-normalization-target";
  const evidenceId = "semantic-table-normalization-evidence";
  const documentGeneration = 4;
  const page = { url: "https://catalog.example/search?q=widget", title: "Widget catalog" };
  const observation = { evidenceId, targetId, documentGeneration, page };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Product name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the product names and prices"
  });

  assert.ok(capability);
  assert.deepEqual(capability.outputSchema.map(field => field.name), ["name", "price"]);
  const result = await capability.execute();
  assert.equal(result.status, "verified");
  assert.deepEqual(result.output.records, [
    { name: "Widget A", price: "$1.25" },
    { name: "Widget B", price: "$2.50" }
  ]);
  assert.equal(result.completeness, "observed_partial");

  const ambiguousSnapshot = tableSnapshot([
    ["Widget A", "Alternate A"],
    ["Widget B", "Alternate B"]
  ], {
    headers: ["Product name", "Name"]
  });
  const ambiguousSession = {
    ...session,
    observer: { getEvidence() { return { status: "available", domSnapshot: ambiguousSnapshot }; } }
  };
  const ambiguousPolicy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Product name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const ambiguousService = new CapabilityService({
    classifyPublicField: ambiguousPolicy.classifyPublicField,
    authorizePublicRead: ambiguousPolicy.authorizePublicRead,
    authorizePublicRelease: ambiguousPolicy.authorizePublicRelease
  });
  assert.deepEqual(await ambiguousService.createObservedReadWorkflowCapabilities({
    session: ambiguousSession,
    principalId: "operator-1",
    observation,
    goal: "Read product names"
  }), [], "duplicate semantic names abstain instead of producing colliding output keys");
});

test("country and population fields normalize consistently across tables and repeated cards", async () => {
  const snapshot = recordGroupSnapshot([
    { fields: { countryName: "Canada", populationValue: "40,000,000" } },
    { fields: { countryName: "Japan", populationValue: "123,000,000" } }
  ], {
    containerClass: "country-results",
    itemClass: "country-card",
    fieldClasses: { countryName: "countryName", populationValue: "populationValue" }
  });
  const targetId = "semantic-country-card-target";
  const evidenceId = "semantic-country-card-evidence";
  const documentGeneration = 6;
  const page = { url: "https://data.example/countries", title: "Countries" };
  const semanticPage = compileSemanticPageModel({ observationId: evidenceId, targetId, documentGeneration, page, domSnapshot: snapshot });
  const observation = { evidenceId, targetId, documentGeneration, page, semanticPage };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://data.example", sourceKey: "countryName", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://data.example", sourceKey: "populationValue", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read country names and population values"
  });

  assert.ok(capability);
  assert.deepEqual(capability.outputSchema.map(field => field.name), ["country", "population"]);
  const fields = semanticPage.collections[0].fields;
  assert.deepEqual(fields.map(field => field.semanticRole), ["country", "population"]);
  const result = await capability.execute();
  assert.deepEqual(result.output.records, [
    { country: "Canada", population: "40,000,000" },
    { country: "Japan", population: "123,000,000" }
  ]);
});

test("deferred one-shot read resolves a public listing after a bounded navigation step", async () => {
  const targetId = "deferred-public-read-target";
  const initialObservation = {
    evidenceId: "deferred-public-read-start",
    targetId,
    documentGeneration: 1,
    page: { url: "https://catalog.example/", title: "Catalog home" },
    candidates: []
  };
  const listingSnapshot = tableSnapshot([
    ["Widget A", "$1.25"],
    ["Widget B", "$2.50"]
  ]);
  let currentSnapshot = listingSnapshot;
  const listingObservation = {
    evidenceId: "deferred-public-read-listing",
    targetId,
    documentGeneration: 2,
    page: { url: "https://catalog.example/products?category=gpu", title: "Graphics cards" },
    semanticPage: compileSemanticPageModel({
      observationId: "deferred-public-read-listing",
      targetId,
      documentGeneration: 2,
      page: { url: "https://catalog.example/products?category=gpu", title: "Graphics cards" },
      domSnapshot: listingSnapshot
    })
  };
  let currentObservation = initialObservation;
  let observationCount = 0;
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration: 1,
    async observe() {
      observationCount++;
      return currentObservation;
    },
    observer: { getEvidence(evidenceId, options = {}) {
      if (options.facets?.includes("page")) return { status: "available", page: { url: "https://catalog.example/products?category=gpu" } };
      return { status: "available", evidenceId, domSnapshot: currentSnapshot };
    } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceHeader: "Name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceHeader: "Price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const goal = "Open the catalog and return product names and prices";
  const [capability] = service.createDeferredObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    goal
  });
  assert.ok(capability);
  assert.deepEqual(capability.outputSchema.map(field => field.name), ["name", "price"]);

  currentObservation = listingObservation;
  session.documentGeneration = 2;
  const result = await capability.execute({ observation: listingObservation });
  assert.equal(result.status, "verified");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.output.records, [
    { name: "Widget A", price: "$1.25" },
    { name: "Widget B", price: "$2.50" }
  ]);
  assert.equal(observationCount, 0, "the workflow passes its fresh post-navigation observation into read binding");
  assert.deepEqual(result.evidenceRefs, [listingObservation.evidenceId]);

  currentSnapshot = tableSnapshot([
    ["Widget A", "2024"],
    ["Widget B", "2025"]
  ], { headers: ["Name", "Year"] });
  currentObservation = {
    ...listingObservation,
    evidenceId: "deferred-public-read-wrong-fields",
    documentGeneration: 3,
    page: { url: "https://catalog.example/products?category=year", title: "Year catalog" },
    semanticPage: compileSemanticPageModel({
      observationId: "deferred-public-read-wrong-fields",
      targetId,
      documentGeneration: 3,
      page: { url: "https://catalog.example/products?category=year", title: "Year catalog" },
      domSnapshot: currentSnapshot
    })
  };
  session.documentGeneration = 3;
  const mismatched = await capability.execute({ observation: currentObservation });
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.reasonCode, "requested_observed_fields_mismatch");
  assert.deepEqual(mismatched.evidenceRefs, [currentObservation.evidenceId]);
});

test("ordinary read goals extract semantically identified fields from a unique visible card collection", async () => {
  const snapshot = recordGroupSnapshot([
    { sender: "Widget A", subject: "$1.25" },
    { sender: "Widget B", subject: "$2.50" }
  ], {
    containerClass: "catalog-grid",
    itemClass: "product-card",
    senderClass: "product-name",
    subjectClass: "product-price"
  });
  const targetId = "semantic-card-read-target";
  const evidenceId = "semantic-card-read-evidence";
  const documentGeneration = 9;
  const page = { url: "https://catalog.example/search?q=widget", title: "Widget catalog" };
  const semanticPage = compileSemanticPageModel({
    observationId: evidenceId,
    targetId,
    documentGeneration,
    page,
    domSnapshot: snapshot
  });
  const observation = { evidenceId, targetId, documentGeneration, page, semanticPage };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceKey: "product-name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceKey: "product-price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const discovered = await service.discover({ session, principalId: "operator-1" });
  assert.equal(discovered.status, "candidate");
  const publicCardCandidate = discovered.candidates.find(candidate => candidate.kind === "visible_record_group");
  assert.ok(publicCardCandidate);
  assert.equal("documentIndex" in publicCardCandidate, false, "internal frame/document locators are not exposed by discovery");

  const capabilities = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the product names and prices"
  });
  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0].outputSchema.map(field => field.name), ["name", "price"]);
  const result = await capabilities[0].execute();
  assert.equal(result.status, "verified");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.output.records, [
    { name: "Widget A", price: "$1.25" },
    { name: "Widget B", price: "$2.50" }
  ]);
  assert.equal(verifyObservedPartialExtractionResult(result.output).status, "valid_observed_partial");
  const planner = new WorkflowGraphPlanner({
    capabilities,
    taskIntent: {
      purposeCode: "extract_records",
      outcomeCode: "observed_records_returned",
      cardinality: "atomic",
      permittedPurposeCodes: ["extract_records"],
      targetRoles: ["observed_records"],
      constraints: ["observed_partial"],
      requiredCapabilityIds: [capabilities[0].id]
    },
    synthesizer: { async synthesize() { throw new Error("a single bound observed read should not call a model"); } }
  });
  const plannedRead = await planner.plan("Read the product names and prices", observation);
  assert.equal(plannedRead.status, "completed");
  assert.equal(planner.getStatus().synthesisCalls, 0);
  assert.deepEqual(planner.getOutputs()[capabilities[0].id].records, result.output.records);
  assert.equal(service.registry, undefined, "the synthesized card read remains ephemeral");
});

test("card extraction abstains for ambiguous semantic bindings, denied fields, and stale routes", async () => {
  const snapshot = recordGroupSnapshot([
    { sender: "Widget A", subject: "$1.25" },
    { sender: "Widget B", subject: "$2.50" }
  ], {
    containerClass: "catalog-grid",
    itemClass: "product-card",
    senderClass: "product-name",
    subjectClass: "product-price"
  });
  const targetId = "semantic-card-read-adversarial-target";
  const evidenceId = "semantic-card-read-adversarial-evidence";
  const documentGeneration = 5;
  const page = { url: "https://catalog.example/search?q=widget", title: "Widget catalog" };
  const semanticPage = compileSemanticPageModel({ observationId: evidenceId, targetId, documentGeneration, page, domSnapshot: snapshot });
  const observation = { evidenceId, targetId, documentGeneration, page, semanticPage };
  let currentUrl = page.url;
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() {
      const currentPage = { ...page, url: currentUrl };
      return { ...observation, page: currentPage };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const allowAll = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceKey: "product-name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceKey: "product-price", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const ambiguousService = new CapabilityService({
    classifyPublicField: allowAll.classifyPublicField,
    authorizePublicRead: allowAll.authorizePublicRead,
    authorizePublicRelease: allowAll.authorizePublicRelease
  });
  const ambiguousObservation = {
    ...observation,
    semanticPage: { ...semanticPage, collections: [...semanticPage.collections, semanticPage.collections[0]] }
  };
  assert.deepEqual(await ambiguousService.createObservedReadWorkflowCapabilities({
    session, principalId: "operator-1", observation: ambiguousObservation,
    goal: "Read the product names and prices"
  }), [], "multiple exact semantic collection bindings are rejected");

  const deniedPolicy = createExtractionFieldPolicy([], [], [
    { origin: "https://catalog.example", sourceKey: "product-name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://catalog.example", sourceKey: "product-price", dataClass: "public", allowRead: false, allowRelease: false }
  ]);
  const deniedService = new CapabilityService({
    classifyPublicField: deniedPolicy.classifyPublicField,
    authorizePublicRead: deniedPolicy.authorizePublicRead,
    authorizePublicRelease: deniedPolicy.authorizePublicRelease
  });
  assert.deepEqual(await deniedService.createObservedReadWorkflowCapabilities({
    session, principalId: "operator-1", observation, goal: "Read the product names and prices"
  }), [], "a denied requested field cannot be silently dropped");

  const staleCapability = (await ambiguousService.createObservedReadWorkflowCapabilities({
    session, principalId: "operator-1", observation, goal: "Read the product names and prices"
  }))[0];
  assert.ok(staleCapability);
  currentUrl = "https://catalog.example/search?q=other";
  const staleResult = await staleCapability.execute();
  assert.equal(staleResult.status, "failed");
  assert.equal(staleResult.reasonCode, "observed_route_changed");
});

test("semantic card reads resolve camelCase title and author fields from a query-bound public listing", async () => {
  const snapshot = recordGroupSnapshot([
    { fields: { title: "Book A", alternateTitle: "Alias A", author: "Author A" } },
    { fields: { title: "Book B", alternateTitle: "Alias B", author: "Author B" } }
  ], {
    containerClass: "searchResults",
    itemClass: "searchResult",
    fieldClasses: { title: "resultTitle", alternateTitle: "mainName", author: "resultAuthor" }
  });
  const targetId = "semantic-camel-field-target";
  const evidenceId = "semantic-camel-field-evidence";
  const documentGeneration = 4;
  const page = { url: "https://books.example/search?q=vision", title: "Search results" };
  const semanticPage = compileSemanticPageModel({ observationId: evidenceId, targetId, documentGeneration, page, domSnapshot: snapshot });
  const observation = { evidenceId, targetId, documentGeneration, page, semanticPage };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://books.example", sourceKey: "resultTitle", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://books.example", sourceKey: "mainName", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://books.example", sourceKey: "resultAuthor", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const capabilities = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the book titles and authors"
  });

  assert.equal(capabilities.length, 1);
  assert.deepEqual(capabilities[0].outputSchema.map(field => field.name), ["name", "author"]);
  const result = await capabilities[0].execute();
  assert.equal(result.status, "verified");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.output.records, [
    { name: "Book A", author: "Author A" },
    { name: "Book B", author: "Author B" }
  ]);
});

test("observed partial card reads preserve legitimate duplicate display names", async () => {
  const snapshot = recordGroupSnapshot([
    { fields: { title: "The Same Book", author: "Author One" } },
    { fields: { title: "The Same Book", author: "Author Two" } }
  ], {
    containerClass: "searchResults",
    itemClass: "searchResult",
    fieldClasses: { title: "product-name", author: "product-author" }
  });
  const targetId = "semantic-duplicate-title-target";
  const evidenceId = "semantic-duplicate-title-evidence";
  const documentGeneration = 2;
  const page = { url: "https://books.example/search?q=duplicates", title: "Search results" };
  const semanticPage = compileSemanticPageModel({ observationId: evidenceId, targetId, documentGeneration, page, domSnapshot: snapshot });
  const observation = { evidenceId, targetId, documentGeneration, page, semanticPage };
  const session = {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async observe() { return observation; },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const policy = createExtractionFieldPolicy([], [], [
    { origin: "https://books.example", sourceKey: "product-name", dataClass: "public", allowRead: true, allowRelease: true },
    { origin: "https://books.example", sourceKey: "product-author", dataClass: "public", allowRead: true, allowRelease: true }
  ]);
  const service = new CapabilityService({
    classifyPublicField: policy.classifyPublicField,
    authorizePublicRead: policy.authorizePublicRead,
    authorizePublicRelease: policy.authorizePublicRelease
  });
  const [capability] = await service.createObservedReadWorkflowCapabilities({
    session,
    principalId: "operator-1",
    observation,
    goal: "Read the book names and authors"
  });
  assert.ok(capability);
  const result = await capability.execute();
  assert.equal(result.status, "verified");
  assert.deepEqual(result.output.records, [
    { name: "The Same Book", author: "Author One" },
    { name: "The Same Book", author: "Author Two" }
  ]);
  assert.deepEqual(result.output.verification.uniqueBy, []);
  assert.equal(verifyObservedPartialExtractionResult(result.output).status, "valid_observed_partial");
  assert.equal(verifyExtractionResult(result.output).status, "incomplete", "partial output never passes complete extraction checks");
});

test("unprofiled public one-shot reads fail closed without an explicit allowlist", async () => {
  const snapshot = tableSnapshot([["Widget A", "1.25"]]);
  const session = {
    attached: true,
    target: { id: "public-read-no-policy-target" },
    documentGeneration: 2,
    async observe() {
      return { evidenceId: "public-read-no-policy-observation", targetId: "public-read-no-policy-target", documentGeneration: 2, page: { url: "https://catalog.example/search?q=widget" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } }
  };
  const service = new CapabilityService();
  const result = await service.readObservedRecords({
    session,
    principalId: "operator-1",
    requestedFields: [{ name: "name", sourceHeader: "Name", type: "string", required: true }]
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "public_observed_read_policy_unavailable");
  assert.deepEqual(result.records, []);
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
    const scope = { capabilityVersion: 1, origin: "https://shop.example", environmentId: "staging", applicationId: "shop", principalId: "operator-1" };
    assert.ok(restored.resolve("shop.products", scope));
    const revoked = await restored.revoke({ capabilityId: "shop.products", ...scope }, { reasonCode: "source_contract_retired" });
    assert.equal(revoked.status, "revoked");
    assert.equal(restored.resolve("shop.products", scope), null, "revoked capability is unavailable immediately");
    assert.equal((await restored.list()).length, 0);

    const afterRestart = await new CapabilityRegistry({ directory }).init();
    assert.equal(afterRestart.resolve("shop.products", scope), null, "revocation survives registry restart");
    assert.equal((await afterRestart.revoke({ capabilityId: "shop.products", ...scope }, { reasonCode: "duplicate_request" })).status, "already_revoked");
    await assert.rejects(() => afterRestart.register(qualification.manifest), /has been revoked/u, "a revoked version cannot be silently re-promoted");
    const files = await readdir(directory);
    assert.equal(files.length, 2, "the original manifest and durable revocation tombstone remain auditable");
    for (const persistedFile of files) assert.equal((await stat(join(directory, persistedFile))).mode & 0o777, 0o600);
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
        authorizedOrigins: ["https://mail.example"],
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
    environment: { environmentId: "webarena-infinity-local", authorizedOrigins: ["https://mail.example"], applications: [{ applicationId: "webarena-infinity-gmail", origin: "https://mail.example" }] },
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
      environment: { environmentId: "webarena-infinity-local", authorizedOrigins: ["https://mail.example"], applications: [{ applicationId: "webarena-infinity-gmail", origin: "https://mail.example" }] },
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
  assert.equal(duplicated.output.verification.duplicateKeys, 0, "overlapping pages are deduplicated in the returned records");
  assert.ok(duplicated.output.verification.paginationProgress.duplicateRecordCount > 0, "the progress receipt retains the duplicate-row count");

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
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
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
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
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
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
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
      environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
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
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"], applications: [{ applicationId: "shop", origin: "https://shop.example" }] },
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
