import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogRoutes } from "../src/api/routes/catalog.js";

function createHarness() {
  const templates = [
    { template_id: "bot-1", name: "First", bot_type: "agent", recommend_desc: "first description", detail_url: "/first", input_schema: { required: ["url"] } },
    { template_id: "bot-2", name: "Second", bot_type: "workflow", recommend_desc: "second description", detail_url: "/second", input_schema: { required: ["query"] } }
  ];
  const calls = [];
  const responses = [];
  const route = createCatalogRoutes({
    officialTemplates: templates,
    regions: ["us", "eu"],
    findTemplate: id => { calls.push(["findTemplate", id]); return templates.find(template => template.template_id === id) ?? null; },
    sendJson: (_response, status, body) => responses.push({ status, body }),
    sendError: (_response, status, code, message) => responses.push({ status, code, message })
  });
  return { route, calls, responses };
}

test("catalog routes leave capability endpoints and unsupported methods to API composition", async () => {
  const harness = createHarness();

  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/capabilities/extra" }), false);
  assert.equal(await harness.route({}, {}, { method: "POST", path: "/v3/bots/templates" }), false);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.responses, []);
});

test("bot catalog preserves pagination and response projection", async () => {
  const harness = createHarness();
  const handled = await harness.route({}, {}, { method: "GET", path: "/v3/bots", query: { page: "2", limit: "1" } });

  assert.equal(handled, true);
  assert.deepEqual(harness.responses, [{ status: 200, body: {
    items: [{ bot_id: "bot-2", name: "Second", bot_type: "workflow", template_id: "bot-2", recommend_desc: "second description" }],
    page: 2, limit: 1, total_count: 2, total_pages: 2
  } }]);
});

test("template catalog and template detail preserve their distinct response shapes", async () => {
  const harness = createHarness();
  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/templates", query: {} }), true);
  assert.deepEqual(harness.responses[0], { status: 200, body: {
    items: [
      { name: "First", template_id: "bot-1", bot_type: "agent", recommend_desc: "first description", detail_url: "/first" },
      { name: "Second", template_id: "bot-2", bot_type: "workflow", recommend_desc: "second description", detail_url: "/second" }
    ],
    page: 1, limit: 10, total_count: 2, total_pages: 1
  } });

  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/templates/bot-1" }), true);
  assert.deepEqual(harness.calls, [["findTemplate", "bot-1"]]);
  assert.deepEqual(harness.responses[1], { status: 200, body: {
    name: "First", template_id: "bot-1", bot_type: "agent", description: "first description",
    input_schema: { required: ["url"] }, recommend_desc: "first description", detail_url: "/first",
    created_at: "2026-10-16T00:00:00Z", published_at: "2026-10-16T00:00:00Z"
  } });
});

test("bot detail, regions, and invalid-template responses remain stable", async () => {
  const harness = createHarness();

  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/bot-2" }), true);
  assert.deepEqual(harness.responses[0], { status: 200, body: {
    bot_id: "bot-2", name: "Second", bot_type: "workflow", input_schema: { required: ["query"] },
    created_at: "2026-10-16T00:00:00Z"
  } });
  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/regions" }), true);
  assert.deepEqual(harness.responses[1], { status: 200, body: ["us", "eu"] });
  assert.equal(await harness.route({}, {}, { method: "GET", path: "/v3/bots/missing" }), true);
  assert.deepEqual(harness.responses[2], { status: 400, code: 99010, message: "bot_id is invalid." });
});
