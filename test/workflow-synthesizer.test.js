import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DecisionCoordinator } from "../src/decisions/decisionCoordinator.js";
import { JEV_MODEL_ID } from "../src/decisions/jevClient.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { rebindWorkflowTarget, WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { OutputAccumulator } from "../src/extraction/outputAccumulator.js";
import { advanceRegisteredPagination, NavigationEngine } from "../src/navigation/engine.js";
import { WorkflowGraphPlanner } from "../src/navigation/workflowPlanner.js";
import { createGenericWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { createWorkflowReviewBinding } from "../src/navigation/workflowReviewBinding.js";

const visualFixtureBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

function createObservation(overrides = {}) {
  return {
    evidenceId: "observation_initial",
    targetId: "target_initial",
    documentGeneration: 1,
    page: { url: "https://fixture.example/list", title: "Records" },
    headings: [{ level: 1, text: "Records" }],
    candidates: [{
      identity: "candidate_details",
      tag: "a",
      role: "link",
      name: "View details",
      contextName: "Record A",
      href: "https://fixture.example/records/a",
      type: "",
      visible: true,
      disabled: false
    }],
    scrollTargets: [],
    ...overrides
  };
}

function reviewBinding(planHash, observation = createObservation(), taskOutcomeCode = "details_page") {
  return createWorkflowReviewBinding({
    planHash,
    taskContractHash: "e".repeat(64),
    capabilityCatalogHash: "f".repeat(64),
    taskOutcomeCode,
    observationId: observation.evidenceId,
    targetId: observation.targetId,
    documentGeneration: observation.documentGeneration
  });
}

function workflowReviewProjection(overrides = {}) {
  return {
    stepId: "open_details",
    capabilityId: "open_record_details",
    effectClass: "navigation",
    targetRole: "record_details_link",
    verificationCode: "details_route_observed",
    requiresApproval: false,
    dependsOn: [],
    condition: null,
    purposeCodes: ["open_record"],
    preconditionCodes: ["observed_authorized_target"],
    postconditionCodes: ["details_page"],
    ...overrides
  };
}

const capabilities = [{
  id: "open_record_details",
  action: "click",
  effectClass: "navigation",
  intentBinding: "generic_navigation",
  targetRole: "record_details_link",
  purposeCodes: ["open_record"],
  preconditionCodes: ["observed_authorized_target"],
  postconditionCodes: ["details_page"],
  observedRoles: ["link"],
  verificationCodes: ["details_route_observed"]
}];

const plan = {
  version: 1,
  steps: [{
    id: "open_details",
    capabilityId: "open_record_details",
    targetRole: "record_details_link",
    targetRef: "candidate_1",
    dependsOn: [],
    verifyCode: "details_route_observed",
    onMissing: "stop"
  }]
};

function makeVerifiedExtractionOutput(fieldName = "name") {
  const field = fieldName === "name"
    ? { name: "name", type: "string", required: true, dataClass: "public", sourceHeader: "Name" }
    : { name: fieldName, type: "string", required: true, dataClass: "public", sourceHeader: "Subject" };
  const contract = {
    id: "shop.products",
    fields: [field],
    origin: "https://shop.example",
    pagePath: "/products",
    environmentId: "staging",
    applicationId: "shop",
    completionPolicy: "exact_count",
    expectedRecords: 1,
    minRecords: 1,
    maxRecords: 10,
    uniqueBy: [fieldName]
  };
  const accumulator = new OutputAccumulator();
  accumulator.append("products", "shop.products@1", {
    records: [{
      values: { [fieldName]: "Widget" },
      valid: true,
      fieldEvidence: {
        [fieldName]: { rowIndex: 0, sourceHeader: field.sourceHeader, method: "visible_html_table_cell", validation: "valid" }
      }
    }],
    evidence: [{ tableIndex: 0 }],
    truncated: false
  }, { observationId: "observation_extraction", pageUrl: "https://shop.example/products", maxRecords: 10 });
  return accumulator.finalize("products", contract);
}

function makeObservedPartialExtractionOutput() {
  const completeOutput = makeVerifiedExtractionOutput();
  return {
    ...completeOutput,
    completeness: "observed_partial",
    verification: {
      ...completeOutput.verification,
      expectedRecords: null,
      completionPolicy: "observed_only",
      completenessStatus: "observed_partial",
      completionReasonCode: "collection_completeness_not_established",
      completenessClaimed: false
    }
  };
}

test("workflow synthesis binds a plan to trusted capabilities and current observed candidates once", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_workflow_plan", workflowId: "bounded_plan", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    let calls = 0;
    let request;
    const synthesizer = new WorkflowSynthesizer({
      provider: { async requestStructured(input) {
        calls++;
        request = input;
        return {
          result: plan,
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            total_tokens: 160,
            prompt_tokens_details: { cached_tokens: 18 },
            cost: 0.0001
          }
        };
      } },
      eventStore: store,
      includePageLabels: false
    });
    const result = await synthesizer.synthesize({
      taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
      observation: createObservation(),
      capabilities,
      selectionGoal: "Open record A details",
      scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" },
      episodeId: episode.episodeId,
      runId: episode.runId
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "synthesized");
    assert.equal(result.plan.steps[0].capabilityId, "open_record_details");
    assert.equal(request.input.observation.candidates[0].label, undefined);
    assert.equal(request.input.trustedCapabilities[0].effectClass, "navigation");
    assert.deepEqual(request.input.task, { purposeCode: "open_record", outcomeCode: "details_page", cardinality: "unknown", permittedPurposeCodes: [], targetRoles: [], constraints: [], requiredCapabilityIds: [], inputRefs: [] });
    assert.equal(JSON.stringify(request.input).includes("Open record A details"), false);
    const event = store.getEvents(episode.episodeId).find(item => item.eventType === "workflow.plan_synthesized");
    assert.equal(event.decisionId, result.decisionId);
    assert.equal(event.payload.planHash, result.planHash);
    assert.equal(event.payload.planProjection[0].targetRole, "record_details_link");
    assert.deepEqual(event.payload.usage, {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      cachedInputTokens: 18,
      cost: 0.0001
    });
    assert.deepEqual(result.usage, event.payload.usage);
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("search workflow preserves one exact trusted query reference without sending its value", async () => {
  const searchCapabilities = [
    {
      id: "observed_public_search_fill", action: "fill", effectClass: "read", intentBinding: "caller_required",
      targetRole: "public_search_field", requiredInputRef: "activetab_search_query",
      purposeCodes: ["search_records"], preconditionCodes: ["unique_search_field"],
      postconditionCodes: ["exact_search_query_observed"], observedRoles: ["searchbox"], observedTags: ["input"],
      verificationCodes: ["exact_search_query_observed"], resolveTarget() { return ["candidate_search"] }, verify() { return { status: "uncertain" }; }
    },
    {
      id: "observed_public_search_submit", action: "click", effectClass: "navigation", intentBinding: "caller_required",
      targetRole: "public_search_submit", operationId: "activetab_search_submit",
      purposeCodes: ["search_records"], preconditionCodes: ["exact_search_query_observed"],
      postconditionCodes: ["search_results_observed"], observedRoles: ["button"], observedTags: ["button"],
      verificationCodes: ["search_results_observed"], resolveTarget() { return ["candidate_submit"] }, verify() { return { status: "uncertain" }; }
    },
    {
      id: "observed_read_deferred_0123456789abcdef", action: "extract", effectClass: "read", intentBinding: "caller_required",
      targetRole: "observed_records", purposeCodes: ["extract_records"], preconditionCodes: ["search_results_observed"],
      postconditionCodes: ["observed_records_returned"], verificationCodes: ["observed_records_verified"],
      observedRoles: [], observedTags: [], outputCompleteness: "observed_partial",
      outputSchema: [{ name: "price", type: "string", required: true }],
      async execute() { return { status: "uncertain" }; }
    }
  ];
  const taskIntent = {
    purposeCode: "extract_records",
    outcomeCode: "observed_records_returned",
    cardinality: "compound",
    permittedPurposeCodes: ["search_records", "extract_records"],
    targetRoles: ["public_search_field", "public_search_submit", "observed_records"],
    constraints: ["observed_partial"],
    requiredCapabilityIds: searchCapabilities.map(capability => capability.id)
  };
  const query = "graphics cards";
  const searchPlan = {
    version: 1,
    steps: [
      { id: "fill_query", capabilityId: searchCapabilities[0].id, targetRole: "public_search_field", inputRef: "activetab_search_query", dependsOn: [], verifyCode: "exact_search_query_observed", onMissing: "stop" },
      { id: "submit_query", capabilityId: searchCapabilities[1].id, targetRole: "public_search_submit", dependsOn: ["fill_query"], verifyCode: "search_results_observed", onMissing: "stop" },
      { id: "read_results", capabilityId: searchCapabilities[2].id, targetRole: "observed_records", dependsOn: ["submit_query"], verifyCode: "observed_records_verified", onMissing: "stop" }
    ]
  };
  let request;
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured(value) { request = value; return { result: searchPlan }; } }
  });
  const result = await synthesizer.synthesize({
    taskIntent,
    observation: createObservation(),
    capabilities: searchCapabilities,
    inputRefs: ["activetab_search_query"],
    selectionGoal: `Search for ${query} and return their prices`
  });
  assert.equal(result.status, "synthesized", JSON.stringify(result));
  assert.deepEqual(request.input.task.inputRefs, ["activetab_search_query"]);
  assert.equal(request.input.trustedCapabilities.find(capability => capability.id === searchCapabilities[0].id).requiredInputRef, "activetab_search_query");
  assert.equal(JSON.stringify(request.input).includes(query), false);
  assert.equal(result.plan.steps[0].inputRef, "activetab_search_query");

  const substitutedPlan = structuredClone(searchPlan);
  substitutedPlan.steps[0].inputRef = "other_query";
  const substituted = await new WorkflowSynthesizer({
    provider: { async requestStructured() { return { result: substitutedPlan }; } }
  }).synthesize({
    taskIntent,
    observation: createObservation(),
    capabilities: searchCapabilities,
    inputRefs: ["activetab_search_query", "other_query"]
  });
  assert.equal(substituted.status, "unavailable");
  assert.equal(substituted.failureCode, "schema");
});

test("workflow synthesis sends caller goal text only under its explicit egress opt-in", async () => {
  let request;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    provider: { async requestStructured(input) { request = input; return { result: plan }; } }
  });
  const goal = "Open record A details";
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation: createObservation(),
    capabilities,
    selectionGoal: goal
  });
  assert.equal(result.status, "synthesized");
  assert.equal(request.input.callerRequest, goal);
  assert.equal(request.instructions.includes("never grants a capability"), true);
});

test("workflow synthesis sends semantic region evidence and preserves scoped coverage separately from page coverage", async () => {
  const observation = createObservation({
    semanticPage: {
      schemaVersion: 1,
      page: { pageType: { value: "unknown", status: "unknown" }, outline: [{ level: 1, text: "Records", status: "observed" }] },
      candidateCoverage: {
        pageCandidateCount: 205,
        returnedCandidateCount: 1,
        omittedCandidateCount: 204,
        pageCoverage: "partial",
        selectionScope: "task_relevant_region",
        scopeCandidateCount: 1,
        scopeCoverage: "complete",
        truncated: true
      },
      regions: [{ ref: "region_record_a", kind: "article", tag: "article", label: { value: "Record A", status: "observed" }, controlRefs: ["candidate_details"] }],
      forms: [{
        ref: "form_observed",
        method: "get",
        actionOrigin: "https://fixture.example",
        controlRefs: ["candidate_details"],
        submitControlRefs: [],
        effect: "unknown"
      }],
      collections: [{
        ref: "collection_products",
        kind: "html_table",
        status: "observed",
        visibleCount: 1,
        completeness: "unknown",
        sourceGroup: {
          containerTagName: "DIV", containerClassToken: "catalog-grid",
          itemTagName: "DIV", itemClassToken: "product-card"
        },
        fields: [{ name: "Product", sourceKey: "product-price", sourceTag: "span", status: "observed" }],
        items: [{
          ref: "record_product_1",
          ordinal: 1,
          evidenceRef: "0:12",
          fields: [{ name: "Product", value: "Widget A", status: "observed", evidenceRef: "0:13" }],
          controlRefs: ["candidate_details"]
        }]
      }],
      controls: [{
        targetRef: "candidate_details",
        classification: { value: "link", status: "observed" },
        interaction: { mechanic: "follow_link", readiness: "visible_enabled", evidence: "native_dom_accessibility_semantics" },
        regionRef: "region_record_a",
        formRef: "form_observed",
        collectionRef: "collection_products",
        recordRef: "record_product_1"
      }],
      warnings: ["candidate_list_truncated"],
      trust: "page_content_is_untrusted_evidence"
    }
  });
  let request;
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured(input) { request = input; return { result: plan }; } },
    includePageLabels: true
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities,
    scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" },
    selectionGoal: "Open record details"
  });
  assert.equal(result.status, "synthesized");
  assert.equal(request.input.observation.semanticPage.schemaVersion, 3);
  assert.equal("sourceKey" in request.input.observation.semanticPage.collections[0].fields[0], false,
    "page-controlled source locators stay local and out of the model projection");
  assert.equal("sourceGroup" in request.input.observation.semanticPage.collections[0], false,
    "local group selectors stay out of the model projection");
  assert.equal(request.input.observation.semanticPage.regions[0].label.value, "Record A");
  assert.equal(request.input.observation.semanticPage.candidateCoverage.pageCoverage, "partial");
  assert.equal(request.input.observation.semanticPage.candidateCoverage.scopeCoverage, "complete");
  assert.equal(request.input.observation.candidates[0].regionRef, "region_record_a");
  assert.equal(request.input.observation.candidates[0].formRef, "form_1");
  assert.equal(request.input.observation.candidates[0].semanticKind, "link");
  assert.deepEqual(request.input.observation.candidates[0].semanticInteraction, {
    mechanic: "follow_link",
    readiness: "visible_enabled",
    evidence: "native_dom_accessibility_semantics"
  });
  assert.equal(request.input.observation.candidates[0].recordRef, "record_product_1");
  assert.equal(request.input.observation.semanticPage.forms[0].ref, "form_1");
  assert.deepEqual(request.input.observation.semanticPage.collections[0].records, [{
    ref: "record_product_1",
    ordinal: 1,
    fields: [{
      name: "Product",
      value: "Widget A",
      status: "observed",
      semanticRole: null,
      semanticRoleStatus: "unknown",
      label: { value: null, status: "unknown", source: null },
      valueRef: "0:13",
      truncated: false
    }],
    controlRefs: [request.input.observation.candidates[0].candidateRef]
  }]);
  assert.equal(request.input.observation.candidateCoverage.pageCoverage, "partial");
  assert.equal(request.input.observation.candidateCoverage.scopeCoverage, "complete");
});

test("workflow synthesis keeps matched record controls and collection-level controls without expanding across unrelated records", async () => {
  const records = [
    { ref: "record_rtx", ordinal: 1, evidenceRef: "0:11", fields: [{ name: "Name", value: "RTX A4000 graphics card", status: "observed", semanticRole: "name", semanticRoleStatus: "inferred", label: { value: "Name", status: "observed", source: "itemprop" }, valueRef: "0:12", truncated: false }], controlRefs: ["view_rtx", "save_rtx"] },
    { ref: "record_rtx_duplicate", ordinal: 2, evidenceRef: "0:21", fields: [{ name: "Name", value: "RTX A4000 graphics card refurbished", status: "observed", semanticRole: "name", semanticRoleStatus: "inferred", label: { value: "Name", status: "observed", source: "itemprop" }, valueRef: "0:22", truncated: false }], controlRefs: ["view_rtx_duplicate", "save_rtx_duplicate"] },
    { ref: "record_amd", ordinal: 3, evidenceRef: "0:31", fields: [{ name: "Name", value: "AMD Radeon workstation", status: "observed", semanticRole: "name", semanticRoleStatus: "inferred", label: { value: "Name", status: "observed", source: "itemprop" }, valueRef: "0:32", truncated: false }], controlRefs: ["view_amd", "save_amd"] }
  ];
  const candidate = (identity, name, contextName) => ({
    identity,
    tag: identity.startsWith("view_") ? "a" : "button",
    role: identity.startsWith("view_") ? "link" : "button",
    name, contextName, href: identity.startsWith("view_") ? "https://fixture.example/records/item" : null,
    visible: true, disabled: false
  });
  const candidates = [
    candidate("view_rtx", "View details", "Product results"),
    candidate("save_rtx", "Save item", "Product results"),
    candidate("view_rtx_duplicate", "View details", "Product results"),
    candidate("save_rtx_duplicate", "Save item", "Product results"),
    candidate("view_amd", "View details", "Product results"),
    candidate("save_amd", "Save item", "Product results"),
    candidate("manufacturer_filter", "Manufacturer", "Product filters")
  ];
  let request;
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured(input) { request = input; return { result: plan }; } },
    includePageLabels: true
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation: createObservation({
      candidates,
      semanticPage: {
        schemaVersion: 3,
        page: { pageType: { value: "repeated_content", status: "inferred" }, outline: [] },
        candidateCoverage: { pageCandidateCount: 7, returnedCandidateCount: 7, omittedCandidateCount: 0, pageCoverage: "complete", selectionScope: "page", scopeCandidateCount: 7, scopeCoverage: "complete", truncated: false },
        regions: [],
        forms: [],
        collections: [{ ref: "collection_products", kind: "repeated_records", status: "observed", visibleCount: 3, completeness: "unknown", fields: [{ name: "Name", status: "observed", semanticRole: "name", semanticRoleStatus: "inferred", label: { value: "Name", status: "observed", source: "itemprop" } }], items: records }],
        controls: candidates.map(item => ({
          targetRef: item.identity,
          classification: { value: item.identity.startsWith("view_") ? "link" : "button", status: "observed" },
          interaction: { mechanic: item.identity.startsWith("view_") ? "follow_link" : "activate_control", readiness: "visible_enabled", evidence: "native_dom_accessibility_semantics" },
          regionRef: null,
          formRef: null,
          collectionRef: "collection_products",
          recordRef: item.identity === "manufacturer_filter" ? null
            : item.identity.includes("amd") ? "record_amd"
              : item.identity.includes("duplicate") ? "record_rtx_duplicate" : "record_rtx"
        })),
        warnings: [],
        trust: "page_content_is_untrusted_evidence"
      }
    }),
    capabilities,
    selectionGoal: "Open the RTX A4000 product details",
    scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" }
  });
  assert.equal(result.status, "synthesized");
  assert.deepEqual(request.input.observation.candidates.map(item => item.label), ["View details", "Save item", "View details", "Save item", "Manufacturer"]);
  assert.equal(request.input.observation.candidateCoverage.scopedCandidateCount, 5);
  assert.deepEqual(request.input.observation.semanticPage.collections[0].records.map(item => item.ref), ["record_rtx", "record_rtx_duplicate"]);
});

test("workflow synthesis preserves the semantic-page outline contract when page labels are redacted", async () => {
  const observation = createObservation({
    semanticPage: {
      schemaVersion: 1,
      page: {
        pageType: { value: "unknown", status: "unknown" },
        outline: Array.from({ length: 40 }, (_, index) => ({ level: 2, text: `Heading ${index + 1}`, status: "observed" }))
      },
      candidateCoverage: {
        pageCandidateCount: 1,
        returnedCandidateCount: 1,
        omittedCandidateCount: 0,
        pageCoverage: "complete",
        selectionScope: "page",
        scopeCandidateCount: 1,
        scopeCoverage: "complete",
        truncated: false
      },
      regions: [{
        ref: "region_private",
        kind: "article",
        tag: "article",
        label: { value: "Private Region Label", status: "inferred", source: "descendant_heading" },
        controlRefs: ["candidate_details"]
      }],
      forms: [],
      collections: [{
        ref: "collection_private",
        kind: "html_table",
        status: "observed",
        visibleCount: 1,
        completeness: "unknown",
        fields: [{ name: "Private Column Label", status: "observed" }],
        fieldsTruncated: false,
        itemsTruncated: false,
        items: [{
          ref: "record_private",
          ordinal: 1,
          evidenceRef: "root:0:10",
          fields: [{ name: "Private Column Label", value: "Private Row Value", status: "observed", evidenceRef: "root:0:11", truncated: false }],
          controlRefs: ["candidate_details"]
        }]
      }],
      controls: [{
        targetRef: "candidate_details",
        classification: { value: "link", status: "observed" },
        regionRef: "region_private",
        formRef: null,
        collectionRef: "collection_private",
        recordRef: "record_private"
      }],
      warnings: [],
      trust: "page_content_is_untrusted_evidence"
    }
  });
  let requestCount = 0;
  let request;
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured(input) { requestCount++; request = input; return { result: plan }; } },
    allowGoalText: true,
    includePageLabels: false
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities,
    scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" },
    selectionGoal: "Open record details"
  });

  assert.equal(result.status, "synthesized");
  assert.equal(requestCount, 1);
  assert.deepEqual(request.input.observation.semanticPage.outline, []);
  assert.deepEqual(request.input.observation.headings, []);
  assert.deepEqual(request.input.observation.semanticPage.regions[0].label, { value: null, status: "redacted", source: null });
  assert.deepEqual(request.input.observation.semanticPage.collections[0].records[0].fields[0], {
    name: "",
    value: null,
    status: "redacted",
    semanticRole: null,
    semanticRoleStatus: "redacted",
    label: { value: null, status: "redacted", source: null },
    valueRef: "root:0:11",
    truncated: false
  });
  const serialized = JSON.stringify(request.input);
  assert.equal(serialized.includes("Heading 1"), false, "redacted page headings never reach the provider");
  assert.equal(serialized.includes("Private Region Label"), false, "redacted region labels never reach the provider");
  assert.equal(serialized.includes("Private Column Label"), false, "redacted table labels never reach the provider");
  assert.equal(serialized.includes("Private Row Value"), false, "redacted table values never reach the provider");
});

test("workflow synthesis rejects a table control whose record reference lacks matching provenance", async () => {
  let requestCount = 0;
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured() { requestCount++; return { result: plan }; } },
    includePageLabels: true
  });
  const observation = createObservation({
    semanticPage: {
      schemaVersion: 1,
      page: { pageType: { value: "unknown", status: "unknown" }, outline: [] },
      candidateCoverage: {
        pageCandidateCount: 1,
        returnedCandidateCount: 1,
        omittedCandidateCount: 0,
        pageCoverage: "complete",
        selectionScope: "page",
        scopeCandidateCount: 1,
        scopeCoverage: "complete",
        truncated: false
      },
      regions: [],
      forms: [],
      collections: [{
        ref: "collection_products",
        kind: "html_table",
        status: "observed",
        visibleCount: 1,
        completeness: "unknown",
        fields: [{ name: "Product", status: "observed" }],
        items: [{
          ref: "record_product_1",
          ordinal: 1,
          evidenceRef: "0:12",
          fields: [{ name: "Product", value: "Widget A", status: "observed", evidenceRef: "0:13" }],
          controlRefs: []
        }]
      }],
      controls: [{
        targetRef: "candidate_details",
        classification: { value: "link", status: "observed" },
        regionRef: null,
        formRef: null,
        collectionRef: "collection_products",
        recordRef: "record_product_1"
      }],
      warnings: [],
      trust: "page_content_is_untrusted_evidence"
    }
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities,
    scope: { applicationId: "fixture_app", environmentClass: "local", principalId: "operator_1" },
    selectionGoal: "Open record details"
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "schema");
  assert.equal(requestCount, 0);
});

test("workflow synthesis sends bound screenshot evidence only with the image-capable opt-in", async () => {
  const observation = createObservation({
    targetId: "target_workflow_image",
    documentGeneration: 2,
    viewport: { width: 800, height: 600 },
    visualEvidence: {
      evidenceId: "observation_initial",
      targetId: "target_workflow_image",
      documentGeneration: 2,
      viewport: { width: 800, height: 600 },
      screenshotBase64: visualFixtureBase64
    }
  });
  let request;
  const synthesizer = new WorkflowSynthesizer({
    provider: {
      capabilities: { imageInput: true },
      async requestStructured(input) { request = input; return { result: plan }; }
    },
    allowScreenshots: true
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities,
    imageEvidence: observation.visualEvidence
  });
  assert.equal(result.status, "synthesized");
  assert.equal(synthesizer.allowScreenshots, true);
  assert.equal(synthesizer.requiresScreenshot, false, "image capability does not force every workflow request to include pixels");
  assert.equal(request.imageEvidence, observation.visualEvidence);
  assert.equal(request.input.observationId, observation.evidenceId);
  const textOnly = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities
  });
  assert.equal(textOnly.status, "synthesized");
  assert.equal(Object.hasOwn(request, "imageEvidence"), false);
  assert.throws(() => new WorkflowSynthesizer({ provider: { async requestStructured() {} }, allowScreenshots: true }), /image support/u);
});

test("workflow synthesis rejects invented capabilities, targets, and cycles before execution", async () => {
  const badPlans = [
    { ...plan, steps: [{ ...plan.steps[0], capabilityId: "admin_everything" }] },
    { ...plan, steps: [{ ...plan.steps[0], targetRef: "candidate_not_observed" }] },
    { version: 1, steps: [
      { ...plan.steps[0], id: "first", dependsOn: ["second"] },
      { ...plan.steps[0], id: "second", dependsOn: ["first"] }
    ] }
  ];
  for (const badPlan of badPlans) {
    const store = new DecisionEventStore({ databasePath: ":memory:" });
    try {
      const episode = store.startEpisode({ runId: "run_invalid_plan", workflowId: "invalid_plan", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
      const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: badPlan }; } }, eventStore: store });
      const result = await synthesizer.synthesize({ taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" }, observation: createObservation(), capabilities, episodeId: episode.episodeId, runId: episode.runId });
      assert.equal(result.status, "unavailable");
      assert.equal(result.failureCode, "schema");
      assert.equal(store.getEvents(episode.episodeId).some(item => item.eventType === "workflow.plan_failed" && item.payload.failureCode === "schema"), true);
    } finally { store.close(); }
  }
});

test("workflow transport failures retain request correlation without provider error text", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_workflow_transport", workflowId: "workflow_transport", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    const error = Object.assign(new Error("private local gateway URL and token must stay out"), {
      kind: "transport",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
      providerLatencyMs: 1500,
      transportCode: "upstream_server_error",
      httpStatus: 504
    });
    const synthesizer = new WorkflowSynthesizer({
      provider: { async requestStructured() { throw error; } },
      eventStore: store,
      allowPageEvidence: true
    });
    const result = await synthesizer.synthesize({
      taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
      observation: createObservation(),
      capabilities,
      episodeId: episode.episodeId,
      runId: episode.runId
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.failureCode, "transport");
    const failed = store.getEvents(episode.episodeId).find(item => item.eventType === "workflow.plan_failed");
    assert.equal(failed.payload.clientRequestId, error.clientRequestId);
    assert.equal(failed.payload.providerLatencyMs, 1500);
    assert.equal(failed.payload.transportCode, "upstream_server_error");
    assert.equal(failed.payload.httpStatus, 504);
    assert.equal(JSON.stringify(failed.payload).includes("private local gateway"), false);
    assert.equal(Object.hasOwn(failed.payload, "httpStatus"), true);
  } finally { store.close(); }
});

test("workflow targets rebind only when exactly one current candidate matches the recorded signature", () => {
  const original = createObservation().candidates[0];
  const signature = {
    tag: original.tag,
    role: original.role,
    name: original.name,
    contextName: original.contextName,
    href: original.href,
    type: original.type,
    pointerInteraction: false
  };
  const binding = { kind: "candidate", signature };
  const current = { ...original, identity: "candidate_fresh", backendNodeId: 81 };
  assert.equal(rebindWorkflowTarget(binding, createObservation({ evidenceId: "observation_fresh", candidates: [current] })).identity, "candidate_fresh");
  assert.equal(rebindWorkflowTarget(binding, createObservation({ candidates: [current, { ...current, identity: "candidate_duplicate" }] })), null);
});

test("workflow synthesis refuses missing typed intent without sending the natural-language goal", async () => {
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { calls++; return { result: plan }; } } });
  const result = await synthesizer.synthesize({ goal: "This free-form goal must stay local", observation: createObservation(), capabilities });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "missing_intent");
  assert.equal(calls, 0);
});

test("configured workflow synthesis refuses all remote page evidence without its independent consent", async () => {
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({
    allowPageEvidence: false,
    allowGoalText: true,
    provider: { async requestStructured() { calls++; return { result: plan }; } }
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    selectionGoal: "Open the record details",
    observation: createObservation(),
    capabilities
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "privacy");
  assert.equal(calls, 0);
});

test("opted-in natural-language synthesis selects only a relevant qualified read contract", async () => {
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "registered_structured_records", observedRoles: [], observedTags: [],
    verificationCodes: ["complete_extraction_verified"], purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    outputSchema: [{ name: "name", type: "string", required: true }, { name: "price", type: "number", required: true }],
    async execute() { return { status: "verified", output: makeVerifiedExtractionOutput("name") }; }
  };
  const deleteCapability = {
    ...capabilities[0], id: "delete_products", action: "click", effectClass: "shared_mutation",
    operationId: "delete_products", requiresApproval: true, targetRole: "delete_product_control",
    intentBinding: "caller_required", purposeCodes: ["delete_products"], postconditionCodes: ["products_deleted"]
  };
  const extractionPlan = {
    version: 1,
    taskIntentRef: "intent_1",
    steps: [{
      id: "extract_products", capabilityId: "shop_products", targetRole: "registered_structured_records",
      dependsOn: [], verifyCode: "complete_extraction_verified", onMissing: "stop"
    }]
  };
  let request;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    provider: { async requestStructured(value) { request = value; return { result: extractionPlan }; } }
  });
  const result = await synthesizer.synthesize({
    taskIntent: null,
    selectionGoal: "Extract the product names and prices",
    observation: createObservation(),
    capabilities: [...capabilities, extractionCapability, deleteCapability]
  });

  assert.equal(result.status, "synthesized");
  assert.equal(request.input.callerRequest, "Extract the product names and prices");
  assert.deepEqual(request.input.taskIntentOptions.map(option => option.capabilityId), ["shop_products"]);
  assert.equal(request.input.trustedCapabilities.some(capability => capability.id === "delete_products"), false);
  assert.equal(result.taskIntent.purposeCode, "extract_products");
  assert.equal(result.taskIntent.outcomeCode, "complete_product_records");
  assert.deepEqual(result.taskIntent.requiredCapabilityIds, ["shop_products"]);
  assert.equal(result.taskIntent.cardinality, "unknown");
});

test("composite read synthesis exposes generic navigation only with a required read outcome", async () => {
  const goal = "Open the catalog and return the product names and prices";
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
    async execute() { throw new Error("the planner test does not execute capabilities"); }
  };
  let providerInput;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    allowPageEvidence: true,
    provider: {
      async requestStructured(request) {
        providerInput = request.input;
        return { result: {
          version: 1,
          taskIntentRef: "intent_1",
          steps: [
            {
              id: "open_catalog",
              capabilityId: "follow_observed_link",
              targetRole: "authorized_navigation_link",
              targetRef: "candidate_1",
              dependsOn: [],
              verifyCode: "authorized_route_changed",
              onMissing: "stop"
            },
            {
              id: "read_catalog",
              capabilityId: readCapability.id,
              targetRole: "observed_records",
              dependsOn: ["open_catalog"],
              verifyCode: "observed_records_verified",
              onMissing: "stop"
            }
          ]
        } };
      }
    }
  });
  const result = await synthesizer.synthesize({
    taskIntent: null,
    selectionGoal: goal,
    observation: createObservation(),
    capabilities: [...createGenericWorkflowCapabilities(), readCapability]
  });

  assert.equal(result.status, "synthesized", JSON.stringify(result));
  assert.equal(result.taskIntent.cardinality, "unknown");
  assert.ok(result.taskIntent.permittedPurposeCodes.includes("navigate"));
  assert.deepEqual(result.taskIntent.requiredCapabilityIds, [readCapability.id]);
  assert.deepEqual(result.plan.steps.map(step => step.capabilityId), ["follow_observed_link", readCapability.id]);
  assert.ok(providerInput.trustedCapabilities.some(capability => capability.id === "follow_observed_link"));
  assert.equal(providerInput.trustedCapabilities.some(capability => capability.effectClass === "shared_mutation"), false);
});

test("natural-language synthesis rejects unrelated read contracts and malformed inferred plans", async () => {
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "registered_structured_records", observedRoles: [], observedTags: [],
    verificationCodes: ["complete_extraction_verified"], purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output: makeVerifiedExtractionOutput("name") }; }
  };
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    provider: { async requestStructured() { calls++; return { result: null }; } }
  });
  const unrelated = await synthesizer.synthesize({
    selectionGoal: "Read public weather alerts", observation: createObservation(), capabilities: [extractionCapability]
  });
  assert.equal(unrelated.status, "unavailable");
  assert.equal(unrelated.failureCode, "schema");
  assert.equal(calls, 0, "unrelated qualified read capabilities are not offered to the model");

  const transformed = await synthesizer.synthesize({
    selectionGoal: "Find the three cheapest products and return their prices",
    observation: createObservation(),
    capabilities: [extractionCapability]
  });
  assert.equal(transformed.status, "unavailable");
  assert.equal(transformed.failureCode, "schema");
  assert.equal(calls, 0, "record extraction alone cannot claim ranking or filtering work");

  const secondExtractionCapability = {
    ...extractionCapability,
    id: "shop_orders",
    purposeCodes: ["extract_orders"],
    postconditionCodes: ["complete_order_records"]
  };
  const ambiguous = await synthesizer.synthesize({
    selectionGoal: "Extract the names", observation: createObservation(),
    capabilities: [extractionCapability, secondExtractionCapability]
  });
  assert.equal(ambiguous.status, "unavailable");
  assert.equal(ambiguous.failureCode, "schema");
  assert.equal(calls, 0, "equally relevant qualified contracts are treated as ambiguous");

  const malformed = await synthesizer.synthesize({
    selectionGoal: "Extract the product names", observation: createObservation(), capabilities: [extractionCapability]
  });
  assert.equal(malformed.status, "unavailable");
  assert.equal(malformed.failureCode, "schema");
  assert.equal(calls, 1);
});

test("natural-language read inference rejects mutation-only and mixed-effect requests", async () => {
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "registered_structured_records", observedRoles: [], observedTags: [],
    verificationCodes: ["complete_extraction_verified"], purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output: makeVerifiedExtractionOutput("name") }; }
  };
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    provider: { async requestStructured() { calls++; return { result: null }; } }
  });

  for (const selectionGoal of [
    "Delete the product records",
    "Deleting the product records",
    "Get rid of the product records",
    "Extract the product names and delete the products",
    "Find products and purchase the cheapest one",
    "Find products and buy the cheapest one",
    "Extract product names while removing records"
  ]) {
    const result = await synthesizer.synthesize({
      selectionGoal, observation: createObservation(), capabilities: [extractionCapability]
    });
    assert.equal(result.status, "unavailable", selectionGoal);
    assert.equal(result.failureCode, "schema", selectionGoal);
  }
  assert.equal(calls, 0, "mutative or mixed-effect requests must not reach inference through read-only intent inference");
});

test("workflow synthesis hides application-specific capabilities unless caller intent names them", async () => {
  let calls = 0;
  const deleteAccount = {
    id: "delete_account",
    action: "click",
    effectClass: "shared_mutation",
    operationId: "delete_account",
    requiresApproval: true,
    targetRole: "delete_account_control",
    purposeCodes: ["delete_account"],
    preconditionCodes: ["authorized_application_scope"],
    postconditionCodes: ["account_deleted"],
    observedRoles: ["button"],
    verificationCodes: ["account_deletion_confirmed"]
  };
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured() { calls++; return { result: plan }; } }
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_reports", outcomeCode: "reports_page" },
    observation: createObservation(),
    capabilities: [deleteAccount]
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "schema");
  assert.equal(calls, 0, "the unrelated application mutation never reaches the inference request");
});

test("workflow synthesis rejects a required capability whose trusted purpose contradicts the task", async () => {
  let calls = 0;
  const deleteReports = {
    id: "delete_reports",
    action: "click",
    effectClass: "navigation",
    intentBinding: "caller_required",
    targetRole: "reports_action",
    observedRoles: ["button"],
    verificationCodes: ["reports_deleted"],
    purposeCodes: ["delete_reports"],
    preconditionCodes: ["authorized_reports_scope"],
    postconditionCodes: ["reports_deleted"]
  };
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { calls++; return { result: plan }; } } });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "view_reports", outcomeCode: "reports_read", requiredCapabilityIds: ["delete_reports"] },
    observation: createObservation(),
    capabilities: [deleteReports]
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "schema");
  assert.equal(calls, 0, "the unrelated capability is rejected before inference");
});

test("workflow synthesis rejects a required outcome available only on a failure branch", async () => {
  let calls = 0;
  const conditionalPlan = {
    version: 1,
    steps: [
      {
        id: "open_section",
        capabilityId: "open_section",
        targetRole: "record_details_link",
        targetRef: "candidate_1",
        dependsOn: [],
        verifyCode: "section_opened",
        onMissing: "stop"
      },
      {
        id: "open_details",
        capabilityId: "open_details_after_section",
        targetRole: "record_details_link",
        targetRef: "candidate_1",
        dependsOn: ["open_section"],
        when: { stepId: "open_section", status: "failed" },
        verifyCode: "details_page",
        onMissing: "stop"
      }
    ]
  };
  const synthesizer = new WorkflowSynthesizer({
    provider: { async requestStructured() { calls++; return { result: conditionalPlan }; } }
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation: createObservation(),
    capabilities: [
      { ...capabilities[0], id: "open_section", verificationCodes: ["section_opened"], postconditionCodes: ["section_opened"] },
      { ...capabilities[0], id: "open_details_after_section", verificationCodes: ["details_page"], postconditionCodes: ["details_page"] }
    ]
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "schema");
});

test("workflow synthesis refuses a dense page when no task-relevant candidate is identified", async () => {
  let calls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { calls++; return { result: plan }; } } });
  const observation = createObservation({
    candidates: Array.from({ length: 170 }, (_, index) => ({
      identity: `candidate_${index + 1}`,
      tag: "a",
      role: "link",
      name: `Unrelated link ${index + 1}`,
      visible: true,
      disabled: false
    }))
  });
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    observation,
    capabilities
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.failureCode, "incomplete_coverage");
  assert.equal(calls, 0, "unknown target relevance cannot be guessed from a DOM-order prefix");
});

test("incomplete interaction coverage permits only an atomic, exact read capability", async () => {
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "registered_structured_records", purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    observedRoles: [], observedTags: [], verificationCodes: ["complete_extraction_verified"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output: makeVerifiedExtractionOutput() }; }
  };
  const extractionPlan = {
    version: 1,
    steps: [{
      id: "extract_products", capabilityId: "shop_products", targetRole: "registered_structured_records",
      dependsOn: [], verifyCode: "complete_extraction_verified", onMissing: "stop"
    }]
  };
  const observation = createObservation({
    candidates: Array.from({ length: 500 }, (_, index) => ({
      identity: `dense_${index}`, tag: "button", role: "button", name: `Control ${index}`,
      visible: true, disabled: false
    }))
  });
  let calls = 0;
  let request;
  const synthesizer = new WorkflowSynthesizer({ provider: {
    async requestStructured(value) { calls++; request = value; return { result: extractionPlan }; }
  } });
  const taskIntent = {
    purposeCode: "extract_products", outcomeCode: "complete_product_records", cardinality: "atomic",
    permittedPurposeCodes: ["extract_products"], requiredCapabilityIds: ["shop_products"]
  };
  const accepted = await synthesizer.synthesize({
    taskIntent, observation, capabilities: [...capabilities, extractionCapability]
  });

  assert.equal(accepted.status, "synthesized", `${JSON.stringify(accepted)}; provider calls=${calls}`);
  assert.deepEqual(request.input.trustedCapabilities.map(capability => capability.id), ["shop_products"]);
  assert.equal(request.input.observation.candidateCoverage.scopeCoverage, "incomplete");
  assert.equal(request.input.observation.candidates.length, 384);

  const compound = await synthesizer.synthesize({
    taskIntent: { ...taskIntent, cardinality: "compound" },
    observation,
    capabilities: [...capabilities, extractionCapability]
  });
  assert.equal(compound.status, "unavailable");
  assert.equal(compound.failureCode, "incomplete_coverage");
  assert.equal(calls, 1, "compound work cannot use a partial interaction scan or reach inference");
});

test("NavigationEngine expands one bounded interaction observation before synthesizing an oversized task scope", async () => {
  const taskCandidates = Array.from({ length: 270 }, (_, index) => ({
    identity: `archive_${index}`,
    tag: "a",
    role: "link",
    name: "Open record",
    contextName: "Archived records",
    href: `https://fixture.example/records/${index}`,
    visible: true,
    disabled: false
  }));
  const unrelatedCandidates = Array.from({ length: 112 }, (_, index) => ({
    identity: `navigation_${index}`,
    tag: "a",
    role: "link",
    name: `Navigation ${index}`,
    contextName: "Main navigation",
    href: `https://fixture.example/navigation/${index}`,
    visible: true,
    disabled: false
  }));
  const candidates = [...taskCandidates, ...unrelatedCandidates];
  const coverage = (returnedCount, returnedScopeCount) => ({
    pageCandidateCount: candidates.length,
    returnedCandidateCount: returnedCount,
    omittedCandidateCount: candidates.length - returnedCount,
    pageCoverage: returnedCount === candidates.length ? "complete" : "partial",
    selectionScope: "task_relevant_region",
    taskRelevantCandidateCount: taskCandidates.length,
    scopeCandidateCount: taskCandidates.length,
    returnedScopeCandidateCount: returnedScopeCount,
    scopeCoverage: returnedScopeCount === taskCandidates.length ? "complete" : "incomplete",
    truncated: returnedCount < candidates.length
  });
  const semanticPage = candidateCoverage => ({
    schemaVersion: 3,
    page: { pageType: { value: "form", status: "inferred" }, outline: [] },
    candidateCoverage: {
      pageCandidateCount: candidates.length,
      pageCoverage: candidateCoverage.pageCoverage,
      selectionScope: "task_relevant_region",
      scopeCandidateCount: taskCandidates.length,
      scopeCoverage: candidateCoverage.scopeCoverage
    },
    regions: [],
    forms: [{
      ref: "form_archived_records",
      method: "get",
      controlRefs: taskCandidates.map(candidate => candidate.identity),
      submitControlRefs: []
    }],
    collections: [],
    controls: candidates.map(candidate => ({
      targetRef: candidate.identity,
      classification: { value: "link", status: "observed" },
      interaction: { mechanic: "follow_link", readiness: "visible_enabled" },
      regionRef: null,
      formRef: taskCandidates.includes(candidate) ? "form_archived_records" : null,
      collectionRef: null,
      recordRef: null
    })),
    warnings: [],
    trust: "page_content_is_untrusted_evidence"
  });
  const observations = [
    {
      ...createObservation({
        evidenceId: "archive_initial",
        observationProfile: "interaction",
        semanticPage: semanticPage(coverage(200, 200)),
        candidates: candidates.slice(0, 200),
        candidateCount: 200,
        candidateCoverage: coverage(200, 200)
      }),
      targetId: "archive-target"
    },
    {
      ...createObservation({
        evidenceId: "archive_expanded",
        observationProfile: "interaction",
        semanticPage: semanticPage(coverage(candidates.length, taskCandidates.length)),
        candidates,
        candidateCount: candidates.length,
        candidateCoverage: coverage(candidates.length, taskCandidates.length)
      }),
      targetId: "archive-target"
    }
  ];
  const observedOptions = [];
  const session = {
    attached: true,
    target: { id: "archive-target", endpoint: "fixture", url: "https://fixture.example/records" },
    async observe(options = {}) {
      observedOptions.push(options);
      return observations[Math.min(observedOptions.length - 1, observations.length - 1)];
    }
  };
  let synthesisInput;
  const synthesizer = new WorkflowSynthesizer({
    includePageLabels: true,
    provider: {
      async requestStructured(request) {
        synthesisInput = request.input;
        return { result: { version: 1, steps: [] } };
      }
    }
  });
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: capabilities,
    maxActions: 1
  });
  const result = await engine.run("Open the archived record", {
    workflowIntent: {
      purposeCode: "open_record",
      outcomeCode: "details_page",
      cardinality: "compound",
      permittedPurposeCodes: ["open_record"],
      targetRoles: ["record_details_link"],
      constraints: [],
      requiredCapabilityIds: ["open_record_details"]
    }
  });

  assert.equal(observedOptions.length, 2);
  assert.equal(observedOptions[1].candidateLimit, 384);
  assert.equal(observedOptions[1].selectionGoal, "Open the archived record");
  assert.ok(synthesisInput, JSON.stringify(result));
  assert.equal(synthesisInput.observation.candidates.length, taskCandidates.length);
  assert.equal(synthesisInput.observation.candidateCoverage.scopeCoverage, "complete");
  assert.equal(synthesisInput.observation.semanticPage.forms[0].controlCount, taskCandidates.length);
  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 0, "invalid model output leaves the browser untouched");
});

test("workflow synthesis scopes dense-page candidates to the task while retaining competing matches", async () => {
  let request;
  const synthesizer = new WorkflowSynthesizer({
    includePageLabels: true,
    provider: { async requestStructured(value) { request = value; return { result: plan }; } }
  });
  const candidates = Array.from({ length: 400 }, (_, index) => ({
    identity: `dense_candidate_${index + 1}`,
    tag: "a",
    role: "link",
    name: index === 86 || index === 399 ? "Export" : index === 198 ? "Details" : `Navigation item ${index + 1}`,
    contextName: index === 86 || index === 198 || index === 399 ? "Archived records" : "Main navigation",
    visible: true,
    disabled: false
  }));
  const result = await synthesizer.synthesize({
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    selectionGoal: "Open the export for archived records",
    observation: createObservation({ candidates }),
    capabilities
  });
  assert.equal(result.status, "synthesized");
  const coverage = request.input.observation.candidateCoverage;
  assert.equal(coverage.pageCandidateCount, 400);
  assert.equal(coverage.scopedCandidateCount, 3);
  assert.equal(coverage.submittedCandidateCount, 3);
  assert.equal(coverage.selectionScope, "task_relevant_region");
  assert.equal(coverage.pageCoverage, "partial");
  assert.equal(coverage.scopeCoverage, "complete");
  assert.deepEqual(request.input.observation.candidates.map(candidate => candidate.label), ["Export", "Details", "Export"]);
  assert.equal(Object.hasOwn(request.input, "selectionGoal"), false, "the caller's natural-language goal is used locally and is not copied into the structured provider input");
});

test("NavigationEngine executes synthesized registered extraction steps and returns only verified typed output", async () => {
  const output = makeVerifiedExtractionOutput();
  const extractionCapability = {
    id: "shop_products",
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "registered_structured_records",
    purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"],
    postconditionCodes: ["complete_product_records"],
    observedRoles: [],
    observedTags: [],
    verificationCodes: ["complete_extraction_verified"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output }; }
  };
  const extractionPlan = {
    version: 1,
    steps: [{
      id: "extract_products",
      capabilityId: "shop_products",
      targetRole: "registered_structured_records",
      dependsOn: [],
      verifyCode: "complete_extraction_verified",
      onMissing: "stop"
    }]
  };
  let synthesisInput;
  const synthesizer = new WorkflowSynthesizer({ provider: {
    async requestStructured(input) {
      synthesisInput = input.input;
      return { result: extractionPlan };
    }
  } });
  let lastJournalStatus = null;
  let persistedOutputs = null;
  const journal = { async write(state) { lastJournalStatus = state.status; } };
  const session = {
    attached: true,
    target: { id: "workflow-extraction-target", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() { return { ...createObservation({ evidenceId: "workflow_extract_observation", page: { url: "https://shop.example/products", title: "Products" }, candidates: [] }), targetId: this.target.id }; }
  };
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [extractionCapability],
    journal,
    persistWorkflowOutputs: async value => {
      assert.notEqual(lastJournalStatus, "succeeded", "the artifact is durable before the journal claims success");
      persistedOutputs = value.outputs;
    },
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"] },
    assertExecutionLease: async () => {}
  });
  const result = await engine.run("Open products", {
    workflowIntent: { purposeCode: "extract_products", outcomeCode: "complete_product_records", requiredCapabilityIds: ["shop_products"] }
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.attempts, 0, "read-only extraction does not dispatch a browser action");
  assert.deepEqual(result.workflowPlan.stepStatuses, { extract_products: "passed" }, JSON.stringify(result));
  assert.deepEqual(result.workflowOutputs.shop_products.records, [{ name: "Widget" }]);
  assert.deepEqual(persistedOutputs, result.workflowOutputs);
  assert.equal(lastJournalStatus, "succeeded");
  assert.equal(JSON.stringify(synthesisInput).includes("Widget"), false, "record values stay out of model synthesis input");
});

test("default auto mode routes explicit read goals through the qualified extraction workflow", async () => {
  const output = makeVerifiedExtractionOutput();
  const extractionCapability = {
    id: "shop_products",
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "registered_structured_records",
    purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"],
    postconditionCodes: ["complete_product_records"],
    observedRoles: [],
    observedTags: [],
    verificationCodes: ["complete_extraction_verified"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output }; }
  };
  let modelCalls = 0;
  const synthesizer = new WorkflowSynthesizer({
    allowGoalText: true,
    allowPageEvidence: true,
    provider: {
      async requestStructured(request) {
        modelCalls++;
        assert.equal(request.input.callerRequest, "Read product names");
        assert.deepEqual(request.input.taskIntentOptions.map(option => option.capabilityId), ["shop_products"]);
        return { result: {
          version: 1,
          taskIntentRef: "intent_1",
          steps: [{
            id: "read_products",
            capabilityId: "shop_products",
            targetRole: "registered_structured_records",
            dependsOn: [],
            verifyCode: "complete_extraction_verified",
            onMissing: "stop"
          }]
        } };
      }
    }
  });
  const session = {
    attached: true,
    target: { id: "auto-workflow-target", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() {
      return {
        ...createObservation({
          evidenceId: "auto_workflow_observation",
          page: { url: "https://shop.example/products", title: "Products" },
          candidates: [{
            identity: "product_details_link", tag: "a", role: "link", name: "Details", contextName: "Widget",
            href: "https://shop.example/products/widget", visible: true, disabled: false
          }]
        }),
        targetId: this.target.id
      };
    }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [extractionCapability],
    environment: { environmentId: "public-shop", authorizedOrigins: ["https://shop.example"] },
    assertExecutionLease: async () => {}
  }).run("Read product names");

  assert.equal(modelCalls, 1);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.attempts, 0, "reading does not dispatch the visible product detail link");
  assert.deepEqual(result.workflowOutputs.shop_products.records, [{ name: "Widget" }]);
});

test("ordinary read goals execute a run-local partial extraction through the workflow model", async () => {
  const output = makeObservedPartialExtractionOutput();
  const capabilityId = "observed_read_0123456789abcdef";
  const extractionCapability = {
    id: capabilityId,
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "observed_records",
    purposeCodes: ["extract_records"],
    preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"],
    observedRoles: [],
    observedTags: [],
    verificationCodes: ["observed_records_verified"],
    outputCompleteness: "observed_partial",
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output, completeness: "observed_partial" }; }
  };
  let providerInput;
  let persisted = false;
  const synthesizer = new WorkflowSynthesizer({
    allowPageEvidence: true,
    provider: {
      async requestStructured(request) {
        providerInput = request.input;
        return { result: {
          version: 1,
          steps: [{
            id: "read_visible_names",
            capabilityId,
            targetRole: "observed_records",
            dependsOn: [],
            verifyCode: "observed_records_verified",
            onMissing: "stop"
          }]
        } };
      }
    }
  });
  const observation = {
    ...createObservation({
      evidenceId: "ordinary_read_observation",
      page: { url: "https://catalog.example/search?q=widget", title: "Catalog" },
      candidates: []
    }),
    targetId: "ordinary-read-target"
  };
  const session = {
    attached: true,
    target: { id: "ordinary-read-target", endpoint: "fixture", url: observation.page.url },
    documentGeneration: 1,
    async observe() { return structuredClone(observation); }
  };
  const capabilityService = {
    async createObservedReadWorkflowCapabilities(input) {
      assert.equal(input.observation.evidenceId, observation.evidenceId);
      assert.equal(input.goal, "List the visible product names");
      return [extractionCapability];
    }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowSynthesizer: synthesizer,
    capabilityService,
    principalId: "operator-1",
    persistWorkflowOutputs: async () => { persisted = true; }
  }).run("List the visible product names");

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.workflowOutputs[capabilityId].records, [{ name: "Widget" }]);
  assert.equal(result.workflowOutputs[capabilityId].completeness, "observed_partial");
  assert.equal(result.workflowOutputs[capabilityId].verification.completenessClaimed, false);
  assert.equal(providerInput.callerRequest, undefined, "goal text stays local without the separate egress opt-in");
  assert.equal(persisted, false, "run-local partial outputs are not retained as reusable extraction artifacts");
});

test("default auto mode abstains on explicit read goals without consent or a matching qualified capability", async () => {
  let modelCalls = 0;
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "registered_structured_records", purposeCodes: ["extract_products"],
    preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    observedRoles: [], observedTags: [], verificationCodes: ["complete_extraction_verified"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { throw new Error("must not execute"); }
  };
  const session = {
    attached: true,
    target: { id: "auto-read-abstain-target", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() {
      return {
        ...createObservation({
          evidenceId: "auto_read_abstain_observation",
          page: { url: "https://shop.example/products", title: "Products" },
          candidates: [{ identity: "product_link", tag: "a", role: "link", name: "Details", contextName: "Widget", href: "https://shop.example/products/widget", visible: true, disabled: false }]
        }),
        targetId: this.target.id
      };
    }
  };
  const makeSynthesizer = ({ allowGoalText }) => new WorkflowSynthesizer({
    allowGoalText, allowPageEvidence: true,
    provider: { async requestStructured() { modelCalls++; return { result: { version: 1, taskIntentRef: "intent_1", steps: [] } }; } }
  });

  for (const synthesizer of [makeSynthesizer({ allowGoalText: false }), makeSynthesizer({ allowGoalText: true })]) {
    const result = await new NavigationEngine(session, {
      plannerMode: "auto", workflowSynthesizer: synthesizer,
      workflowCapabilities: synthesizer.allowGoalText ? [] : [extractionCapability],
      environment: { environmentId: "public-shop", authorizedOrigins: ["https://shop.example"] },
      assertExecutionLease: async () => {}
    }).run("Read product names");
    assert.equal(result.status, "unresolved", JSON.stringify(result));
    assert.equal(result.attempts, 0, "no partial navigation action is allowed");
  }
  assert.equal(modelCalls, 0, "goal text is not sent without explicit consent and no unrelated model request is made");
});

test("read goals cannot use an atomic typed intent to fall back to one visible click", async () => {
  const session = {
    attached: true,
    target: { id: "read-atomic-fallback-target", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() {
      return {
        ...createObservation({
          evidenceId: "read_atomic_fallback_observation",
          page: { url: "https://shop.example/products", title: "Products" },
          candidates: [{ identity: "product_link", tag: "a", role: "link", name: "Details", contextName: "Widget", href: "https://shop.example/products/widget", visible: true, disabled: false }]
        }),
        targetId: this.target.id
      };
    }
  };
  const result = await new NavigationEngine(session, {
    plannerMode: "auto",
    workflowSynthesizer: new WorkflowSynthesizer({
      allowGoalText: false,
      allowPageEvidence: true,
      provider: { async requestStructured() { throw new Error("invalid typed intent must stop before inference"); } }
    }),
    environment: { environmentId: "public-shop", authorizedOrigins: ["https://shop.example"] },
    workflowIntent: {
      purposeCode: "extract_products", outcomeCode: "complete_product_records", cardinality: "atomic"
    },
    assertExecutionLease: async () => {}
  }).run("Read product names");

  assert.equal(result.status, "unresolved", JSON.stringify(result));
  assert.equal(result.attempts, 0, "read completion cannot degrade to a visible navigation click");
});

test("registered workflow pagination uses the authorized executor and rejects scope drift or lease loss", async () => {
  let currentUrl = "https://shop.example/products?page=1";
  let dispatches = 0;
  let leaseChecks = 0;
  const session = {
    attached: true,
    target: { id: "pagination-target", url: currentUrl },
    async observe() {
      return {
        targetId: this.target.id,
        evidenceId: `pagination-${dispatches}`,
        pageChangeFingerprint: currentUrl,
        domMutationCount: 0,
        lifecycleEventCount: 0,
        page: { url: currentUrl, title: "Products" }
      };
    },
    observer: {
      getEvidence() {
        const href = currentUrl.endsWith("page=1") ? "?page=2" : "?page=3";
        const strings = ["A", "rel", "next", "href", href];
        return {
          status: "available",
          domSnapshot: {
            strings,
            documents: [{
              nodes: { nodeName: [0], attributes: [[1, 2, 3, 4]], parentIndex: [-1] },
              layout: { nodeIndex: [0], bounds: [[0, 0, 20, 10]] }
            }]
          }
        };
      }
    },
    async waitForChange() {},
    client: {
      async send(method, params) {
        assert.equal(method, "Page.navigate");
        dispatches++;
        currentUrl = params.url;
      }
    }
  };
  const environment = { environmentId: "staging", authorizedOrigins: ["https://shop.example"] };
  const advance = details => advanceRegisteredPagination({
    session,
    environment,
    assertExecutionLease: async () => { leaseChecks++; },
    ...details
  });

  const verified = await advance({
    url: "https://shop.example/products?page=2",
    fromPageUrl: "https://shop.example/products?page=1"
  });
  assert.equal(verified.status, "verified");
  assert.equal(dispatches, 1);
  assert.equal(leaseChecks, 2, "the authorized executor checks the live target lease before dispatch");

  const external = await advance({
    url: "https://elsewhere.example/products?page=3",
    fromPageUrl: currentUrl
  });
  assert.equal(external.status, "blocked");
  assert.equal(dispatches, 1, "scope mismatch is refused before CDP navigation");

  const staleSource = await advance({
    url: "https://shop.example/products?page=3",
    fromPageUrl: "https://shop.example/products?page=1"
  });
  assert.equal(staleSource.status, "blocked");
  assert.equal(dispatches, 1, "navigation cannot be based on a stale source page");

  const noLease = await advanceRegisteredPagination({
    session,
    environment,
    assertExecutionLease: async () => { throw new Error("lease lost"); },
    url: "https://shop.example/products?page=3",
    fromPageUrl: currentUrl
  });
  assert.equal(noLease.status, "blocked");
  assert.equal(dispatches, 1, "lease loss prevents dispatch");
});

test("registered explicit next-page buttons are re-resolved and clicked through the authorized executor", async () => {
  const url = "https://shop.example/products";
  let changed = false;
  let clicks = 0;
  let leaseChecks = 0;
  const snapshot = {
    strings: ["HTML", "BUTTON", "aria-label", "Next page"],
    documents: [{
      nodes: {
        nodeName: [0, 1], nodeValue: [-1, -1], textValue: [-1, -1], parentIndex: [-1, 0],
        attributes: [[], [2, 3]], backendNodeId: [10, 11]
      },
      layout: { nodeIndex: [1], bounds: [[10, 10, 80, 24]] }
    }]
  };
  const candidate = {
    identity: "pagination-target:root:unknown:11:1", targetId: "pagination-button-target", documentGeneration: 1,
    frameId: "unknown", frameTargetId: null, backendNodeId: 11, tag: "button", role: "button", name: "Next page",
    href: null, visible: true, disabled: false, submitsForm: false, opensNewTarget: false
  };
  const session = {
    attached: true,
    documentGeneration: 1,
    target: { id: "pagination-button-target", url },
    observer: { getEvidence() { return { status: "available", domSnapshot: snapshot }; } },
    async observe() {
      return {
        targetId: this.target.id,
        evidenceId: `button-page-${changed ? "after" : "before"}`,
        documentGeneration: this.documentGeneration,
        pageChangeFingerprint: changed ? "changed" : "before",
        page: { url, title: "Products" },
        candidates: [candidate]
      };
    },
    async validateObservedCandidate(selected, { expectedUrl }) {
      return { status: "valid", targetId: this.target.id, documentGeneration: this.documentGeneration,
        backendNodeId: selected.backendNodeId, url: expectedUrl };
    },
    async click(selected, { beforeDispatch }) {
      assert.equal(selected.identity, candidate.identity);
      await beforeDispatch?.();
      clicks++;
      changed = true;
      return { dispatched: true };
    },
    async waitForChange() {}
  };
  const advance = await advanceRegisteredPagination({
    session,
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"] },
    assertExecutionLease: async () => { leaseChecks++; },
    fromPageUrl: url,
    nextPage: { status: "available", kind: "explicit_next_same_path", action: "click", target: { frameId: "unknown", backendNodeId: 11, tag: "button" } },
    kind: "explicit_next_same_path",
    paginationOperationId: "registered-pagination:test@1",
    paginationOperationAuthorizer: {
      authorize({ action, candidate: selected }) {
        return action === "click" && selected.identity === candidate.identity
          ? { allowed: true, category: "test_registered_pagination" }
          : { allowed: false };
      }
    }
  });
  assert.equal(advance.status, "verified", JSON.stringify(advance));
  assert.equal(clicks, 1);
  assert.ok(leaseChecks >= 2, "the lease is checked by both action admission and the browser dispatch callback");
});

test("synthesized extraction cannot add a target and incomplete or mismatched output never completes", async () => {
  const extractionCapability = {
    id: "shop_products", action: "extract", effectClass: "read", intentBinding: "caller_required", targetRole: "registered_structured_records",
    observedRoles: [], observedTags: [], verificationCodes: ["complete_extraction_verified"],
    purposeCodes: ["extract_products"], preconditionCodes: ["qualified_capability_scope"], postconditionCodes: ["complete_product_records"],
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output: makeVerifiedExtractionOutput("subject") }; }
  };
  const badPlan = {
    version: 1,
    steps: [{
      id: "extract_products", capabilityId: "shop_products", targetRole: "registered_structured_records",
      targetRef: "candidate_1", dependsOn: [], verifyCode: "complete_extraction_verified", onMissing: "stop"
    }]
  };
  const badSynthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: badPlan }; } } });
  const rejected = await badSynthesizer.synthesize({
    taskIntent: { purposeCode: "extract_products", outcomeCode: "complete_product_records", requiredCapabilityIds: ["shop_products"] },
    observation: createObservation(), capabilities: [extractionCapability]
  });
  assert.equal(rejected.status, "unavailable");

  const omittedRequiredCapability = await new WorkflowSynthesizer({
    provider: { async requestStructured() { return { result: plan }; } }
  }).synthesize({
    taskIntent: { purposeCode: "extract_products", outcomeCode: "complete_product_records", requiredCapabilityIds: ["shop_products"] },
    observation: createObservation(),
    capabilities: [...capabilities, extractionCapability]
  });
  assert.equal(omittedRequiredCapability.status, "unavailable", "a plan cannot omit a caller-required extraction capability");

  const validPlan = { ...badPlan, steps: [{ ...badPlan.steps[0], targetRef: undefined }] };
  delete validPlan.steps[0].targetRef;
  const engine = new NavigationEngine({
    attached: true,
    target: { id: "workflow-extraction-invalid-output", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() { return { ...createObservation({ evidenceId: "workflow_extract_invalid_observation", candidates: [] }), targetId: this.target.id }; }
  }, {
    plannerMode: "workflow",
    workflowSynthesizer: new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: validPlan }; } } }),
    workflowCapabilities: [extractionCapability],
    environment: { environmentId: "staging", authorizedOrigins: ["https://shop.example"] },
    assertExecutionLease: async () => {}
  });
  const result = await engine.run("Extract the visible product records", {
    workflowIntent: { purposeCode: "extract_products", outcomeCode: "complete_product_records", requiredCapabilityIds: ["shop_products"] }
  });
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.workflowPlan.stepStatuses, { extract_products: "failed" });
  assert.deepEqual(result.workflowPlan.stepFailureCodes, { extract_products: "extraction_schema_mismatch" });
  assert.equal(Object.hasOwn(result, "workflowOutputs"), false);
});

test("workflow continuation never reports a required extraction as complete when its artifact was not persisted", async () => {
  const session = {
    attached: true,
    target: { id: "workflow-extraction-resume", endpoint: "fixture", url: "https://shop.example/products" },
    async observe() {
      return { ...createObservation({ evidenceId: "workflow_extract_resume_observation", page: { url: "https://shop.example/products", title: "Products" }, candidates: [] }), targetId: this.target.id };
    }
  };
  const goal = "Open products";
  const engine = new NavigationEngine(session, { plannerMode: "workflow" });
  const result = await engine.run(goal, {
    workflowIntent: { purposeCode: "extract_products", outcomeCode: "complete_product_records", requiredCapabilityIds: ["shop_products"] },
    resumeState: {
      taskId: "resume_extraction_run",
      goal,
      targetId: session.target.id,
      endpoint: session.target.endpoint,
      status: "running",
      attempts: [],
      recoveryCount: 0
    }
  });
  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /artifact was not retained|output is not retained/iu);
  assert.equal(Object.hasOwn(result, "workflowOutputs"), false);
});

test("Jev reviews one compact workflow projection in a batched 1.14 request and never authorizes it", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_plan_review", workflowId: "plan_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    let calls = 0;
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: { async decide({ state, questions }) {
        calls++;
        assert.equal(state.step_count, 2);
        assert.equal(state.task_outcome_code, "details_page");
        assert.match(state.review_binding_hash, /^[a-f0-9]{64}$/u);
        assert.deepEqual(state.steps[1].depends_on, ["open_details"]);
        assert.deepEqual(state.steps[1].condition, { step_id: "open_details", status: "passed" });
        assert.deepEqual(state.steps[1].postcondition_codes, ["details_page"]);
        assert.deepEqual(Object.keys(questions), ["plan_coherence", "plan_verifiability", "plan_boundary_alignment"]);
        return {
          model: JEV_MODEL_ID,
          answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.96 }])),
          usage: { inputTokens: 80, outputTokens: 12 }
        };
      } }
    });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      decisionId: "decision_plan_review",
      observationId: "observation_initial",
      planHash: "b".repeat(64),
      reviewBinding: reviewBinding("b".repeat(64)),
      observation: createObservation(),
      planProjection: [
        workflowReviewProjection(),
        workflowReviewProjection({
          stepId: "confirm_details",
          dependsOn: ["open_details"],
          condition: { stepId: "open_details", status: "passed" }
        })
      ]
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "reviewed");
    assert.equal(result.disposition, "supported");
    assert.equal(result.reviewOutcome, "supported");
    assert.equal(result.bindingStatus, "bound");
    assert.equal(result.planHash, "b".repeat(64));
    assert.equal(result.reviewBindingHash, reviewBinding("b".repeat(64)).bindingHash);
    assert.equal(result.reviewPolicyVersion, "workflow_plan_review_v1");
    assert.equal(result.authorizesOperation, false);
    const events = store.getEvents(episode.episodeId);
    assert.equal(events.filter(item => item.eventType === "decision.predicted").length, 3);
    const capturedInput = events.find(item => item.eventType === "decision.input_captured");
    assert.equal(capturedInput.payload.inputKind, "workflow_plan_review");
    assert.deepEqual(capturedInput.payload.inputProjection.state.steps[1].depends_on, ["open_details"]);
    assert.deepEqual(capturedInput.payload.inputProjection.state.steps[1].condition, { step_id: "open_details", status: "passed" });
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("Jev workflow review presents only the screenshot bound to the exact workflow observation", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_plan_visual_review", workflowId: "plan_visual_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    const observation = {
      evidenceId: "observation_plan_visual",
      targetId: "target_plan_visual",
      documentGeneration: 4,
      viewport: { width: 800, height: 600 },
      visualEvidence: {
        evidenceId: "observation_plan_visual",
        targetId: "target_plan_visual",
        documentGeneration: 4,
        viewport: { width: 800, height: 600 },
        screenshotBase64: visualFixtureBase64
      }
    };
    const coordinator = new DecisionCoordinator({
      eventStore: store,
      client: {
        allowImages: true,
        async decide({ imageEvidence, questions }) {
          assert.equal(imageEvidence, observation.visualEvidence);
          return { model: JEV_MODEL_ID, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.95 }])) };
        }
      }
    });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      observationId: observation.evidenceId,
      planHash: "c".repeat(64),
      reviewBinding: reviewBinding("c".repeat(64), observation),
      observation,
      imageEvidence: observation.visualEvidence,
      planProjection: [workflowReviewProjection()]
    });
    assert.equal(result.status, "reviewed");
    const input = store.getEvents(episode.episodeId).find(item => item.eventType === "decision.input_captured");
    assert.equal(input.payload.planHash, "c".repeat(64));
    assert.equal(input.payload.reviewPolicyVersion, "workflow_plan_review_v1");
    assert.equal(input.payload.bindingHash, result.reviewBindingHash);
    assert.equal(input.payload.targetId, observation.targetId);
    assert.equal(input.payload.documentGeneration, observation.documentGeneration);
    assert.equal(input.payload.inputProjection.visualEvidence.evidenceId, observation.evidenceId);
    assert.equal(input.payload.inputProjection.visualEvidence.viewport.width, 800);
    assert.equal("screenshotBase64" in input.payload.inputProjection.visualEvidence, false);
    assert.equal(store.verifyEpisodeChain(episode.episodeId).ok, true);
  } finally { store.close(); }
});

test("Jev unavailability is captured as advisory workflow-review state", async () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_plan_review_unavailable", workflowId: "plan_review", applicationId: "fixture_app", environmentClass: "local", executionMode: "standalone", policyVersion: "policy_v1" });
    const coordinator = new DecisionCoordinator({ eventStore: store, client: { async decide() { throw Object.assign(new Error("offline"), { kind: "transport" }); } } });
    const result = await coordinator.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "workflow_plan",
      observationId: "observation_initial",
      planHash: "d".repeat(64),
      reviewBinding: reviewBinding("d".repeat(64)),
      observation: createObservation(),
      planProjection: [workflowReviewProjection()]
    });
    assert.deepEqual({ status: result.status, failureCode: result.failureCode, authorizesOperation: result.authorizesOperation }, { status: "unavailable", failureCode: "transport", authorizesOperation: false });
    assert.equal(store.getEvents(episode.episodeId).filter(item => item.eventType === "decision.failed").length, 3);
  } finally { store.close(); }
});

test("negative Jev workflow review suspends before returning an executable step", async () => {
  const dag = {
    version: 1,
    steps: [
      { id: "open_details", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "confirm_details", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: ["open_details"], when: { stepId: "open_details", status: "passed" }, verifyCode: "details_route_observed", onMissing: "stop" }
    ]
  };
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: dag }; } } });
  let fallbackCalls = 0;
  const planner = new WorkflowGraphPlanner({
    synthesizer,
    capabilities,
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page" },
    fallbackPlanner: { async plan() { fallbackCalls++; return { status: "ambiguous", reason: "local evidence is insufficient" }; } },
    decisionRuntime: {
      jevClient: { async decide() {} },
      async reviewWorkflowPlan(input) {
        return {
          decisionId: input.decisionId,
          status: "reviewed",
          disposition: "needs_agent_review",
          reviewOutcome: "needs_review",
          bindingStatus: "bound",
          planHash: input.planHash,
          observationId: input.observationId,
          reviewBindingHash: input.reviewBinding.bindingHash,
          taskContractHash: input.reviewBinding.taskContractHash,
          capabilityCatalogHash: input.reviewBinding.capabilityCatalogHash,
          targetId: input.reviewBinding.targetId,
          documentGeneration: input.reviewBinding.documentGeneration,
          reviewPolicyVersion: "workflow_plan_review_v1",
          authorizesOperation: false
        };
      }
    }
  });
  const result = await planner.plan("Open record details", createObservation());
  assert.equal(result.status, "needs_human");
  assert.equal(result.workflowReview.reviewOutcome, "needs_review");
  assert.match(result.reason, /no browser effect was dispatched/u);
  assert.equal(planner.getStatus().reviewOutcome, "needs_review");
  assert.equal(planner.getStatus().status, "suspended_review");
  assert.deepEqual(result.suspendedPlan, {
    planHash: planner.getStatus().suspendedPlanHash,
    observationId: planner.getStatus().suspendedObservationId,
    decisionId: planner.result.decisionId,
    eventId: planner.result.eventId
  });
  const repeated = await planner.plan("Open record details", createObservation());
  assert.equal(repeated.status, "needs_human", "a later planner pass cannot execute a plan after review refused it");
  assert.equal(planner.getStatus().status, "suspended_review");
  assert.equal(fallbackCalls, 1, "the deterministic planner was consulted for routing only; no fallback action was selected");
});

test("required registered workflow capability fails closed when synthesis is unavailable", async () => {
  let fallbackCalls = 0;
  const planner = new WorkflowGraphPlanner({
    synthesizer: { async synthesize() { return { status: "unavailable", failureCode: "transport" }; } },
    capabilities,
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page", requiredCapabilityIds: ["open_record_details"] },
    fallbackPlanner: { async plan() { fallbackCalls++; return { status: "planned", action: { type: "click", target: createObservation().candidates[0] } }; } }
  });
  const result = await planner.plan("Open record details", createObservation());
  assert.equal(result.status, "ambiguous");
  assert.match(result.reason, /required registered capability/u);
  assert.equal(fallbackCalls, 0);
});

test("synthesis failure never degrades compound or unknown work into a partial deterministic action", async () => {
  for (const cardinality of ["compound", "unknown"]) {
    let deterministicCalls = 0;
    const observation = createObservation();
    const planner = new WorkflowGraphPlanner({
      synthesizer: { async synthesize() { return { status: "unavailable", failureCode: "transport" }; } },
      capabilities,
      taskIntent: { purposeCode: "general_task", outcomeCode: "requested_result", cardinality },
      fallbackPlanner: { async plan() {
        deterministicCalls++;
        return { status: "planned", confidence: 0.99, action: { type: "click", target: observation.candidates[0] } };
      } }
    });
    const result = await planner.plan("Open a record and extract its details", observation);
    assert.equal(result.status, "ambiguous");
    assert.equal(Object.hasOwn(result, "action"), false);
    assert.equal(deterministicCalls, 1, "deterministic evidence is inspected once for routing, not selected as a partial fallback");
  }
});

test("synthesis failure may retain a uniquely resolved safe atomic click", async () => {
  const observation = createObservation();
  const deterministicPlan = { status: "planned", confidence: 0.95, action: { type: "click", target: observation.candidates[0] } };
  const planner = new WorkflowGraphPlanner({
    synthesizer: { async synthesize() { return { status: "unavailable", failureCode: "transport" }; } },
    capabilities,
    taskIntent: { purposeCode: "open_record", outcomeCode: "details_page", cardinality: "atomic" },
    fallbackPlanner: { async plan() { return deterministicPlan; } }
  });
  assert.equal(await planner.plan("Open record details", observation), deterministicPlan);
});

test("NavigationEngine executes a synthesized plan through its authorized browser executor", async () => {
  const session = {
    attached: true,
    target: { id: "workflow-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [{ level: 1, text: "Records" }],
      candidates: [{
        identity: "details_link",
        targetId: "workflow-target",
        documentGeneration: 1,
        backendNodeId: 15,
        tag: "a",
        role: "link",
        name: "View details",
        contextName: "Record A",
        href: "https://fixture.example/records/a",
        visible: true,
        disabled: false
      }],
      scrollTargets: []
    },
    observationCount: 0,
    documentGeneration: 1,
    dispatched: 0,
    async observe() {
      this.observationCount++;
      return { evidenceId: `workflow_observation_${this.observationCount}`, targetId: this.target.id, documentGeneration: this.documentGeneration, ...structuredClone(this.state) };
    },
    async waitForChange() {},
    async click(candidate) {
      assert.equal(candidate.backendNodeId, 15);
      this.dispatched++;
      this.state = { page: { url: "https://fixture.example/records/a", title: "Record details" }, headings: [{ level: 1, text: "Record details" }], candidates: [], scrollTargets: [] };
      this.documentGeneration++;
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  let jevCalls = 0;
  const decisionRuntime = createDecisionRuntime({
    eventStore,
    semanticAnalyzer: null,
    jevClient: { async decide({ questions }) {
      jevCalls++;
      return { model: JEV_MODEL_ID, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", probabilityYes: 0.94 }])) };
    } }
  });
  let modelCalls = 0;
  try {
    const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { modelCalls++; return { result: plan }; } }, eventStore });
    const engine = new NavigationEngine(session, {
      plannerMode: "workflow",
      workflowSynthesizer: synthesizer,
      workflowCapabilities: [{
        ...capabilities[0],
        verify({ verificationCode, beforeObservation, afterObservation }) {
          return verificationCode === "details_route_observed" && afterObservation.page.url.endsWith("/records/a")
            && beforeObservation.page.url !== afterObservation.page.url
            ? { status: "verified", contractId: "open_record_details", verifiedCode: verificationCode, evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId] }
            : { status: "failed", reasonCode: "expected_destination_not_observed" };
        }
      }],
      decisionRuntime,
      environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
      assertExecutionLease: async () => {},
      maxActions: 4
    });
    const result = await engine.run("Open record A details", { workflowIntent: { purposeCode: "open_record", outcomeCode: "details_page" } });
    assert.equal(result.status, "succeeded");
    assert.equal(result.attempts, 1);
    assert.equal(result.workflowPlan.status, "completed");
    assert.equal(result.workflowPlan.synthesisCalls, 1);
    assert.equal(modelCalls, 1);
    assert.equal(jevCalls, 0, "Jev is skipped for a routine one-step workflow with no visual evidence");
    assert.equal(session.dispatched, 1);
    const episode = eventStore.listEpisodes().at(-1);
    const events = eventStore.getEvents(episode.episode_id);
    assert.equal(events.filter(event => event.eventType === "workflow.plan_synthesized").length, 1);
    assert.equal(events.filter(event => event.eventType === "decision.predicted").length, 0);
    assert.deepEqual(events.filter(event => event.eventType === "inference.route_selected").map(event => event.payload.route), ["semantic_only", "deterministic"]);
    assert.equal(events.filter(event => event.eventType === "verification.completed").length, 1);
    assert.equal(eventStore.verifyEpisodeChain(episode.episode_id).ok, true);
  } finally { decisionRuntime.close(); }
});

test("NavigationEngine executes a verified conditional DAG without another planning call per action", async () => {
  const first = createObservation().candidates[0];
  const second = { ...first, identity: "candidate_next", name: "Continue", contextName: "Section one", href: "https://fixture.example/step-two" };
  const dag = {
    version: 1,
    steps: [
      { id: "open_first", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "open_second", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_2", dependsOn: ["open_first"], when: { stepId: "open_first", status: "passed" }, verifyCode: "details_route_observed", onMissing: "stop" }
    ]
  };
  const session = {
    attached: true,
    target: { id: "workflow-dag-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [{ level: 1, text: "Records" }],
      candidates: [first, second].map((candidate, index) => ({
        ...candidate,
        targetId: "workflow-dag-target",
        documentGeneration: 1,
        backendNodeId: 30 + index
      })),
      scrollTargets: []
    },
    dispatched: [],
    observations: 0,
    documentGeneration: 1,
    async observe() { this.observations++; return { evidenceId: `dag_observation_${this.observations}`, targetId: this.target.id, documentGeneration: this.documentGeneration, ...structuredClone(this.state) }; },
    async waitForChange() {},
    async click(candidate) {
      this.dispatched.push(candidate.backendNodeId);
      const path = this.dispatched.length === 1 ? "/step-one" : "/step-two";
      this.state.page = { url: `https://fixture.example${path}`, title: "Workflow step" };
      this.documentGeneration++;
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  let synthesisCalls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { synthesisCalls++; return { result: dag }; } } });
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [{
      ...capabilities[0],
      purposeCodes: ["complete_sections"],
      postconditionCodes: ["two_sections_complete"],
      verify({ verificationCode, beforeObservation, afterObservation }) {
        return afterObservation.page.url.endsWith("/step-one") || afterObservation.page.url.endsWith("/step-two")
          ? { status: "verified", contractId: "open_record_details", verifiedCode: verificationCode, evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId] }
          : { status: "failed", reasonCode: "expected_destination_not_observed" };
      }
    }],
    environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
    assertExecutionLease: async () => {},
    maxActions: 4
  });
  const result = await engine.run("Complete the two section workflow", { workflowIntent: { purposeCode: "complete_sections", outcomeCode: "two_sections_complete" } });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(session.dispatched, [30, 31]);
  assert.equal(synthesisCalls, 1);
  assert.equal(result.workflowPlan.synthesisCalls, 1);
  assert.deepEqual(result.workflowPlan.stepStatuses, { open_first: "passed", open_second: "passed" });
});

test("workflow plans resolve registered target roles from fresh observations on later pages", async () => {
  const steps = {
    version: 1,
    steps: [
      { id: "open_details", capabilityId: "open_record_details", targetRole: "record_details_link", targetRef: "candidate_1", dependsOn: [], verifyCode: "details_route_observed", onMissing: "stop" },
      { id: "continue", capabilityId: "continue_flow", targetRole: "continue_link", dependsOn: ["open_details"], when: { stepId: "open_details", status: "passed" }, verifyCode: "results_route_observed", onMissing: "stop" }
    ]
  };
  const session = {
    attached: true,
    target: { id: "workflow-future-target", endpoint: "fixture", url: "https://fixture.example/list" },
    state: {
      page: { url: "https://fixture.example/list", title: "Records" },
      headings: [],
      candidates: [{ identity: "details", tag: "a", role: "link", name: "Details", href: "https://fixture.example/details", visible: true, disabled: false, targetId: "workflow-future-target", documentGeneration: 1, backendNodeId: 41 }],
      scrollTargets: []
    },
    dispatched: [],
    observations: 0,
    documentGeneration: 1,
    async observe() { this.observations++; return { evidenceId: `future_observation_${this.observations}`, targetId: this.target.id, documentGeneration: this.documentGeneration, ...structuredClone(this.state) }; },
    async waitForChange() {},
    async click(candidate) {
      this.dispatched.push(candidate.identity);
      if (candidate.identity === "details") {
        this.state.page = { url: "https://fixture.example/details", title: "Details" };
        this.documentGeneration++;
        this.state.candidates = [{ identity: "continue_now", tag: "a", role: "link", name: "Continue", href: "https://fixture.example/results", visible: true, disabled: false, targetId: this.target.id, documentGeneration: 2, backendNodeId: 52 }];
      } else {
        this.state.page = { url: "https://fixture.example/results", title: "Results" };
        this.documentGeneration++;
        this.state.candidates = [];
      }
      this.target.url = this.state.page.url;
      return { dispatched: true };
    }
  };
  let synthesisCalls = 0;
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { synthesisCalls++; return { result: steps }; } } });
  const engine = new NavigationEngine(session, {
    plannerMode: "workflow",
    workflowSynthesizer: synthesizer,
    workflowCapabilities: [
      { ...capabilities[0], verify({ verificationCode, beforeObservation, afterObservation }) {
        return afterObservation.page.url.endsWith("/details")
          ? { status: "verified", contractId: "open_record_details", verifiedCode: verificationCode, evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId] }
          : { status: "failed", reasonCode: "expected_destination_not_observed" };
      } },
      {
        id: "continue_flow", action: "click", effectClass: "navigation", intentBinding: "generic_navigation", targetRole: "continue_link",
        purposeCodes: ["continue_flow"], preconditionCodes: ["observed_authorized_target"], postconditionCodes: ["results_page"],
        observedRoles: [], observedTags: [],
        resolveTarget(observation) { return observation.candidates.filter(candidate => candidate.name === "Continue").map(candidate => candidate.identity); },
        verificationCodes: ["results_route_observed"],
        verify({ verificationCode, beforeObservation, afterObservation }) {
          return afterObservation.page.url.endsWith("/results")
            ? { status: "verified", contractId: "continue_flow", verifiedCode: verificationCode, evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId] }
            : { status: "failed", reasonCode: "expected_destination_not_observed" };
        }
      }
    ],
    workflowIntent: { purposeCode: "complete_records_flow", permittedPurposeCodes: ["open_record", "continue_flow"], outcomeCode: "results_page" },
    environment: { environmentId: "fixture_environment", authorizedOrigins: ["https://fixture.example"] },
    assertExecutionLease: async () => {},
    maxActions: 4
  });
  const result = await engine.run("Open details then continue");
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(session.dispatched, ["details", "continue_now"]);
  assert.equal(synthesisCalls, 1);
  assert.deepEqual(result.workflowPlan.stepStatuses, { open_details: "passed", continue: "passed" });
});

test("generic link verification binds success to the fresh link destination", () => {
  const [capability] = createGenericWorkflowCapabilities({
    environment: { environmentId: "fixture", authorizedOrigins: ["https://fixture.example"], applications: [] }
  });
  const target = {
    identity: "details",
    href: "https://fixture.example/records/a",
    targetId: "fixture-tab",
    documentGeneration: 3
  };
  const beforeObservation = {
    evidenceId: "before-1",
    targetId: "fixture-tab",
    documentGeneration: 3,
    page: { url: "https://fixture.example/records", title: "Records" },
    headings: [{ level: 1, text: "Records" }],
    candidates: [target]
  };
  const after = (url, overrides = {}) => ({
    evidenceId: "after-1",
    targetId: "fixture-tab",
    documentGeneration: 3,
    page: { url, title: "Record details" },
    headings: [{ level: 1, text: "Record details" }],
    candidates: [],
    ...overrides
  });
  const verify = observation => capability.verify({
    verificationCode: "authorized_route_changed",
    beforeObservation,
    afterObservation: observation,
    target
  });

  const correct = verify(after("https://fixture.example/records/a"));
  assert.equal(correct.status, "verified");
  assert.equal(correct.contractId, capability.id);
  assert.equal(correct.verificationKind, "destination_observed");
  assert.equal(correct.expectedDestination, "https://fixture.example/records/a");
  assert.equal(correct.observedDestination, "https://fixture.example/records/a");
  assert.deepEqual(correct.evidenceRefs, ["before-1", "after-1"]);
  assert.equal(verify(after("https://fixture.example/error", { page: { url: "https://fixture.example/error", title: "Not Found" } })).reasonCode, "observed_destination_mismatch");
  assert.equal(verify(after("https://fixture.example/login", { page: { url: "https://fixture.example/login", title: "Sign in" } })).reasonCode, "observed_destination_mismatch");
  assert.equal(verify(after("https://fixture.example/records/a", { networkSignals: [{ status: 500 }] })).reasonCode, "destination_error_observed");
  assert.equal(verify({ ...after("https://fixture.example/records/a"), evidenceId: "before-1" }).status, "uncertain");
  assert.equal(verify(after("https://fixture.example/records/a", {
    targetId: "another-tab",
    documentGeneration: 4
  })).reasonCode, "destination_target_or_generation_mismatch");
  assert.equal(verify(after("https://fixture.example/records/a", {
    documentGeneration: 4,
    page: { url: "https://fixture.example/records/a", title: "Records" },
    headings: [{ level: 1, text: "Records" }],
    candidates: [target]
  })).reasonCode, "destination_content_not_observed", "an SPA URL update without fresh destination context is not verified even when Chrome advances the candidate generation");
  assert.equal(capability.verify({
    verificationCode: "authorized_route_changed",
    beforeObservation: { ...beforeObservation, candidates: [] },
    afterObservation: after("https://fixture.example/records/a"),
    target
  }).status, "uncertain");
});

test("workflow planner does not accept an unbound verified status object", async () => {
  const capability = {
    id: "open_record_details",
    action: "click",
    effectClass: "navigation",
    targetRole: "record_details_link",
    observedRoles: ["link"],
    observedTags: ["a"],
    verificationCodes: ["details_route_observed"],
    resolveTarget(observation) { return observation.candidates.map(candidate => candidate.identity); },
    verify() { return { status: "verified", reasonCode: "claimed_without_proof" }; }
  };
  const step = {
    id: "open_details",
    capabilityId: capability.id,
    targetRole: capability.targetRole,
    dependsOn: [],
    verifyCode: "details_route_observed",
    onMissing: "stop"
  };
  const planner = new WorkflowGraphPlanner({ capabilities: [capability] });
  planner.result = { plan: { steps: [step] }, capabilities: { byId: new Map([[capability.id, capability]]) }, bindings: new Map() };
  const beforeObservation = {
    evidenceId: "before-proof-test",
    page: { url: "https://fixture.example/records" },
    candidates: [{ identity: "details", href: "https://fixture.example/records/a", visible: true, disabled: false }]
  };
  const planned = await planner.plan("Open details", beforeObservation);
  assert.equal(planned.status, "planned");
  const outcome = await planner.recordOutcome({
    action: planned.action,
    beforeObservation,
    afterObservation: { evidenceId: "after-proof-test", page: { url: "https://fixture.example/records/a" } },
    dispatchStatus: "dispatched"
  });
  assert.equal(outcome.status, "uncertain");
  assert.equal(planner.isComplete(), false);
});

test("workflow input references preserve exact strings and refuse implicit scalar coercion", async () => {
  const capability = {
    id: "fill_email",
    action: "fill",
    effectClass: "test_owned_mutation",
    intentBinding: "caller_required",
    operationId: "fill_form_field",
    targetRole: "email_field",
    purposeCodes: ["fill_email"],
    preconditionCodes: ["authorized_form_field"],
    postconditionCodes: ["email_field_updated"],
    observedRoles: ["textbox"],
    observedTags: ["input"],
    verificationCodes: ["exact_form_value_verified"],
    verify() { return { status: "uncertain" }; }
  };
  const inputPlan = {
    version: 1,
    steps: [{
      id: "fill_email",
      capabilityId: capability.id,
      targetRole: capability.targetRole,
      targetRef: "candidate_1",
      inputRef: "email",
      dependsOn: [],
      verifyCode: "exact_form_value_verified",
      onMissing: "stop"
    }]
  };
  const makePlanner = value => new WorkflowGraphPlanner({
    synthesizer: new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: inputPlan }; } } }),
    capabilities: [capability],
    inputs: { email: value },
    taskIntent: { purposeCode: "fill_email", outcomeCode: "email_field_updated", requiredCapabilityIds: ["fill_email"] }
  });
  const observation = createObservation({
    candidates: [{ identity: "email", tag: "input", role: "textbox", name: "Email", visible: true, disabled: false }]
  });
  const exact = "Foo.Bar+QA@example.com  ";
  const planned = await makePlanner(exact).plan("Fill the email field", observation);
  assert.equal(planned.status, "planned");
  assert.equal(planned.action.value, exact);
  for (const value of [123, true]) {
    const refused = await makePlanner(value).plan("Fill the email field", observation);
    assert.equal(refused.status, "ambiguous", `non-string caller input ${String(value)} is refused before dispatch`);
    assert.match(refused.reason, /caller input reference is absent or exceeds/u);
  }
});
