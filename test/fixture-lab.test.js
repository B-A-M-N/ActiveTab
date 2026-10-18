import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFiAgentTwinProvider } from "../test-lab/fixtures/fi-agent-twin/provider.js";
import { runBenchmarkEpisode } from "../test-lab/runtime/benchmarkRunner.js";
import { deriveUiVariant } from "../test-lab/runtime/variantEngine.js";
import { validateScenario } from "../test-lab/runtime/scenario.js";

const baseScenario = JSON.parse(await readFile(new URL("../test-lab/catalog/scenarios/fi-task-recovery-004.json", import.meta.url), "utf8"));

function responseCookie(response, name) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, `${name} cookie was issued`);
  const pair = header.split(";")[0];
  assert.equal(pair.slice(0, pair.indexOf("=")), name);
  return pair;
}

async function authenticateFixture(targetBinding) {
  const platformOrigin = targetBinding.applicationOrigins[0];
  const agentOrigin = targetBinding.applicationOrigins[1];
  const platformLogin = await fetch(`${platformOrigin}/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "lab-user", password: "lab-password" })
  });
  assert.equal(platformLogin.status, 303);
  const platformCookie = responseCookie(platformLogin, "platform_session");
  const dashboard = await fetch(platformOrigin, { headers: { cookie: platformCookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Agents/u);

  const crossRealmWithoutLogin = await fetch(`${agentOrigin}/app`);
  assert.equal(crossRealmWithoutLogin.status, 200);
  assert.match(await crossRealmWithoutLogin.text(), /Cloud Agent Sign In/u);

  const agentLogin = await fetch(`${agentOrigin}/auth/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "lab-user", password: "lab-password" })
  });
  assert.equal(agentLogin.status, 303);
  const agentCookie = responseCookie(agentLogin, "agent_session");
  const app = await fetch(`${agentOrigin}/app`, { headers: { cookie: agentCookie } });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /New agent task|role="combobox"/u);
  return { platformCookie, agentCookie, agentOrigin };
}

async function createRun({ agentOrigin, agentCookie, task, operationKey = "fixture-run-once-0001" }) {
  const response = await fetch(`${agentOrigin}/api/runs`, {
    method: "POST",
    headers: { cookie: agentCookie, "content-type": "application/json", "idempotency-key": operationKey },
    body: JSON.stringify({ modelRef: task.modelRef, promptRef: task.promptRef, prompt: task.prompt })
  });
  return { response, body: response.ok ? await response.json() : null };
}

async function waitForTerminalStatus({ agentOrigin, agentCookie, runId }) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await fetch(`${agentOrigin}/api/runs/${encodeURIComponent(runId)}`, { headers: { cookie: agentCookie } });
    if (response.ok) {
      const run = await response.json();
      if (["succeeded", "failed"].includes(run.status)) return run;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Twin task did not reach a terminal state before the test deadline.");
}

test("fixture catalog validates and derives reproducible semantic UI variants", () => {
  assert.deepEqual(validateScenario(baseScenario), { valid: true, errors: [] });
  assert.deepEqual(deriveUiVariant(baseScenario), deriveUiVariant(baseScenario));
  const changed = structuredClone(baseScenario);
  changed.seed++;
  assert.equal(deriveUiVariant(changed).seed, changed.seed);
  const invalid = structuredClone(baseScenario);
  invalid.application.variants.modelSelector = "unknown_widget";
  assert.throws(() => deriveUiVariant(invalid), /Unsupported modelSelector/u);
});

test("FI Agent Twin separates auth realms, persists asynchronous runs, and keeps the oracle out of the driver binding", async t => {
  const scenario = structuredClone(baseScenario);
  scenario.faults = [];
  const provider = createFiAgentTwinProvider();
  t.after(() => provider.dispose());
  await provider.provision({ episodeId: "ep-twin-test", scenario });
  await provider.seed({ episodeId: "ep-twin-test", scenario });
  const binding = provider.getTargetBinding();
  assert.notEqual(new URL(binding.applicationOrigins[0]).origin, new URL(binding.applicationOrigins[1]).origin);
  assert.equal(Object.hasOwn(binding, "oracle"), false);
  assert.equal(Object.hasOwn(binding, "oracleToken"), false);

  const { agentCookie, agentOrigin } = await authenticateFixture(binding);
  const { response, body } = await createRun({ agentOrigin, agentCookie, task: {
    modelRef: scenario.task.model_ref,
    promptRef: scenario.task.prompt_ref,
    prompt: scenario.task.prompt
  } });
  assert.equal(response.status, 201);
  assert.equal(body.status, "queued");
  const completed = await waitForTerminalStatus({ agentOrigin, agentCookie, runId: body.runId });
  assert.equal(completed.status, "succeeded");

  for (const source of ["status", "steps", "usage", "errors"]) {
    const diagnostic = await fetch(`${agentOrigin}/diagnostics/runs/${encodeURIComponent(body.runId)}/${source}`, { headers: { cookie: agentCookie } });
    assert.equal(diagnostic.status, 200, `${source} diagnostic is run scoped`);
    assert.equal((await diagnostic.json()).runId, body.runId);
  }
  const forbiddenSettingsWrite = await fetch(`${agentOrigin}/api/admin/settings`, {
    method: "PATCH",
    headers: { cookie: agentCookie, "content-type": "application/json" },
    body: JSON.stringify({ signupEnabled: false })
  });
  assert.equal(forbiddenSettingsWrite.status, 403);
  const oracle = await provider.verifyOutcome({ episodeId: "ep-twin-test", scenario });
  assert.equal(oracle.runs.length, 1);
  assert.equal(oracle.runs[0].runId, body.runId);
  assert.equal(oracle.runs[0].promptMatches, true);
  assert.equal(oracle.unauthorizedMutationAttempts, 1);
});

test("persisted submit survives a lost acknowledgement and idempotency prevents duplicate jobs", async t => {
  const scenario = structuredClone(baseScenario);
  const provider = createFiAgentTwinProvider();
  t.after(() => provider.dispose());
  await provider.provision({ episodeId: "ep-drop-ack", scenario });
  await provider.seed({ episodeId: "ep-drop-ack", scenario });
  const { agentCookie, agentOrigin } = await authenticateFixture(provider.getTargetBinding());
  const headers = { cookie: agentCookie, "content-type": "application/json", "idempotency-key": "stable-operation-key-001" };
  const body = JSON.stringify({ modelRef: scenario.task.model_ref, promptRef: scenario.task.prompt_ref, prompt: scenario.task.prompt });
  await assert.rejects(() => fetch(`${agentOrigin}/api/runs`, { method: "POST", headers, body }));

  const duplicate = await fetch(`${agentOrigin}/api/runs`, { method: "POST", headers, body });
  assert.equal(duplicate.status, 200);
  const duplicateResult = await duplicate.json();
  assert.equal(duplicateResult.duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  const status = await fetch(`${agentOrigin}/api/runs/${encodeURIComponent(duplicateResult.runId)}`, { headers: { cookie: agentCookie } });
  assert.equal(status.status, 503, "the scheduled status outage is independently visible");
  const afterOutage = await fetch(`${agentOrigin}/api/runs/${encodeURIComponent(duplicateResult.runId)}`, { headers: { cookie: agentCookie } });
  assert.equal(afterOutage.status, 200);
  assert.equal((await afterOutage.json()).status, "running", "the simulated status view can lag backend truth");
  const completed = await waitForTerminalStatus({ agentOrigin, agentCookie, runId: duplicateResult.runId });
  assert.equal(completed.status, "succeeded");

  const oracle = await provider.verifyOutcome({ episodeId: "ep-drop-ack", scenario });
  assert.equal(oracle.runs.length, 1);
  assert.equal(oracle.runs[0].runId, duplicateResult.runId);
});

test("benchmark runner awards PASS only for exact independent run correlation and verified cleanup", async () => {
  const scenario = structuredClone(baseScenario);
  scenario.faults = [];
  let driverKeys;
  const report = await runBenchmarkEpisode({
    provider: createFiAgentTwinProvider(),
    scenario,
    driver: async driverContext => {
      driverKeys = Object.keys(driverContext).filter(key => key !== "signal").sort();
      const { targetBinding, task } = driverContext;
      const { agentCookie, agentOrigin } = await authenticateFixture(targetBinding);
      const { response, body } = await createRun({ agentOrigin, agentCookie, task });
      assert.equal(response.status, 201);
      await waitForTerminalStatus({ agentOrigin, agentCookie, runId: body.runId });
      return { status: "succeeded", reportedRunId: body.runId };
    }
  });
  assert.deepEqual(driverKeys, ["automationRunId", "episodeId", "targetBinding", "task"].sort());
  assert.equal(report.score.status, "PASS");
  assert.equal(report.score.exactRunCorrelation, true);
  assert.equal(report.cleanupStatus, "verified");
  assert.equal(JSON.stringify(report).includes(scenario.task.prompt), false, "reports exclude raw task prompts");
});

test("benchmark runner records false success when the independent oracle finds no exact run", async () => {
  const scenario = structuredClone(baseScenario);
  scenario.faults = [];
  const report = await runBenchmarkEpisode({
    provider: createFiAgentTwinProvider(),
    scenario,
    driver: async () => ({ status: "succeeded", reportedRunId: "run-from-ui-claim-only" })
  });
  assert.equal(report.score.status, "FAIL");
  assert.equal(report.score.falseSuccess, true);
  assert.equal(report.score.exactRunCorrelation, false);
});
