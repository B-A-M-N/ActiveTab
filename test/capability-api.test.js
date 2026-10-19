import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../src/api/local-server.js";
import { CapabilityRegistry } from "../src/capabilities/capabilityRegistry.js";
import { CapabilityService } from "../src/capabilities/capabilityService.js";
import { CapabilityQualifier } from "../src/capabilities/capabilityQualifier.js";
import { createExtractionWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { loadEnvironmentBinding } from "../src/testing/profiles.js";
import { qualifyExtractionManifest } from "../test-lab/fixtures/extractionQualification.js";

function tableSnapshot(documentUrl) {
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
      documentURL: intern(documentUrl),
      nodes: { nodeName, nodeValue, textValue, parentIndex, attributes },
      layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
    }]
  };
}

test("capability API discovers structure, compiles trusted fields, qualifies, and lists reusable recipes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-capability-api-"));
  const profilesDirectory = fileURLToPath(new URL("../profiles/", import.meta.url));
  const environment = await loadEnvironmentBinding(profilesDirectory, "freeinference-staging");
  let currentPageUrl = "https://staging.freeinference.org/dashboard/admin/users";
  const apiRequestUrl = new URL("/api/products", currentPageUrl).href;
  const snapshot = tableSnapshot(currentPageUrl);
  const session = {
    attached: true,
    target: { id: "authorized-fixture-target", url: currentPageUrl },
    documentGeneration: 1,
    async observe() {
      return { evidenceId: "observation-api", targetId: "authorized-fixture-target", documentGeneration: 1, page: { url: currentPageUrl, title: "Products" } };
    },
    observer: {
      getEvidence() {
        return {
          status: "available",
          domSnapshot: snapshot,
          networkActivity: [{
            requestId: "shop-api-request",
            url: apiRequestUrl,
            method: "GET",
            status: 200,
            mimeType: "application/json",
            resourceType: "Fetch",
            finishedAt: 1.5
          }]
        };
      },
      async inspectNetworkResponse(evidenceId, options) {
        assert.equal(evidenceId, "observation-api");
        assert.equal(options.requestId, "shop-api-request");
        return {
          status: "available",
          request: { requestId: "shop-api-request", url: apiRequestUrl, method: "GET", status: 200, mimeType: "application/json", resourceType: "Fetch" },
          responseBody: { status: "included", format: "json", hasMore: false, data: JSON.stringify({ items: [{ id: 1, name: "Widget A" }] }), credentialRedactions: 0, credentialDetails: { items: [], omitted: 0 } }
        };
      }
    },
    async close() {}
  };
  const registry = await new CapabilityRegistry({ directory: join(directory, "capabilities") }).init();
  const capabilityService = new CapabilityService({
    registry,
    qualifier: new CapabilityQualifier({ runQualification: qualifyExtractionManifest }),
    classifyField: () => "public",
    authorizeRead: () => true,
    authorizeRelease: () => true
  });
  let runCalls = 0;
  const navigationRunner = {
    async run() { runCalls++; return { status: "failed", output: { reason: "unused in this contract test" } }; },
    async discoverCapabilities() { return capabilityService.discover({ session, environment, principalId: "local_api_automation" }); },
    async readObservedRecords(input) { return capabilityService.readObservedRecords({ ...input, session, environment, principalId: "local_api_automation" }); },
    async discoverObservedApis() { return capabilityService.discoverObservedApis({ session, environment, principalId: "local_api_automation" }); },
    async inspectObservedApi(candidateId) { return capabilityService.inspectObservedApi(candidateId, { session, environment, principalId: "local_api_automation" }); },
    async qualifyObservedApi(candidateId, options) { return capabilityService.qualifyObservedApi(candidateId, { ...options, principalId: "local_api_automation" }); },
    async compileCapability(input) { return capabilityService.compile({ ...input, session, environment, principalId: "local_api_automation" }); },
    async qualifyCapability(recipeId, options) { return capabilityService.qualify(recipeId, { ...options, session, environment, principalId: "local_api_automation" }); },
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
    assert.equal(discovery.body.candidates[0].applicationId, "fi-admin");
    assert.equal(discovery.body.candidates[0].pagePath, "/dashboard/admin/users");
    assert.equal(JSON.stringify(discovery.body).includes("Widget A"), false);

    const observedRead = await call("POST", "/v3/capabilities/read", {
      candidate_id: discovery.body.candidates[0].candidateId,
      fields: [
        { name: "name", sourceHeader: "Name", type: "string", required: true },
        { name: "price", sourceHeader: "Price", type: "number", required: true }
      ],
      max_records: 10,
      unique_by: ["name"]
    });
    assert.equal(observedRead.status, 200);
    assert.equal(observedRead.body.status, "observed_partial");
    assert.deepEqual(observedRead.body.records, [{ name: "Widget A", price: 1.25 }, { name: "Widget B", price: 2.5 }]);
    assert.equal(observedRead.body.verification.completenessClaimed, false);
    assert.equal(registry.list().length, 0, "one-shot reads do not register reusable capabilities");

    const apiDiscovery = await call("POST", "/v3/capabilities/network/discover", {});
    assert.equal(apiDiscovery.status, 200);
    assert.equal(apiDiscovery.body.candidates[0].endpointPath, "/api/products");
    const inspectedApi = await call("POST", `/v3/capabilities/network/candidates/${apiDiscovery.body.candidates[0].candidateId}/inspect`, {});
    assert.equal(inspectedApi.status, 200);
    assert.equal(inspectedApi.body.candidates[0].fields.find(field => field.name === "name").type, "string");
    assert.equal(JSON.stringify(inspectedApi.body).includes("Widget A"), false);
    const apiQualification = await call("POST", `/v3/capabilities/network/candidates/${inspectedApi.body.candidates[0].candidateId}/qualify`, { variants: 3 });
    assert.equal(apiQualification.status, 200);
    assert.equal(apiQualification.body.status, "unavailable", "API qualification stays unavailable without an independent API fixture oracle");

    const candidateId = discovery.body.candidates[0].candidateId;
    currentPageUrl = "https://staging.freeinference.org/dashboard";
    session.target.url = currentPageUrl;
    await assert.rejects(
      capabilityService.compile({
        candidateId,
        capabilityId: "shop.products",
        fields: [
          { name: "name", sourceHeader: "Name", type: "string", required: true },
          { name: "price", sourceHeader: "Price", type: "number", required: true }
        ],
        maxRecords: 10,
        expectedRecords: 2,
        uniqueBy: ["name"],
        session,
        environment,
        principalId: "local_api_automation"
      }),
      /current route differs/u,
      "compilation refuses a same-origin application change after discovery"
    );
    currentPageUrl = "https://staging.freeinference.org/dashboard/admin/users";
    session.target.url = currentPageUrl;
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
    assert.equal(compiled.body.recipe.applicationId, "fi-admin");
    assert.equal(compiled.body.recipe.pagePath, "/dashboard/admin/users");
    assert.deepEqual(compiled.body.recipe.extractionContract.fields.map(field => field.dataClass), ["public", "public"]);

    currentPageUrl = "https://staging.freeinference.org/dashboard";
    session.target.url = currentPageUrl;
    await assert.rejects(
      capabilityService.qualify(compiled.body.recipeId, { variants: 3, principalId: "local_api_automation", session, environment }),
      /current route differs/u,
      "qualification refuses a same-origin application change after discovery"
    );
    assert.equal(registry.list().length, 0, "a stale candidate is not registered");

    currentPageUrl = "https://staging.freeinference.org/dashboard/admin/users";
    session.target.url = currentPageUrl;
    const qualified = await call("POST", `/v3/capabilities/recipes/${compiled.body.recipeId}/qualify`, { variants: 3 });
    assert.equal(qualified.status, 200);
    assert.equal(qualified.body.status, "qualified");
    const listed = await call("GET", "/v3/capabilities");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].capability_id, "shop.products");
    assert.equal(listed.body.items[0].page_path, "/dashboard/admin/users");
    assert.equal(listed.body.items[0].application_id, "fi-admin");

    currentPageUrl = "https://staging.freeinference.org/dashboard";
    session.target.url = currentPageUrl;
    const workflowCapabilities = createExtractionWorkflowCapabilities({
      registry,
      session,
      environment,
      principalId: "local_api_automation",
      authorizeRelease: () => true,
      assertExecutionLease: async () => {}
    });
    assert.equal(workflowCapabilities.length, 1, "workflow capability binds to the profile route declared by its manifest");
    const workflowExecution = await workflowCapabilities[0].execute();
    assert.equal(workflowExecution.status, "blocked", "MCP/workflow execution refuses a same-origin but different resolved application");
    const wrongRoute = await call("POST", "/v3/bots/templates/local-page-data-extractor/runs", {
      input: { url: "https://staging.freeinference.org/dashboard", capability_id: "shop.products" }
    });
    assert.equal(wrongRoute.status, 400);
    assert.equal(runCalls, 0);

    const revoked = await call("POST", "/v3/capabilities/revoke", {
      capability_id: "shop.products",
      version: 1,
      origin: "https://staging.freeinference.org",
      environment_id: "freeinference-staging",
      application_id: "fi-admin",
      principal_id: "local_api_automation",
      reason_code: "operator_retired"
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status, "revoked");
    assert.equal(registry.resolve("shop.products", {
      capabilityVersion: 1,
      origin: "https://staging.freeinference.org",
      environmentId: "freeinference-staging",
      applicationId: "fi-admin",
      principalId: "local_api_automation"
    }), null);
    const afterRevocation = await call("GET", "/v3/capabilities");
    assert.equal(afterRevocation.body.items.length, 0);
    const reloadedRegistry = await new CapabilityRegistry({ directory: join(directory, "capabilities") }).init();
    assert.equal(reloadedRegistry.resolve("shop.products", {
      capabilityVersion: 1,
      origin: "https://staging.freeinference.org",
      environmentId: "freeinference-staging",
      applicationId: "fi-admin",
      principalId: "local_api_automation"
    }), null, "the API revocation is still effective after registry reload");
    const duplicateRevocation = await call("POST", "/v3/capabilities/revoke", {
      capability_id: "shop.products",
      version: 1,
      origin: "https://staging.freeinference.org",
      environment_id: "freeinference-staging",
      application_id: "fi-admin",
      principal_id: "local_api_automation",
      reason_code: "operator_retired"
    });
    assert.equal(duplicateRevocation.body.status, "already_revoked");
    const incompleteRevocation = await call("POST", "/v3/capabilities/revoke", { capability_id: "shop.products" });
    assert.equal(incompleteRevocation.status, 400, "revocation requires full exact scope, not a capability name alone");
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
