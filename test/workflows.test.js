import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NavigationEngine } from "../src/navigation/engine.js";
import { DeterministicPlanner } from "../src/navigation/planner.js";
import { matchesTargetSignature, targetSignature, WorkflowStore } from "../src/state/workflows.js";

class FixtureSession {
  target = { id: "fixture-target", endpoint: "local-cdp" };
  clicks = [];
  scrolls = [];
  constructor(states) { this.states = states; this.index = 0; }
  async observe() { return { evidenceId: `e-${this.index}`, ...structuredClone(this.states[this.index]) }; }
  async click(target) {
    this.clicks.push(target.identity);
    if (this.index + 1 < this.states.length) this.index++;
    else throw new Error("Unexpected extra click");
  }
  async scroll(target) {
    this.scrolls.push(target.identity);
    if (this.index + 1 < this.states.length) this.index++;
    else throw new Error("Unexpected extra scroll");
  }
  async waitForChange() {}
}

const pageState = (path, title, heading, candidates = [], scrollTargets = []) => ({
  page: { url: `https://shop.example.test${path}`, title },
  headings: [{ level: 1, text: heading }],
  candidates,
  scrollTargets
});
const candidate = (identity, name) => ({ identity, name, tag: "button", role: "button", visible: true, disabled: false, href: null });
const listTarget = (identity, scrollTop) => ({
  identity, name: "Invoice list", contextName: "Invoices", tag: "div", role: "list", kind: "container",
  visible: true, canScrollDown: scrollTop < 1_200, scrollTop, maxScrollTop: 1_200, clientHeight: 168
});
const plannerForFirst = () => ({
  calls: 0,
  async plan(_goal, observation) {
    this.calls++;
    const target = observation.candidates[0];
    return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: "No target" };
  }
});

test("workflow target signatures hash section context and preserve legacy signatures", () => {
  const billing = { ...candidate("billing", "Continue"), contextName: "Billing history" };
  const shipping = { ...candidate("shipping", "Continue"), contextName: "Shipping history" };
  const signature = targetSignature(billing);
  assert.match(signature.contextFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(signature).includes("Billing history"), false);
  assert.equal(matchesTargetSignature(billing, signature), true);
  assert.equal(matchesTargetSignature(shipping, signature), false);
  const legacySignature = { ...signature };
  delete legacySignature.contextFingerprint;
  assert.equal(matchesTargetSignature(shipping, legacySignature), true, "old version 1 workflow records without a context fingerprint remain readable");
});

test("workflow replay distinguishes duplicate labels by hashed section context without planning", async () => withStore(async store => {
  const start = pageState("/", "Shop", "Shop", [
    { ...candidate("shipping-first", "Continue"), contextName: "Shipping history" },
    { ...candidate("billing-first", "Continue"), contextName: "Billing history" }
  ]);
  const destination = pageState("/billing", "Billing history", "Billing history");
  const firstSession = new FixtureSession([start, destination]);
  const firstRun = await new NavigationEngine(firstSession, { planner: new DeterministicPlanner(), workflowStore: store, maxActions: 1 }).run("Open the billing history page");
  assert.equal(firstRun.status, "succeeded");
  assert.deepEqual(firstSession.clicks, ["billing-first"]);
  assert.equal(firstRun.workflowReplay.status, "recorded");

  const replayStart = structuredClone(start);
  replayStart.candidates[0].identity = "shipping-fresh";
  replayStart.candidates[1].identity = "billing-fresh";
  const replaySession = new FixtureSession([replayStart, destination]);
  const forbiddenPlanner = { calls: 0, async plan() { this.calls++; throw new Error("A unique hashed context should replay without planning."); } };
  const replay = await new NavigationEngine(replaySession, { planner: forbiddenPlanner, workflowStore: store, maxActions: 1 }).run("Open the billing history page");
  assert.equal(replay.status, "succeeded");
  assert.equal(replay.workflowReplay.status, "replayed");
  assert.deepEqual(replaySession.clicks, ["billing-fresh"]);
  assert.equal(forbiddenPlanner.calls, 0);
}));

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-workflow-"));
  try { await run(new WorkflowStore(join(directory, "workflows.json"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("verified multi-step workflow replays with fresh node identities and no planner calls", async () => withStore(async store => {
  const states = [
    pageState("/", "Shop", "Shop", [candidate("old-account", "Open account")]),
    pageState("/account", "Account", "Account", [candidate("old-security", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ];
  const firstSession = new FixtureSession(states);
  const firstPlanner = plannerForFirst();
  const recorded = await new NavigationEngine(firstSession, { planner: firstPlanner, workflowStore: store, maxActions: 3 }).run("Open the account security page");
  assert.equal(recorded.status, "succeeded");
  assert.equal(firstPlanner.calls, 2);
  assert.equal(recorded.workflowReplay.status, "recorded");

  const replayStates = structuredClone(states).map((state, index) => {
    if (index === 0) state.candidates[0].identity = "new-account-node";
    if (index === 1) state.candidates[0].identity = "new-security-node";
    return state;
  });
  const replaySession = new FixtureSession(replayStates);
  const replayPlanner = plannerForFirst();
  const replayed = await new NavigationEngine(replaySession, { planner: replayPlanner, workflowStore: store, maxActions: 3 }).run("Open the account security page");
  assert.equal(replayed.status, "succeeded");
  assert.equal(replayed.workflowReplay.status, "replayed");
  assert.equal(replayed.workflowReplay.actions, 2);
  assert.equal(replayPlanner.calls, 0);
  assert.deepEqual(replaySession.clicks, ["new-account-node", "new-security-node"]);
}));

test("version 2 workflows replay virtualized scrolling only from a matching fresh list position", async () => withStore(async store => {
  const goal = "Open invoice 24 page";
  const start = pageState("/invoices", "Invoices", "Invoices",
    Array.from({ length: 6 }, (_, index) => candidate(`first-row-${index + 1}`, `Open invoice ${index + 1}`)),
    [listTarget("first-list", 0)]);
  const afterScroll = pageState("/invoices", "Invoices", "Invoices",
    Array.from({ length: 6 }, (_, index) => candidate(`scrolled-row-${index + 19}`, `Open invoice ${index + 19}`)),
    [listTarget("first-list-after", 700)]);
  const destination = pageState("/invoice/24", "Invoice 24", "Invoice 24");
  const planner = {
    calls: 0,
    async plan(_goal, observation) {
      this.calls++;
      const invoice = observation.candidates.find(item => item.name === "Open invoice 24");
      if (invoice) return { status: "planned", action: { type: "click", target: invoice } };
      const scrollTarget = observation.scrollTargets.find(item => item.kind === "container" && item.canScrollDown);
      return scrollTarget
        ? { status: "planned", action: { type: "scroll", target: scrollTarget, direction: "down" } }
        : { status: "ambiguous", reason: "No current invoice row or scroll target." };
    }
  };

  const learnedSession = new FixtureSession([start, afterScroll, destination]);
  const learned = await new NavigationEngine(learnedSession, { planner, workflowStore: store, maxActions: 4, maxScrolls: 2 }).run(goal);
  assert.equal(learned.status, "succeeded", JSON.stringify(learned));
  assert.equal(learned.workflowReplay.status, "recorded");
  assert.deepEqual(learnedSession.scrolls, ["first-list"]);
  assert.equal(planner.calls, 2);

  const serialized = await readFile(store.path, "utf8");
  const data = JSON.parse(serialized);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.workflows[0].version, 2);
  assert.deepEqual(data.workflows[0].steps.map(step => step.action), ["scroll", "click"]);
  for (const privateText of ["Invoice list", "Open invoice 24", "first-list", "https://shop.example.test"]) assert.equal(serialized.includes(privateText), false);

  const replayStart = structuredClone(start);
  replayStart.scrollTargets[0].identity = "fresh-list";
  replayStart.candidates.forEach(item => { item.identity = `fresh-${item.identity}`; });
  const replayAfterScroll = structuredClone(afterScroll);
  replayAfterScroll.scrollTargets[0].identity = "fresh-list-after";
  replayAfterScroll.candidates.forEach(item => { item.identity = `fresh-${item.identity}`; });
  const replaySession = new FixtureSession([replayStart, replayAfterScroll, destination]);
  const forbiddenPlanner = { calls: 0, async plan() { this.calls++; throw new Error("A fresh, matching scroll workflow should replay without planning."); } };
  const replayed = await new NavigationEngine(replaySession, { planner: forbiddenPlanner, workflowStore: store, maxActions: 4, maxScrolls: 2 }).run(goal);
  assert.equal(replayed.status, "succeeded");
  assert.equal(replayed.workflowReplay.status, "replayed");
  assert.equal(replayed.workflowReplay.actions, 2);
  assert.equal(forbiddenPlanner.calls, 0);
  assert.deepEqual(replaySession.scrolls, ["fresh-list"]);
  assert.deepEqual(replaySession.clicks, ["fresh-scrolled-row-24"]);

  const changedStart = structuredClone(start);
  changedStart.scrollTargets[0].identity = "changed-list";
  changedStart.candidates[0] = candidate("new-row", "Open invoice 7");
  const changedAfterScroll = structuredClone(afterScroll);
  changedAfterScroll.scrollTargets[0].identity = "changed-list";
  const changedSession = new FixtureSession([changedStart, changedAfterScroll, destination]);
  const repairPlanner = {
    calls: 0,
    async plan(_goal, observation) {
      this.calls++;
      const invoice = observation.candidates.find(item => item.name === "Open invoice 24");
      if (invoice) return { status: "planned", action: { type: "click", target: invoice } };
      const scrollTarget = observation.scrollTargets.find(item => item.kind === "container" && item.canScrollDown);
      return scrollTarget
        ? { status: "planned", action: { type: "scroll", target: scrollTarget, direction: "down" } }
        : { status: "ambiguous", reason: "No current invoice row or scroll target." };
    }
  };
  const repaired = await new NavigationEngine(changedSession, { planner: repairPlanner, workflowStore: store, maxActions: 4, maxScrolls: 2 }).run(goal);
  assert.equal(repaired.status, "succeeded");
  assert.equal(repairPlanner.calls, 2, "a changed visible row set invalidates the replay before any stored scroll is dispatched");
  assert.deepEqual(changedSession.scrolls, ["changed-list"]);
  assert.deepEqual(changedSession.clicks, ["scrolled-row-24"]);
}));

test("legacy version 1 click workflows remain readable", async () => withStore(async store => {
  const goal = "Open the account page";
  const start = pageState("/", "Shop", "Shop", [candidate("old-node", "Open account")]);
  const destination = pageState("/account", "Account", "Account");
  const learned = await new NavigationEngine(new FixtureSession([start, destination]), { planner: plannerForFirst(), workflowStore: store }).run(goal);
  assert.equal(learned.status, "succeeded");

  const data = JSON.parse(await readFile(store.path, "utf8"));
  data.schemaVersion = 1;
  data.workflows[0].version = 1;
  data.workflows[0].steps = data.workflows[0].steps.map(({ action, ...step }) => step);
  await writeFile(store.path, JSON.stringify(data));

  const replaySession = new FixtureSession([
    pageState("/", "Shop", "Shop", [candidate("new-node", "Open account")]),
    destination
  ]);
  const forbiddenPlanner = { calls: 0, async plan() { this.calls++; throw new Error("A valid legacy click workflow should replay."); } };
  const replayed = await new NavigationEngine(replaySession, { planner: forbiddenPlanner, workflowStore: store, maxActions: 1 }).run(goal);
  assert.equal(replayed.status, "succeeded");
  assert.equal(replayed.workflowReplay.status, "replayed");
  assert.equal(forbiddenPlanner.calls, 0);
  assert.deepEqual(replaySession.clicks, ["new-node"]);
}));

test("stale target signatures invalidate the workflow and repair through the current planner", async () => withStore(async store => {
  const original = [
    pageState("/", "Shop", "Shop", [candidate("old-node", "Open account")]),
    pageState("/account", "Account", "Account")
  ];
  const first = await new NavigationEngine(new FixtureSession(original), { planner: plannerForFirst(), workflowStore: store }).run("Open the account page");
  assert.equal(first.status, "succeeded");

  const changedSession = new FixtureSession([
    pageState("/", "Shop", "Shop", [candidate("current-node", "Account")]),
    pageState("/account", "Account", "Account")
  ]);
  const currentPlanner = plannerForFirst();
  const repaired = await new NavigationEngine(changedSession, { planner: currentPlanner, workflowStore: store }).run("Open the account page");
  assert.equal(repaired.status, "succeeded");
  assert.equal(currentPlanner.calls, 1, "stale workflow falls through to fresh planning");
  assert.equal(repaired.workflowReplay.status, "recorded");
  assert.deepEqual(changedSession.clicks, ["current-node"]);
}));

test("intermediate workflow replay failure replans from fresh evidence and records the repaired trace", async () => withStore(async store => {
  const goal = "Open the account security page";
  const learned = new FixtureSession([
    pageState("/", "Shop", "Shop", [candidate("old-account", "Open account")]),
    pageState("/account", "Account", "Account", [candidate("old-security", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ]);
  const initial = await new NavigationEngine(learned, { planner: plannerForFirst(), workflowStore: store, maxActions: 3 }).run(goal);
  assert.equal(initial.status, "succeeded");

  class IntermediateFailureSession extends FixtureSession {
    async click(target) {
      this.clicks.push(target.identity);
      if (target.identity === "stale-security-node") {
        this.index = 2;
        throw new Error("The replay target became stale before input.");
      }
      if (target.identity === "new-account-node" && this.index === 0) {
        this.index = 1;
        return;
      }
      if (target.identity === "repaired-security-node" && this.index === 2) {
        this.index = 3;
        return;
      }
      throw new Error("Unexpected target or task state.");
    }
  }

  const replaySession = new IntermediateFailureSession([
    pageState("/", "Shop", "Shop", [candidate("new-account-node", "Open account")]),
    pageState("/account", "Account", "Account", [candidate("stale-security-node", "Security settings")]),
    pageState("/account", "Account", "Account", [candidate("repaired-security-node", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ]);
  const repairPlanner = {
    calls: 0,
    async plan(_goal, observation, { excludedIdentities }) {
      this.calls++;
      const target = observation.candidates.find(item => !excludedIdentities.includes(item.identity));
      return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: "No fresh target" };
    }
  };

  const repaired = await new NavigationEngine(replaySession, { planner: repairPlanner, workflowStore: store, maxActions: 4, maxRecoveries: 1 }).run(goal);
  assert.equal(repaired.status, "succeeded");
  assert.equal(repaired.recoveries, 1);
  assert.equal(repaired.workflowReplay.status, "repaired-and-recorded");
  assert.equal(repairPlanner.calls, 1);
  assert.deepEqual(replaySession.clicks, ["new-account-node", "stale-security-node", "repaired-security-node"]);

  const start = pageState("/", "Shop", "Shop", [candidate("second-account-node", "Open account")]);
  const stored = await store.find(goal, { page: start.page });
  assert.equal(stored.steps.length, 2, "the failed click is omitted from the newly verified trace");
  const replayAgainSession = new FixtureSession([
    start,
    pageState("/account", "Account", "Account", [candidate("second-security-node", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ]);
  const noCallPlanner = { calls: 0, async plan() { this.calls++; throw new Error("A repaired trace should replay without planning."); } };
  const replayedAgain = await new NavigationEngine(replayAgainSession, { planner: noCallPlanner, workflowStore: store, maxActions: 3 }).run(goal);
  assert.equal(replayedAgain.status, "succeeded");
  assert.equal(replayedAgain.workflowReplay.status, "replayed");
  assert.equal(replayedAgain.workflowReplay.actions, 2);
  assert.equal(noCallPlanner.calls, 0);
}));

test("a failed replay that changes observed state is never omitted to manufacture a reusable trace", async () => withStore(async store => {
  const goal = "Open the account security page";
  const learned = new FixtureSession([
    pageState("/", "Shop", "Shop", [candidate("old-account", "Open account")]),
    pageState("/account", "Account", "Account", [candidate("old-security", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ]);
  await new NavigationEngine(learned, { planner: plannerForFirst(), workflowStore: store, maxActions: 3 }).run(goal);

  class PartialFailureSession extends FixtureSession {
    async click(target) {
      this.clicks.push(target.identity);
      if (target.identity === "new-account-node" && this.index === 0) {
        this.index = 1;
        return;
      }
      if (target.identity === "stale-security-node" && this.index === 1) {
        this.index = 2;
        throw new Error("The action failed after causing a visible transition.");
      }
      if (target.identity === "repaired-security-node" && this.index === 2) {
        this.index = 3;
        return;
      }
      throw new Error("Unexpected target or task state.");
    }
  }

  const replaySession = new PartialFailureSession([
    pageState("/", "Shop", "Shop", [candidate("new-account-node", "Open account")]),
    pageState("/account", "Account", "Account", [candidate("stale-security-node", "Security settings")]),
    pageState("/account/pending", "Loading security", "Loading security", [candidate("repaired-security-node", "Security settings")]),
    pageState("/account/security", "Security", "Security settings")
  ]);
  const planner = {
    async plan(_goal, observation, { excludedIdentities }) {
      const target = observation.candidates.find(item => !excludedIdentities.includes(item.identity));
      return target ? { status: "planned", action: { type: "click", target } } : { status: "ambiguous", reason: "No fresh target" };
    }
  };

  const result = await new NavigationEngine(replaySession, { planner, workflowStore: store, maxActions: 4, maxRecoveries: 1 }).run(goal);
  assert.equal(result.status, "succeeded");
  assert.equal(result.workflowReplay.status, "repaired-not-recorded");
  assert.match(result.workflowReplay.reason, /failed action changed observable state/);
  assert.equal(await store.find(goal, { page: { url: "https://shop.example.test/" } }), undefined);
}));

test("workflow persistence contains only bounded hashes and creates owner-only files", async () => withStore(async store => {
  const session = new FixtureSession([
    pageState("/", "Shop", "Shop", [candidate("node", "Open private account 4412")]),
    pageState("/account", "Private account", "Private account")
  ]);
  await new NavigationEngine(session, { planner: plannerForFirst(), workflowStore: store }).run("Open the private account page for customer 4412");
  const raw = await readFile(store.path, "utf8");
  assert.equal(raw.includes("private account"), false);
  assert.equal(raw.includes("4412"), false);
  assert.equal(raw.includes("https://shop.example.test"), false);
  assert.equal(raw.includes("node"), false);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
}));
