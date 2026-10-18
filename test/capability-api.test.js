import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/local-server.js";
import { CapabilityRegistry } from "../src/capabilities/capabilityRegistry.js";
import { CapabilityService } from "../src/capabilities/capabilityService.js";
import { CapabilityQualifier } from "../src/capabilities/capabilityQualifier.js";
import { qualifyExtractionManifest } from "../test-lab/fixtures/extractionQualification.js";

function tableSnapshot() {
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
  const header = add("TR", add("THEAD", table));
  for (const value of ["Name", "Price"]) {
    const cell = add("TH", header);
    add("#text", cell, value);
  }
  const tbody = add("TBODY", table);
  for (const [name, price] of [["Widget A", "1.25"], ["Widget B", "2.50"]]) {
    const row = add("TR", tbody);
    const nameCell = add("TD", row);
    add("#text", nameCell, name);
    const priceCell = add("TD", row);
    add("#text", priceCell, price);
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

test("capability API discovers structure, compiles trusted fields, qualifies, and lists reusable recipes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-capability-api-"));
  const snapshot = tableSnapshot();
  const session = {
    attached: true,
    target: { id: "authorized-fixture-target" },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "observation-api", documentGeneration: 1, page: { url: "https://shop.example/products", title: "Products" } };
    },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } },
    async close() {}
  };
  const environment = { environmentId: "staging", applications: [{ applicationId: "shop", origin: "https://shop.example" }] };
  const registry = await new CapabilityRegistry({ directory: join(directory, "capabilities") }).init();
  const capabilityService = new CapabilityService({
    registry,
    qualifier: new CapabilityQualifier({ runQualification: qualifyExtractionManifest }),
    classifyField: () => "public"
  });
  let runCalls = 0;
  const navigationRunner = {
    async run() { runCalls++; return { status: "failed", output: { reason: "unused in this contract test" } }; },
    async discoverCapabilities() { return capabilityService.discover({ session, environment, principalId: "local_api_automation" }); },
    async compileCapability(input) { return capabilityService.compile({ ...input, session, environment, principalId: "local_api_automation" }); },
    async qualifyCapability(recipeId, options) { return capabilityService.qualify(recipeId, { ...options, principalId: "local_api_automation" }); },
    listCapabilities() { return registry.list(); }
  };
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(directory, "tasks"),
    navigationRunner,
    capabilityRegistry: registry,
    capabilityService,
    apiToken: "local-test-token"
  });
  try {
    const { url } = await api.start();
    const call = async (method, path, body) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { Authorization: "Bearer local-test-token", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, body: await response.json() };
    };
    const discovery = await call("POST", "/v3/capabilities/discover", {});
    assert.equal(discovery.status, 200);
    assert.equal(discovery.body.candidates.length, 1);
    assert.equal(JSON.stringify(discovery.body).includes("Widget A"), false);
    const candidateId = discovery.body.candidates[0].candidateId;
    const compiled = await call("POST", "/v3/capabilities/compile", {
      candidate_id: candidateId,
      capability_id: "shop.products",
      fields: [
        { name: "name", sourceHeader: "Name", type: "string", required: true, dataClass: "credential" },
        { name: "price", sourceHeader: "Price", type: "number", required: true, dataClass: "credential" }
      ],
      max_records: 10,
      expected_records: 2,
      unique_by: ["name"]
    });
    assert.equal(compiled.status, 200);
    assert.ok(compiled.body.recipeId);
    assert.deepEqual(compiled.body.recipe.extractionContract.fields.map(field => field.dataClass), ["public", "public"]);
    const qualified = await call("POST", `/v3/capabilities/recipes/${compiled.body.recipeId}/qualify`, { variants: 3 });
    assert.equal(qualified.status, 200);
    assert.equal(qualified.body.status, "qualified");
    const listed = await call("GET", "/v3/capabilities");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].capability_id, "shop.products");
    assert.equal(listed.body.items[0].page_path, "/products");
    const wrongRoute = await call("POST", "/v3/bots/templates/local-page-data-extractor/runs", {
      input: { url: "https://shop.example/admin", capability_id: "shop.products" }
    });
    assert.equal(wrongRoute.status, 400);
    assert.equal(runCalls, 0);
  } finally {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability API refuses use without the local API token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-capability-api-auth-"));
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(directory, "tasks"),
    navigationRunner: { async run() { return {}; } },
    apiToken: "local-test-token"
  });
  try {
    const { url } = await api.start();
    const response = await fetch(`${url}/v3/capabilities`);
    assert.equal(response.status, 401);
  } finally {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
