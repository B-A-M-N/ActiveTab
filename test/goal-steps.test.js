/**
 * Goal-driven semantic steps + durable suspensions in the test runner
 * (P1-2, P0-3). Uses a scripted browser-session stub: no Chrome required.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRunner } from "../src/testing/runner.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { RUN_STATUS, isWaitingRunStatus, isTerminalRunStatus } from "../src/testing/schema.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";

const environment = buildEnvironmentBinding({
  profile_id: "cloud-agent-staging",
  environment: {
    environment_id: "freeinference-staging",
    platform: "freeinference",
    application_entry_url: "https://staging.freeinference.org",
    authorized_origins: ["https://staging.freeinference.org"],
    applications: [{ application_id: "fi-agents", authentication_realm: "agents-session", candidate_entry: "/agents/" }]
  }
});

/** Minimal scripted session: serves observations, asserts no mutations while suspended. */
function makeSession({ pages, onMutating }) {
  let index = 0;
  const session = {
    target: { id: "tab-1" },
    mutations: 0,
    async observe() {
      const page = pages[Math.min(index, pages.length - 1)];
      return {
        page,
        headings: page.title ? [{ text: page.title, level: 1 }] : [],
        candidates: page.candidates ?? [],
        evidenceId: `ev-${index}`,
        pageChangeFingerprint: `fp-${index}`,
        domMutationCount: index,
        lifecycleEventCount: index
      };
    },
    async waitForChange() { index = Math.min(index + 1, pages.length - 1); },
    async client() {},
    click: async () => { session.mutations++; if (onMutating) onMutating("click"); },
    async close() {}
  };
  session.client = { send: async () => { session.mutations++; if (onMutating) onMutating("navigate"); } };
  return session;
}

async function withInterventions(fn) {
  const dir = await mkdtemp(join(tmpdir(), "activetab-goal-"));
  const store = new InterventionStore(dir);
  await store.init();
  try { return await fn(store); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a goal step that hits authentication suspends durably at that step (no skip, no fail)", () =>
  withInterventions(async interventions => {
    const session = makeSession({
      pages: [
        { url: "https://staging.freeinference.org/login", title: "Sign in to continue", candidates: [{ name: "Sign in", role: "button" }, { name: "Password", type: "password", role: "textbox" }] }
      ]
    });
    const runner = new TestRunner({ session, interventions, environment });
    const receipt = await runner.run({
      id: "wf", name: "Enter Agents",
      steps: [
        { id: "s1", type: "goal", goal: "Find and open the Agents application", intervention: { type: "authentication", realm: "agents-session", requiredAction: "Sign in.", condition: { type: "authenticated_session_check", realm: "agents-session" } } },
        { id: "s2", type: "assert", assertion: { type: "page_title_contains", value: "agent" } }
      ]
    }, { runId: "run-auth" });

    assert.equal(receipt.status, RUN_STATUS.WAITING_FOR_AUTHENTICATION, `run suspends resumably, got ${receipt.status}`);
    assert.ok(isWaitingRunStatus(receipt.status));
    assert.ok(!isTerminalRunStatus(receipt.status));
    // The login page forced suspension before any downstream step ran.
    assert.equal(receipt.steps.length, 1, "downstream steps must not dispatch while suspended");
    assert.equal(receipt.steps[0].status, "SUSPENDED");
    assert.equal(session.mutations, 0, "no mutating browser actions during suspension");
    // Durable record with exact identity and predicate.
    const pending = interventions.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].runId, "run-auth");
    assert.equal(pending[0].stepId, "s1");
    assert.equal(pending[0].authenticationRealm, "agents-session");
    assert.equal(pending[0].completionCondition.type, "authenticated_session_check");
    assert.equal(receipt.interventions.length, 1);
    assert.equal(receipt.interventions[0].externalState, "waiting_for_authentication");
  }));

test("an unverified environment origin suspends with a human-decision intervention", () =>
  withInterventions(async interventions => {
    const session = makeSession({
      pages: [{ url: "https://unrelated.example.net/", title: "Something else", candidates: [] }]
    });
    const runner = new TestRunner({ session, interventions, environment });
    const receipt = await runner.run({
      id: "wf", name: "Wrong environment",
      steps: [{ id: "s1", type: "goal", goal: "Open Agents" }]
    }, { runId: "run-env" });
    assert.equal(receipt.status, RUN_STATUS.WAITING_FOR_HUMAN_DECISION);
    const pending = interventions.listPending();
    assert.equal(pending[0].type, "human_decision");
    assert.match(pending[0].reason, /not authorized/);
    assert.equal(session.mutations, 0);
  }));

test("goal workflow validation requires intervention declarations to name a verified predicate", async () => {
  const runner = new TestRunner({});
  await assert.rejects(() => runner.run({ id: "w", name: "n", steps: [{ id: "s", type: "goal" }] }), /goal is required/);
  await assert.rejects(() => runner.run({ id: "w", name: "n", steps: [{ id: "s", type: "goal", goal: "x", intervention: { type: "authentication" } }] }), /condition\.type/);
});
