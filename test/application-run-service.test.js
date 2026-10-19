import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationRunService } from "../src/navigation/applicationRunService.js";
import { createRunStateFixture } from "./runStateFixture.js";

function createSession(targetId = "shared-service-target") {
  const target = { id: targetId, endpoint: "fixture", url: "https://shop.example.test/" };
  return {
    target,
    attached: true,
    async observe() {
      return {
        evidenceId: "shared-service-observation",
        targetId,
        page: { url: target.url, title: "Shop" },
        headings: [{ level: 1, text: "Shop" }],
        candidates: [],
        scrollTargets: []
      };
    }
  };
}

function runOptions(session, journal, goal = "Open account") {
  return {
    session,
    goal,
    journal,
    workflowIntent: { purposeCode: "account", outcomeCode: "account_visible" },
    engineOptions: {
      executionMode: "standalone",
      plannerMode: "deterministic",
      planner: { async plan() { return { status: "unavailable", reason: "No safe action in this fixture." }; } }
    }
  };
}

test("ApplicationRunService uses its durable target lease for HTTP-style runs", async () => {
  const fixture = await createRunStateFixture("activetab-application-run-service-");
  const session = createSession();
  const journalStates = [];
  const journal = { async write(state) { journalStates.push(state.status); } };
  const service = new ApplicationRunService({ runStateStore: fixture.store });
  try {
    const result = await service.runNavigation({
      ...runOptions(session, journal),
      leaseOwner: "http-run-service-test"
    });
    assert.equal(result.status, "unresolved");
    assert.ok(journalStates.includes("running"));
    assert.ok(journalStates.includes("unresolved"));
  } finally {
    await fixture.cleanup();
  }
});

test("ApplicationRunService forwards exact caller input bindings to local planning", async () => {
  const fixture = await createRunStateFixture("activetab-application-run-inputs-");
  const session = createSession();
  let capturedBindings;
  const exactValue = "Foo.Bar+QA@example.com  ";
  const planner = {
    async plan(_goal, _observation, options) {
      capturedBindings = options.inputBindings;
      return { status: "ambiguous", reason: "Fixture stops before dispatch." };
    }
  };
  const service = new ApplicationRunService({ runStateStore: fixture.store });
  try {
    const result = await service.runNavigation({
      ...runOptions(session, { async write() {} }),
      inputBindings: { email: exactValue },
      workflowInputs: { email: exactValue },
      engineOptions: { planner, executionMode: "standalone" }
    });
    assert.equal(result.status, "unresolved");
    assert.equal(capturedBindings.email, exactValue);
  } finally {
    await fixture.cleanup();
  }
});

test("ApplicationRunService exposes the same leased executor to MCP preparation", async () => {
  const fixture = await createRunStateFixture("activetab-application-run-service-mcp-");
  const session = createSession("mcp-shared-service-target");
  const journal = { async write() {} };
  const service = new ApplicationRunService({ runStateStore: fixture.store });
  try {
    const result = await service.withTargetLease(session, "mcp-run-service-test", async ({ runNavigation }) => {
      const execution = runNavigation(runOptions(session, journal, "Find account"));
      assert.throws(
        () => runNavigation(runOptions(session, journal, "Find billing")),
        /one navigation task/
      );
      return await execution;
    });
    assert.equal(result.status, "unresolved");
  } finally {
    await fixture.cleanup();
  }
});

test("ApplicationRunService starts declarative runs with its shared runner and diagnostics", async () => {
  const fixture = await createRunStateFixture("activetab-application-workflow-service-");
  const session = createSession("workflow-service-target");
  const service = new ApplicationRunService({ runStateStore: fixture.store });
  try {
    const started = service.startWorkflowRun({
      session,
      runId: "shared-workflow-run",
      workflow: {
        id: "shared-workflow",
        name: "Shared workflow",
        steps: [{ id: "shop-visible", type: "assert", assertion: { type: "page_title_contains", value: "Shop" } }]
      },
      runnerOptions: { runStateStore: null }
    });
    assert.equal(started.runner.runStateStore, fixture.store, "the service owns the durable run-state binding");
    assert.equal(started.collector.runId, "shared-workflow-run");
    const receipt = await started.runPromise;
    assert.equal(receipt.status, "PASSED");
    assert.equal(receipt.steps[0].status, "PASS");
  } finally {
    await fixture.cleanup();
  }
});
