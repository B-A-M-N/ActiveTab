import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configuredPlanner, DeterministicPlanner, OpenAICompatiblePlanner } from "../src/navigation/planner.js";

const visualFixtureBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");

const jsonResponse = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
});

function structuredProposal(request, { candidateRef = "", scrollRef = "", decision = candidateRef ? "select_candidate" : scrollRef ? "select_scroll" : "abstain", reasonCode = candidateRef ? "selected_candidate" : scrollRef ? "selected_scroll" : "insufficient_evidence" } = {}) {
  const message = request.messages[1].content;
  const payload = JSON.parse(typeof message === "string" ? message : message[0].text);
  return {
    version: 1,
    observationId: payload.input.observationId,
    decision,
    candidateRef,
    scrollRef,
    reasonCode
  };
}

test("OpenAI-compatible planner strips URL user-info, query, and fragment before sending compact evidence", async () => {
  let request;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    apiKey: "provider-secret",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      request = { url: _url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(structuredProposal(JSON.parse(options.body), { candidateRef: "candidate_1" })) } }] });
    }
  });
  const observation = {
    page: { url: "https://page-user:page-pass@shop.example.test/account?session=page-secret#private", title: "Account" },
    headings: [{ level: 1, text: "Account" }],
    frames: [],
    candidates: [{ identity: "candidate-1", tag: "button", role: "button", name: "Open account", contextName: "Account overview", href: "https://link-user:link-pass@shop.example.test/account?token=link-secret", visible: true }]
  };
  const result = await planner.plan("Open the account page", observation);
  assert.equal(result.status, "planned");
  const body = JSON.stringify(request.body);
  assert.equal(body.includes("page-secret"), false);
  assert.equal(body.includes("page-user"), false);
  assert.equal(body.includes("page-pass"), false);
  assert.equal(body.includes("link-secret"), false);
  assert.equal(body.includes("link-user"), false);
  assert.equal(body.includes("link-pass"), false);
  assert.equal(body.includes("provider-secret"), false, "provider credentials are headers, never message content");
  assert.equal(request.body.messages[1].content.includes("?session="), false);
  assert.equal(request.body.messages[1].content.includes("Account overview"), true, "section context is available only within the explicitly enabled page-evidence request");
  assert.equal(request.headers.authorization, "Bearer provider-secret");
});

test("OpenAI-compatible planner sends a bounded evidence-linked semantic page projection", async () => {
  let requestPayload;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requestPayload = JSON.parse(request.messages[1].content);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(structuredProposal(request, { candidateRef: "candidate_1" })) } }] });
    }
  });
  const observation = {
    evidenceId: "semantic_projection_observation",
    targetId: "semantic_projection_target",
    documentGeneration: 4,
    page: { url: "https://shop.example.test/account?secret=session", title: "Account settings" },
    headings: [{ level: 1, text: "Account settings" }],
    frames: [],
    scrollTargets: [],
    candidates: [{
      identity: "root:frame-a:backend-node-17", tag: "button", role: "button", name: "Account settings",
      contextName: "Profile controls", visible: true, disabled: false
    }],
    semanticPage: {
      schemaVersion: 2,
      evidence: { observationId: "semantic_projection_observation", targetId: "semantic_projection_target", documentGeneration: 4 },
      page: { pageType: { value: "unknown", status: "unknown" } },
      candidateCoverage: {
        pageCandidateCount: 240, returnedCandidateCount: 200, omittedCandidateCount: 40,
        pageCoverage: "partial", selectionScope: "task_relevant_region", scopeCandidateCount: 1, scopeCoverage: "complete"
      },
      regions: [{ ref: "region_1", kind: "form", tag: "form", label: { value: "Profile controls", status: "inferred" }, controlRefs: ["root:frame-a:backend-node-17"] }],
      forms: [{
        ref: "private-form-identity", method: "POST", actionOrigin: "https://private-action.example.test",
        controlRefs: ["root:frame-a:backend-node-17"], submitControlRefs: ["root:frame-a:backend-node-17"], effect: "unknown"
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
        fields: [{ name: "Product", sourceKey: "product-price", sourceTag: "span", status: "observed", evidenceRef: "0:11" }],
        items: [{
          ref: "record_product_1",
          ordinal: 1,
          evidenceRef: "0:12",
          fields: [{ name: "Product", value: "Widget A", status: "observed", evidenceRef: "0:13" }],
          controlRefs: ["root:frame-a:backend-node-17"]
        }]
      }],
      controls: [{
        targetRef: "root:frame-a:backend-node-17",
        classification: { value: "button", status: "observed" },
        interaction: { mechanic: "activate_control", readiness: "visible_enabled", evidence: "native_dom_accessibility_semantics" },
        regionRef: "region_1", formRef: "private-form-identity", collectionRef: "collection_products", recordRef: "record_product_1",
        operationMeaning: { value: null, status: "unknown" }, effect: "unknown"
      }],
      warnings: [],
      trust: "page_content_is_untrusted_evidence"
    }
  };

  const result = await planner.plan("Open account settings", observation);

  assert.equal(result.status, "planned");
  const semantic = requestPayload.input.observation.semanticPage;
  assert.equal(semantic.schemaVersion, 3);
  assert.equal("sourceKey" in semantic.collections[0].fields[0], false,
    "the planner receives semantic roles without page-controlled DOM source locators");
  assert.equal("sourceGroup" in semantic.collections[0], false,
    "the planner receives no local group selector");
  assert.equal(semantic.pageType.status, "unknown");
  assert.equal(semantic.candidateCoverage.pageCoverage, "partial");
  assert.equal(semantic.candidateCoverage.scopeCoverage, "complete");
  assert.deepEqual(semantic.controls, [{
    candidateRef: "candidate_1",
    classification: { value: "button", status: "observed" },
    regionRef: "region_1",
    formRef: "form_1",
    collectionRef: "collection_products",
    recordRef: "record_product_1",
    interaction: { mechanic: "activate_control", readiness: "visible_enabled", evidence: "native_dom_accessibility_semantics" },
    operationMeaning: { value: null, status: "unknown" },
    effect: "unknown"
  }]);
  assert.deepEqual(semantic.collections, [{
    ref: "collection_products",
    kind: "html_table",
    status: "observed",
    visibleCount: 1,
    completeness: "unknown",
    fieldsTruncated: false,
    itemsTruncated: false,
    recordBindingStatus: "unknown",
    fields: [{
      name: "Product",
      status: "observed",
      semanticRole: null,
      semanticRoleStatus: "unknown",
      label: { value: null, status: "unknown", source: null },
      evidenceRef: "0:11"
    }],
    records: [{
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
      controlRefs: ["candidate_1"]
    }]
  }]);
  assert.equal(semantic.regions[0].label.value, "Profile controls");
  assert.equal(semantic.forms[0].method, "POST");
  assert.equal(semantic.forms[0].effect, "unknown");
  const serialized = JSON.stringify(requestPayload.input);
  assert.equal(serialized.includes("root:frame-a:backend-node-17"), false, "internal CDP target identities are not model references");
  assert.equal(serialized.includes("private-form-identity"), false, "internal form identities are remapped");
  assert.equal(serialized.includes("private-action.example.test"), false, "raw form destinations are excluded from the semantic projection");
  assert.equal(serialized.includes("secret=session"), false, "the existing sanitized page URL remains in force");
  assert.equal(requestPayload.input.observation.semanticPage.trust, "page_content_is_untrusted_evidence");
});

test("OpenAI-compatible planner excludes semantically unrelated candidates before asking the model", async () => {
  let calls = 0;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      assert.match(request.messages[1].content, /Open reports/u);
      assert.match(request.messages[1].content, /Reports/u);
      assert.doesNotMatch(request.messages[1].content, /Delete account/u);
      assert.doesNotMatch(request.messages[1].content, /Delete reports/u, "shared nouns cannot make a destructive control eligible for a read/navigation goal");
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(structuredProposal(JSON.parse(options.body), { candidateRef: "candidate_1" })) } }] });
    }
  });
  const result = await planner.plan("Open reports", {
    evidenceId: "planner_relevance_observation",
    page: { url: "https://example.test", title: "Home" }, headings: [], frames: [], scrollTargets: [],
    candidates: [
      { identity: "reports", tag: "a", role: "link", name: "Reports", contextName: "Reports", visible: true, disabled: false },
      { identity: "delete", tag: "button", role: "button", name: "Delete account", contextName: "Account settings", visible: true, disabled: false },
      { identity: "delete_reports", tag: "button", role: "button", name: "Delete reports", contextName: "Reports", visible: true, disabled: false }
    ]
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "planned");
  assert.equal(result.action.target.identity, "reports");
});

test("OpenAI-compatible planner does not call the model when every candidate is irrelevant to the goal", async () => {
  let calls = 0;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1", model: "test-model", allowPageContent: true,
    fetchImpl: async () => { calls++; throw new Error("irrelevant candidates must not be sent"); }
  });
  const result = await planner.plan("Open reports", {
    evidenceId: "planner_irrelevance_observation",
    page: { url: "https://example.test", title: "Account" }, headings: [], frames: [], scrollTargets: [],
    candidates: [{ identity: "delete", tag: "button", role: "button", name: "Delete account", contextName: "Account settings", visible: true, disabled: false }]
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(calls, 0);
});

test("model candidate proposals cannot select a destructive target that only shares goal nouns", async () => {
  let calls = 0;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const proposal = structuredProposal(body, { candidateRef: "candidate_1" });
      // Even a fabricated reference to a locally excluded target cannot pass
      // the response schema's per-request enum or the local reference lookup.
      proposal.candidateRef = "candidate_2";
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    }
  });
  const pending = planner.plan("Open reports", {
    evidenceId: "planner_shared_noun_observation",
    page: { url: "https://example.test", title: "Reports" },
    headings: [], frames: [], scrollTargets: [],
    candidates: [
      { identity: "reports", tag: "a", role: "link", name: "Reports", visible: true, disabled: false },
      { identity: "delete_reports", tag: "button", role: "button", name: "Delete reports", visible: true, disabled: false }
    ]
  });
  await assert.rejects(pending, error => error.kind === "schema");
  assert.equal(calls, 1);
});

test("OpenAI-compatible planner can select only a currently observed scroll region", async () => {
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.messages[1].content.includes("scroll_1"));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(structuredProposal(body, { scrollRef: "scroll_1" })) } }] });
    }
  });
  const target = { identity: "invoice-list", kind: "container", name: "Invoice list", visible: true, canScrollDown: true };
  const observation = { page: { url: "https://shop.example.test", title: "Shop" }, headings: [], frames: [], candidates: [], scrollTargets: [target] };
  const result = await planner.plan("Open invoice 24 page", observation);
  assert.equal(result.status, "planned");
  assert.equal(result.action.type, "scroll");
  assert.equal(result.action.target, target);
});

test("model action planning requires standalone mode plus a separate explicit selection", async () => {
  const previous = {
    endpoint: process.env.ACTIVETAB_MODEL_ENDPOINT,
    model: process.env.ACTIVETAB_MODEL,
    modelApiKey: process.env.ACTIVETAB_MODEL_API_KEY,
    semanticApiKey: process.env.ACTIVETAB_SEMANTIC_API_KEY,
    freeInferenceApiKey: process.env.FREEINFERENCE_API_KEY,
    allow: process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT,
    allowScreenshots: process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS,
    imageInput: process.env.ACTIVETAB_MODEL_IMAGE_INPUT
  };
  try {
    process.env.ACTIVETAB_MODEL_ENDPOINT = "https://model.example.test/v1";
    process.env.ACTIVETAB_MODEL = "test-model";
    delete process.env.ACTIVETAB_MODEL_API_KEY;
    delete process.env.ACTIVETAB_SEMANTIC_API_KEY;
    process.env.FREEINFERENCE_API_KEY = "freeinference-test-key";
    delete process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT;
    delete process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS;
    delete process.env.ACTIVETAB_MODEL_IMAGE_INPUT;
    assert.ok(configuredPlanner() instanceof DeterministicPlanner);
    assert.throws(() => configuredPlanner({ executionMode: "standalone", plannerMode: "model" }), /ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1/);
    assert.throws(() => new OpenAICompatiblePlanner({ endpoint: "https://model.example.test/v1", model: "test-model" }), /Explicitly set ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT/);
    process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = "1";
    assert.ok(configuredPlanner() instanceof DeterministicPlanner, "endpoint configuration does not change the planner role");
    assert.ok(configuredPlanner({ executionMode: "standalone", plannerMode: "model" }) instanceof OpenAICompatiblePlanner);
    assert.ok(configuredPlanner({ executionMode: "agent_directed", plannerMode: "model" }) instanceof DeterministicPlanner);
    process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS = "1";
    assert.equal(configuredPlanner({ executionMode: "standalone", plannerMode: "model" }).requiresScreenshot, false,
      "screenshot consent alone does not declare provider image capability");
    process.env.ACTIVETAB_MODEL_IMAGE_INPUT = "1";
    assert.equal(configuredPlanner({ executionMode: "standalone", plannerMode: "model" }).requiresScreenshot, true);
    delete process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS;
    delete process.env.ACTIVETAB_MODEL_IMAGE_INPUT;
    let authorization;
    const credentialFallbackPlanner = configuredPlanner({
      executionMode: "standalone",
      plannerMode: "model",
      fetchImpl: async (_url, options) => {
        authorization = options.headers.authorization;
        const request = JSON.parse(options.body);
        const input = JSON.parse(request.messages[1].content);
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({
          version: 1,
          observationId: input.input.observationId,
          decision: "select_candidate",
          candidateRef: "candidate_1",
          scrollRef: "",
          reasonCode: "selected_candidate"
        }) } }] });
      }
    });
    const credentialFallbackResult = await credentialFallbackPlanner.plan("Click Save", {
      evidenceId: "credential_fallback_observation",
      targetId: "credential_fallback_target",
      documentGeneration: 1,
      viewport: { width: 1280, height: 720 },
      page: { url: "https://example.test/settings", title: "Settings" },
      headings: [],
      candidates: [{ identity: "save_button", tag: "button", role: "button", name: "Save", visible: true, disabled: false }],
      scrollTargets: []
    });
    assert.equal(authorization, "Bearer freeinference-test-key");
    assert.equal(credentialFallbackResult.status, "planned");
  } finally {
    if (previous.endpoint === undefined) delete process.env.ACTIVETAB_MODEL_ENDPOINT;
    else process.env.ACTIVETAB_MODEL_ENDPOINT = previous.endpoint;
    if (previous.model === undefined) delete process.env.ACTIVETAB_MODEL;
    else process.env.ACTIVETAB_MODEL = previous.model;
    if (previous.modelApiKey === undefined) delete process.env.ACTIVETAB_MODEL_API_KEY;
    else process.env.ACTIVETAB_MODEL_API_KEY = previous.modelApiKey;
    if (previous.semanticApiKey === undefined) delete process.env.ACTIVETAB_SEMANTIC_API_KEY;
    else process.env.ACTIVETAB_SEMANTIC_API_KEY = previous.semanticApiKey;
    if (previous.freeInferenceApiKey === undefined) delete process.env.FREEINFERENCE_API_KEY;
    else process.env.FREEINFERENCE_API_KEY = previous.freeInferenceApiKey;
    if (previous.allow === undefined) delete process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT;
    else process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = previous.allow;
    if (previous.allowScreenshots === undefined) delete process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS;
    else process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS = previous.allowScreenshots;
    if (previous.imageInput === undefined) delete process.env.ACTIVETAB_MODEL_IMAGE_INPUT;
    else process.env.ACTIVETAB_MODEL_IMAGE_INPUT = previous.imageInput;
  }
});

test("automatic planning reuses the configured semantic endpoint with the current FreeInference model ID", async () => {
  const names = [
    "ACTIVETAB_MODEL_ENDPOINT", "ACTIVETAB_MODEL", "ACTIVETAB_MODEL_API_KEY",
    "ACTIVETAB_SEMANTIC_ENDPOINT", "ACTIVETAB_SEMANTIC_MODEL", "ACTIVETAB_SEMANTIC_API_KEY",
    "FREEINFERENCE_API_KEY", "ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT"
  ];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const name of names) delete process.env[name];
    process.env.ACTIVETAB_SEMANTIC_ENDPOINT = "https://freeinference.example.test/v1";
    process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = "1";
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(structuredProposal(JSON.parse(options.body), { candidateRef: "candidate_2" })) } }] });
    };

    const planner = configuredPlanner({ executionMode: "standalone", plannerMode: "auto" });
    assert.ok(planner instanceof OpenAICompatiblePlanner);
    assert.equal(planner.provider.model, "glm-5.3-flash");
    const result = await planner.plan("Click Save", {
      evidenceId: "auto_model_observation",
      targetId: "auto_model_target",
      documentGeneration: 1,
      viewport: { width: 1280, height: 720 },
      page: { url: "https://fixture.example.test/settings", title: "Settings" },
      headings: [],
      candidates: [
        { identity: "save-one", tag: "button", role: "button", name: "Save", visible: true, disabled: false },
        { identity: "save-two", tag: "button", role: "button", name: "Save", visible: true, disabled: false }
      ],
      scrollTargets: []
    });
    assert.equal(request.url, "https://freeinference.example.test/v1/chat/completions");
    assert.equal(request.body.model, "glm-5.3-flash");
    assert.equal(result.status, "planned");
    assert.equal(result.action.target.identity, "save-two");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("local planner fills a unique searchbox and then selects its matching submitter", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    candidates: [
      { identity: "query-field", tag: "input", type: "search", role: "searchbox", name: "Search products", formIdentity: "search-form", visible: true },
      { identity: "submit-search", tag: "button", role: "button", name: "Search", submitsForm: true, formIdentity: "search-form", formMethod: "get", visible: true }
    ]
  };
  const fill = await planner.plan("Search for blue shoes", observation);
  assert.equal(fill.status, "planned");
  assert.equal(fill.action.type, "type");
  assert.equal(fill.action.target.identity, "query-field");
  assert.equal(fill.action.value, "blue shoes");
  const submit = await planner.plan("Search for blue shoes", observation, { excludedIdentities: ["query-field"] });
  assert.equal(submit.status, "planned");
  assert.equal(submit.action.type, "click");
  assert.equal(submit.action.target.identity, "submit-search");
});

test("form planning preserves exact caller values instead of normalizing executable text", async () => {
  const planner = new DeterministicPlanner();
  const cases = [
    ["Fill Email field with Foo.Bar+QA@example.com", "email", "Foo.Bar+QA@example.com"],
    ["Enter URL field with HTTPS://Example.test/Case?Token=AbC-123", "url", "HTTPS://Example.test/Case?Token=AbC-123"],
    ["Set Code field to XyZ_009-Aa", "code", "XyZ_009-Aa"],
    ["Fill Notes field with  leading and trailing  ", "notes", " leading and trailing  "]
  ];
  for (const [goal, label, expected] of cases) {
    const observation = { candidates: [{ identity: "field", tag: "input", type: "text", role: "textbox", name: label, visible: true }] };
    const plan = await planner.plan(goal, observation);
    assert.equal(plan.status, "planned", goal);
    assert.equal(plan.action.value, expected, goal);
  }

  const exactMultiline = "  First line\nSecond LINE 🌳\n trailing space  ";
  const multiline = await planner.plan("Fill Notes field with inputRef:notes", {
    candidates: [{ identity: "notes", tag: "textarea", type: "text", role: "textbox", name: "Notes", visible: true }]
  }, { inputBindings: { notes: exactMultiline } });
  assert.equal(multiline.status, "planned");
  assert.equal(multiline.action.value, exactMultiline);

  const selection = await planner.plan("Choose the Color dropdown as Ocean Blue / bright", {
    candidates: [{ identity: "color", tag: "select", role: "combobox", name: "Color", visible: true }]
  });
  assert.equal(selection.status, "planned");
  assert.equal(selection.action.value, "Ocean Blue / bright");
});

test("ambiguous, missing, and oversized form values fail closed without mutation", async () => {
  const planner = new DeterministicPlanner();
  const observation = { candidates: [{ identity: "notes", tag: "textarea", type: "text", role: "textbox", name: "Notes", visible: true }] };
  assert.equal((await planner.plan("Fill Notes field with inputRef:missing", observation)).status, "ambiguous");
  assert.equal((await planner.plan("Fill Notes field with First line\nSecond line", observation)).status, "ambiguous");
  const oversized = await planner.plan("Fill Notes field with inputRef:notes", observation, { inputBindings: { notes: "x".repeat(2_001) } });
  assert.equal(oversized.status, "ambiguous");
  assert.match(oversized.reason, /2000-character input limit/u);
  assert.equal((await planner.plan("Fill Notes field", observation)).status, "ambiguous");
});

test("vision-enabled planning sends the current screenshot with DOM evidence in one request", async () => {
  let messages;
  let calls = 0;
  const provider = {
    model: "vision-model",
    capabilities: { imageInput: true },
    async decide(input) {
      calls++;
      messages = input;
      return { decision: { action: "click", identity: "button-1" }, usage: null };
    }
  };
  const planner = new OpenAICompatiblePlanner({ allowPageContent: true, allowScreenshots: true, provider });
  const observation = {
    evidenceId: "observation-1",
    targetId: "target-1",
    documentGeneration: 4,
    viewport: { width: 1280, height: 720 },
    visualEvidence: {
      evidenceId: "observation-1",
      targetId: "target-1",
      documentGeneration: 4,
      viewport: { width: 1280, height: 720 },
      screenshotBase64: visualFixtureBase64
    },
    page: { url: "https://shop.example.test", title: "Shop" },
    headings: [],
    frames: [],
    candidates: [{ identity: "button-1", tag: "button", role: "button", name: "Open cart", visible: true }],
    scrollTargets: []
  };
  const result = await planner.plan("Open the cart page", observation);
  assert.equal(result.status, "planned");
  assert.equal(calls, 1, "vision adds evidence to the existing inference request");
  assert.equal(messages.length, 2);
  assert.equal(typeof messages[1].content[0].text, "string");
  assert.ok(messages[1].content[0].text.includes("candidate_1"));
  assert.ok(messages[1].content[0].text.includes("observation-1"));
  assert.equal(messages[1].content[1].image_url.url, `data:image/jpeg;base64,${visualFixtureBase64}`);
});

test("screenshot transmission stays disabled by default and fails closed when opted in evidence is missing", async () => {
  let calls = 0;
  let lastMessages;
  const provider = {
    model: "vision-model",
    capabilities: { imageInput: true },
    async decide(messages) {
      calls++;
      lastMessages = messages;
      return { decision: { action: "stop", reason: "done" }, usage: null };
    }
  };
  const observation = {
    page: { url: "https://shop.example.test", title: "Shop" },
    headings: [], frames: [], candidates: [
      { identity: "cart-link", tag: "a", role: "link", name: "Cart", contextName: "Shopping", visible: true, disabled: false }
    ], scrollTargets: [], screenshotBase64: "/9j/2Q=="
  };
  const textPlanner = new OpenAICompatiblePlanner({ allowPageContent: true, provider });
  await textPlanner.plan("Open the cart page", observation);
  assert.equal(typeof lastMessages[1].content, "string");
  assert.equal(lastMessages[1].content.includes("/9j/2Q=="), false);
  assert.equal(calls, 1, "default planning does not require or transmit image evidence");

  const screenshotPlanner = new OpenAICompatiblePlanner({ allowPageContent: true, allowScreenshots: true, provider });
  const result = await screenshotPlanner.plan("Open the cart page", { ...observation, visualEvidence: undefined });
  assert.equal(result.status, "ambiguous");
  assert.equal(calls, 1, "missing screenshot evidence prevents a text-only fallback");
  assert.throws(() => new OpenAICompatiblePlanner({
    allowPageContent: true,
    allowScreenshots: true,
    provider: { async decide() {} }
  }), /provider configured with image input support/u);
});

test("local planner uses structural section context to distinguish duplicate control labels", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    candidates: [
      { identity: "shipping-continue", tag: "button", role: "button", name: "Continue", contextName: "Shipping history", visible: true },
      { identity: "billing-continue", tag: "button", role: "button", name: "Continue", contextName: "Billing history", visible: true }
    ]
  };
  const plan = await planner.plan("Open the billing history page", observation);
  assert.equal(plan.status, "planned");
  assert.equal(plan.action.target.identity, "billing-continue");
  assert.match(plan.reasoning, /section-context/);
});

test("local planner scrolls the uniquely relevant observed list when no target is rendered yet", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    candidates: [{ identity: "continue", tag: "button", role: "button", name: "Continue", visible: true }],
    scrollTargets: [
      { identity: "page", kind: "viewport", name: "Page", visible: true, canScrollDown: true },
      { identity: "invoice-list", kind: "container", name: "Invoice list", contextName: "Invoices", visible: true, canScrollDown: true }
    ]
  };
  const plan = await planner.plan("Open invoice 24 page", observation, { maxScrolls: 5, scrollActionsUsed: 0 });
  assert.equal(plan.status, "planned");
  assert.equal(plan.action.type, "scroll");
  assert.equal(plan.action.target.identity, "invoice-list");
  assert.equal((await planner.plan("Open invoice 24 page", observation, { maxScrolls: 5, scrollActionsUsed: 5 })).status, "ambiguous");
  const fallbackScroll = await planner.plan("Open invoice 24 page", observation, { excludedScrollIdentities: ["invoice-list"] });
  assert.equal(fallbackScroll.status, "planned", "resume can choose another current region rather than repeating uncertain movement");
  assert.equal(fallbackScroll.action.target.identity, "page");
});

test("local planner keeps an ambiguous visible control from triggering exploratory scrolling", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    candidates: [
      { identity: "first", tag: "button", role: "button", name: "Continue", visible: true },
      { identity: "second", tag: "button", role: "button", name: "Continue", visible: true }
    ],
    scrollTargets: [{ identity: "list", kind: "container", name: "Invoice list", visible: true, canScrollDown: true }]
  };
  const plan = await planner.plan("Continue", observation);
  assert.equal(plan.status, "ambiguous");
});

test("local planner returns target-scoped evidence handles for ambiguous candidates", async () => {
  const planner = new DeterministicPlanner();
  const observation = {
    candidates: [
      { identity: "root:frame-a:node-11", backendNodeId: 11, tag: "button", role: "button", name: "Continue", contextName: "Account setup", visible: true, bounds: { x: 10, y: 20, width: 90, height: 30 } },
      { identity: "oopif:frame-b:node-22", backendNodeId: 22, frameTargetId: "oopif", tag: "button", role: "button", name: "Continue", contextName: "Account setup", visible: true, bounds: { x: 120, y: 20, width: 90, height: 30 } }
    ]
  };

  const plan = await planner.plan("Continue", observation);

  assert.equal(plan.status, "ambiguous");
  assert.deepEqual(plan.candidates.map(candidate => ({ identity: candidate.identity, backendNodeId: candidate.backendNodeId, frameTargetId: candidate.frameTargetId })), [
    { identity: "root:frame-a:node-11", backendNodeId: 11, frameTargetId: undefined },
    { identity: "oopif:frame-b:node-22", backendNodeId: 22, frameTargetId: "oopif" }
  ]);
  assert.equal(plan.candidates[0].bounds.width, 90);
  assert.equal(plan.candidates[0].contextName, "Account setup");
});
