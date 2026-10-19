import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api/local-server.js";
import { ApplicationRunService } from "../src/navigation/applicationRunService.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";
import { RunStateStore } from "../src/testing/runState.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { RUN_STATUS } from "../src/testing/schema.js";

const environment = buildEnvironmentBinding({
  profile_id: "cross-transport-fixture",
  environment: {
    environment_id: "cross-transport-staging",
    platform: "fixture",
    application_entry_url: "https://staging.fixture.example/",
    authorized_origins: ["https://staging.fixture.example"],
    applications: [{ application_id: "fixture-app", authentication_realm: "fixture-realm", candidate_entry: "/app/" }]
  }
});

function createSession() {
  let authenticated = false;
  const target = {
    id: "cross-transport-target",
    endpoint: "fixture-cdp",
    url: "https://staging.fixture.example/app/login"
  };
  return {
    attached: true,
    target,
    async observe() {
      const page = authenticated
        ? { url: "https://staging.fixture.example/app/task/composer", title: "Task composer" }
        : { url: "https://staging.fixture.example/app/login", title: "Sign in to continue" };
      target.url = page.url;
      return {
        evidenceId: authenticated ? "cross-transport-authenticated" : "cross-transport-login",
        targetId: target.id,
        documentGeneration: authenticated ? 2 : 1,
        page,
        headings: [{ level: 1, text: page.title }],
        candidates: authenticated ? [
          { identity: "new-task", name: "New task", role: "link", tag: "a", visible: true, disabled: false },
          { identity: "task-prompt", name: "Describe the task", role: "textbox", tag: "textarea", visible: true, disabled: false }
        ] : [
          { identity: "sign-in", name: "Sign in", role: "button", tag: "button", visible: true, disabled: false },
          { identity: "password", name: "Password", role: "textbox", tag: "input", type: "password", visible: true, disabled: false }
        ],
        scrollTargets: [],
        frames: [],
        pageChangeFingerprint: authenticated ? "authenticated-page" : "login-page"
      };
    },
    async waitForChange() {},
    async close() {},
    client: { async send() { return {}; } },
    async hasAttachmentGrant(targetId) {
      return { ok: targetId === target.id };
    },
    async verifyAuthentication(realm) {
      return authenticated && realm === "fixture-realm"
        ? { authenticated: true, identity: "fixture-principal", evidenceId: "cross-transport-authenticated" }
        : { authenticated: false, reason: "Fixture session remains unauthenticated." };
    },
    async verifyEnvironment(url) {
      return { ok: url.startsWith("https://staging.fixture.example/") };
    },
    authenticate() { authenticated = true; }
  };
}

test("a suspended MCP-originated run resumes through HTTP from canonical durable state", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-cross-transport-"));
  const taskStoreDir = join(directory, "tasks");
  const runStateStore = new RunStateStore(join(directory, "runs"));
  const interventionStore = new InterventionStore(join(directory, "interventions"));
  const session = createSession();
  const runId = "mcp-origin-cross-transport-run";
  const workflow = {
    id: "cross-transport-auth-flow",
    name: "Cross transport authentication flow",
    steps: [
      {
        id: "enter-application",
        type: "goal",
        goal: "Open the task composer page",
        intervention: {
          type: "authentication",
          realm: "fixture-realm",
          requiredAction: "Complete the fixture sign-in.",
          condition: { type: "authenticated_session_check", realm: "fixture-realm" }
        }
      },
      { id: "verify-task-composer", type: "assert", assertion: { type: "candidate_name_contains", value: "new task" } }
    ]
  };
  let api;
  try {
    await runStateStore.init();
    await interventionStore.init();

    // MCP uses ApplicationRunService with this shared RunStateStore.
    const mcpStarted = new ApplicationRunService({ runStateStore }).startWorkflowRun({
      session,
      workflow,
      runId,
      runnerOptions: {
        interventions: interventionStore,
        environment,
        profileId: environment.profileId,
        principalId: "local_mcp_automation"
      }
    });
    const firstReceipt = await mcpStarted.runPromise;
    assert.equal(firstReceipt.status, RUN_STATUS.WAITING_FOR_AUTHENTICATION);
    assert.equal((await runStateStore.getFresh(runId)).status, "waiting_for_authentication");
    assert.equal(session.target.id, (await runStateStore.getFresh(runId)).target.targetId);

    // The HTTP process resolves the same owner-only stores and reattaches the
    // exact target after the fixture's independent authentication predicate is true.
    session.authenticate();
    api = createApiServer({
      port: 0,
      taskStoreDir,
      navigationRunner: { async run() { throw new Error("The compatibility task path must not run."); } },
      apiToken: "cross-transport-test-token",
      testSessionResolver: async ({ continuation }) => {
        assert.equal(continuation.runId, runId);
        assert.equal(continuation.targetId, session.target.id);
        return session;
      },
      testEnvironmentResolver: async () => environment,
      testProfileIdResolver: async () => environment.profileId,
      testPrincipalResolver: async () => "local_mcp_automation",
      runStateStore
    });
    const { url } = await api.start();
    const response = await fetch(`${url}/v1/test/runs/${runId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer cross-transport-test-token" },
      body: JSON.stringify({ workflow })
    });
    assert.equal(response.status, 202, await response.text());

    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await fetch(`${url}/v1/test/runs/${runId}/status`, {
        headers: { Authorization: "Bearer cross-transport-test-token" }
      });
      status = await polled.json();
      if (status.status !== "RUNNING") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.status, RUN_STATUS.PASSED, JSON.stringify(status));
    assert.deepEqual(status.steps.map(step => [step.stepId, step.status]), [
      ["enter-application", "PASS"],
      ["verify-task-composer", "PASS"]
    ]);
    assert.equal((await runStateStore.getFresh(runId)).status, "passed");
    assert.equal(session.target.id, "cross-transport-target", "cross-transport resume preserves exact target identity");
  } finally {
    await api?.stop();
    runStateStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
