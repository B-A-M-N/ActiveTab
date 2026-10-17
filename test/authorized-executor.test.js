/** P0-1: centralized action authorization boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedAction } from "../src/runtime/authorizedExecutor.js";

function mockSession({ observation = null } = {}) {
  return {
    dispatched: [],
    async observe() { return observation; },
    async click(candidate) { this.dispatched.push(["click", candidate.backendNodeId]); return { dispatched: true }; },
    async fillField(candidate, value) { this.dispatched.push(["fill", candidate.backendNodeId, value]); return { dispatched: true }; },
    async selectOption(candidate, value) { this.dispatched.push(["select", candidate.backendNodeId, value]); return { dispatched: true }; },
    async uploadFile(candidate, paths) { this.dispatched.push(["upload", candidate.backendNodeId]); return { dispatched: true }; },
    client: { async send(method, params) { this.sent = this.sent ?? []; this.sent.push([method, params]); return {}; } }
  };
}

test("sensitive actions are refused before dispatch through the authorized executor", async () => {
  const candidate = { name: "Delete account", role: "button", tag: "button", visible: true, backendNodeId: 1, targetId: "tab-1", documentGeneration: 1 };
  const observation = { page: { url: "https://app.example.test/", title: "Settings" }, candidates: [candidate], evidenceId: "e-1" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session, goal: "Open the settings page", action: "click", candidate
  });
  assert.equal(result.dispatched, false, "Policy must block sensitive actions before dispatch.");
  assert.equal(result.authorized, false);
  assert.equal(session.dispatched.length, 0, "No effectful CDP dispatch may occur.");
  assert.equal(session.client.sent, undefined, "No CDP command may be sent.");
});

test("authorized navigation dispatches through the session", async () => {
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [], evidenceId: "e-2" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session, action: "navigate", url: "https://app.example.test/dashboard"
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(session.client.sent?.[0]?.[0], "Page.navigate");
});

test("loopback navigation is refused when no environment is bound", async () => {
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [], evidenceId: "e-3" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session, action: "navigate", url: "http://127.0.0.1:8080/admin"
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.authorized, false);
  assert.equal(session.client.sent, undefined);
});
