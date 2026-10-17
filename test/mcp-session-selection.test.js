import test from "node:test";
import assert from "node:assert/strict";
import { selectBrowserSession } from "../src/mcp/session-selection.js";

test("MCP selects the requested target when several browser sessions are attached", () => {
  const first = { target: { id: "first" } };
  const second = { target: { id: "second" } };
  const sessions = new Map([["first", first], ["second", second]]);
  assert.equal(selectBrowserSession(sessions, "second"), second);
  assert.throws(() => selectBrowserSession(sessions), /targetId is required when multiple tabs are attached/);
  assert.throws(() => selectBrowserSession(sessions, "unknown"), /No explicitly authorized tab/);
});

test("MCP keeps single-session calls compatible when targetId is omitted", () => {
  const session = { target: { id: "only" } };
  assert.equal(selectBrowserSession(new Map([["only", session]])), session);
  assert.throws(() => selectBrowserSession(new Map()), /No explicitly authorized tab/);
});
