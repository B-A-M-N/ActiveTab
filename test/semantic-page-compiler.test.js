import test from "node:test";
import assert from "node:assert/strict";
import { compileSemanticPageModel, rankInteractionCandidates } from "../src/observe/semanticPageCompiler.js";
import { buildDocumentIndex } from "../src/observe/documentIndex.js";
import { resolveSemanticQuery } from "../src/navigation/semanticAnalyzer.js";

function buildCatalogEvidence() {
  const strings = [];
  const stringIds = new Map();
  const stringIndex = value => {
    const normalized = String(value);
    if (!stringIds.has(normalized)) {
      stringIds.set(normalized, strings.length);
      strings.push(normalized);
    }
    return stringIds.get(normalized);
  };
  const nodes = [];
  const add = (tag, parentIndex, attributes = {}, text = "") => {
    const backendNodeId = nodes.length + 1;
    const attributesFlat = Object.entries(attributes).flatMap(([name, value]) => [stringIndex(name), stringIndex(value)]);
    const index = nodes.length;
    nodes.push({
      nodeName: stringIndex(tag),
      parentIndex,
      attributes: attributesFlat,
      backendNodeId,
      nodeValue: text ? stringIndex(text) : "",
      textValue: text ? stringIndex(text) : ""
    });
    return { index, backendNodeId };
  };
  const root = add("#document", -1);
  const main = add("MAIN", root.index);
  const heading = add("H1", main.index);
  add("#text", heading.index, {}, "Product catalog");
  const form = add("FORM", main.index, { method: "get", action: "https://catalog.example/search" });
  const search = add("INPUT", form.index, { type: "search", "aria-label": "Search products" });
  const list = add("UL", main.index, { class: "results" });
  const items = [];
  for (const [title, price] of [["Widget A", "$10"], ["Widget B", "$20"]]) {
    const item = add("LI", list.index, { class: "product" });
    items.push(item);
    const titleNode = add("H2", item.index, { class: "product-title" });
    add("#text", titleNode.index, {}, title);
    const priceNode = add("SPAN", item.index, { class: "product-price" });
    add("#text", priceNode.index, {}, price);
  }
  const view = add("A", items[0].index, { href: "/products/widget-a", class: "view-link" });
  add("#text", view.index, {}, "View details");

  const snapshot = {
    strings,
    documents: [{
      frameId: stringIndex("frame-main"),
      nodes: {
        nodeName: nodes.map(node => node.nodeName),
        nodeValue: nodes.map(node => node.nodeValue),
        textValue: nodes.map(node => node.textValue),
        parentIndex: nodes.map(node => node.parentIndex),
        attributes: nodes.map(node => node.attributes),
        backendNodeId: nodes.map(node => node.backendNodeId)
      },
      layout: { nodeIndex: nodes.map((_, index) => index), bounds: nodes.map(() => [0, 0, 80, 20]) }
    }]
  };
  return {
    snapshot,
    search,
    view,
    candidates: [
      {
        identity: "target:frame-main:1:search:4",
        targetId: "target",
        frameId: "frame-main",
        backendNodeId: search.backendNodeId,
        role: "searchbox",
        tag: "input",
        type: "search",
        name: "Search products",
        contextName: null,
        visible: true,
        disabled: false,
        formIdentity: "target:frame-main:1:form:4",
        formMethod: "get",
        formActionOrigin: "https://catalog.example",
        submitsForm: false
      },
      {
        identity: "target:frame-main:1:view:17",
        targetId: "target",
        frameId: "frame-main",
        backendNodeId: view.backendNodeId,
        role: "link",
        tag: "a",
        name: "View details",
        contextName: null,
        visible: true,
        disabled: false,
        submitsForm: false
      }
    ]
  };
}

function buildMicrodataCatalogEvidence({ duplicatePrice = false, sharedItemClass = false, classless = false } = {}) {
  const strings = [];
  const stringIds = new Map();
  const stringIndex = value => {
    const normalized = String(value);
    if (!stringIds.has(normalized)) {
      stringIds.set(normalized, strings.length);
      strings.push(normalized);
    }
    return stringIds.get(normalized);
  };
  const nodes = [];
  const candidates = [];
  const add = (tag, parentIndex, attributes = {}, text = "") => {
    const index = nodes.length;
    const backendNodeId = index + 1;
    nodes.push({
      nodeName: stringIndex(tag),
      parentIndex,
      attributes: Object.entries(attributes).flatMap(([name, value]) => [stringIndex(name), stringIndex(value)]),
      backendNodeId,
      nodeValue: text ? stringIndex(text) : "",
      textValue: text ? stringIndex(text) : ""
    });
    return { index, backendNodeId };
  };
  const root = add("#document", -1);
  const main = add("MAIN", root.index);
  const list = add("UL", main.index, { class: "results" });
  for (const [slug, name, price] of [
    ["rtx", "RTX A4000", "$450"],
    ["radeon", "Radeon Pro W6600", "$300"]
  ]) {
    const productAttributes = {
      itemscope: "",
      itemtype: "https://schema.org/Product"
    };
    if (!classless) productAttributes.class = sharedItemClass ? "product-card" : `random-${slug}`;
    const product = add("LI", list.index, productAttributes);
    const titleAttributes = { itemprop: "name" };
    if (!classless) titleAttributes.class = sharedItemClass ? "product-title" : `c-${slug}-a`;
    const title = add("H2", product.index, titleAttributes);
    add("#text", title.index, {}, name);
    const priceAttributes = { itemprop: "price" };
    if (!classless) priceAttributes.class = sharedItemClass ? "product-price" : `c-${slug}-b`;
    const cost = add("SPAN", product.index, priceAttributes);
    add("#text", cost.index, {}, price);
    if (duplicatePrice && slug === "rtx") {
      const alternate = add("SPAN", product.index, { itemprop: "price", class: "c-rtx-c" });
      add("#text", alternate.index, {}, "$499");
    }
    const detailsAttributes = { href: `/products/${slug}`, itemprop: "url" };
    if (!classless) detailsAttributes.class = sharedItemClass ? "product-details" : `c-${slug}-d`;
    const details = add("A", product.index, detailsAttributes);
    add("#text", details.index, {}, "Details");
    candidates.push({
      identity: `candidate:${slug}:details`,
      targetId: "target",
      frameId: "frame-main",
      backendNodeId: details.backendNodeId,
      role: "link",
      tag: "a",
      type: null,
      name: "Details",
      contextName: name,
      visible: true,
      disabled: false,
      submitsForm: false
    });
  }
  const snapshot = {
    strings,
    documents: [{
      frameId: stringIndex("frame-main"),
      nodes: {
        nodeName: nodes.map(node => node.nodeName),
        nodeValue: nodes.map(node => node.nodeValue),
        textValue: nodes.map(node => node.textValue),
        parentIndex: nodes.map(node => node.parentIndex),
        attributes: nodes.map(node => node.attributes),
        backendNodeId: nodes.map(node => node.backendNodeId)
      },
      layout: { nodeIndex: nodes.map((_, index) => index), bounds: nodes.map(() => [0, 0, 100, 20]) }
    }]
  };
  return { snapshot, candidates };
}

function appendJsonLdScript(snapshot, value) {
  const strings = snapshot.strings;
  const ids = new Map(strings.map((item, index) => [item, index]));
  const intern = item => {
    const text = String(item);
    if (!ids.has(text)) { ids.set(text, strings.length); strings.push(text); }
    return ids.get(text);
  };
  const nodes = snapshot.documents[0].nodes;
  const scriptIndex = nodes.nodeName.length;
  const parent = nodes.nodeName.findIndex(index => strings[index] === "#document");
  const maxBackendId = Math.max(...nodes.backendNodeId.filter(Number.isInteger));
  nodes.nodeName.push(intern("SCRIPT"));
  nodes.nodeValue.push(-1);
  nodes.textValue.push(-1);
  nodes.parentIndex.push(parent);
  nodes.attributes.push([intern("type"), intern("application/ld+json")]);
  nodes.backendNodeId.push(maxBackendId + 1);
  const text = JSON.stringify(value);
  nodes.nodeName.push(intern("#text"));
  nodes.nodeValue.push(intern(text));
  nodes.textValue.push(intern(text));
  nodes.parentIndex.push(scriptIndex);
  nodes.attributes.push([]);
  nodes.backendNodeId.push(maxBackendId + 2);
}

function buildTableEvidence() {
  const strings = [];
  const stringIds = new Map();
  const stringIndex = value => {
    const normalized = String(value);
    if (!stringIds.has(normalized)) {
      stringIds.set(normalized, strings.length);
      strings.push(normalized);
    }
    return stringIds.get(normalized);
  };
  let nextBackendNodeId = 1;
  const documents = [];
  const candidates = [];
  const addDocument = (frameId, build) => {
    const nodes = [];
    const add = (tag, parentIndex, attributes = {}, text = "") => {
      const index = nodes.length;
      const backendNodeId = nextBackendNodeId++;
      nodes.push({
        nodeName: stringIndex(tag),
        parentIndex,
        attributes: Object.entries(attributes).flatMap(([name, value]) => [stringIndex(name), stringIndex(value)]),
        backendNodeId,
        nodeValue: text ? stringIndex(text) : "",
        textValue: text ? stringIndex(text) : ""
      });
      return { index, backendNodeId };
    };
    build({ add });
    documents.push({
      frameId: stringIndex(frameId),
      nodes: {
        nodeName: nodes.map(node => node.nodeName),
        nodeValue: nodes.map(node => node.nodeValue),
        textValue: nodes.map(node => node.textValue),
        parentIndex: nodes.map(node => node.parentIndex),
        attributes: nodes.map(node => node.attributes),
        backendNodeId: nodes.map(node => node.backendNodeId)
      },
      layout: { nodeIndex: nodes.map((_, index) => index), bounds: nodes.map(() => [0, 0, 80, 20]) }
    });
  };
  const addText = (add, parent, value) => add("#text", parent.index, {}, value);
  const addControl = (add, parent, frameId, label, name = "View") => {
    const link = add("A", parent.index, { href: "/items/" + label.toLowerCase() });
    addText(add, link, name);
    candidates.push({
      identity: "candidate:" + frameId + ":" + label + ":" + link.backendNodeId,
      targetId: "target",
      frameId,
      backendNodeId: link.backendNodeId,
      role: "link",
      tag: "a",
      name,
      contextName: null,
      visible: true,
      disabled: false,
      submitsForm: false
    });
    return link;
  };

  addDocument("frame-main", ({ add }) => {
    const root = add("#document", -1);
    const table = add("TABLE", root.index);
    const head = add("THEAD", table.index);
    const headerRow = add("TR", head.index);
    for (const name of ["Product", "Action"]) {
      const cell = add("TH", headerRow.index);
      addText(add, cell, name);
    }
    const body = add("TBODY", table.index);
    for (const name of ["Alpha", "Beta"]) {
      const row = add("TR", body.index);
      const nameCell = add("TD", row.index);
      addText(add, nameCell, name);
      const actionCell = add("TD", row.index);
      addControl(add, actionCell, "frame-main", name);
      if (name === "Alpha") {
        const nested = add("TABLE", actionCell.index);
        const nestedHead = add("TR", nested.index);
        const nestedHeader = add("TH", nestedHead.index);
        addText(add, nestedHeader, "Nested item");
        const nestedRow = add("TR", nested.index);
        const nestedValue = add("TD", nestedRow.index);
        addText(add, nestedValue, "Nested value");
        const nestedAction = add("TD", nestedRow.index);
        addControl(add, nestedAction, "frame-main", "nested");
      }
    }

    const noHeader = add("TABLE", root.index);
    const plainRow = add("TR", noHeader.index);
    const plainCell = add("TD", plainRow.index);
    addText(add, plainCell, "Not a headed table");
  });

  addDocument("frame-child", ({ add }) => {
    const root = add("#document", -1);
    const table = add("TABLE", root.index);
    const header = add("TR", table.index);
    const headerCell = add("TH", header.index);
    addText(add, headerCell, "Product");
    const row = add("TR", table.index);
    const value = add("TD", row.index);
    addText(add, value, "Gamma");
    const action = add("TD", row.index);
    addControl(add, action, "frame-child", "gamma");
  });
  return { snapshot: { strings, documents }, candidates };
}

test("semantic page model links controls to regions, forms, and repeated structures without inventing effects", () => {
  const fixture = buildCatalogEvidence();
  const page = compileSemanticPageModel({
    observationId: "observation-1",
    targetId: "target",
    documentGeneration: 3,
    page: { url: "https://catalog.example/search?q=widget", title: "Search products" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates,
    headings: [{ level: 1, text: "Product catalog", frameId: "frame-main" }],
    headingCount: 1,
    candidateCoverage: {
      pageCandidateCount: 301,
      returnedCandidateCount: 2,
      omittedCandidateCount: 299,
      pageCoverage: "partial",
      selectionScope: "task_relevant_region",
      scopeCandidateCount: 2,
      scopeCoverage: "complete",
      truncated: true
    },
    coverage: { closedShadowDom: false }
  });

  const search = page.controls.find(control => control.role === "searchbox");
  const link = page.controls.find(control => control.role === "link");
  assert.equal(page.schemaVersion, 3);
  assert.equal(page.page.origin, "https://catalog.example");
  assert.deepEqual(page.page.pageType, { value: "repeated_content", status: "inferred" });
  assert.equal(page.candidateCoverage.pageCoverage, "partial");
  assert.equal(page.candidateCoverage.scopeCoverage, "complete");
  assert.ok(page.regions.some(region => region.kind === "main" && region.label.value === "Product catalog"));
  assert.equal(search.formRef, fixture.candidates[0].formIdentity);
  assert.ok(search.regionRef);
  assert.deepEqual(search.interaction, {
    mechanic: "enter_text",
    readiness: "visible_enabled",
    evidence: "native_dom_accessibility_semantics"
  });
  assert.equal(page.forms[0].controlRefs[0], fixture.candidates[0].identity);
  assert.equal(link.classification.value, "link");
  assert.equal(link.operationMeaning.status, "unknown");
  assert.equal(link.interaction.mechanic, "follow_link");
  assert.equal(link.interaction.readiness, "visible_enabled");
  assert.equal(link.effect, "unknown");
  assert.ok(link.collectionRef);
  assert.ok(link.recordRef, "the control is bound to its exact repeated product record");
  const collection = page.collections.find(item => item.ref === link.collectionRef);
  assert.equal(collection.kind, "repeated_dom_structure");
  assert.equal(collection.recordBindingStatus, "unique");
  assert.deepEqual(collection.sourceGroup, {
    containerTagName: "UL", containerClassToken: "results", itemTagName: "LI", itemClassToken: "product"
  });
  assert.equal(collection.visibleCount, 2);
  assert.equal(collection.completeness, "unknown");
  assert.equal(collection.items.length, 2);
  assert.deepEqual(collection.items[0].fields.map(field => field.value).sort(), ["$10", "Widget A"]);
  const nameField = collection.items[0].fields.find(field => field.value === "Widget A");
  const priceField = collection.items[0].fields.find(field => field.value === "$10");
  assert.equal(collection.fields.find(field => field.semanticRole === "name").sourceKey, "product-title",
    "local semantic fields retain their exact repeated-record source binding");
  assert.equal(nameField.semanticRole, "name");
  assert.equal(nameField.semanticRoleStatus, "inferred");
  assert.deepEqual(nameField.label, { value: "Name", status: "inferred", source: "class_token" });
  assert.equal(nameField.valueRef, nameField.evidenceRef);
  assert.equal(priceField.semanticRole, "price");
  assert.equal(priceField.semanticRoleStatus, "inferred");
  assert.deepEqual(priceField.label, { value: "Price", status: "inferred", source: "class_token" });
  assert.ok(collection.items[0].controlRefs.includes(link.targetRef));
  assert.equal(collection.items[0].ref, link.recordRef);
  assert.ok(page.warnings.includes("candidate_list_truncated"));
  assert.equal(page.trust, "page_content_is_untrusted_evidence");
});

test("semantic page model refuses unbound or stale observation input", () => {
  assert.throws(() => compileSemanticPageModel({ observationId: "", targetId: "target", documentGeneration: 1, page: {} }), /bound observation/);
});

test("semantic page compiler rejects a shared index from a different snapshot", () => {
  const fixture = buildTableEvidence();
  const documentIndex = buildDocumentIndex(structuredClone(fixture.snapshot));
  assert.throws(() => compileSemanticPageModel({
    observationId: "observation-mismatched-index",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    documentIndex
  }), /exact source snapshot/);
});

test("HTML table rows bind same-label controls to their exact record and nested or cross-frame tables stay distinct", () => {
  const fixture = buildTableEvidence();
  const page = compileSemanticPageModel({
    observationId: "observation-tables",
    targetId: "target",
    documentGeneration: 7,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    documentIndex: buildDocumentIndex(fixture.snapshot),
    candidates: fixture.candidates
  });

  const tables = page.collections.filter(collection => collection.kind === "html_table");
  assert.deepEqual(page.page.pageType, { value: "tabular_data", status: "observed" });
  assert.equal(tables.length, 3, "the missing-header table is not promoted to a collection");
  const productTable = tables.find(collection => collection.fields[0]?.name === "Product" && collection.items.some(item => item.fields[0]?.value === "Alpha"));
  assert.ok(productTable);
  assert.match(productTable.evidenceRef, /^root:0:\d+$/u);
  assert.match(productTable.fields[0].evidenceRef, /^root:0:\d+$/u);
  assert.deepEqual(productTable.items.map(item => item.fields[0].value), ["Alpha", "Beta"]);
  assert.equal(productTable.fields[0].semanticRole, "name");
  assert.equal(productTable.fields[0].semanticRoleStatus, "inferred");
  assert.deepEqual(productTable.fields[0].label, { value: "Product", status: "observed", source: "table_header" });
  assert.equal(productTable.items[0].fields[0].valueRef, productTable.items[0].fields[0].evidenceRef);

  const alphaItem = productTable.items.find(item => item.fields[0].value === "Alpha");
  const betaItem = productTable.items.find(item => item.fields[0].value === "Beta");
  const alphaControl = page.controls.find(control => control.targetRef.includes(":Alpha:"));
  const betaControl = page.controls.find(control => control.targetRef.includes(":Beta:"));
  assert.equal(alphaControl.collectionRef, productTable.ref);
  assert.equal(alphaControl.recordRef, alphaItem.ref);
  assert.ok(alphaItem.controlRefs.includes(alphaControl.targetRef));
  assert.equal(betaControl.collectionRef, productTable.ref);
  assert.equal(betaControl.recordRef, betaItem.ref);
  assert.ok(betaItem.controlRefs.includes(betaControl.targetRef));
  assert.notEqual(alphaControl.recordRef, betaControl.recordRef);

  const nestedControl = page.controls.find(control => control.targetRef.includes(":nested:"));
  const nestedTable = tables.find(collection => collection.items.some(item => item.fields[0]?.value === "Nested value"));
  assert.equal(nestedControl.collectionRef, nestedTable.ref);
  assert.equal(nestedControl.recordRef, nestedTable.items[0].ref);
  const crossFrameControl = page.controls.find(control => control.targetRef.includes(":gamma:"));
  const crossFrameTable = tables.find(collection => collection.items.some(item => item.fields[0]?.value === "Gamma"));
  assert.equal(crossFrameControl.collectionRef, crossFrameTable.ref);
  assert.equal(crossFrameControl.recordRef, crossFrameTable.items[0].ref);

  for (const control of page.controls) {
    assert.equal(control.operationMeaning.status, "unknown");
    assert.equal(control.effect, "unknown");
  }
  assert.ok(page.warnings.includes("collection_completeness_unknown"));
});

test("semantic page compiler binds OOPIF tables to frame-qualified candidates and evidence", () => {
  const fixture = buildTableEvidence();
  const rootSnapshot = { strings: fixture.snapshot.strings, documents: [fixture.snapshot.documents[0]] };
  const childDocument = structuredClone(fixture.snapshot.documents[1]);
  childDocument.nodes.backendNodeId = childDocument.nodes.backendNodeId.map((_, index) => index + 1);
  const childSnapshot = { strings: fixture.snapshot.strings, documents: [childDocument] };
  const gammaSource = fixture.candidates.find(candidate => candidate.identity.includes(":gamma:"));
  const gammaNodeIndex = fixture.snapshot.documents[1].nodes.backendNodeId.indexOf(gammaSource.backendNodeId);
  const gammaCandidate = {
    ...gammaSource,
    backendNodeId: gammaNodeIndex + 1,
    frameTargetId: "oopif-target",
    parentFrameId: "root-frame"
  };

  const page = compileSemanticPageModel({
    observationId: "observation-oopif",
    targetId: "target",
    documentGeneration: 9,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: rootSnapshot,
    frameSnapshots: [{
      targetId: "oopif-target",
      frameId: "frame-child",
      parentFrameId: "root-frame",
      domSnapshot: childSnapshot
    }],
    documentIndex: buildDocumentIndex(rootSnapshot),
    frameDocumentIndexes: [buildDocumentIndex(childSnapshot, {
      frameTargetId: "oopif-target",
      parentFrameId: "root-frame"
    })],
    candidates: [...fixture.candidates.filter(candidate => candidate !== gammaSource), gammaCandidate]
  });

  const gammaControl = page.controls.find(control => control.targetRef === gammaCandidate.identity);
  const gammaCollection = page.collections.find(collection => collection.items?.some(item => item.fields[0]?.value === "Gamma"));
  assert.ok(gammaCollection);
  assert.equal(gammaCollection.frameId, "frame-child");
  assert.equal(gammaCollection.frameTargetId, "oopif-target");
  assert.equal(gammaCollection.parentFrameId, "root-frame");
  assert.match(gammaCollection.evidenceRef, /^oopif-target:0:\d+$/u);
  assert.equal(gammaControl.frameTargetId, "oopif-target");
  assert.equal(gammaControl.parentFrameId, "root-frame");
  assert.equal(gammaControl.collectionRef, gammaCollection.ref);
  assert.equal(gammaControl.recordRef, gammaCollection.items[0].ref);
});

test("semantic field roles use explicit itemprop metadata and leave randomized classes unknown", () => {
  const fixture = buildCatalogEvidence();
  const document = fixture.snapshot.documents[0];
  const strings = fixture.snapshot.strings;
  const addString = value => {
    const index = strings.indexOf(value);
    if (index >= 0) return index;
    strings.push(value);
    return strings.length - 1;
  };
  const attributesFor = nodeIndex => {
    const flat = document.nodes.attributes[nodeIndex];
    const pairs = [];
    for (let offset = 0; offset < flat.length; offset += 2) pairs.push([strings[flat[offset]], strings[flat[offset + 1]]]);
    return pairs;
  };
  const setAttribute = (nodeIndex, name, value) => {
    const pairs = attributesFor(nodeIndex).filter(([key]) => key !== name);
    pairs.push([name, value]);
    document.nodes.attributes[nodeIndex] = pairs.flatMap(([key, item]) => [addString(key), addString(item)]);
  };
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex++) {
    const tag = strings[document.nodes.nodeName[nodeIndex]];
    const attributes = Object.fromEntries(attributesFor(nodeIndex));
    if (tag === "H2" && attributes.class === "product-title") setAttribute(nodeIndex, "itemprop", "name");
    if (tag === "SPAN" && attributes.class === "product-price") setAttribute(nodeIndex, "data-price", "present");
  }
  const explicit = compileSemanticPageModel({
    observationId: "observation-itemprop",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates
  });
  const explicitFields = explicit.collections.find(collection => collection.kind === "repeated_dom_structure").items[0].fields;
  assert.ok(explicitFields.some(field => field.semanticRole === "name" && field.semanticRoleStatus === "observed"
    && field.label.value === "name" && field.label.source === "itemprop"));
  assert.ok(explicitFields.some(field => field.semanticRole === "price" && field.semanticRoleStatus === "inferred"
    && field.label.source === "data_attribute_name"));

  const randomized = buildCatalogEvidence();
  const randomDocument = randomized.snapshot.documents[0];
  const randomStrings = randomized.snapshot.strings;
  const titleClassIndex = randomStrings.indexOf("product-title");
  const priceClassIndex = randomStrings.indexOf("product-price");
  randomStrings.push("xk3-91d", "z991-q2m");
  const randomizedTitleClassIndex = randomStrings.length - 2;
  const randomizedPriceClassIndex = randomStrings.length - 1;
  for (let nodeIndex = 0; nodeIndex < randomDocument.nodes.nodeName.length; nodeIndex++) {
    const flat = randomDocument.nodes.attributes[nodeIndex];
    for (let offset = 1; offset < flat.length; offset += 2) {
      if (flat[offset] === titleClassIndex) flat[offset] = randomizedTitleClassIndex;
      if (flat[offset] === priceClassIndex) flat[offset] = randomizedPriceClassIndex;
    }
  }
  const unknown = compileSemanticPageModel({
    observationId: "observation-randomized-class",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: randomized.snapshot,
    candidates: randomized.candidates
  });
  const unknownFields = unknown.collections.find(collection => collection.kind === "repeated_dom_structure").items[0].fields;
  assert.ok(unknownFields.every(field => field.semanticRole === null && field.semanticRoleStatus === "unknown"
    && field.label.status === "unknown"));
});

test("structured microdata binds product fields and details controls without relying on CSS class names", () => {
  const fixture = buildMicrodataCatalogEvidence();
  const page = compileSemanticPageModel({
    observationId: "observation-microdata",
    targetId: "target",
    documentGeneration: 4,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    documentIndex: buildDocumentIndex(fixture.snapshot),
    candidates: fixture.candidates
  });

  const products = page.collections.find(collection => collection.kind === "microdata_product");
  assert.ok(products, "explicit sibling Product itemscopes form a semantic collection");
  assert.equal(products.visibleCount, 2);
  assert.equal(products.completeness, "unknown");
  assert.deepEqual(products.fields.map(field => [field.name, field.semanticRole, field.semanticRoleStatus]), [
    ["name", "name", "observed"],
    ["price", "price", "observed"],
    ["url", "url", "observed"]
  ]);
  const rtx = products.items.find(item => item.fields.find(field => field.name === "name")?.value === "RTX A4000");
  const radeon = products.items.find(item => item.fields.find(field => field.name === "name")?.value === "Radeon Pro W6600");
  assert.ok(rtx && radeon);
  assert.equal(rtx.fields.find(field => field.name === "price").value, "$450");
  assert.equal(radeon.fields.find(field => field.name === "price").value, "$300");
  const rtxLink = page.controls.find(control => control.targetRef === "candidate:rtx:details");
  const radeonLink = page.controls.find(control => control.targetRef === "candidate:radeon:details");
  assert.equal(rtxLink.recordRef, rtx.ref);
  assert.equal(radeonLink.recordRef, radeon.ref);
  assert.ok(rtx.controlRefs.includes(rtxLink.targetRef));
  assert.ok(radeon.controlRefs.includes(radeonLink.targetRef));
  for (const control of page.controls) {
    assert.equal(control.operationMeaning.status, "unknown");
    assert.equal(control.effect, "unknown");
  }
});

test("classless microdata records resolve through the local semantic query path", () => {
  const fixture = buildMicrodataCatalogEvidence({ classless: true });
  const page = compileSemanticPageModel({
    observationId: "observation-classless-query",
    targetId: "target",
    documentGeneration: 9,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates
  });
  const policyInputs = [];
  const result = resolveSemanticQuery(page, "{ products[] { name price } }", {
    authorizeField: field => { policyInputs.push(field); return field.origin === "https://catalog.example"; },
    authorizeRelease: field => field.origin === "https://catalog.example"
  });
  assert.equal(result.status, "available");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.records.map(record => record.values), [
    { name: "RTX A4000", price: "$450" },
    { name: "Radeon Pro W6600", price: "$300" }
  ]);
  assert.equal(result.records[0].provenance.name.resolutionState, "observed");
  assert.equal(policyInputs.length, 2);
});

test("duplicate structured item properties remain unknown instead of selecting an arbitrary value", () => {
  const fixture = buildMicrodataCatalogEvidence({ duplicatePrice: true });
  const page = compileSemanticPageModel({
    observationId: "observation-microdata-ambiguous",
    targetId: "target",
    documentGeneration: 4,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates
  });
  const products = page.collections.find(collection => collection.kind === "microdata_product");
  const rtx = products.items.find(item => item.fields.find(field => field.name === "name")?.value === "RTX A4000");
  const price = rtx.fields.find(field => field.name === "price");
  assert.equal(price.value, "");
  assert.equal(price.status, "unknown");
  assert.equal(price.evidenceRef, null);
  assert.equal(products.fields.find(field => field.name === "price").status, "unknown");
});

test("bounded JSON-LD is retained only as metadata hints and never overrides visible collection values", () => {
  const fixture = buildCatalogEvidence();
  appendJsonLdScript(fixture.snapshot, {
    "@context": "https://schema.org",
    "@graph": [{
      "@type": "Product",
      name: "Conflicting Widget A",
      sku: "widget-a",
      offers: { price: "999.00", priceCurrency: "USD" }
    }]
  });
  const page = compileSemanticPageModel({
    observationId: "observation-jsonld",
    targetId: "target",
    documentGeneration: 8,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates
  });
  assert.equal(page.structuredData.status, "available");
  const product = page.structuredData.hints.find(hint => hint.types.includes("Product"));
  assert.equal(product.status, "metadata_only");
  assert.ok(product.properties.some(field => field.path === "offers.price" && field.value === "999.00"));
  assert.equal(typeof product.scriptRef, "string");
  const visibleValues = page.collections.flatMap(collection => collection.items ?? [])
    .flatMap(item => item.fields.map(field => field.value));
  assert.ok(visibleValues.includes("Widget A"));
  assert.equal(visibleValues.includes("Conflicting Widget A"), false);
});

test("explicit microdata replaces a duplicate class-derived collection for the same records", () => {
  const fixture = buildMicrodataCatalogEvidence({ sharedItemClass: true });
  const page = compileSemanticPageModel({
    observationId: "observation-microdata-deduplicated",
    targetId: "target",
    documentGeneration: 4,
    page: { url: "https://catalog.example/products", title: "Products" },
    domSnapshot: fixture.snapshot,
    candidates: fixture.candidates
  });
  assert.equal(page.collections.filter(collection => collection.kind === "microdata_product").length, 1);
  assert.equal(page.collections.filter(collection => collection.kind === "repeated_dom_structure").length, 0);
  for (const candidate of fixture.candidates) {
    const control = page.controls.find(item => item.targetRef === candidate.identity);
    const record = page.collections[0].items.find(item => item.ref === control.recordRef);
    assert.ok(record);
    assert.ok(record.controlRefs.includes(control.targetRef));
  }
});

test("repeated fields use unique aria-labelledby associations as observed labels", () => {
  const fixture = buildCatalogEvidence();
  const { snapshot } = fixture;
  const document = snapshot.documents[0];
  const strings = snapshot.strings;
  const stringIndex = value => {
    const existing = strings.indexOf(value);
    if (existing >= 0) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const attributesFor = nodeIndex => {
    const flat = document.nodes.attributes[nodeIndex];
    const result = [];
    for (let offset = 0; offset < flat.length; offset += 2) {
      result.push([strings[flat[offset]], strings[flat[offset + 1]]]);
    }
    return result;
  };
  const setAttribute = (nodeIndex, name, value) => {
    const entries = attributesFor(nodeIndex).filter(([key]) => key !== name);
    entries.push([name, value]);
    document.nodes.attributes[nodeIndex] = entries.flatMap(([key, item]) => [stringIndex(key), stringIndex(item)]);
  };
  const removeAttribute = (nodeIndex, name) => {
    document.nodes.attributes[nodeIndex] = attributesFor(nodeIndex)
      .filter(([key]) => key !== name)
      .flatMap(([key, item]) => [stringIndex(key), stringIndex(item)]);
  };
  const labelNodeIndexes = [];
  const addLabel = (parentIndex, id, text) => {
    const nodes = document.nodes;
    const nodeIndex = nodes.nodeName.length;
    nodes.nodeName.push(stringIndex("SPAN"));
    nodes.parentIndex.push(parentIndex);
    nodes.attributes.push([stringIndex("id"), stringIndex(id)]);
    nodes.backendNodeId.push(1_000 + nodeIndex);
    nodes.nodeValue.push(stringIndex(""));
    nodes.textValue.push(stringIndex(""));
    document.layout.nodeIndex.push(nodeIndex);
    document.layout.bounds.push([0, 0, 80, 20]);
    const textNodeIndex = nodes.nodeName.length;
    nodes.nodeName.push(stringIndex("#text"));
    nodes.parentIndex.push(nodeIndex);
    nodes.attributes.push([]);
    nodes.backendNodeId.push(2_000 + textNodeIndex);
    nodes.nodeValue.push(stringIndex(text));
    nodes.textValue.push(stringIndex(text));
    document.layout.nodeIndex.push(textNodeIndex);
    document.layout.bounds.push([0, 0, 80, 20]);
    labelNodeIndexes.push(nodeIndex);
  };

  let priceNumber = 0;
  const priceNodeIndexes = [];
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex++) {
    const tag = strings[document.nodes.nodeName[nodeIndex]];
    const attributes = Object.fromEntries(attributesFor(nodeIndex));
    if (tag !== "SPAN" || attributes.class !== "product-price") continue;
    const id = `price-label-${priceNumber}`;
    const valueId = `price-value-${priceNumber}`;
    priceNodeIndexes.push(nodeIndex);
    setAttribute(nodeIndex, "id", valueId);
    setAttribute(nodeIndex, "aria-labelledby", id);
    setAttribute(nodeIndex, "class", "x41-random");
    addLabel(document.nodes.parentIndex[nodeIndex], id, "Sale price");
    priceNumber++;
  }

  const page = compileSemanticPageModel({
    observationId: "observation-labelled-fields",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: snapshot,
    candidates: fixture.candidates
  });
  const priceFields = page.collections.find(collection => collection.kind === "repeated_dom_structure").items
    .map(item => item.fields.find(field => field.label?.source === "aria_labelledby"));
  assert.equal(priceFields.length, 2);
  assert.ok(priceFields.every(field => field.semanticRole === "price" && field.semanticRoleStatus === "inferred"
    && field.label.value === "Sale price" && field.label.status === "observed"));

  setAttribute(labelNodeIndexes[1], "id", "price-label-0");
  const duplicateIdPage = compileSemanticPageModel({
    observationId: "observation-duplicate-label-id",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: snapshot,
    candidates: fixture.candidates
  });
  const ambiguousFields = duplicateIdPage.collections.find(collection => collection.kind === "repeated_dom_structure").items
    .flatMap(item => item.fields.filter(field => field.value.startsWith("$")));
  assert.equal(ambiguousFields.length, 2);
  assert.ok(ambiguousFields.every(field => field.semanticRole === null && field.semanticRoleStatus === "unknown"
    && field.label.status === "unknown"));

  for (const [index, labelNodeIndex] of labelNodeIndexes.entries()) {
    document.nodes.nodeName[labelNodeIndex] = stringIndex("LABEL");
    setAttribute(labelNodeIndex, "for", `price-value-${index}`);
    removeAttribute(labelNodeIndex, "id");
    removeAttribute(priceNodeIndexes[index], "aria-labelledby");
  }
  const labelForPage = compileSemanticPageModel({
    observationId: "observation-label-for",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: snapshot,
    candidates: fixture.candidates
  });
  const labelForFields = labelForPage.collections.find(collection => collection.kind === "repeated_dom_structure").items
    .map(item => item.fields.find(field => field.label?.source === "html_label_for"));
  assert.equal(labelForFields.length, 2);
  assert.ok(labelForFields.every(field => field.semanticRole === "price" && field.label.value === "Sale price"));
});

test("repeated definition-list values bind to their preceding observed terms", () => {
  const strings = [];
  const stringIds = new Map();
  const stringIndex = value => {
    if (!stringIds.has(value)) {
      stringIds.set(value, strings.length);
      strings.push(value);
    }
    return stringIds.get(value);
  };
  const nodes = [];
  const add = (tag, parentIndex, attributes = {}, text = "") => {
    const index = nodes.length;
    nodes.push({
      nodeName: stringIndex(tag),
      parentIndex,
      attributes: Object.entries(attributes).flatMap(([name, value]) => [stringIndex(name), stringIndex(value)]),
      backendNodeId: index + 1,
      nodeValue: stringIndex(text),
      textValue: stringIndex(text)
    });
    return index;
  };
  const root = add("#document", -1);
  const collection = add("DIV", root, { class: "catalog" });
  for (const price of ["$10", "$20"]) {
    const item = add("ARTICLE", collection, { class: "product-card" });
    const list = add("DL", item);
    const term = add("DT", list);
    add("#text", term, {}, "Price");
    const value = add("DD", list, { class: "unstable-f41" });
    add("#text", value, {}, price);
  }
  const snapshot = {
    strings,
    documents: [{
      frameId: stringIndex("frame-main"),
      nodes: {
        nodeName: nodes.map(node => node.nodeName),
        nodeValue: nodes.map(node => node.nodeValue),
        textValue: nodes.map(node => node.textValue),
        parentIndex: nodes.map(node => node.parentIndex),
        attributes: nodes.map(node => node.attributes),
        backendNodeId: nodes.map(node => node.backendNodeId)
      },
      layout: { nodeIndex: nodes.map((_, index) => index), bounds: nodes.map(() => [0, 0, 80, 20]) }
    }]
  };
  const page = compileSemanticPageModel({
    observationId: "observation-description-list",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/products", title: "Catalog" },
    domSnapshot: snapshot
  });
  const fields = page.collections.find(item => item.kind === "repeated_dom_structure")?.items
    .map(item => item.fields[0]);
  assert.equal(fields?.length, 2);
  assert.ok(fields.every(field => field.semanticRole === "price" && field.semanticRoleStatus === "inferred"
    && field.label.value === "Price" && field.label.source === "description_term"));
});

test("semantic control type prefers native input attributes when accessibility roles are generic", () => {
  const page = compileSemanticPageModel({
    observationId: "observation-checkbox",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://example.test/", title: "Preferences" },
    domSnapshot: { strings: [], documents: [] },
    candidates: [{ identity: "checkbox-1", role: "button", tag: "input", type: "checkbox", name: "Enable setting" }]
  });
  assert.equal(page.controls[0].classification.value, "checkbox");
});

test("semantic interactions describe browser mechanics without implying authorization or unsafe control behavior", () => {
  const page = compileSemanticPageModel({
    observationId: "observation-interactions",
    targetId: "target",
    documentGeneration: 1,
    page: { url: "https://example.test/catalog", title: "Catalog" },
    domSnapshot: { strings: [], documents: [] },
    candidates: [
      { identity: "safe_search", role: "searchbox", tag: "input", type: "search", name: "Search", visible: true, disabled: false },
      { identity: "password", role: "textbox", tag: "input", type: "password", name: "Password", visible: true, disabled: false },
      { identity: "script_link", role: "link", tag: "a", href: "javascript:alert(1)", name: "Open", visible: true, disabled: false },
      { identity: "disabled_select", role: "combobox", tag: "select", name: "Category", visible: true, disabled: true },
      { identity: "submit", role: "button", tag: "button", name: "Save", visible: true, disabled: false, submitsForm: true }
    ]
  });
  const controls = new Map(page.controls.map(control => [control.targetRef, control]));
  assert.equal(controls.get("safe_search").interaction.mechanic, "enter_text");
  assert.equal(controls.get("password").interaction.mechanic, "unknown");
  assert.equal(controls.get("script_link").interaction.mechanic, "unknown");
  assert.deepEqual(controls.get("disabled_select").interaction, {
    mechanic: "choose_option",
    readiness: "disabled",
    evidence: "native_dom_accessibility_semantics"
  });
  assert.equal(controls.get("submit").interaction.mechanic, "submit_form");
  for (const control of page.controls) {
    assert.equal(control.operationMeaning.status, "unknown");
    assert.equal(control.effect, "unknown");
  }
});

test("task-local candidate ranking finds a late target and keeps its same-region competitor", () => {
  const candidates = Array.from({ length: 248 }, (_, index) => ({
    identity: `navigation_${index}`,
    role: "link",
    tag: "a",
    name: `Navigation item ${index}`,
    contextName: null,
    visible: true
  }));
  candidates.push(
    { identity: "target_save", role: "button", tag: "button", name: "Save item", contextName: "Widget card", visible: true },
    { identity: "competitor_remove", role: "button", tag: "button", name: "Remove item", contextName: "Widget card", visible: true }
  );

  const result = rankInteractionCandidates(candidates, "save widget", { maxCandidates: 200 });
  assert.equal(result.candidates[0].identity, "target_save");
  assert.ok(result.candidates.some(candidate => candidate.identity === "competitor_remove"));
  assert.equal(result.pageCandidateCount, 250);
  assert.equal(result.pageCoverage, "partial");
  assert.equal(result.scopeCoverage, "complete");
  assert.equal(result.scopeCandidateCount, 2);
});

test("task-local candidate ranking uses record context and retains controls from the matched record", () => {
  const candidates = [
    { identity: "view", role: "link", tag: "a", name: "View details", recordContext: "RTX A4000 graphics card $450", visible: true },
    { identity: "save", role: "button", tag: "button", name: "Save item", recordContext: "RTX A4000 graphics card $450", visible: true },
    { identity: "other", role: "link", tag: "a", name: "View details", recordContext: "AMD Radeon workstation $500", visible: true }
  ];
  const result = rankInteractionCandidates(candidates, "open the RTX A4000 product", { maxCandidates: 2 });
  assert.deepEqual(result.candidates.map(candidate => candidate.identity), ["view", "save"]);
  assert.equal(result.selectionScope, "task_relevant_region");
  assert.equal(result.scopeCandidateCount, 2);
  assert.equal(result.scopeCoverage, "complete");
});

test("task candidate ranking reports incomplete when a relevant region exceeds its bound", () => {
  const candidates = Array.from({ length: 201 }, (_, index) => ({
    identity: `save_${index}`,
    role: "button",
    tag: "button",
    name: "Save widget",
    contextName: "Widget card",
    visible: true
  }));
  const result = rankInteractionCandidates(candidates, "save widget", { maxCandidates: 200 });
  assert.equal(result.taskRelevantCandidateCount, 201);
  assert.equal(result.scopeCoverage, "incomplete");
  assert.equal(result.returnedScopeCandidateCount, 200);
});

test("bounded task-scope expansion retains every relevant control through the 384-candidate limit", () => {
  const candidates = Array.from({ length: 270 }, (_, index) => ({
    identity: `archive_${index}`,
    role: "link",
    tag: "a",
    name: "Open record",
    contextName: "Archived records",
    visible: true
  }));
  const result = rankInteractionCandidates(candidates, "Open the archived record", { maxCandidates: 384 });
  assert.equal(result.candidates.length, 270);
  assert.equal(result.scopeCandidateCount, 270);
  assert.equal(result.returnedScopeCandidateCount, 270);
  assert.equal(result.scopeCoverage, "complete");
});

test("cross-frame merge preserves candidates already selected inside their task scopes", () => {
  const candidates = [
    { identity: "other", name: "Mars mission result", visible: true },
    { identity: "scoped", name: "Attributes section target", visible: true }
  ];
  const result = rankInteractionCandidates(candidates, "Mars mission", {
    maxCandidates: 1,
    priorityCandidateIdentities: ["scoped"]
  });
  assert.deepEqual(result.candidates.map(candidate => candidate.identity), ["scoped"]);
  assert.equal(result.pageCoverage, "partial");
});
