import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEnvironmentBinding } from "../src/environments/model.js";
import { createQualificationToolHandlers } from "../src/mcp/tools/qualificationTools.js";

const profile = JSON.parse(readFileSync(resolve("profiles/cloud-agent-staging.json"), "utf8"));
const environment = buildEnvironmentBinding(profile);

function createHandlers({ sessions = new Map(), testRuns = new Map(), loadEnvironmentProfile = async () => null, workflowToolRuntime = { startWorkflowRun() { throw new Error("workflow start was unexpected"); } } } = {}) {
  return createQualificationToolHandlers({
    sessions,
    testRuns,
    workflowToolRuntime,
    loadEnvironmentProfile,
    decisionRuntime: {},
    runStateStore: {},
    verifyObservedUrl: (binding, url) => ({ ok: binding.authorizedOrigins.includes(new URL(url).origin) })
  });
}

test("Cloud Agent entry requires an explicitly selected attached session", async () => {
  let profileLoadCount = 0;
  const handlers = createHandlers({
    loadEnvironmentProfile: async () => { profileLoadCount++; return { profile, environment }; }
  });

  await assert.rejects(handlers.enter_cloud_agent({ targetId: "missing" }), /No explicitly authorized tab/);
  assert.equal(profileLoadCount, 0);
});

test("Cloud Agent entry checks the staging environment before observing the attached tab", async () => {
  let observeCount = 0;
  const session = { target: { id: "tab-1" }, observe: async () => { observeCount++; return null; } };
  const handlers = createHandlers({
    sessions: new Map([["tab-1", session]]),
    loadEnvironmentProfile: async () => ({ profile, environment: { ...environment, environmentId: "other-environment" } })
  });

  await assert.rejects(handlers.enter_cloud_agent({ targetId: "tab-1" }), /limited to the FreeInference staging environment/);
  assert.equal(observeCount, 0);
});

test("Cloud Agent entry recognizes the observed composer without starting a task", async () => {
  const observation = {
    evidenceId: "composer-evidence-1",
    targetId: "tab-1",
    page: { url: "https://agents-staging.freeinference.org/tasks", title: "Cloud Agent" },
    candidates: [
      { name: "New Task", role: "button", visible: true },
      { name: "Task prompt", role: "textbox", visible: true, disabled: false }
    ]
  };
  const session = { target: { id: "tab-1" }, observe: async () => observation };
  let startCount = 0;
  const handlers = createHandlers({
    sessions: new Map([["tab-1", session]]),
    loadEnvironmentProfile: async () => ({ profile, environment }),
    workflowToolRuntime: { startWorkflowRun() { startCount++; return { status: "started", runId: "unexpected" }; } }
  });

  assert.deepEqual(await handlers.enter_cloud_agent({ targetId: "tab-1" }), {
    status: "ready",
    targetId: "tab-1",
    environmentId: "freeinference-staging",
    applicationId: "fi-agents",
    evidenceId: "composer-evidence-1",
    taskSubmitted: false
  });
  assert.equal(startCount, 0);
});

test("Cloud Agent evidence collection waits for the ActiveTab workflow to settle", async () => {
  const run = {
    integration: { adapterId: "freeinference-cloud-agent" },
    runState: { settled: false, receipt: null }
  };
  const handlers = createHandlers({ testRuns: new Map([["run-1", run]]) });

  await assert.rejects(handlers.collect_cloud_agent_run_evidence({ runId: "run-1" }), /Wait for the ActiveTab Cloud Agent workflow to finish/);
});
