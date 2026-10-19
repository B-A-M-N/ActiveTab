import test from "node:test";
import assert from "node:assert/strict";
import { classifyTaskRequest, isExplicitReadWorkflowRequest, resolveTaskIntent, selectTaskExecutionRoute } from "../src/navigation/taskIntentResolver.js";
import { createGenericWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import { WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";

const capabilities = createGenericWorkflowCapabilities();

test("task request classification selects structural reads before observation without retaining the goal", () => {
  const read = classifyTaskRequest("Read the history section and summarize its main events");
  assert.equal(read.status, "read_candidate");
  assert.equal(read.observationProfile, "structural");
  assert.equal(read.requiresCandidateDiscovery, false);
  assert.equal(read.requiresSemanticCompilation, true);
  assert.equal("goal" in read, false);

  const mixed = classifyTaskRequest("Search for the article, open it, and summarize the history section");
  assert.equal(mixed.observationProfile, "interaction");
  assert.equal(mixed.requiresCandidateDiscovery, true);
  assert.equal(classifyTaskRequest("List visible product prices", { suppliedIntent: { purposeCode: "read" } }).observationProfile, "interaction");
});

test("automatic task routing selects workflow only for guarded reads and typed or compound work", () => {
  const read = classifyTaskRequest("List the visible product names");
  assert.equal(selectTaskExecutionRoute({
    requestedPlannerMode: "auto", classifiedTask: read, trustedCapabilities: [],
    taskResolution: { status: "unresolved", reasonCode: "read_capability_unavailable" }
  }).kind, "unresolved");
  const searchRead = classifyTaskRequest("Search for wildlife and return the titles");
  assert.equal(selectTaskExecutionRoute({
    requestedPlannerMode: "auto", classifiedTask: searchRead, trustedCapabilities: capabilities,
    taskResolution: { status: "resolved" }
  }).kind, "workflow");

  const composite = classifyTaskRequest("Open the catalog and click Buy");
  assert.equal(composite.compoundRequest, true);
  assert.equal(selectTaskExecutionRoute({
    requestedPlannerMode: "auto", classifiedTask: composite, trustedCapabilities: capabilities,
    taskResolution: { status: "unresolved", reasonCode: "task_intent_requires_typed_contract" }
  }).kind, "workflow");

  const registered = classifyTaskRequest("Run the approved catalog operation", {
    suppliedIntent: { purposeCode: "inspect_catalog", outcomeCode: "catalog_checked", cardinality: "compound", requiredCapabilityIds: ["catalog.inspect"] }
  });
  assert.equal(selectTaskExecutionRoute({
    requestedPlannerMode: "auto", classifiedTask: registered,
    trustedCapabilities: [{ id: "catalog.inspect" }], taskResolution: { status: "resolved" }
  }).kind, "workflow");
  assert.equal(selectTaskExecutionRoute({
    requestedPlannerMode: "auto", classifiedTask: registered,
    trustedCapabilities: [], taskResolution: { status: "resolved" }
  }).kind, "unresolved", "caller-supplied IDs do not create trusted capabilities");
});

test("explicit planner modes retain their selected execution route", () => {
  const classifiedTask = classifyTaskRequest("List the visible product names");
  assert.equal(selectTaskExecutionRoute({ requestedPlannerMode: "deterministic", classifiedTask }).kind, "direct_navigation");
  assert.equal(selectTaskExecutionRoute({ requestedPlannerMode: "model", classifiedTask }).kind, "semantic_navigation");
  assert.equal(selectTaskExecutionRoute({ requestedPlannerMode: "workflow", classifiedTask }).kind, "workflow");
});

test("task intent resolver preserves caller typed contracts without reinterpretation", () => {
  const intent = { purposeCode: "navigate", outcomeCode: "route_changed", cardinality: "atomic" };
  const result = resolveTaskIntent({ goal: "Open the account page", suppliedIntent: intent, capabilities });
  assert.equal(result.status, "resolved");
  assert.equal(result.source, "caller_typed");
  assert.equal(result.intent, intent);
});

test("plain navigation goals resolve only to the existing trusted generic link contract", () => {
  const result = resolveTaskIntent({ goal: "Open the public research page", capabilities });
  assert.equal(result.status, "resolved");
  assert.equal(result.source, "trusted_generic_navigation");
  assert.deepEqual(result.intent, {
    purposeCode: "navigate",
    outcomeCode: "route_changed",
    cardinality: "unknown",
    permittedPurposeCodes: ["navigate"],
    targetRoles: [],
    constraints: [],
    requiredCapabilityIds: []
  });
});

test("task intent resolver does not turn extraction or consequential requests into navigation", () => {
  for (const goal of [
    "Open the catalog and extract every price",
    "Go to the account page and submit the payment",
    "Delete the old report"
  ]) {
    assert.equal(resolveTaskIntent({ goal, capabilities }).status, "unresolved", goal);
  }
});

test("explicit read requests are routed to a complete workflow contract", () => {
  for (const goal of [
    "Extract product prices",
    "Read the current weather alerts",
    "Compare the two visible plans",
    "List the names and prices of the products",
    "Return the titles of the search results"
  ]) {
    assert.equal(isExplicitReadWorkflowRequest(goal), true, goal);
  }
  for (const goal of ["Open the research page", "Open the product list", "Search for public weather alerts", "Click the menu"]) {
    assert.equal(isExplicitReadWorkflowRequest(goal), false, goal);
  }
});

test("an ordinary visible-record request resolves only to its trusted ephemeral read capability", () => {
  const readCapability = {
    id: "observed_read_0123456789abcdef",
    action: "extract",
    effectClass: "read",
    targetRole: "observed_records",
    purposeCodes: ["extract_records"],
    postconditionCodes: ["observed_records_returned"],
    outputSchema: [{ name: "name", type: "string", required: true }]
  };
  const result = resolveTaskIntent({
    goal: "List the visible product names",
    capabilities: [readCapability],
    observedReadCapabilityIds: [readCapability.id]
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.source, "trusted_ephemeral_observed_read");
  assert.deepEqual(result.intent, {
    purposeCode: "extract_records",
    outcomeCode: "observed_records_returned",
    cardinality: "atomic",
    permittedPurposeCodes: ["extract_records"],
    targetRoles: ["observed_records"],
    constraints: ["observed_partial"],
    requiredCapabilityIds: [readCapability.id]
  });
  assert.equal(resolveTaskIntent({
    goal: "List the visible product names",
    capabilities: [readCapability]
  }).status, "unresolved", "a caller-provided capability is not trusted unless the engine separately identifies it as its own observed-read projection");
});

test("composite read requests do not collapse to an atomic current-page extraction", () => {
  const readCapability = {
    id: "observed_read_0123456789abcdef",
    action: "extract",
    effectClass: "read",
    targetRole: "observed_records",
    purposeCodes: ["extract_records"],
    postconditionCodes: ["observed_records_returned"],
    outputSchema: [{ name: "price", type: "string", required: true }]
  };
  const supplied = { capabilities: [readCapability], observedReadCapabilityIds: [readCapability.id] };

  const currentPageRead = resolveTaskIntent({ goal: "Return the titles of the search results", ...supplied });
  assert.equal(currentPageRead.status, "resolved");
  assert.equal(currentPageRead.source, "trusted_ephemeral_observed_read");
  assert.equal(currentPageRead.intent.cardinality, "atomic");

  const openAndRead = resolveTaskIntent({ goal: "Open the catalog and list the product prices", ...supplied });
  assert.equal(openAndRead.status, "unresolved");
  assert.equal(openAndRead.reasonCode, "composite_read_requires_workflow_synthesis");

  const searchAndRead = resolveTaskIntent({ goal: "Search for graphics cards and return their prices", ...supplied });
  assert.equal(searchAndRead.status, "unresolved");
  assert.equal(searchAndRead.reasonCode, "search_read_capability_unavailable");

  const searchCapabilities = [
    { id: "observed_public_search_fill", action: "fill", effectClass: "read", targetRole: "public_search_field", requiredInputRef: "activetab_search_query", purposeCodes: ["search_records"] },
    { id: "observed_public_search_submit", action: "click", effectClass: "navigation", targetRole: "public_search_submit", purposeCodes: ["search_records"] }
  ];
  const searchRead = resolveTaskIntent({
    goal: "Search for graphics cards and return their prices",
    capabilities: [readCapability, ...searchCapabilities],
    observedReadCapabilityIds: [readCapability.id],
    searchCapabilityIds: searchCapabilities.map(capability => capability.id)
  });
  assert.equal(searchRead.status, "resolved");
  assert.equal(searchRead.source, "trusted_same_origin_search_and_read");
  assert.equal(searchRead.intent.cardinality, "compound");
  assert.deepEqual(searchRead.intent.requiredCapabilityIds, [
    "observed_public_search_fill", "observed_public_search_submit", readCapability.id
  ]);
  assert.equal(resolveTaskIntent({
    goal: "Search for graphics cards and return their prices",
    capabilities: [readCapability, ...searchCapabilities],
    observedReadCapabilityIds: [readCapability.id]
  }).reasonCode, "search_read_capability_unavailable", "caller metadata alone cannot turn the search into an admitted workflow");

  const rankAndRead = resolveTaskIntent({
    goal: "Find the three cheapest products in this category and give me their prices",
    ...supplied
  });
  assert.equal(rankAndRead.status, "unresolved");
  assert.equal(rankAndRead.reasonCode, "read_requires_unsupported_operation");
});

test("generic navigation inference fails closed when trusted capability contract is missing or duplicated", () => {
  assert.equal(resolveTaskIntent({ goal: "Visit the research page", capabilities: [] }).status, "unresolved");
  assert.equal(resolveTaskIntent({ goal: "Visit the research page", capabilities: [...capabilities, ...capabilities] }).status, "unresolved");
});

test("NavigationEngine resolves an ordinary navigation goal before workflow synthesis", async () => {
  let request;
  let observationOptions;
  const observation = {
    evidenceId: "live_observation_1",
    targetId: "target_1",
    documentGeneration: 1,
    page: { url: "https://research.example/", title: "Research" },
    headings: [{ level: 1, text: "Research" }],
    candidates: [{
      identity: "research_link",
      tag: "a",
      role: "link",
      name: "Research Library",
      contextName: "",
      href: "https://research.example/library",
      visible: true,
      disabled: false
    }],
    scrollTargets: []
  };
  const session = {
    attached: true,
    target: { id: "target_1", endpoint: "http://127.0.0.1:9222" },
    async observe(options) { observationOptions = options; return structuredClone(observation); }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: {
      allowScreenshots: false,
      async synthesize(input) {
        request = input;
        return { status: "unavailable", failureCode: "test_transport" };
      }
    }
  }).run("Open the Research Library");

  assert.equal(request.taskIntent.purposeCode, "navigate");
  assert.equal(request.taskIntent.outcomeCode, "route_changed");
  assert.equal(request.taskIntent.cardinality, "unknown");
  assert.equal(request.selectionGoal, "Open the Research Library");
  assert.equal(observationOptions.profile, "interaction");
  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 0);
});

test("auto routing offers a deferred observed-read capability for composite public goals", async () => {
  const goal = "Open the catalog and return product names and prices";
  const readCapability = {
    id: "observed_read_deferred_0123456789abcdef",
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "observed_records",
    purposeCodes: ["extract_records"],
    preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"],
    verificationCodes: ["observed_records_verified"],
    observedRoles: [],
    observedTags: [],
    outputCompleteness: "observed_partial",
    outputSchema: [
      { name: "name", type: "string", required: true },
      { name: "price", type: "string", required: true }
    ],
    async execute() { throw new Error("synthesis failure should prevent execution"); }
  };
  let synthesisInput;
  const observation = {
    evidenceId: "composite-read-routing-observation",
    targetId: "composite-read-routing-target",
    documentGeneration: 1,
    page: { url: "https://catalog.example/", title: "Catalog" },
    headings: [],
    candidates: [],
    scrollTargets: []
  };
  const session = {
    attached: true,
    target: { id: observation.targetId, endpoint: "remote-cdp", url: observation.page.url },
    async observe() { return observation; }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowSynthesizer: {
      allowScreenshots: false,
      async synthesize(input) {
        synthesisInput = input;
        return { status: "unavailable", failureCode: "test_transport" };
      }
    },
    capabilityService: {
      createDeferredObservedReadWorkflowCapabilities() { return [readCapability]; }
    }
  }).run(goal);

  assert.equal(result.status, "unresolved");
  assert.ok(synthesisInput, "the composite request uses the workflow synthesizer in auto mode");
  assert.equal(synthesisInput.taskIntent, null, "a composite request is not mislabeled as a current-page atomic read");
  assert.ok(synthesisInput.capabilities.some(capability => capability.id === readCapability.id));
  assert.ok(synthesisInput.capabilities.some(capability => capability.intentBinding === "generic_navigation"));
  assert.equal(result.attempts, 0, "unavailable inference does not execute a partial navigation");
});

test("unsupported compound auto requests abstain without dispatching their first navigation step", async () => {
  let clicks = 0;
  let synthesisCalls = 0;
  const session = {
    attached: true,
    target: { id: "unsupported-compound-target", endpoint: "fixture", url: "https://shop.example.test/" },
    async observe() {
      return {
        evidenceId: "unsupported-compound-observation",
        targetId: this.target.id,
        documentGeneration: 1,
        page: { url: this.target.url, title: "Shop" },
        headings: [],
        candidates: [{ identity: "catalog-link", backendNodeId: 1, name: "Catalog", role: "link", tag: "a", href: "https://shop.example.test/catalog", visible: true, disabled: false }],
        scrollTargets: []
      };
    },
    async click() { clicks++; }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowSynthesizer: {
      allowScreenshots: false,
      async synthesize() { synthesisCalls++; return { status: "unavailable", failureCode: "test_transport" }; }
    },
    maxRecoveries: 0
  }).run("Open the catalog and click Buy");

  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 0);
  assert.equal(synthesisCalls, 1, "auto resolves compound tasks through trusted workflow machinery");
  assert.equal(clicks, 0, "synthesis failure cannot fall back to a partial navigation");
  assert.match(result.reason, /no action was selected/u);
});

test("auto routing composes a private exact search binding with an observed partial read contract", async () => {
  const query = "unusual public search phrase";
  const goal = `Search for ${query} and return their prices`;
  const observed = {
    evidenceId: "search-read-routing-observation",
    targetId: "search-read-routing-target",
    documentGeneration: 1,
    page: { url: "https://search.example/", title: "Search" },
    headings: [],
    candidates: [
      {
        identity: "query-field", backendNodeId: 11, targetId: "search-read-routing-target", documentGeneration: 1,
        tag: "input", type: "search", role: "searchbox", name: "Search", visible: true, disabled: false,
        readOnly: false, formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example",
        formTargetSameContext: true
      },
      {
        identity: "submit-search", backendNodeId: 12, targetId: "search-read-routing-target", documentGeneration: 1,
        tag: "button", role: "button", name: "Search", visible: true, disabled: false, submitsForm: true,
        formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example", formTargetSameContext: true
      }
    ],
    scrollTargets: []
  };
  let readExecutionCalls = 0;
  const readCapability = {
    id: "observed_read_deferred_0123456789abcdef",
    action: "extract", effectClass: "read", intentBinding: "caller_required", targetRole: "observed_records",
    purposeCodes: ["extract_records"], preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"], verificationCodes: ["observed_records_verified"],
    observedRoles: [], observedTags: [], outputCompleteness: "observed_partial",
    outputSchema: [{ name: "price", type: "string", required: true }],
    async execute() { readExecutionCalls++; throw new Error("unverified search results must not be extracted"); }
  };
  let providerRequest;
  let readRequestText;
  const plan = {
    version: 1,
    steps: [
      { id: "read_results", capabilityId: readCapability.id, targetRole: "observed_records", dependsOn: [], verifyCode: "observed_records_verified", onMissing: "stop" },
      { id: "fill_query", capabilityId: "observed_public_search_fill", targetRole: "public_search_field", inputRef: "activetab_search_query_2", dependsOn: [], verifyCode: "exact_search_query_observed", onMissing: "stop" },
      { id: "submit_query", capabilityId: "observed_public_search_submit", targetRole: "public_search_submit", dependsOn: ["fill_query"], verifyCode: "search_results_observed", onMissing: "stop" }
    ]
  };
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: false,
    provider: { async requestStructured(request) {
      providerRequest = request;
      return { result: plan };
    } }
  });
  const session = {
    attached: true,
    target: { id: observed.targetId, endpoint: "remote-cdp", url: observed.page.url },
    documentGeneration: 1,
    async observe() { return structuredClone(observed); }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowInputs: { activetab_search_query: "caller-owned existing input" },
    workflowSynthesizer: synthesizer,
    capabilityService: {
      createDeferredObservedReadWorkflowCapabilities({ goal: readGoal } = {}) { readRequestText = readGoal; return [readCapability]; }
    },
    principalId: "test_principal"
  }).run(goal);

  assert.equal(providerRequest.input.task.cardinality, "compound");
  assert.deepEqual(providerRequest.input.task.requiredCapabilityIds, [
    "observed_public_search_fill", "observed_public_search_submit", readCapability.id
  ]);
  assert.deepEqual(providerRequest.input.task.inputRefs, ["activetab_search_query", "activetab_search_query_2"]);
  assert.equal(providerRequest.input.trustedCapabilities.find(capability => capability.id === "observed_public_search_fill").requiredInputRef, "activetab_search_query_2");
  assert.equal(JSON.stringify(providerRequest.input).includes(query), false);
  assert.equal(readRequestText, "their prices", "the search terms do not get interpreted as requested output fields");
  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 0);
  assert.equal(readExecutionCalls, 0, "a model plan cannot extract preexisting page content before this run verifies the requested search");
});
