import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeToolHandlers } from "../src/mcp/tools/runtimeTools.js";

test("MCP runtime capabilities project attached targets, catalog readiness, and consent separately", () => {
  const sessions = new Map([
    ["target-b", { attached: true }],
    ["target-a", { attached: true }],
    ["target-c", { attached: false }]
  ]);
  const modelPreflight = {
    status: "ready",
    telemetryRecorded: true,
    routes: [
      { role: "planner", status: "available", model: "planner-model", inferenceReachability: "catalog_only", imageCapability: true },
      { role: "jev", status: "unavailable", model: "review-model", inferenceReachability: "not_configured", imageCapability: true }
    ]
  };
  const handlers = createRuntimeToolHandlers({
    sessions,
    modelPreflight,
    workflowStore: {},
    env: {
      ACTIVETAB_MODEL_ENDPOINT: "https://model.invalid",
      ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT: "1",
      ACTIVETAB_MODEL_ALLOW_SCREENSHOTS: "1",
      ACTIVETAB_JEV_ALLOW_IMAGES: "0"
    }
  });

  const result = handlers.get_runtime_capabilities();
  assert.deepEqual(result.browser, {
    status: "attached",
    attachedTargetCount: 2,
    targetIds: ["target-a", "target-b"]
  });
  assert.deepEqual(result.planning, {
    status: "available",
    reasonCode: null,
    model: "planner-model",
    preflight: "available",
    preflightKind: "authenticated_catalog_only",
    inferenceReachability: "catalog_only",
    pageContentConsent: true
  });
  assert.equal(result.visual.secondary.status, "available");
  assert.equal(result.visual.jev.status, "requires_consent");
  assert.equal(result.jev.preflightKind, "authenticated_catalog_only");
  assert.equal(result.workflowReuse.status, "available");
  assert.equal(result.modelPreflight.telemetryRecorded, true);
  assert.equal(JSON.stringify(result).includes("model.invalid"), false);
});
