import test from "node:test";
import assert from "node:assert/strict";
import { createMcpToolDispatcher } from "../src/mcp/toolRegistry.js";

test("MCP dispatcher routes every advertised tool to exactly one handler", async () => {
  const dispatcher = createMcpToolDispatcher({
    tools: [{ name: "observe_page" }, { name: "run_goal" }],
    handlerGroups: [
      { observe_page: async args => ({ observed: args.targetId }) },
      { run_goal: async args => ({ goal: args.goal }) }
    ]
  });

  assert.equal(dispatcher.has("observe_page"), true);
  assert.deepEqual(await dispatcher.dispatch("observe_page", { targetId: "tab-1" }), { observed: "tab-1" });
  assert.deepEqual(await dispatcher.dispatch("run_goal", { goal: "open archive" }), { goal: "open archive" });
  await assert.rejects(dispatcher.dispatch("unknown", {}), /Unknown tool/);
});

test("MCP dispatcher rejects duplicate, missing, and unadvertised handlers", () => {
  assert.throws(() => createMcpToolDispatcher({
    tools: [{ name: "observe_page" }],
    handlerGroups: [{ observe_page() {} }, { observe_page() {} }]
  }), /Duplicate MCP handler/);

  assert.throws(() => createMcpToolDispatcher({
    tools: [{ name: "observe_page" }],
    handlerGroups: [{}]
  }), /has no handler/);

  assert.throws(() => createMcpToolDispatcher({
    tools: [{ name: "observe_page" }],
    handlerGroups: [{ observe_page() {}, hidden_tool() {} }]
  }), /not advertised/);

  assert.throws(() => createMcpToolDispatcher({
    tools: [{ name: "observe_page" }, { name: "observe_page" }],
    handlerGroups: [{ observe_page() {} }]
  }), /Duplicate MCP catalog/);
});
