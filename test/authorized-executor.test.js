/** P0-1: centralized action authorization boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedAction } from "../src/runtime/authorizedExecutor.js";
import { createSearchSubmitAuthorizer, SEARCH_SUBMIT_OPERATION_ID } from "../src/navigation/search.js";

const fixtureLease = async () => {};

function mockSession({ observation = null } = {}) {
  return {
    dispatched: [],
    async observe() { return observation; },
    async click(candidate) { this.dispatched.push(["click", candidate.backendNodeId]); return { dispatched: true }; },
    async typeSearchPhrase(candidate, value, observation) {
      this.dispatched.push(["type", candidate.backendNodeId, value, observation?.page?.url]);
      return { dispatched: true };
    },
    async navigateObservedLinkInSameTarget(candidate, { beforeDispatch } = {}) {
      const href = this.actualLinkHref ?? candidate.href;
      await beforeDispatch?.({ candidate, href, sameTargetNavigation: true });
      this.dispatched.push(["same_target_navigation", candidate.backendNodeId, href]);
      return { dispatched: true, navigationMode: "same_target" };
    },
    async fillField(candidate, value) { this.dispatched.push(["fill", candidate.backendNodeId, value]); return { dispatched: true }; },
    async selectOption(candidate, value) { this.dispatched.push(["select", candidate.backendNodeId, value]); return { dispatched: true }; },
    async uploadFile(candidate, paths) { this.dispatched.push(["upload", candidate.backendNodeId]); return { dispatched: true }; },
    client: { async send(method, params) { this.sent = this.sent ?? []; this.sent.push([method, params]); return {}; } }
  };
}

test("same-origin GET query fields require the exact caller search contract for typing and submit", async () => {
  const field = {
    identity: "query-field", targetId: "tab-1", formIdentity: "query-form", documentGeneration: 1,
    backendNodeId: 11, tag: "input", type: "text", queryField: true,
    formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true, name: "Search", visible: true, disabled: false
  };
  const submit = {
    identity: "query-submit", targetId: "tab-1", formIdentity: "query-form", documentGeneration: 1,
    backendNodeId: 12, tag: "button", type: "submit", name: "Search", submitsForm: true,
    formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true, visible: true, disabled: false
  };
  const observation = {
    evidenceId: "query-evidence", targetId: "tab-1", documentGeneration: 1,
    page: { url: "https://search.example.test/", title: "Search" }, candidates: [field, submit]
  };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  const authorizer = createSearchSubmitAuthorizer("rare bookshops");
  const typed = await executeAuthorizedAction({
    session, goal: "Search for rare bookshops", action: "type", candidate: field,
    value: "rare bookshops", operationId: SEARCH_SUBMIT_OPERATION_ID,
    operationAuthorizer: authorizer, assertExecutionLease: fixtureLease
  });
  assert.equal(typed.dispatched, true, JSON.stringify(typed));
  assert.deepEqual(session.dispatched[0], ["type", field.backendNodeId, "rare bookshops", observation.page.url]);

  const submitted = await executeAuthorizedAction({
    session, goal: "Search for rare bookshops", action: "click", candidate: submit,
    operationId: SEARCH_SUBMIT_OPERATION_ID, operationAuthorizer: authorizer,
    assertExecutionLease: fixtureLease
  });
  assert.equal(submitted.dispatched, true, JSON.stringify(submitted));
  assert.deepEqual(session.dispatched[1], ["click", submit.backendNodeId]);

  const fillSession = mockSession({ observation });
  fillSession.target = { id: "tab-1", url: observation.page.url };
  fillSession.attached = true;
  const fillAuthorizer = createSearchSubmitAuthorizer("rare bookshops");
  const filled = await executeAuthorizedAction({
    session: fillSession, goal: "Search for rare bookshops and return prices", action: "fill", candidate: field,
    value: "rare bookshops", operationId: SEARCH_SUBMIT_OPERATION_ID,
    operationAuthorizer: fillAuthorizer, assertExecutionLease: fixtureLease
  });
  assert.equal(filled.dispatched, true, JSON.stringify(filled));
  const filledAndSubmitted = await executeAuthorizedAction({
    session: fillSession, goal: "Search for rare bookshops and return prices", action: "click", candidate: submit,
    operationId: SEARCH_SUBMIT_OPERATION_ID, operationAuthorizer: fillAuthorizer,
    assertExecutionLease: fixtureLease
  });
  assert.equal(filledAndSubmitted.dispatched, true, JSON.stringify(filledAndSubmitted));
  assert.deepEqual(fillSession.dispatched.map(([action]) => action), ["fill", "click"]);

  const foreignField = { ...field, identity: "foreign-query", formIdentity: "foreign-form", formActionOrigin: "https://other.example.test" };
  const foreignObservation = { ...observation, evidenceId: "foreign-query-evidence", candidates: [foreignField] };
  const foreignSession = mockSession({ observation: foreignObservation });
  foreignSession.target = { id: "tab-1", url: observation.page.url };
  foreignSession.attached = true;
  const refused = await executeAuthorizedAction({
    session: foreignSession, goal: "Search for rare bookshops", action: "type", candidate: foreignField,
    value: "rare bookshops", operationId: SEARCH_SUBMIT_OPERATION_ID,
    operationAuthorizer: createSearchSubmitAuthorizer("rare bookshops"), assertExecutionLease: fixtureLease
  });
  assert.equal(refused.dispatched, false);
  assert.equal(refused.category, "operation_contract_refused");
  assert.deepEqual(foreignSession.dispatched, []);

  for (const [suffix, overrides] of [
    ["post-override", { formMethod: "post" }],
    ["new-target", { formTargetSameContext: false }],
    ["cross-origin-action", { formActionOrigin: "https://other.example.test" }]
  ]) {
    const unsafeSubmit = { ...submit, identity: `unsafe-${suffix}`, ...overrides };
    const unsafeObservation = { ...observation, evidenceId: `unsafe-${suffix}`, candidates: [field, unsafeSubmit] };
    const unsafeSession = mockSession({ observation: unsafeObservation });
    unsafeSession.target = { id: "tab-1", url: observation.page.url };
    unsafeSession.attached = true;
    const unsafeAuthorizer = createSearchSubmitAuthorizer("rare bookshops");
    const unsafeType = await executeAuthorizedAction({
      session: unsafeSession, goal: "Search for rare bookshops", action: "type", candidate: field,
      value: "rare bookshops", operationId: SEARCH_SUBMIT_OPERATION_ID,
      operationAuthorizer: unsafeAuthorizer, assertExecutionLease: fixtureLease
    });
    assert.equal(unsafeType.dispatched, true, suffix);
    const unsafeClick = await executeAuthorizedAction({
      session: unsafeSession, goal: "Search for rare bookshops", action: "click", candidate: unsafeSubmit,
      operationId: SEARCH_SUBMIT_OPERATION_ID, operationAuthorizer: unsafeAuthorizer,
      assertExecutionLease: fixtureLease
    });
    assert.equal(unsafeClick.dispatched, false, suffix);
    assert.deepEqual(unsafeSession.dispatched.map(([action]) => action), ["type"], suffix);
  }
});

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

  const allowed = await executeAuthorizedAction({ session, action: "click", candidate, assertExecutionLease: fixtureLease });
  assert.equal(allowed.dispatched, true);
  assert.deepEqual(session.dispatched, [["click", 9]]);

  session.dispatched.length = 0;
  const external = { ...candidate, href: "https://other.example.test/next" };
  session.observe = async () => ({ ...observation, candidates: [external], evidenceId: "e-cross-origin-link" });
  const refused = await executeAuthorizedAction({ session, action: "click", candidate: external, assertExecutionLease: fixtureLease });
  assert.equal(refused.dispatched, false);
  assert.equal(refused.category, "navigation_target_untrusted");
  assert.deepEqual(session.dispatched, []);
});

test("links that open another target are refused unless same-target navigation is explicit", async () => {
  const candidate = { identity: "new-tab-link", targetId: "tab-1", documentGeneration: 1, backendNodeId: 18, name: "Article", role: "link", tag: "a", href: "https://app.example.test/article", opensNewTarget: true, visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Search" }, candidates: [candidate], evidenceId: "e-new-target-link" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;

  const refused = await executeAuthorizedAction({ session, action: "click", candidate, assertExecutionLease: fixtureLease });
  assert.equal(refused.dispatched, false);
  assert.equal(refused.category, "new_target_requires_authorization");
  assert.deepEqual(session.dispatched, []);

  let authorizations = 0;
  let leaseChecks = 0;
  session.actualLinkHref = "https://app.example.test/article?revision=observed";
  const followed = await executeAuthorizedAction({
    session,
    environment: { authorizedOrigins: ["https://app.example.test"] },
    action: "click",
    candidate,
    sameTargetNavigation: true,
    operationId: "public_search_readonly_browse",
    operationAuthorizer: {
      async authorize({ action, url }) {
        authorizations++;
        assert.equal(action, "click");
        assert.equal(url, session.actualLinkHref, "the trusted operation contract receives the exact revalidated destination");
        return { allowed: true };
      }
    },
    assertExecutionLease: async () => { leaseChecks++; }
  });
  assert.equal(followed.dispatched, true);
  assert.equal(followed.dispatchResult.navigationMode, "same_target");
  assert.equal(authorizations, 1);
  assert.ok(leaseChecks >= 3, "the lease is rechecked immediately before direct navigation");
  assert.deepEqual(session.dispatched, [["same_target_navigation", 18, session.actualLinkHref]]);
});

test("explicit same-target navigation contains script-opened anchors without a target attribute", async () => {
  const candidate = { identity: "script-open-link", targetId: "tab-1", documentGeneration: 1, backendNodeId: 19, name: "Article", role: "link", tag: "a", href: "https://app.example.test/article", opensNewTarget: false, visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Search" }, candidates: [candidate], evidenceId: "e-script-open-link" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  const result = await executeAuthorizedAction({
    session,
    environment: { authorizedOrigins: ["https://app.example.test"] },
    action: "click",
    candidate,
    sameTargetNavigation: true,
    assertExecutionLease: fixtureLease
  });
  assert.equal(result.dispatched, true, result.reason);
  assert.equal(result.dispatchResult.navigationMode, "same_target");
  assert.deepEqual(session.dispatched, [["same_target_navigation", 19, candidate.href]]);
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
    assertExecutionLease: fixtureLease,
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
    assertExecutionLease: fixtureLease,
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
    assertExecutionLease: fixtureLease,
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

test("attached targets refuse dispatch when no durable target lease is supplied", async () => {
  const candidate = { identity: "settings-tab", targetId: "tab-1", documentGeneration: 1, backendNodeId: 22, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-no-lease" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  const result = await executeAuthorizedAction({ session, action: "click", candidate });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "target_lease_unavailable");
  assert.deepEqual(session.dispatched, []);
});

test("a lost target lease refuses before any durable reservation or browser effect", async () => {
  const candidate = { identity: "settings-tab", targetId: "tab-1", documentGeneration: 1, backendNodeId: 20, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-lost-lease" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  let reservations = 0;
  const result = await executeAuthorizedAction({
    session,
    action: "click",
    candidate,
    assertExecutionLease: async () => { throw new Error("lease expired"); },
    onReserve: async () => { reservations++; return { allowed: true }; }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "target_lease_lost");
  assert.equal(reservations, 0);
  assert.deepEqual(session.dispatched, []);
});

test("lease loss after reservation closes the reservation as refused without dispatch", async () => {
  const candidate = { identity: "settings-tab", targetId: "tab-1", documentGeneration: 1, backendNodeId: 21, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  const observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/", title: "Home" }, candidates: [candidate], evidenceId: "e-lease-after-reserve" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  let checks = 0;
  let reserved = false;
  let dispatchStatus = null;
  const result = await executeAuthorizedAction({
    session,
    action: "click",
    candidate,
    assertExecutionLease: async () => {
      checks++;
      if (checks > 1) throw new Error("lease expired");
    },
    onReserve: async () => { reserved = true; return { allowed: true }; },
    onDispatch: async ({ dispatchStatus: status }) => { dispatchStatus = status; }
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.category, "target_lease_lost");
  assert.equal(reserved, true);
  assert.equal(dispatchStatus, "refused");
  assert.deepEqual(session.dispatched, []);
});

function compositeSelectFixture() {
  const combobox = { identity: "model-combobox", targetId: "tab-1", documentGeneration: 1, backendNodeId: 30, name: "Model", role: "combobox", tag: "button", visible: true, disabled: false };
  const option = { identity: "model-option", targetId: "tab-1", documentGeneration: 1, backendNodeId: 31, name: "GLM5.3-flash", role: "option", tag: "div", visible: true, disabled: false };
  let observation = { targetId: "tab-1", documentGeneration: 1, page: { url: "https://app.example.test/models", title: "Models" }, candidates: [combobox, option], evidenceId: "e-composite-select" };
  const session = mockSession({ observation });
  session.target = { id: "tab-1", url: observation.page.url };
  session.attached = true;
  session.observe = async () => observation;
  session.setObservation = next => { observation = next; };
  session.dispatched = [];
  return { combobox, option, session, getObservation: () => observation };
}

function allowFixtureSelect(candidateIdentity, exactValue) {
  const dispatchStatuses = [];
  return {
    dispatchStatuses,
    async authorize({ action, candidate, value, observation }) {
      const allowed = action === "select" && candidate?.identity === candidateIdentity && value === exactValue
        && observation?.page?.url === "https://app.example.test/models";
      return { allowed, category: "fixture_select", reason: "The scoped fixture contract permits only the exact model selection." };
    },
    async recordDispatch({ dispatchStatus } = {}) { dispatchStatuses.push(dispatchStatus); }
  };
}

test("a composite select refuses an unexpected second control after opening the combobox", async () => {
  const { combobox, option, session, getObservation } = compositeSelectFixture();
  const unexpected = { identity: "unexpected-control", targetId: "tab-1", documentGeneration: 1, backendNodeId: 32, name: "GLM5.3-flash", role: "button", tag: "button", visible: true, disabled: false };
  session.setObservation({ ...getObservation(), candidates: [combobox, option, unexpected] });
  const operationAuthorizer = allowFixtureSelect(combobox.identity, "GLM5.3-flash");
  session.selectOption = async (candidate, value, { actionEnvelope, authorizeSuboperation } = {}) => {
    assert.deepEqual(actionEnvelope.allowedSuboperations, ["open_observed_combobox", "select_exact_controlled_option"]);
    let decision = await authorizeSuboperation({ stage: "prepare", suboperation: "open_observed_combobox", candidate, menuCandidate: candidate });
    assert.equal(decision.allowed, true);
    decision = await authorizeSuboperation({ stage: "dispatch", suboperation: "open_observed_combobox", candidate: decision.candidate, menuCandidate: decision.menuCandidate });
    assert.equal(decision.allowed, true);
    session.dispatched.push(["open", candidate.identity]);
    await authorizeSuboperation({ stage: "completed", suboperation: "open_observed_combobox", candidate: candidate, menuCandidate: candidate });

    decision = await authorizeSuboperation({ stage: "prepare", suboperation: "select_exact_controlled_option", candidate: unexpected, menuCandidate: candidate });
    if (!decision.allowed) return { dispatched: true, selected: false, selectionStatus: "refused_after_open", reason: decision.reason };
    session.dispatched.push(["unexpected-click", unexpected.identity]);
    return { dispatched: true, selected: true, selectionStatus: "selected" };
  };

  const result = await executeAuthorizedAction({
    session,
    action: "select",
    candidate: combobox,
    value: "GLM5.3-flash",
    operationId: "select-model",
    operationAuthorizer,
    assertExecutionLease: fixtureLease
  });
  assert.equal(result.status, "partial");
  assert.equal(result.dispatchResult.selectionStatus, "refused_after_open");
  assert.deepEqual(session.dispatched, [["open", combobox.identity]], "the second control is refused before its click dispatch");
  assert.deepEqual(operationAuthorizer.dispatchStatuses, ["uncertain"], "a partial composite effect cannot advance the typed operation sequence as complete");
  assert.ok(option, "the fixture includes the expected option, distinct from the injected control");
});

test("a composite select rechecks page binding before the option dispatch", async () => {
  const { combobox, option, session, getObservation } = compositeSelectFixture();
  const operationAuthorizer = allowFixtureSelect(combobox.identity, "GLM5.3-flash");
  session.selectOption = async (candidate, value, { authorizeSuboperation } = {}) => {
    let decision = await authorizeSuboperation({ stage: "prepare", suboperation: "open_observed_combobox", candidate, menuCandidate: candidate });
    assert.equal(decision.allowed, true);
    decision = await authorizeSuboperation({ stage: "dispatch", suboperation: "open_observed_combobox", candidate: decision.candidate, menuCandidate: decision.menuCandidate });
    assert.equal(decision.allowed, true);
    session.dispatched.push(["open", candidate.identity]);
    await authorizeSuboperation({ stage: "completed", suboperation: "open_observed_combobox", candidate, menuCandidate: candidate });

    const current = getObservation();
    session.setObservation({ ...current, page: { ...current.page, url: "https://app.example.test/another-application" }, candidates: [combobox, option], evidenceId: "e-changed-application" });
    decision = await authorizeSuboperation({ stage: "prepare", suboperation: "select_exact_controlled_option", candidate: option, menuCandidate: candidate });
    if (!decision.allowed) return { dispatched: true, selected: false, selectionStatus: "refused_after_open", reason: decision.reason };
    session.dispatched.push(["select", option.identity]);
    return { dispatched: true, selected: true, selectionStatus: "selected" };
  };

  const result = await executeAuthorizedAction({
    session,
    action: "select",
    candidate: combobox,
    value: "GLM5.3-flash",
    operationId: "select-model",
    operationAuthorizer,
    assertExecutionLease: fixtureLease
  });
  assert.equal(result.status, "partial");
  assert.match(result.dispatchResult.reason, /page or target changed/);
  assert.deepEqual(session.dispatched, [["open", combobox.identity]], "a changed application page cannot receive the option click");
  assert.deepEqual(operationAuthorizer.dispatchStatuses, ["uncertain"]);
});

test("a composite select rechecks its durable target lease before the option dispatch", async () => {
  const { combobox, option, session } = compositeSelectFixture();
  const operationAuthorizer = allowFixtureSelect(combobox.identity, "GLM5.3-flash");
  session.selectOption = async (candidate, value, { authorizeSuboperation } = {}) => {
    let decision = await authorizeSuboperation({ stage: "prepare", suboperation: "open_observed_combobox", candidate, menuCandidate: candidate });
    assert.equal(decision.allowed, true);
    decision = await authorizeSuboperation({ stage: "dispatch", suboperation: "open_observed_combobox", candidate: decision.candidate, menuCandidate: decision.menuCandidate });
    assert.equal(decision.allowed, true);
    session.dispatched.push(["open", candidate.identity]);
    await authorizeSuboperation({ stage: "completed", suboperation: "open_observed_combobox", candidate, menuCandidate: candidate });

    decision = await authorizeSuboperation({ stage: "prepare", suboperation: "select_exact_controlled_option", candidate: option, menuCandidate: candidate });
    if (!decision.allowed) return { dispatched: true, selected: false, selectionStatus: "refused_after_open", reason: decision.reason };
    session.dispatched.push(["select", option.identity]);
    return { dispatched: true, selected: true, selectionStatus: "selected" };
  };
  let leaseChecks = 0;
  const result = await executeAuthorizedAction({
    session,
    action: "select",
    candidate: combobox,
    value: "GLM5.3-flash",
    operationId: "select-model",
    operationAuthorizer,
    assertExecutionLease: async () => {
      leaseChecks++;
      if (leaseChecks >= 5) throw new Error("lease expired between composite suboperations");
    }
  });
  assert.equal(leaseChecks, 5, "the executor checks the lease again before preparing the second suboperation");
  assert.equal(result.status, "partial");
  assert.match(result.dispatchResult.reason, /execution lease was lost/);
  assert.deepEqual(session.dispatched, [["open", combobox.identity]], "lease loss prevents the option click");
  assert.deepEqual(operationAuthorizer.dispatchStatuses, ["uncertain"]);
});
