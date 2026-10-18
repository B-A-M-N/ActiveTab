import test from "node:test";
import assert from "node:assert/strict";
import { configuredPlanner, DeterministicPlanner, OpenAICompatiblePlanner } from "../src/navigation/planner.js";

const jsonResponse = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" }
});

test("OpenAI-compatible planner strips URL user-info, query, and fragment before sending compact evidence", async () => {
  let request;
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    apiKey: "provider-secret",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      request = { url: _url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "click", identity: "candidate-1" }) } }] });
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

test("OpenAI-compatible planner can select only a currently observed scroll region", async () => {
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.messages[1].content.includes("invoice-list"));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "scroll", identity: "invoice-list", direction: "down" }) } }] });
    }
  });
  const target = { identity: "invoice-list", kind: "container", name: "Invoice list", visible: true, canScrollDown: true };
  const observation = { page: { url: "https://shop.example.test", title: "Shop" }, headings: [], frames: [], candidates: [], scrollTargets: [target] };
  const result = await planner.plan("Open invoice 24 page", observation);
  assert.equal(result.status, "planned");
  assert.equal(result.action.type, "scroll");
  assert.equal(result.action.target, target);
});

test("model action planning requires standalone mode plus a separate explicit selection", () => {
  const previous = {
    endpoint: process.env.ACTIVETAB_MODEL_ENDPOINT,
    model: process.env.ACTIVETAB_MODEL,
    allow: process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT
  };
  try {
    process.env.ACTIVETAB_MODEL_ENDPOINT = "https://model.example.test/v1";
    process.env.ACTIVETAB_MODEL = "test-model";
    delete process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT;
    assert.ok(configuredPlanner() instanceof DeterministicPlanner);
    assert.throws(() => configuredPlanner({ executionMode: "standalone", plannerMode: "model" }), /ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1/);
    assert.throws(() => new OpenAICompatiblePlanner({ endpoint: "https://model.example.test/v1", model: "test-model" }), /Explicitly set ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT/);
    process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = "1";
    assert.ok(configuredPlanner() instanceof DeterministicPlanner, "endpoint configuration does not change the planner role");
    assert.ok(configuredPlanner({ executionMode: "standalone", plannerMode: "model" }) instanceof OpenAICompatiblePlanner);
    assert.ok(configuredPlanner({ executionMode: "agent_directed", plannerMode: "model" }) instanceof DeterministicPlanner);
  } finally {
    if (previous.endpoint === undefined) delete process.env.ACTIVETAB_MODEL_ENDPOINT;
    else process.env.ACTIVETAB_MODEL_ENDPOINT = previous.endpoint;
    if (previous.model === undefined) delete process.env.ACTIVETAB_MODEL;
    else process.env.ACTIVETAB_MODEL = previous.model;
    if (previous.allow === undefined) delete process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT;
    else process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT = previous.allow;
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
