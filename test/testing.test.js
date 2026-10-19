import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkflow, STEP_STATUS, STEP_TYPES } from "../src/testing/schema.js";
import { evaluateAssertion } from "../src/testing/assertions.js";
import { TestReceipt, deriveRunStatus } from "../src/testing/receipts.js";
import { RUN_STATUS } from "../src/testing/schema.js";
import { TestRunner } from "../src/testing/runner.js";
import { RunStateStore } from "../src/testing/runState.js";
import { createRunStateFixture } from "./runStateFixture.js";

test("schema validates workflow structure", () => {
  assert.equal(validateWorkflow(null).valid, false);
  assert.equal(validateWorkflow({}).valid, false);
  assert.equal(validateWorkflow({ id: "x", name: "x", steps: [] }).valid, false);
  assert.equal(validateWorkflow({ id: "x", name: "x", steps: [{ id: "s1", type: "navigate" }] }).valid, false);
  const good = validateWorkflow({
    id: "wf-1", name: "Test workflow",
    steps: [
      { id: "s1", type: "navigate", url: "http://example.com" },
      { id: "s2", type: "assert", assertion: { type: "page_title_contains", value: "example" } },
      { id: "s3", type: "cleanup" }
    ]
  });
  assert.equal(good.valid, true);
  assert.deepEqual(good.errors, []);
});

test("schema rejects unknown step types", () => {
  const bad = validateWorkflow({
    id: "x", name: "x",
    steps: [{ id: "s1", type: "destroy_everything" }]
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => e.includes("not a recognized step type")));
});

test("schema validates DAG dependencies, branches, and cycles", () => {
  const branched = validateWorkflow({
    id: "dag-valid", name: "Acyclic workflow", execution: "dag",
    steps: [
      { id: "root", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: [] },
      { id: "then", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: ["root"], when: { stepId: "root", statuses: [STEP_STATUS.PASS] } },
      { id: "else", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: ["root"], when: { stepId: "root", statuses: [STEP_STATUS.FAIL] } }
    ]
  });
  assert.equal(branched.valid, true, branched.errors.join(" "));
  assert.deepEqual(branched.order.map(step => step.id), ["root", "then", "else"]);

  const cyclic = validateWorkflow({
    id: "dag-cycle", name: "Cycle", execution: "dag",
    steps: [
      { id: "a", type: "assert", assertion: { type: "page_title_contains", value: "a" }, dependsOn: ["b"] },
      { id: "b", type: "assert", assertion: { type: "page_title_contains", value: "b" }, dependsOn: ["a"] }
    ]
  });
  assert.equal(cyclic.valid, false);
  assert.ok(cyclic.errors.some(error => error.includes("dependency cycle")));
});

test("assertions: page_title_contains", () => {
  const ctx = { observation: { page: { title: "Demo shop" } } };
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "demo" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "missing" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "page_title_contains", value: "x" }, {}).status, "UNCERTAIN");
});

test("assertions: candidate_name_contains requires a visible fresh UI control", () => {
  const ctx = { observation: {
    evidenceId: "agent-composer-1",
    candidates: [
      { name: "New task", visible: true },
      { name: "Hidden New task", visible: false }
    ]
  } };
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "new task" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "run" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "candidate_name_contains", value: "new task" }, {}).status, "UNCERTAIN");
});

test("assertions: url_matches", () => {
  const ctx = { observation: { page: { url: "http://127.0.0.1:3000/archive" } } };
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "/archive" }, ctx).status, "PASS");
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "/missing" }, ctx).status, "FAIL");
  assert.equal(evaluateAssertion({ type: "url_matches", pattern: "[bad" }, ctx).status, "UNCERTAIN");
});

test("assertions: network_request_seen", () => {
  const mockCollector = {
    getSnapshots() {
      return [{ sourceId: "net", data: { requests: [{ url: "http://api.example.com/data" }] } }];
    }
  };
  const ctx = { collector: mockCollector };
  const pass = evaluateAssertion({ type: "network_request_seen", urlPattern: "api\\.example\\.com" }, ctx);
  assert.equal(pass.status, "PASS");
  const fail = evaluateAssertion({ type: "network_request_seen", urlPattern: "other\\.com" }, ctx);
  assert.equal(fail.status, "FAIL");
});

test("assertions: diagnostic_source_available requires collected evidence", () => {
  const registeredOnly = { hasSource: id => id === "src-1", getSnapshots: () => [] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: registeredOnly }).status, "UNCERTAIN");
  const notRegistered = { hasSource: () => false, getSnapshots: () => [] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-2" }, { collector: notRegistered }).status, "FAIL");
  const withEvidence = { hasSource: () => true, getSnapshots: () => [{ sourceId: "src-1", data: { status: "available", requests: [] } }] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: withEvidence }).status, "PASS");
  const emptyEvidence = { hasSource: () => true, getSnapshots: () => [{ sourceId: "src-1", data: { status: "empty", requests: [] } }] };
  assert.equal(evaluateAssertion({ type: "diagnostic_source_available", sourceId: "src-1" }, { collector: emptyEvidence }).status, "UNCERTAIN");
});

test("receipts record steps and derive status", () => {
  const receipt = new TestReceipt({ runId: "r1", workflowId: "w1", workflowName: "Test" });
  receipt.recordStep({ stepId: "s1", type: "navigate", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.recordStep({ stepId: "s2", type: "assert", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.recordStep({ stepId: "s3", type: "cleanup", status: STEP_STATUS.PASS, reason: "ok" });
  receipt.finish(deriveRunStatus(receipt.steps));
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(receipt.toObject().steps.length, 3);
});

test("deriveRunStatus handles mixed statuses", () => {
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "PASS" }]), "PASSED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "FAIL" }]), "FAILED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "BLOCKED" }]), "BLOCKED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "CANCELED" }]), "CANCELED");
  assert.equal(deriveRunStatus([{ status: "PASS" }, { status: "UNCERTAIN" }]), "UNCERTAIN");
});

test("uncertain dispatched step stays uncertain until independent evidence reconciles it", () => {
  const receipt = new TestReceipt({ runId: "r-uncertain", workflowId: "w-uncertain", workflowName: "Task" });
  receipt.recordStep({ stepId: "submit", type: "interact", status: STEP_STATUS.UNCERTAIN, reason: "Dispatched; awaiting independent evidence." });
  receipt.finish(deriveRunStatus(receipt.steps));
  assert.equal(receipt.status, RUN_STATUS.UNCERTAIN);
  assert.equal(receipt.reconcileStep("submit", { status: STEP_STATUS.PASS, reason: "Exact outcome verified.", evidenceIds: ["browser_ev", "backend_ev"] }), true);
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.deepEqual(receipt.steps[0].evidenceIds, ["browser_ev", "backend_ev"]);
  assert.equal(receipt.reconcileStep("submit", { status: STEP_STATUS.FAIL }), false);
});

test("runner executes navigate + assert + cleanup", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  let navigateCalled = false;
  const mockSession = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      return { targetId: "fixture-target", page: { title: "Archive", url: navigateCalled ? "http://fixture.local/archive" : "http://fixture.local/" }, candidates: [], evidenceId: "ev-1", pageChangeFingerprint: navigateCalled ? "changed" : "initial" };
    },
    async waitForChange() {},
    client: {
      async send(method, params) {
        if (method === "Page.navigate") { navigateCalled = true; return { frameId: "f1", loaderId: "l1" }; }
        throw new Error(`Unexpected CDP call ${method}`);
      }
    }
  };
  const runner = new TestRunner({
    session: mockSession,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] }
  });
  const receipt = await runner.run({
    id: "wf-e2e", name: "Navigate to archive",
    steps: [
      { id: "nav-1", type: "navigate", url: "http://fixture.local/", waitMs: 10 },
      { id: "assert-1", type: "assert", assertion: { type: "page_title_contains", value: "archive" } },
      { id: "cleanup-1", type: "cleanup" }
    ]
  }, { runId: "run-t1" });

  // Cleanup with no action and no test-owned resources is a valid declaration.
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(receipt.steps.length, 3);
  assert.equal(receipt.steps[0].status, "PASS");
  assert.equal(receipt.steps[1].status, "PASS");
  assert.equal(receipt.steps[2].status, "PASS");
});

test("runner blocks unsupported step types and records reason", async () => {
  const runner = new TestRunner({ session: null });
  const receipt = await runner.run({
    id: "wf-block", name: "Blocked",
    steps: [{ id: "s1", type: "interact", action: { type: "click" } }]
  }, { runId: "run-t2" });
  assert.equal(receipt.status, RUN_STATUS.BLOCKED);
  assert.equal(receipt.steps[0].status, "BLOCKED");
});

test("runner preserves a possibly dispatched browser error as UNCERTAIN", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = { identity: "tab-settings", targetId: "fixture-target", documentGeneration: 1, backendNodeId: 22, name: "Settings", role: "tab", tag: "button", visible: true, disabled: false };
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      return { targetId: "fixture-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Home" }, candidates: [candidate], evidenceId: "ev-dispatch-uncertain" };
    },
    async click() { throw new Error("CDP connection closed after sending the click"); }
  };
  const receipt = await new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] }
  }).run({
    id: "wf-uncertain-dispatch",
    name: "Preserve uncertain dispatch",
    steps: [{ id: "click-settings", type: "interact", action: { type: "click", target: { identity: "tab-settings" } } }]
  }, { runId: "run-dispatch-uncertain" });
  assert.equal(receipt.steps[0].status, STEP_STATUS.UNCERTAIN);
  assert.equal(receipt.status, RUN_STATUS.UNCERTAIN);
});

test("DAG runner evaluates declared branches and skips the inactive branch", async () => {
  const session = { async observe() { return { page: { url: "http://fixture.local/", title: "Home" }, candidates: [], evidenceId: "ev-dag" }; } };
  const receipt = await new TestRunner({ session }).run({
    id: "wf-dag-branch", name: "Branch on observed status", execution: "dag",
    steps: [
      { id: "join", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: ["fallback"] },
      { id: "success-path", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: ["probe"], when: { stepId: "probe", statuses: [STEP_STATUS.PASS] } },
      { id: "fallback", type: "assert", assertion: { type: "page_title_contains", value: "Home" }, dependsOn: ["probe"], when: { stepId: "probe", statuses: [STEP_STATUS.FAIL] } },
      { id: "probe", type: "assert", assertion: { type: "page_title_contains", value: "Admin" }, dependsOn: [] }
    ]
  }, { runId: "run-dag-branch" });
  assert.deepEqual(receipt.steps.map(step => [step.stepId, step.status]), [
    ["probe", STEP_STATUS.FAIL],
    ["success-path", STEP_STATUS.SKIPPED],
    ["fallback", STEP_STATUS.PASS],
    ["join", STEP_STATUS.PASS]
  ]);
  assert.equal(receipt.status, RUN_STATUS.PASSED, "The failed probe is handled by the declared failure branch and successful terminal join.");
});

test("DAG terminal failures remain failures when no declared branch handles them", async () => {
  const session = { async observe() { return { page: { url: "http://fixture.local/", title: "Home" }, candidates: [], evidenceId: "ev-dag-terminal" }; } };
  const receipt = await new TestRunner({ session }).run({
    id: "wf-dag-terminal-failure", name: "Uncaught graph failure", execution: "dag",
    steps: [{ id: "terminal-check", type: "assert", assertion: { type: "page_title_contains", value: "Admin" }, dependsOn: [] }]
  }, { runId: "run-dag-terminal-failure" });
  assert.equal(receipt.steps[0].status, STEP_STATUS.FAIL);
  assert.equal(receipt.status, RUN_STATUS.FAILED);
});

test("durable DAG resume reconciles an uncertain dispatch, preserves workflow binding, and skips completed effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-dag-resume-"));
  try {
    const store = new RunStateStore(dir);
    await store.init();
    const candidate = { identity: "open-report", targetId: "durable-target", documentGeneration: 1, backendNodeId: 41, name: "Open report", role: "link", tag: "a", href: "http://fixture.local/report", visible: true, disabled: false };
    let dispatchCount = 0;
    const makeSession = () => ({
      target: { id: "durable-target", url: "http://fixture.local/" },
      attached: true,
      async observe() { return { targetId: "durable-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Home" }, candidates: [candidate], evidenceId: `durable-evidence-${dispatchCount}` }; },
      async click() { dispatchCount++; throw new Error("transport ended after dispatch may have begun"); }
    });
    const workflow = {
      id: "durable-dag", name: "Recover graph after uncertain dispatch", execution: "dag",
      steps: [
        { id: "open", type: "interact", dependsOn: [], action: { type: "click", target: { identity: "open-report" } } },
        { id: "verify", type: "assert", dependsOn: ["open"], assertion: { type: "page_title_contains", value: "Home" } }
      ]
    };
    const first = await new TestRunner({
      session: makeSession(),
      environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
      runStateStore: store
    }).run(workflow, { runId: "durable-dag-run" });
    assert.equal(first.status, RUN_STATUS.UNCERTAIN);
    assert.equal(dispatchCount, 1);
    const pending = (await store.getFresh(first.runId)).pendingOperations[0];
    assert.equal(pending.status, "UNCERTAIN");

    await store.reconcileOperation(first.runId, {
      operationId: pending.operationId,
      status: "VERIFIED",
      evidenceIds: ["independent-outcome-evidence"],
      summary: "The exact expected postcondition was independently observed."
    });
    const restartedStore = new RunStateStore(dir);
    await restartedStore.init();
    const resumed = await new TestRunner({
      session: makeSession(),
      environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
      runStateStore: restartedStore
    }).run(workflow, { runId: first.runId });
    assert.equal(resumed.status, RUN_STATUS.PASSED);
    assert.equal(resumed.steps.findLast(step => step.stepId === "open").status, STEP_STATUS.PASS);
    assert.equal(resumed.steps.findLast(step => step.stepId === "verify").status, STEP_STATUS.PASS);
    assert.equal(dispatchCount, 1, "recovery must continue the DAG without replaying the effect");

    await assert.rejects(() => new TestRunner({
      session: makeSession(),
      environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
      runStateStore: restartedStore
    }).run({ ...workflow, name: "Changed workflow contract" }, { runId: first.runId }), /workflow or authority binding differs/);
    assert.equal(dispatchCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a competing run is refused before it can control an already leased browser target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-target-lease-runner-"));
  try {
    const store = new RunStateStore(dir);
    await store.init();
    const otherStore = new RunStateStore(dir);
    await otherStore.init();
    let enteredObservation;
    let releaseObservation;
    const observationEntered = new Promise(resolve => { enteredObservation = resolve; });
    const observationGate = new Promise(resolve => { releaseObservation = resolve; });
    let dispatchCount = 0;
    let firstObservation = true;
    let currentUrl = "http://fixture.local/";
    const session = {
      target: { id: "one-shared-target", url: "http://fixture.local/" },
      attached: true,
      async observe() {
        if (firstObservation) {
          firstObservation = false;
          enteredObservation();
          await observationGate;
        }
        return {
          targetId: "one-shared-target",
          documentGeneration: 1,
          page: { url: currentUrl, title: "Fixture" },
          candidates: [],
          evidenceId: `target-lease-${dispatchCount}`,
          pageChangeFingerprint: `state-${dispatchCount}`
        };
      },
      client: { async send(_method, params) { dispatchCount++; currentUrl = params.url; } },
      async waitForChange() {}
    };
    const workflow = { id: "target-lease-flow", name: "Target lease flow", steps: [{ id: "navigate", type: "navigate", url: "http://fixture.local/next" }] };
    const firstRun = new TestRunner({
      session,
      environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
      runStateStore: store
    }).run(workflow, { runId: "target-lease-run-one" });
    await observationEntered;

    await assert.rejects(
      () => new TestRunner({
        session,
        environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
        runStateStore: otherStore
      }).run(workflow, { runId: "target-lease-run-two" }),
      error => error.code === "RUN_TARGET_LEASE_HELD"
    );
    assert.equal(dispatchCount, 0, "The competing run must not dispatch while the target is leased.");

    releaseObservation();
    const receipt = await firstRun;
    assert.equal(receipt.status, RUN_STATUS.PASSED);
    assert.equal(dispatchCount, 1);
    const durable = await store.getFresh(receipt.runId);
    assert.ok(durable.target.fencingToken > 0);
    assert.equal(durable.pendingOperations[0].targetFencingToken, durable.target.fencingToken);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a durable cancellation from another store stops the DAG before its next dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-dag-cancel-"));
  try {
    const store = new RunStateStore(dir);
    await store.init();
    const remoteStore = new RunStateStore(dir);
    await remoteStore.init();
    let releaseObservation;
    let markObserved;
    const observationStarted = new Promise(resolve => { markObserved = resolve; });
    const observationGate = new Promise(resolve => { releaseObservation = resolve; });
    let dispatchCount = 0;
    const candidate = { identity: "danger", targetId: "cancel-target", documentGeneration: 1, backendNodeId: 49, name: "Danger", role: "button", tag: "button", visible: true, disabled: false };
    const session = {
      target: { id: "cancel-target", url: "http://fixture.local/" },
      attached: true,
      async observe() {
        markObserved();
        await observationGate;
        return { targetId: "cancel-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Home" }, candidates: [candidate], evidenceId: "cancel-observation" };
      },
      async click() { dispatchCount++; }
    };
    const workflow = {
      id: "cancel-dag", name: "Stop before next effect", execution: "dag",
      steps: [
        { id: "baseline", type: "assert", dependsOn: [], assertion: { type: "page_title_contains", value: "Home" } },
        { id: "effect", type: "interact", dependsOn: ["baseline"], action: { type: "click", target: { identity: "danger" } } }
      ]
    };
    const runPromise = new TestRunner({
      session,
      environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
      runStateStore: store
    }).run(workflow, { runId: "cancel-dag-run" });
    await observationStarted;
    await remoteStore.requestCancellation("cancel-dag-run");
    releaseObservation();
    const receipt = await runPromise;
    assert.equal(receipt.status, RUN_STATUS.CANCELED);
    assert.equal(dispatchCount, 0);
    assert.equal((await remoteStore.getFresh("cancel-dag-run")).cancellationRequested, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped variables feed exact operation inputs without appearing in receipts", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = { identity: "task-input", targetId: "fixture-target", documentGeneration: 1, backendNodeId: 31, name: "Task", role: "textbox", tag: "textarea", visible: true, disabled: false };
  let enteredValue = null;
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() { return { targetId: "fixture-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Composer" }, candidates: [candidate], evidenceId: "ev-input" }; },
    async fillField(_candidate, value) { enteredValue = value; },
    async verifyControlValue(_candidate, value) { return { verified: true, matches: enteredValue === value }; }
  };
  const runner = new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
    operationAuthorizer: { async authorize() { return { allowed: true }; } }
  });
  const receipt = await runner.run({
    id: "workflow-scoped-value", name: "Scoped value", inputs: { taskText: "private caller task" },
    steps: [{ id: "fill", type: "interact", action: { type: "fill", operationId: "task-input", target: { identity: "task-input" }, value: { variable: "taskText" }, verifyValue: true } }]
  }, { runId: "run-scoped-value" });
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(enteredValue, "private caller task");
  assert.equal(JSON.stringify(receipt.toObject()).includes("private caller task"), false);
});

test("interaction PASS requires both exact value read-back and its declared application postcondition", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = { identity: "task-input", targetId: "fixture-target", documentGeneration: 1, backendNodeId: 31, name: "Task", role: "textbox", tag: "textarea", visible: true, disabled: false };
  let enteredValue = null;
  let observationCount = 0;
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      return {
        targetId: "fixture-target", documentGeneration: 1,
        page: { url: "http://fixture.local/", title: "Composer" },
        candidates: [candidate], evidenceId: `ev-dual-verification-${++observationCount}`
      };
    },
    async fillField(_candidate, value) { enteredValue = value; return { dispatched: true }; },
    async verifyControlValue(_candidate, value) { return { verified: true, matches: enteredValue === value }; },
    async waitForChange() {}
  };
  const runner = new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
    operationAuthorizer: { async authorize() { return { allowed: true }; } }
  });
  const receipt = await runner.run({
    id: "workflow-dual-verification", name: "Dual verification",
    steps: [{
      id: "fill", type: "interact", action: {
        type: "fill", operationId: "task-input", target: { identity: "task-input" },
        value: "requested task", verifyValue: true,
        postcondition: { type: "page_title_contains", value: "Task submitted" }
      }
    }]
  }, { runId: "run-dual-verification" });
  assert.equal(receipt.steps.find(step => step.stepId === "fill").status, STEP_STATUS.FAIL,
    "exact field read-back cannot hide a failed declared application postcondition");
  assert.equal(enteredValue, "requested task", JSON.stringify(receipt.toObject()));
  assert.equal(receipt.status, RUN_STATUS.FAILED);
});

test("interaction remains UNCERTAIN when exact value read-back is unavailable despite a passing postcondition", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = { identity: "task-input", targetId: "fixture-target", documentGeneration: 1, backendNodeId: 32, name: "Task", role: "textbox", tag: "textarea", visible: true, disabled: false };
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      return { targetId: "fixture-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Task submitted" }, candidates: [candidate], evidenceId: "ev-value-readback-unavailable" };
    },
    async fillField() { return { dispatched: true }; },
    async waitForChange() {}
  };
  const runner = new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
    operationAuthorizer: { async authorize() { return { allowed: true }; } }
  });
  const receipt = await runner.run({
    id: "workflow-value-readback-uncertain", name: "Value read-back uncertainty",
    steps: [{
      id: "fill", type: "interact", action: {
        type: "fill", operationId: "task-input", target: { identity: "task-input" },
        value: "requested task", verifyValue: true,
        postcondition: { type: "page_title_contains", value: "Task submitted" }
      }
    }]
  }, { runId: "run-value-readback-uncertain" });
  assert.equal(receipt.steps.find(step => step.stepId === "fill").status, STEP_STATUS.UNCERTAIN);
  assert.equal(receipt.status, RUN_STATUS.UNCERTAIN,
    "an application postcondition cannot substitute for unavailable exact value read-back");
});

test("bounded repeat stops at the first verified condition and records iteration checkpoints", async () => {
  let observations = 0;
  const session = { async observe() { observations++; return { page: { url: "http://fixture.local/", title: "Ready" }, candidates: [], evidenceId: `ev-${observations}` }; } };
  const receipt = await new TestRunner({ session }).run({
    id: "workflow-repeat", name: "Bounded repeat",
    steps: [{
      id: "poll",
      type: "repeat",
      maxIterations: 4,
      until: { type: "page_title_contains", value: "Ready" },
      body: [{ id: "checkpoint", type: "set_variable", name: "iteration", value: 1 }]
    }]
  }, { runId: "run-repeat" });
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.deepEqual(receipt.steps.map(step => step.stepId), ["poll/iteration-1/checkpoint", "poll"]);
  assert.ok(receipt.steps.some(step => step.status === STEP_STATUS.PASS));
});

test("trusted reusable subworkflows receive explicit inputs and return allowlisted variables", async t => {
  const runState = await createRunStateFixture();
  t.after(() => runState.cleanup());
  const candidate = { identity: "task-input", targetId: "fixture-target", documentGeneration: 1, backendNodeId: 32, name: "Task", role: "textbox", tag: "textarea", visible: true, disabled: false };
  let enteredValue = null;
  const session = {
    target: { id: "fixture-target", url: "http://fixture.local/" },
    attached: true,
    async observe() { return { targetId: "fixture-target", documentGeneration: 1, page: { url: "http://fixture.local/", title: "Composer" }, candidates: [candidate], evidenceId: "ev-subworkflow" }; },
    async fillField(_candidate, value) { enteredValue = value; },
    async verifyControlValue(_candidate, value) { return { verified: true, matches: enteredValue === value }; }
  };
  const child = {
    id: "registered-copy", name: "Registered child workflow", inputNames: ["taskText"],
    steps: [{ id: "copy", type: "set_variable", name: "outputText", value: { variable: "taskText" } }]
  };
  const runner = new TestRunner({
    session,
    runStateStore: runState.store,
    environment: { environmentId: "fixture-local", authorizedOrigins: ["http://fixture.local"] },
    workflowRegistry: new Map([[child.id, child]]),
    operationAuthorizer: { async authorize() { return { allowed: true }; } }
  });
  const receipt = await runner.run({
    id: "workflow-parent", name: "Parent workflow", inputs: { suppliedText: "scoped child input" },
    steps: [
      { id: "child-call", type: "subworkflow", workflowRef: child.id, inputs: { taskText: { variable: "suppliedText" } }, outputs: { outputText: "resultText" } },
      { id: "use-child-output", type: "interact", action: { type: "fill", operationId: "task-input", target: { identity: "task-input" }, value: { variable: "resultText" }, verifyValue: true } }
    ]
  }, { runId: "run-subworkflow" });
  assert.equal(receipt.status, RUN_STATUS.PASSED);
  assert.equal(enteredValue, "scoped child input");
  assert.ok(receipt.steps.some(step => step.stepId === "child-call/copy" && step.status === STEP_STATUS.PASS));
});

test("runner validates workflow before executing", async () => {
  const runner = new TestRunner({ session: null });
  await assert.rejects(() => runner.run({ id: "bad" }), /Invalid workflow/);
});

test("API-call snapshots preserve refusal, error, and uncertainty instead of producing false PASS", async () => {
  for (const [result, expectedStatus, expectedEffect] of [
    [{ status: "ok", result: { status: "refused" } }, STEP_STATUS.BLOCKED, "refused"],
    [{ status: "unavailable", result: { status: "ok" } }, STEP_STATUS.UNCERTAIN, "unavailable"],
    [{ status: "error" }, STEP_STATUS.FAIL, "error"],
    [{ status: "unavailable" }, STEP_STATUS.UNCERTAIN, "unavailable"],
    [{ status: "available" }, STEP_STATUS.PASS, "available"]
  ]) {
    const collector = {
      runId: "api-result-fixture",
      hasSource: sourceId => sourceId === "fixture-source",
      async collect(sourceId, operation, options) {
        assert.equal(sourceId, "fixture-source");
        assert.equal(operation, "read");
        assert.equal(options.operationId, "read_fixture_state");
        return { snapshotId: "fixture-snapshot", sourceId, data: result };
      }
    };
    const receipt = await new TestRunner({ collector }).run({
      id: "api-result-workflow",
      name: "Classify API result",
      steps: [{ id: "read", type: "api_call", operation: { operationId: "read_fixture_state", sourceId: "fixture-source" } }]
    }, { runId: `api-result-${expectedEffect}` });
    assert.equal(receipt.steps[0].status, expectedStatus);
    assert.equal(receipt.steps[0].details.dispatchStatus, "dispatched");
    assert.equal(receipt.steps[0].details.effectStatus, expectedEffect);
    assert.equal(receipt.steps[0].details.verificationStatus, "not_verified");
  }
});
