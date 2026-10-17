import test from "node:test";
import assert from "node:assert/strict";
import { NavigationEngine } from "../src/navigation/engine.js";

class FailingRouteSession {
  target = { id: "test-target", endpoint: "local-cdp" };
  state = {
    page: { url: "https://shop.example.test/", title: "Shop" },
    headings: [{ level: 1, text: "Shop" }],
    candidates: [{ identity: "fresh-button", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "button", tag: "button", visible: true }]
  };
  count = 0;

  async observe() { return { evidenceId: `evidence-${this.count}`, ...structuredClone(this.state) }; }
  async click() {
    this.count += 1;
    this.state = {
      page: { url: "https://shop.example.test/error", title: "Error" },
      headings: [{ level: 1, text: "Error" }],
      candidates: []
    };
  }
  async waitForChange() {}
}

test("an unrelated URL change is not treated as task success", async () => {
  const session = new FailingRouteSession();
  const result = await new NavigationEngine(session, { maxRecoveries: 1 }).run("Open the account page");
  assert.equal(result.status, "needs_human");
  assert.equal(result.attempts, 1);
  assert.equal(result.page, undefined);
});

test("a matching label on the unchanged starting page does not verify navigation", async () => {
  const session = {
    target: { id: "unchanged-target", endpoint: "local-cdp" },
    async observe() {
      return {
        evidenceId: "same-page",
        page: { url: "https://shop.example.test/", title: "Open account" },
        headings: [{ level: 1, text: "Open account" }],
        candidates: [{ identity: "same-button", name: "Open account", role: "button", tag: "button", visible: true }]
      };
    },
    async click() {},
    async waitForChange() {}
  };
  const result = await new NavigationEngine(session, { maxActions: 2 }).run("Open the account page");
  assert.notEqual(result.status, "succeeded");
  assert.equal(result.attempts, 1);
});

test("an unchanged matching label cannot combine with an unrelated frame change to verify the goal", async () => {
  const session = {
    target: { id: "frame-label-baseline-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Portal" },
      headings: [{ level: 1, text: "Account" }, { level: 2, text: "Settings" }],
      candidates: [{ identity: "open-account", name: "Open account", role: "button", tag: "button", visible: true }]
    },
    async observe() { return { evidenceId: this.current.headings[1].text, ...structuredClone(this.current) }; },
    async click() {
      this.current = {
        ...this.current,
        headings: [{ level: 1, text: "Account" }, { level: 2, text: "Profile" }]
      };
    },
    async waitForChange() {}
  };

  const result = await new NavigationEngine(session, { maxActions: 1, maxRecoveries: 0 }).run("Open the account page");

  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 1);
});

test("substring matches in an unrelated error route do not verify the requested page", async () => {
  const session = {
    target: { id: "unaccounted-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [{ identity: "open-account", backendNodeId: 1, name: "Open account", role: "button", tag: "button", visible: true }]
    },
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async click() {
      this.current = {
        page: { url: "https://shop.example.test/unaccounted", title: "Unaccounted error" },
        headings: [{ level: 1, text: "Unaccounted error" }],
        candidates: []
      };
    },
    async waitForChange() {}
  };

  const result = await new NavigationEngine(session, { maxActions: 1, maxRecoveries: 0 }).run("Open the account page");

  assert.equal(result.status, "unresolved");
  assert.equal(result.attempts, 1);
});

test("a changed SPA heading can verify the requested page without a URL change", async () => {
  const session = {
    target: { id: "spa-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Welcome" }],
      candidates: [{ identity: "account-tab", name: "Open account", role: "button", tag: "button", visible: true }]
    },
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async click() {
      this.current = {
        page: { url: "https://shop.example.test/", title: "Account" },
        headings: [{ level: 1, text: "Account" }],
        candidates: []
      };
    },
    async waitForChange() {}
  };
  const result = await new NavigationEngine(session, { maxActions: 1 }).run("Open the account page");
  assert.equal(result.status, "succeeded");
  assert.equal(result.page.title, "Account");
});

test("anti-automation and login states stop before any browser action", async () => {
  for (const [observation, category] of [
    [{ page: { url: "https://shop.example.test/challenge", title: "Security check" }, headings: [{ level: 1, text: "Verify you are human" }], candidates: [{ identity: "continue", name: "Continue", role: "button", tag: "button", visible: true }] }, "anti_automation"],
    [{ page: { url: "https://shop.example.test/login", title: "Account" }, headings: [{ level: 1, text: "Sign in to continue" }], candidates: [{ identity: "password", name: "Password", role: "textbox", tag: "input", type: "password", visible: true }] }, "authentication"]
  ]) {
    const session = {
      target: { id: `handoff-${category}`, endpoint: "local-cdp" },
      clicks: 0,
      async observe() { return { evidenceId: "handoff-evidence", ...structuredClone(observation) }; },
      async click() { this.clicks++; },
      async waitForChange() {}
    };
    const planner = { async plan() { throw new Error("Handoff pages must stop before planning an action."); } };
    const result = await new NavigationEngine(session, { planner }).run("Open the account page");
    assert.equal(result.status, "needs_human");
    assert.equal(result.interventionRequired.category, category);
    assert.equal(result.interventionRequired.evidenceId, "handoff-evidence");
    assert.equal(session.clicks, 0);
  }
});

test("an unrelated password field does not block navigation without login context", async () => {
  const session = {
    target: { id: "password-field-page", endpoint: "local-cdp" },
    current: {
      page: { url: "http://127.0.0.1/shop", title: "Demo shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [
        { identity: "fixture-password", name: "Test password", role: "textbox", tag: "input", type: "password", visible: true },
        { identity: "frame-action", name: "Open frame controls", role: "button", tag: "button", visible: true }
      ]
    },
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async click() {
      this.current = {
        page: { url: "http://127.0.0.1/shop", title: "Frame controls" },
        headings: [{ level: 1, text: "Frame controls" }],
        candidates: []
      };
    },
    async waitForChange() {}
  };
  const result = await new NavigationEngine(session, { maxActions: 1 }).run("Open frame controls");
  assert.equal(result.status, "succeeded");
  assert.equal(result.page.title, "Frame controls");
});

test("explicit task resume records when a human handoff condition has cleared", async () => {
  const journal = {
    value: undefined,
    async write(value) { this.value = structuredClone(value); }
  };
  const session = {
    target: { id: "handoff-resume-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/challenge", title: "Security check" },
      headings: [{ level: 1, text: "Verify you are human" }],
      candidates: []
    },
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async click() { throw new Error("The already-complete resumed goal must not click."); },
    async waitForChange() {}
  };

  const goal = "Open the account page";
  const initial = await new NavigationEngine(session, { journal }).run(goal);
  assert.equal(initial.status, "needs_human");
  const handoffState = structuredClone(journal.value);
  assert.equal(handoffState.interventionRequired.category, "anti_automation");

  // Model an operator completing the challenge in the authorized tab before the explicit resume.
  session.current = {
    page: { url: "https://shop.example.test/account", title: "Account" },
    headings: [{ level: 1, text: "Account" }],
    candidates: []
  };
  const planner = { async plan() { throw new Error("The resumed page already proves the goal."); } };
  const resumed = await new NavigationEngine(session, { journal, planner }).run(goal, { resumeState: handoffState });

  assert.equal(resumed.status, "succeeded");
  const continuation = journal.value.interventionContinuation;
  assert.equal(continuation.category, "anti_automation");
  assert.equal(continuation.handoffEvidenceId, "Security check");
  assert.equal(continuation.observedEvidenceId, "Account");
  assert.ok(Number.isFinite(Date.parse(continuation.resumedAt)));
  assert.equal(journal.value.interventionRequired, undefined);
});

test("a failed action identity is not retried from unchanged evidence", async () => {
  const session = {
    target: { id: "stable-target", endpoint: "local-cdp" },
    clicks: 0,
    async observe() {
      return {
        evidenceId: "same-evidence",
        page: { url: "https://shop.example.test/", title: "Shop" },
        headings: [{ level: 1, text: "Shop" }],
        candidates: [{ identity: "same-button", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "button", tag: "button", visible: true }]
      };
    },
    async click() {
      this.clicks += 1;
      throw new Error("The target rejected the action.");
    },
    async waitForChange() {}
  };

  const result = await new NavigationEngine(session, { maxActions: 3, maxRecoveries: 2 }).run("Open the account page");
  assert.equal(result.status, "needs_human");
  assert.equal(result.attempts, 1);
  assert.equal(session.clicks, 1);
});

test("a failed action that partially changes the route is journaled and replanned from fresh evidence", async () => {
  const firstTarget = { identity: "first-account-link", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "link", tag: "a", visible: true };
  const continuationTarget = { identity: "continue-account-link", backendNodeId: 2, documentGeneration: 2, name: "Continue to account", role: "link", tag: "a", visible: true };
  const session = {
    target: { id: "partial-transition-target", endpoint: "local-cdp" },
    clicks: [],
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [firstTarget]
    },
    async observe() { return { evidenceId: `${this.current.page.title}-evidence`, ...structuredClone(this.current) }; },
    async click(target) {
      this.clicks.push(target.identity);
      if (target.identity === firstTarget.identity) {
        this.current = {
          page: { url: "https://shop.example.test/contact-options", title: "Contact options" },
          headings: [{ level: 1, text: "Choose a contact method" }],
          candidates: [continuationTarget]
        };
        throw new Error("The route changed before the original node detached.");
      }
      this.current = {
        page: { url: "https://shop.example.test/account", title: "Account" },
        headings: [{ level: 1, text: "Account" }],
        candidates: []
      };
    },
    async waitForChange() {}
  };
  const plannerCalls = [];
  const planner = {
    async plan(_goal, observation, { excludedIdentities }) {
      plannerCalls.push({ evidenceId: observation.evidenceId, excludedIdentities });
      if (observation.page.url.endsWith("/")) return { status: "planned", action: { type: "click", target: firstTarget } };
      if (observation.page.url.endsWith("/contact-options")) return { status: "planned", action: { type: "click", target: continuationTarget } };
      return { status: "unresolved", reason: "No further action is required." };
    }
  };
  const journal = { value: undefined, async write(value) { this.value = structuredClone(value); } };
  const recordedWorkflows = [];
  const workflowStore = {
    async find() { return undefined; },
    async record(...args) { recordedWorkflows.push(args); return true; }
  };

  const result = await new NavigationEngine(session, { planner, journal, workflowStore, maxActions: 3, maxRecoveries: 1 }).run("Open the account page");

  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts, 2);
  assert.equal(result.recoveries, 1);
  assert.deepEqual(session.clicks, [firstTarget.identity, continuationTarget.identity]);
  assert.equal(plannerCalls[1].evidenceId, "Contact options-evidence");
  assert.ok(plannerCalls[1].excludedIdentities.includes(firstTarget.identity));
  assert.equal(journal.value.attempts[0].error.message, "The route changed before the original node detached.");
  assert.notEqual(journal.value.attempts[0].beforeRouteFingerprint, journal.value.attempts[0].afterRouteFingerprint);
  assert.deepEqual(recordedWorkflows, [], "a trace containing a failed action that changed page state must not be persisted");
});

test("a lost tab observation journals the action and resume excludes its matching target", async () => {
  const lostTarget = { identity: "lost-target", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "button", tag: "button", visible: true };
  const recreatedTarget = { ...lostTarget, identity: "recreated-target", backendNodeId: 101, documentGeneration: 8 };
  const fallbackTarget = { identity: "account-fallback", backendNodeId: 2, documentGeneration: 1, name: "View account", role: "link", tag: "a", visible: true, href: "https://shop.example.test/account" };
  const journal = { value: undefined, async write(value) { this.value = structuredClone(value); } };
  const interruptedSession = {
    target: { id: "reconnect-target", endpoint: "local-cdp" },
    detached: false,
    async observe() {
      if (this.detached) throw new Error("The authorized browser target is detached.");
      return { evidenceId: "before-detach", page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [lostTarget] };
    },
    async click() { this.detached = true; throw new Error("Click result was lost when the tab detached."); },
    async waitForChange() {}
  };
  const plannerViews = [];
  const planner = {
    async plan(_goal, observation) {
      plannerViews.push(observation.candidates.map(candidate => candidate.identity));
      const target = observation.candidates[0];
      return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: "No current candidate remains." };
    }
  };

  const interrupted = await new NavigationEngine(interruptedSession, { planner, journal, maxActions: 3, maxRecoveries: 1 }).run("Open the account page");

  assert.equal(interrupted.status, "unresolved");
  assert.equal(interrupted.attempts, 1);
  assert.equal(journal.value.attempts[0].observationUnavailable, true);
  assert.equal(journal.value.attempts[0].targetIdentity, lostTarget.identity);
  assert.match(journal.value.attempts[0].observationError.message, /target is detached/);
  assert.equal(journal.value.attempts[0].afterStateFingerprint, undefined);

  const reconnectedSession = {
    target: interruptedSession.target,
    clicks: [],
    async observe() {
      return { evidenceId: "after-reconnect", page: this.page, headings: this.headings, candidates: [recreatedTarget, fallbackTarget] };
    },
    async click(target) {
      this.clicks.push(target.identity);
      assert.equal(target.identity, fallbackTarget.identity, "resume must not retry a same-signature target with a new backend identity");
      this.page = { url: "https://shop.example.test/account", title: "Account" };
      this.headings = [{ level: 1, text: "Account" }];
    },
    async waitForChange() {},
    page: { url: "https://shop.example.test/", title: "Shop" },
    headings: [{ level: 1, text: "Shop" }]
  };
  const resumePlanner = {
    async plan(_goal, observation) {
      plannerViews.push(observation.candidates.map(candidate => candidate.identity));
      return { status: "planned", action: { type: "click", target: observation.candidates[0] } };
    }
  };

  const resumed = await new NavigationEngine(reconnectedSession, { planner: resumePlanner, journal, maxActions: 3, maxRecoveries: 1 }).run("Open the account page", { resumeState: structuredClone(journal.value) });

  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(reconnectedSession.clicks, [fallbackTarget.identity]);
  assert.deepEqual(plannerViews[1], [fallbackTarget.identity], "resume filters a recreated control with the same target signature");
});

test("the journal records a redacted action intent before dispatch and clears it after verification", async () => {
  const target = { identity: "account-link", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "link", tag: "a", visible: true };
  const journal = {
    value: undefined,
    writes: [],
    async write(value) { this.value = structuredClone(value); this.writes.push(structuredClone(value)); }
  };
  const session = {
    target: { id: "write-ahead-target", endpoint: "local-cdp" },
    current: { page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [target] },
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async click(selected) {
      assert.equal(journal.value.pendingAction.targetIdentity, selected.identity);
      assert.equal("value" in journal.value.pendingAction, false);
      this.current = { page: { url: "https://shop.example.test/account", title: "Account" }, headings: [{ level: 1, text: "Account" }], candidates: [] };
    },
    async waitForChange() {}
  };

  const result = await new NavigationEngine(session, { journal, maxActions: 1 }).run("Open the account page");

  assert.equal(result.status, "succeeded");
  assert.ok(journal.writes.some(write => write.pendingAction?.action === "click"));
  assert.equal(journal.value.pendingAction, undefined);
  assert.equal(journal.value.attempts.length, 1);
});

test("resume excludes the same target after failure despite an unrelated DOM state change", async () => {
  const failedTarget = { identity: "failed-account-button", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "button", tag: "button", visible: true };
  const alternativeTarget = { identity: "account-overview-link", backendNodeId: 2, documentGeneration: 1, name: "Account overview", role: "link", tag: "a", visible: true };
  const session = {
    target: { id: "resume-retry-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [failedTarget, alternativeTarget]
    },
    clicks: [],
    async observe() { return { evidenceId: "same-state-evidence", ...structuredClone(this.current) }; },
    async click(target) {
      this.clicks.push(target.identity);
      if (target.identity === failedTarget.identity) {
        this.current = {
          ...this.current,
          headings: [{ level: 1, text: "Temporarily unavailable" }]
        };
        throw new Error("The action failed after an unrelated page update.");
      }
      this.current = {
        page: { url: "https://shop.example.test/account", title: "Account" },
        headings: [{ level: 1, text: "Account" }],
        candidates: []
      };
    },
    async waitForChange() {}
  };
  const plannerViews = [];
  const planner = {
    async plan(_goal, observation) {
      plannerViews.push(observation.candidates.map(candidate => candidate.identity));
      const target = observation.candidates[0];
      return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: "No current candidate remains." };
    }
  };
  const journal = { value: undefined, async write(value) { this.value = structuredClone(value); } };

  const interrupted = await new NavigationEngine(session, { planner, journal, maxActions: 1, maxRecoveries: 1 }).run("Open the account page");
  assert.equal(interrupted.status, "unresolved");
  assert.notEqual(journal.value.attempts[0].beforeStateFingerprint, journal.value.attempts[0].afterStateFingerprint);
  assert.equal(journal.value.attempts[0].sameTargetRemained, true);
  const resumed = await new NavigationEngine(session, { planner, journal, maxActions: 3, maxRecoveries: 1 }).run("Open the account page", { resumeState: structuredClone(journal.value) });

  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(session.clicks, [failedTarget.identity, alternativeTarget.identity], "resume must not dispatch the failed semantic target again");
  assert.deepEqual(plannerViews[1], [alternativeTarget.identity], "all planner providers receive the current candidate list with the unchanged failed target removed");
});

test("engine refuses a cached planner target that is absent from the fresh candidate set", async () => {
  const staleTarget = { identity: "stale-control", backendNodeId: 1, documentGeneration: 1, name: "Open account", role: "button", tag: "button", visible: true };
  const session = {
    target: { id: "cached-planner-target", endpoint: "local-cdp" },
    clicks: 0,
    async observe() {
      return {
        evidenceId: "unchanged-page",
        page: { url: "https://shop.example.test/", title: "Shop" },
        headings: [{ level: 1, text: "Shop" }],
        candidates: [staleTarget]
      };
    },
    async click() { this.clicks++; throw new Error("No state change after failed action."); },
    async waitForChange() {}
  };
  const planner = { async plan() { return { status: "planned", action: { type: "click", target: staleTarget } }; } };

  const result = await new NavigationEngine(session, { planner, maxActions: 3, maxRecoveries: 2 }).run("Open the account page");

  assert.equal(result.status, "needs_human");
  assert.equal(session.clicks, 1, "the planner cannot redispatch a cached target filtered from current evidence");
  assert.match(result.reason, /not present and interactable in the fresh observation/);
});

test("a model-selected sensitive action outside the user goal is handed off without clicking", async () => {
  const session = new FailingRouteSession();
  const target = { ...session.state.candidates[0], name: "Place order", submitsForm: true };
  session.state.candidates = [target];
  const planner = { async plan() { return { status: "planned", action: { type: "click", target } }; } };
  const result = await new NavigationEngine(session, { planner }).run("Open the checkout page");
  assert.equal(result.status, "needs_human");
  assert.equal(result.authorizationRequired.category, "purchase");
  assert.equal(result.authorizationRequired.evidenceId, "evidence-0");
  assert.equal(session.count, 0, "page content or a planner decision cannot authorize a purchase");
});

test("search phrase runs locally, verifies the query, and never persists or returns the text", async () => {
  const journal = {
    value: undefined,
    async write(value) { this.value = structuredClone(value); }
  };
  const searchField = { identity: "search-field", backendNodeId: 1, documentGeneration: 1, tag: "input", type: "search", role: "searchbox", name: "Search products", visible: true };
  const submitButton = { identity: "search-submit", backendNodeId: 2, documentGeneration: 1, tag: "button", role: "button", name: "Search", submitsForm: true, visible: true };
  const session = {
    target: { id: "search-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [searchField, submitButton]
    },
    entered: undefined,
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async typeSearchPhrase(target, value) {
      assert.equal(target.identity, searchField.identity);
      this.entered = value;
    },
    async click(target) {
      assert.equal(target.identity, submitButton.identity);
      this.current = {
        page: { url: "https://shop.example.test/search", title: "Search results" },
        headings: [{ level: 1, text: "Search results" }],
        candidates: [searchField, submitButton]
      };
    },
    async verifySearchOutcome(value) { return this.entered === value && this.current.page.title === "Search results"; },
    async waitForChange() {}
  };
  const workflowStore = {
    async find() { throw new Error("Search phrases must not look up persisted workflows."); },
    async record() { throw new Error("Search phrases must not persist replayable form workflows."); }
  };
  const externalPlanner = { async plan() { throw new Error("Search text must stay outside external planners."); } };

  const result = await new NavigationEngine(session, { journal, workflowStore, planner: externalPlanner }).run("Search for green tea");

  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts, 2);
  assert.equal(result.recoveries, 0, "the planned fill step is not counted as a recovery");
  assert.deepEqual(journal.value.attempts.map(attempt => attempt.action), ["type", "click"]);
  assert.equal(journal.value.goal, "[redacted task goal]");
  assert.equal(journal.value.goalFingerprint.length, 64);
  assert.equal(journal.value.requiresGoalInput, true);
  assert.equal(JSON.stringify(journal.value).includes("green tea"), false);
  assert.equal(JSON.stringify(result).includes("green tea"), false);
  assert.equal(result.workflowReplay.status, "skipped_form_input");
});

test("task journals redact arbitrary goals and reject a different goal on resume", async () => {
  const journal = {
    value: undefined,
    async write(value) { this.value = structuredClone(value); }
  };
  const privateMarker = "case-7419-private-person";
  const goal = `Open the private record for ${privateMarker}`;
  const session = {
    target: { id: "private-goal-target", endpoint: "local-cdp" },
    clicks: 0,
    observations: 0,
    async observe() {
      this.observations++;
      return { evidenceId: "private-goal-evidence", page: { url: "https://records.example.test/", title: "Records" }, headings: [{ level: 1, text: "Records" }], candidates: [] };
    },
    async click() { this.clicks++; },
    async waitForChange() {}
  };
  const planner = {
    calls: 0,
    async plan() { this.calls++; return { status: "ambiguous", reason: "No unique target." }; }
  };

  const result = await new NavigationEngine(session, { journal, planner }).run(goal);
  assert.equal(result.status, "unresolved");
  assert.equal(journal.value.goal, "[redacted task goal]");
  assert.match(journal.value.goalFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(journal.value.initialPageLabelHashes.length, 2, "the journal stores separate title and heading hashes");
  assert.ok(journal.value.initialPageLabelHashes.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(journal.value.requiresGoalInput, true);
  assert.equal(JSON.stringify(journal.value).includes(privateMarker), false);
  assert.equal(JSON.stringify(journal.value).includes("Records"), false, "page labels are hashed instead of copied into the task journal");
  assert.equal(JSON.stringify(result).includes(privateMarker), false);

  await assert.rejects(
    () => new NavigationEngine(session, { journal, planner }).run(`Open the private record for another person`, { resumeState: journal.value }),
    /goal fingerprint or target does not match/
  );
  assert.equal(planner.calls, 1, "a changed goal is rejected before another planning decision");
  assert.equal(session.observations, 1, "a changed goal is rejected before another page observation");
  assert.equal(session.clicks, 0);
});

test("ambiguous goals return retained candidate handles without dispatching a guessed click", async () => {
  const session = {
    target: { id: "ambiguous-target", endpoint: "local-cdp" },
    clicks: 0,
    async observe() {
      return {
        evidenceId: "ambiguous-evidence",
        page: { url: "https://shop.example.test/account", title: "Account" },
        headings: [{ level: 1, text: "Account setup" }],
        candidates: [
          { identity: "target-one", backendNodeId: 11, tag: "button", role: "button", name: "Continue", contextName: "Account setup", visible: true, bounds: { x: 10, y: 20, width: 90, height: 30 } },
          { identity: "target-two", backendNodeId: 22, frameTargetId: "frame-two", tag: "button", role: "button", name: "Continue", contextName: "Account setup", visible: true, bounds: { x: 120, y: 20, width: 90, height: 30 } }
        ]
      };
    },
    async click() { this.clicks++; },
    async waitForChange() {}
  };

  const result = await new NavigationEngine(session).run("Continue");

  assert.equal(result.status, "unresolved");
  assert.equal(result.evidenceId, "ambiguous-evidence");
  assert.deepEqual(result.targetResolution.candidates.map(({ backendNodeId, frameTargetId }) => ({ backendNodeId, frameTargetId })), [
    { backendNodeId: 11, frameTargetId: undefined },
    { backendNodeId: 22, frameTargetId: "frame-two" }
  ]);
  assert.match(result.targetResolution.nextStep, /revalidate it against a fresh observation/);
  assert.equal(session.clicks, 0);
});

test("resuming a redacted search journal re-enters the caller phrase instead of reading it from disk", async () => {
  const journal = {
    value: undefined,
    async write(value) { this.value = structuredClone(value); }
  };
  const searchField = { identity: "resume-search-field", backendNodeId: 1, documentGeneration: 1, tag: "input", type: "search", role: "searchbox", name: "Search", visible: true };
  const submitButton = { identity: "resume-search-submit", backendNodeId: 2, documentGeneration: 1, tag: "button", role: "button", name: "Search", submitsForm: true, visible: true };
  const session = {
    target: { id: "resume-search-target", endpoint: "local-cdp" },
    current: {
      page: { url: "https://shop.example.test/", title: "Shop" },
      headings: [{ level: 1, text: "Shop" }],
      candidates: [searchField, submitButton]
    },
    entered: undefined,
    async observe() { return { evidenceId: this.current.page.title, ...structuredClone(this.current) }; },
    async typeSearchPhrase(_target, value) { this.entered = value; },
    async click(target) {
      assert.equal(target.identity, submitButton.identity);
      this.current = {
        page: { url: "https://shop.example.test/search", title: "Search results" },
        headings: [{ level: 1, text: "Search results" }],
        candidates: [searchField, submitButton]
      };
    },
    async verifySearchOutcome(value) { return this.entered === value && this.current.page.title === "Search results"; },
    async waitForChange() {}
  };
  const goal = "Search for bronze lamp";
  const interrupted = await new NavigationEngine(session, { journal, maxActions: 1 }).run(goal);
  assert.equal(interrupted.status, "unresolved");
  const saved = structuredClone(journal.value);
  assert.equal(saved.goal, "[redacted task goal]");
  assert.equal(saved.goalFingerprint.length, 64);
  assert.equal(JSON.stringify(saved).includes("bronze lamp"), false);

  const enteredBeforeMismatch = session.entered;
  await assert.rejects(
    () => new NavigationEngine(session, { journal, maxActions: 3 }).run("Search for red flags", { resumeState: saved }),
    /goal fingerprint or target does not match/
  );
  assert.equal(session.entered, enteredBeforeMismatch, "a changed goal is rejected without changing the existing search field");

  const resumed = await new NavigationEngine(session, { journal, maxActions: 3 }).run(goal, { resumeState: saved });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.attempts, 3, "resume retypes the caller-supplied phrase, then submits it");
  assert.equal(JSON.stringify(journal.value).includes("bronze lamp"), false);
  assert.equal(JSON.stringify(resumed).includes("bronze lamp"), false);
});

test("with an environment binding, a click onto a non-authorized origin is recovered, never success", async () => {
  const environment = {
    environmentId: "freeinference-staging",
    authorizedOrigins: ["https://staging.freeinference.org"],
    entryOrigin: "https://staging.freeinference.org"
  };
  const navigations = [];
  const session = {
    target: { id: "env-target", endpoint: "local-cdp" },
    state: {
      page: { url: "https://staging.freeinference.org/", title: "FreeInference" },
      headings: [{ level: 1, text: "FreeInference" }],
      candidates: [
        { identity: "ext-link", backendNodeId: 1, documentGeneration: 1, name: "Agents", role: "link", tag: "a", visible: true },
        { identity: "good-link", backendNodeId: 2, documentGeneration: 1, name: "Documentation", role: "link", tag: "a", visible: true }
      ]
    },
    clicks: 0,
    async observe() { return { evidenceId: `ev-${this.clicks}`, pageChangeFingerprint: `fp-${this.clicks}`, domMutationCount: this.clicks, lifecycleEventCount: this.clicks, ...structuredClone(this.state) }; },
    async waitForChange() {},
    client: {
      async send(method, params) {
        if (method === "Page.navigate") {
          navigations.push(params.url);
          session.state = {
            page: { url: "https://staging.freeinference.org/", title: "FreeInference" },
            headings: [{ level: 1, text: "FreeInference" }],
            candidates: [
              { identity: "good-link", backendNodeId: 2, documentGeneration: 1, name: "Agents portal", role: "link", tag: "a", visible: true }
            ]
          };
        }
      }
    },
    async click(candidate) {
      this.clicks += 1;
      if (candidate.identity === "ext-link") {
        // The planner picked an external/unauthorized link.
        this.state = {
          page: { url: "https://unrelated.example.net/agents", title: "Agents" },
          headings: [{ level: 1, text: "Agents" }],
          candidates: []
        };
      } else {
        this.state = {
          page: { url: "https://staging.freeinference.org/agents", title: "Agents" },
          headings: [{ level: 1, text: "Agents portal" }],
          candidates: []
        };
      }
    }
  };
  const result = await new NavigationEngine(session, { environment, maxActions: 3, maxRecoveries: 2 }).run("Open the Agents portal");
  // The engine never declared success while on the unauthorized origin: it
  // detected the off-environment navigation, returned to the authorized page,
  // excluded the offending link, and only then completed on the authorized
  // /agents route.
  assert.equal(result.status, "succeeded", `expected recovery to succeed on the authorized origin (got ${result.status}: ${result.reason})`);
  assert.ok(navigations.includes("https://staging.freeinference.org/"), `engine must navigate back to the authorized page, got ${JSON.stringify(navigations)}`);
  assert.ok(session.clicks >= 2, "the off-environment link must not be the final state; a fresh authorized action was required");
  assert.match(result.page?.url ?? "", /^https:\/\/staging\.freeinference\.org\//, `final page must be on the authorized origin, got ${result.page?.url}`);
});
