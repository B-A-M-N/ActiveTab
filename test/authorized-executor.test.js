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

test("pre-dispatch review refusal is enforced before the browser effect", async () => {
  const candidate = { name: "Open account", role: "tab", tag: "button", visible: true, backendNodeId: 2, targetId: "tab-1", documentGeneration: 1 };
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-review" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session,
    goal: "Open account",
    action: "click",
    candidate,
    onAdmission: async () => ({ allowed: false, category: "independent_review_required", reason: "Jev requested agent review." })
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "independent_review_required");
  assert.equal(session.dispatched.length, 0);
  assert.equal(session.client.sent, undefined);
});

test("authorized navigation dispatches through the session", async () => {
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [], evidenceId: "e-2" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session,
    environment: { authorizedOrigins: ["https://app.example.test"] },
    action: "navigate",
    url: "https://app.example.test/dashboard"
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(session.client.sent?.[0]?.[0], "Page.navigate");
});

test("loopback navigation is refused when no environment is bound", async () => {
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [], evidenceId: "e-3" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({
    session, action: "navigate", url: "https://app.example.test/next"
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.authorized, false);
  assert.equal(result.category, "environment_unbound");
  assert.equal(session.client.sent, undefined);
});

test("same-origin link clicks also require an explicit environment binding", async () => {
  const candidate = { identity: "link-1", targetId: "tab-1", documentGeneration: 1, backendNodeId: 8, name: "Next", role: "link", tag: "a", href: "https://app.example.test/next", visible: true, disabled: false };
  const observation = { targetId: "tab-1", page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-link" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({ session, action: "click", candidate });
  assert.equal(result.dispatched, false);
  assert.equal(result.authorized, false);
  assert.equal(result.category, "environment_unbound");
  assert.equal(session.dispatched.length, 0);
  assert.equal(session.client.sent, undefined);
});

test("an attached target permits same-origin links but cannot follow them across origins without a profile", async () => {
  const candidate = { identity: "link-2", targetId: "tab-1", documentGeneration: 1, backendNodeId: 9, name: "Next", role: "link", tag: "a", href: "/next", visible: true, disabled: false };
  const observation = { targetId: "tab-1", page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-target-bound-link" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;

  const allowed = await executeAuthorizedAction({ session, action: "click", candidate });
  assert.equal(allowed.dispatched, true);
  assert.deepEqual(session.dispatched, [["click", 9]]);

  session.dispatched.length = 0;
  const external = { ...candidate, href: "https://other.example.test/next" };
  session.observe = async () => ({ ...observation, candidates: [external], evidenceId: "e-cross-origin-link" });
  const refused = await executeAuthorizedAction({ session, action: "click", candidate: external });
  assert.equal(refused.dispatched, false);
  assert.equal(refused.category, "navigation_target_untrusted");
  assert.deepEqual(session.dispatched, []);
});

test("the explicit local-fixture capability permits loopback navigation", async () => {
  const observation = { page: { url: "http://127.0.0.1:8080/", title: "Fixture" }, candidates: [], evidenceId: "e-fixture" };
  const session = mockSession({ observation });
  const result = await executeAuthorizedAction({ session, action: "navigate", url: "http://127.0.0.1:8080/next", localFixture: true });
  assert.equal(result.dispatched, true);
  assert.equal(session.client.sent?.[0]?.[0], "Page.navigate");
});

test("a trusted typed contract is checked even when generic policy allows the control", async () => {
  const candidate = { identity: "tab-settings", targetId: "tab-1", documentGeneration: 1, backendNodeId: 15, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-typed" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  let authorizations = 0;
  const result = await executeAuthorizedAction({
    session,
    action: "click",
    candidate,
    operationId: "registered-settings-step",
    operationAuthorizer: { async authorize() { authorizations++; return { allowed: false, reason: "The registered workflow does not include this control." }; } }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "operation_contract_refused");
  assert.equal(authorizations, 1);
  assert.deepEqual(session.dispatched, []);
});

test("a typed operation contract cannot override a hard policy denial", async () => {
  const candidate = { identity: "hidden", targetId: "tab-1", documentGeneration: 1, backendNodeId: 16, name: "Settings", role: "tab", tag: "button", visible: false, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-hard-deny" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  let authorizations = 0;
  const result = await executeAuthorizedAction({
    session,
    action: "click",
    candidate,
    operationId: "registered-settings-step",
    operationAuthorizer: { async authorize() { authorizations++; return { allowed: true }; } }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "control_unavailable");
  assert.equal(authorizations, 0);
  assert.deepEqual(session.dispatched, []);
});

test("the page and exact candidate are revalidated after pre-dispatch review", async () => {
  const candidate = { identity: "open-settings", targetId: "tab-1", documentGeneration: 1, backendNodeId: 17, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  let observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-before-review" };
  const session = mockSession({ observation });
  session.observe = async () => observation;
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  const result = await executeAuthorizedAction({
    session,
    action: "click",
    candidate,
    onAdmission: async () => {
      observation = { ...observation, documentGeneration: 2, candidates: [{ ...candidate, documentGeneration: 2, backendNodeId: 18 }], evidenceId: "e-after-review" };
      return { allowed: true };
    }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "pre_dispatch_state_changed");
  assert.deepEqual(session.dispatched, []);
});

test("a CDP error after dispatch begins returns an uncertain outcome", async () => {
  const candidate = { name: "Open account", role: "tab", tag: "button", visible: true, backendNodeId: 19 };
  const observation = { page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-dispatch-error" };
  const session = mockSession({ observation });
  session.click = async () => { throw new Error("connection closed while awaiting acknowledgement"); };
  const result = await executeAuthorizedAction({ session, action: "click", candidate });
  assert.equal(result.status, "uncertain");
  assert.equal(result.authorized, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.effectStatus, "uncertain");
});
