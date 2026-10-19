import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { buildEpisode } from "../src/telemetry/episodeBuilder.js";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { QualificationService } from "../src/testing/qualificationService.js";
import { createQualificationRuntime } from "../src/testing/qualificationRuntime.js";
import { TestRunner } from "../src/testing/runner.js";

const gmailScenario = JSON.parse(await readFile(new URL("../test-lab/catalog/scenarios/webarena-infinity-gmail-task-001.json", import.meta.url), "utf8"));
const gmailExtractionScenario = JSON.parse(await readFile(new URL("../test-lab/catalog/scenarios/webarena-infinity-gmail-extract-001.json", import.meta.url), "utf8"));
const fiScenario = JSON.parse(await readFile(new URL("../test-lab/catalog/scenarios/fi-task-recovery-004.json", import.meta.url), "utf8"));
const chromeCandidates = [process.env.CHROME_PATH, process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .filter((path, index, paths) => typeof path === "string" && path && paths.indexOf(path) === index);
const extractionChromeAvailable = chromeCandidates.some(path => {
  try { accessSync(path, fsConstants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
});

function headedDisplayProblem() {
  if (process.env.ACTIVETAB_HEADLESS === "1" || process.platform !== "linux") return null;
  const display = process.env.DISPLAY;
  if (!display) return "headed Chrome requires a reachable DISPLAY; run with npm run test:headed -- --xvfb, enter a graphical session, or explicitly set ACTIVETAB_HEADLESS=1";
  const probe = spawnSync("xdpyinfo", ["-display", display], { stdio: "ignore", timeout: 1500 });
  if (probe.error?.code === "ENOENT") return "headed Chrome requires xdpyinfo and a reachable DISPLAY; use npm run test:headed -- --xvfb or explicitly set ACTIVETAB_HEADLESS=1";
  if (probe.status !== 0) return `headed Chrome cannot reach DISPLAY=${display}; use npm run test:headed -- --xvfb or explicitly set ACTIVETAB_HEADLESS=1`;
  return null;
}

const extractionBrowserPrerequisite = !extractionChromeAvailable
  ? "skipped: an executable Chrome/Chromium binary is required; configure CHROME_PATH or CHROME_BIN"
  : headedDisplayProblem();

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function makeProvider() {
  return {
    async provision() {},
    async seed() {},
    getTargetBinding() {
      return { entryUrl: "http://127.0.0.1:8000", environment: { authorizedOrigins: ["http://127.0.0.1:8000"] } };
    },
    async injectFault() {},
    async verifyOutcome() { return { verified: true, evidenceRefs: ["oracle_exact"] }; },
    async reset() {},
    async dispose() { return { status: "verified" }; },
    async scoreOutcome({ driverResult, cleanupVerified }) {
      const passed = driverResult.status === "succeeded" && cleanupVerified;
      return { status: passed ? "PASS" : "FAIL", evidenceRefs: ["oracle_exact"] };
    }
  };
}

function createRuntime() {
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const decisionRuntime = createDecisionRuntime({
    eventStore,
    jevClient: { async decide() { throw new Error("No reviewer request is expected."); } },
    semanticAnalyzer: null
  });
  return { eventStore, decisionRuntime };
}

test("qualification lifecycle links independently scored runs to the parent episode without training data leakage", async () => {
  const { eventStore, decisionRuntime } = createRuntime();
  try {
    const parent = decisionRuntime.startEpisode({ runId: "run_parent_qualification", workflowId: "workflow_parent", applicationId: "external_mail", environmentClass: "local" });
    const source = eventStore.append({
      episodeId: parent.episodeId, runId: parent.runId, stepId: "resolve_target", eventType: "intent.proposed",
      payload: { operation: "mark_read", operationClass: "test_owned_mutation", targetRole: "message_row", expectedOutcomeClass: "message_read" }
    });
    const service = new QualificationService({
      decisionRuntime,
      scenarioCatalog: [gmailScenario],
      providers: { webarena_infinity_gmail: () => makeProvider() },
      drivers: { webarena_infinity_gmail: async () => ({ status: "succeeded" }) }
    });
    const result = await service.qualify({
      runId: parent.runId, episodeId: parent.episodeId, stepId: "qualify_strategy",
      scenarioId: gmailScenario.scenario_id, providerId: "webarena_infinity_gmail",
      trigger: "ambiguous_target", principalId: "local_operator",
      strategyFingerprint: "a".repeat(64), sourceEventIds: [source.eventId], evidenceRefs: ["obs_message_list"]
    });
    assert.equal(result.status, "qualified");
    assert.equal(result.report.score.status, "PASS");
    assert.deepEqual(result.qualification, {
      level: "outcome",
      providerId: "webarena_infinity_gmail",
      providerIdentity: "webarena_infinity_gmail_state_oracle_v1",
      scenarioSeed: gmailScenario.seed,
      sourceRevision: gmailScenario.qualification.source_revision,
      oracleReference: gmailScenario.qualification.oracle_reference,
      independentApplicationOutcome: true,
      cleanupResult: { status: "verified" }
    });

    const events = eventStore.getEvents(parent.episodeId);
    const started = events.find(event => event.eventType === "qualification.started");
    const completed = events.find(event => event.eventType === "qualification.completed");
    assert.ok(started && completed);
    assert.equal(started.decisionId, completed.decisionId);
    assert.equal(completed.parentEventId, started.eventId);
    assert.equal(started.payload.sourceEventIds[0], source.eventId);
    assert.equal(started.trainingEligibility, "pending");
    assert.equal(completed.trainingEligibility, "pending");
    assert.equal(completed.payload.qualificationLevel, "outcome");
    assert.equal(completed.payload.providerIdentity, "webarena_infinity_gmail_state_oracle_v1");
    assert.equal(completed.payload.scenarioSeed, gmailScenario.seed);
    assert.equal(completed.payload.sourceRevision, gmailScenario.qualification.source_revision);
    assert.equal(completed.payload.oracleReference, gmailScenario.qualification.oracle_reference);
    assert.equal(completed.payload.independentApplicationOutcome, true);
    assert.deepEqual(completed.payload.cleanupResult, { status: "verified" });
    assert.equal(JSON.stringify(events).includes(gmailScenario.task.goal), false);
    assert.equal(eventStore.verifyEpisodeChain(parent.episodeId).ok, true);

    const reconstructed = buildEpisode(eventStore, parent.episodeId);
    assert.equal(reconstructed.qualifications[0].knowledgeState, "candidate");
    assert.equal(reconstructed.qualifications[0].qualification.level, "outcome");
    assert.deepEqual(reconstructed.qualifications[0].qualification.cleanupResult, { status: "verified" });
    assert.equal(reconstructed.qualifications[0].trainingEligibility, "pending");
    const candidates = eventStore.listQualificationCandidates({
      applicationId: "external_mail", environmentClass: "local", principalId: "local_operator",
      providerId: "webarena_infinity_gmail"
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].state, "candidate");
    assert.equal(candidates[0].strategyFingerprint, "a".repeat(64));
    assert.equal(candidates[0].trainingEligibility, "pending");
    assert.deepEqual(eventStore.listQualificationCandidates({
      applicationId: "external_mail", environmentClass: "local", principalId: "different_operator",
      providerId: "webarena_infinity_gmail"
    }), []);
  } finally { decisionRuntime.close(); }
});

test("an unavailable optional qualification records PASS and does not stop the workflow", async () => {
  const { decisionRuntime } = createRuntime();
  try {
    const receipt = await new TestRunner({ decisionRuntime }).run({
      id: "workflow_optional_qualification", name: "Optional qualification",
      steps: [
        { id: "qualify_optional", type: "qualify", scenarioId: "scenario_missing", providerId: "provider_missing", trigger: "ui_drift" },
        { id: "qualify_again", type: "qualify", scenarioId: "scenario_missing", providerId: "provider_missing", trigger: "observed_failure" }
      ]
    }, { runId: "run_optional_qualification" });
    assert.equal(receipt.status, "PASSED");
    assert.deepEqual(receipt.steps.map(step => step.status), ["PASS", "PASS"]);
    assert.equal(receipt.steps[0].details.qualificationStatus, "unavailable");
  } finally { decisionRuntime.close(); }
});

test("a caller-required qualification fails its step when unavailable", async () => {
  const { decisionRuntime } = createRuntime();
  try {
    const receipt = await new TestRunner({ decisionRuntime }).run({
      id: "workflow_required_qualification", name: "Required qualification",
      steps: [{ id: "qualify_required", type: "qualify", scenarioId: "scenario_missing", providerId: "provider_missing", trigger: "workflow_reuse", required: true }]
    }, { runId: "run_required_qualification" });
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.steps[0].status, "FAIL");
  } finally { decisionRuntime.close(); }
});

test("qualification runtime forwards the explicit headless opt-in to its default native CDP driver", async () => {
  const previous = process.env.ACTIVETAB_HEADLESS;
  process.env.ACTIVETAB_HEADLESS = "1";
  const { decisionRuntime } = createRuntime();
  try {
    const parent = decisionRuntime.startEpisode({ runId: "run_headless_qualification", workflowId: "workflow_headless", applicationId: "fi_agent_twin", environmentClass: "local" });
    let launchOptions = null;
    const service = createQualificationRuntime({
      decisionRuntime,
      scenarios: [fiScenario],
      providers: { fi_agent_twin: () => makeProvider() },
      launchBrowser: async options => {
        launchOptions = options;
        throw new Error("stop after verifying launch mode");
      }
    });
    await service.qualify({
      runId: parent.runId,
      episodeId: parent.episodeId,
      stepId: "qualify_headless",
      scenarioId: fiScenario.scenario_id,
      providerId: "fi_agent_twin",
      trigger: "ambiguous_target",
      principalId: "local_operator",
      strategyFingerprint: "b".repeat(64)
    });
    assert.equal(launchOptions?.headed, false);
    assert.equal(launchOptions?.keepBrowserOpen, false);
  } finally {
    if (previous === undefined) delete process.env.ACTIVETAB_HEADLESS;
    else process.env.ACTIVETAB_HEADLESS = previous;
    decisionRuntime.close();
  }
});

test("WebArena extraction driver distinguishes browser launch from discovery failures", async t => {
  const { createWebArenaInfinityGmailExtractionDriver } = await import("../test-lab/adapters/webarenaInfinityGmailDriver.js");
  const targetBinding = {
    entryUrl: "http://127.0.0.1:8000",
    environment: { environmentId: "fixture", authorizedOrigins: ["http://127.0.0.1:8000"] }
  };
  const task = { operation: "extract_inbox_records" };

  const launchFailure = await createWebArenaInfinityGmailExtractionDriver({
    headed: false,
    launchBrowser: async () => { throw new Error("launch failed"); }
  })({ automationRunId: "launch_failure", targetBinding, task });
  assert.equal(launchFailure.reasonCode, "browser_launch_failed");

  let closed = false;
  const discoveryFailure = await createWebArenaInfinityGmailExtractionDriver({
    headed: false,
    launchBrowser: async () => ({
      session: { attached: true, target: { id: "target_fixture", endpoint: "fixture" }, async observe() { throw new Error("observation failed"); } },
      async close() { closed = true; }
    })
  })({ automationRunId: "discovery_failure", targetBinding, task });
  assert.equal(discoveryFailure.reasonCode, "extraction_discovery_failed");
  assert.equal(closed, true);
});

async function startGmailStateServer({ initialIsRead = false, resetIsRead = initialIsRead, initialState = null, resetStateOverride = null } = {}) {
  const oracleToken = "unit-test-webarena-oracle-token-do-not-use-outside-tests";
  const original = initialState ?? {
    emails: [{ subject: gmailScenario.task.subject, from: { name: gmailScenario.task.sender }, isRead: initialIsRead }]
  };
  let state = structuredClone(original);
  let resetState = resetStateOverride ?? structuredClone(original);
  if (!resetStateOverride) resetState.emails[0].isRead = resetIsRead;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/") {
      response.setHeader("content-type", "text/html");
      const rows = (state.emails ?? []).map(email => `
        <div class="mail-item">
          <span class="email-sender">${escapeHtml(email.from?.name ?? "")}</span>
          <span class="email-subject-text">${escapeHtml(email.subject ?? "")}</span>
        </div>`).join("");
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Gmail</title>
        <style>body{font:16px sans-serif;margin:24px}.mail-list{width:720px}.mail-item{display:flex;gap:24px;min-height:40px;align-items:center}.email-sender{width:220px}</style>
        </head><body><main><div class="mail-list">${rows}</div></main></body></html>`);
    } else if ((request.method === "GET" && request.url === "/api/state") || (request.method === "POST" && ["/api/reset", "/api/oracle/seed"].includes(request.url))) {
      if (request.headers["x-activetab-fixture-oracle"] !== oracleToken) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "oracle authorization required" }));
        return;
      }
      if (request.method === "GET") {
        response.end(JSON.stringify(state));
      } else {
        if (request.url === "/api/oracle/seed") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          state = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!resetStateOverride) resetState = structuredClone(state);
          response.end(JSON.stringify({ status: "ok", seed_created: true }));
        } else {
          state = structuredClone(resetState);
          response.end(JSON.stringify({ status: "ok", seed_restored: true }));
        }
      }
    } else if (request.method === "PUT" && request.url === "/api/state") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.end(JSON.stringify({ status: "ok" }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    oracleToken,
    getState: () => structuredClone(state),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test("WebArena-Infinity adapter is loopback-bound, scores browser claims against target state, and resets cleanup", async t => {
  const { WebArenaInfinityGmailProvider } = await import("../test-lab/adapters/webarenaInfinityGmailProvider.js");
  const server = await startGmailStateServer();
  t.after(() => server.close());
  const provider = new WebArenaInfinityGmailProvider({ origin: server.origin, oracleToken: server.oracleToken });
  const report = await (await import("../test-lab/runtime/benchmarkRunner.js")).runBenchmarkEpisode({
    provider,
    scenario: gmailScenario,
    driver: async ({ targetBinding, task }) => {
      assert.equal(Object.hasOwn(targetBinding, "oracle"), false);
      assert.equal(Object.hasOwn(targetBinding, "oracleUrl"), false);
      assert.equal(Object.hasOwn(targetBinding, "oracleToken"), false);
      assert.equal(task.goal, gmailScenario.task.goal);
      const hiddenState = await fetch(`${targetBinding.entryUrl}/api/state`);
      assert.equal(hiddenState.status, 403, "the browser-facing origin does not expose the benchmark oracle");
      await fetch(`${targetBinding.entryUrl}/api/state`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ emails: [{ subject: gmailScenario.task.subject, from: { name: gmailScenario.task.sender }, isRead: true }] })
      });
      return { status: "succeeded" };
    }
  });
  assert.equal(report.score.status, "PASS");
  assert.equal(report.cleanupStatus, "verified");
  assert.equal(server.getState().emails[0].isRead, false);
});

test("WebArena-Infinity extraction driver uses native CDP and scores typed records against its isolated oracle", {
  ...(extractionBrowserPrerequisite ? { skip: extractionBrowserPrerequisite } : {}),
  timeout: 90_000
}, async t => {
  const { WebArenaInfinityGmailProvider } = await import("../test-lab/adapters/webarenaInfinityGmailProvider.js");
  const { createWebArenaInfinityGmailExtractionDriver } = await import("../test-lab/adapters/webarenaInfinityGmailDriver.js");
  const expectedState = {
    emails: gmailExtractionScenario.task.emails.map(email => ({
      subject: email.subject,
      from: { name: email.sender },
      isRead: true
    }))
  };
  const server = await startGmailStateServer({ initialState: expectedState });
  t.after(() => server.close());
  const provider = new WebArenaInfinityGmailProvider({ origin: server.origin, oracleToken: server.oracleToken });
  let scoringEvidence = null;
  const originalScoreOutcome = provider.scoreOutcome.bind(provider);
  provider.scoreOutcome = async input => {
    scoringEvidence = input;
    return await originalScoreOutcome(input);
  };
  const report = await (await import("../test-lab/runtime/benchmarkRunner.js")).runBenchmarkEpisode({
    provider,
    scenario: gmailExtractionScenario,
    driver: createWebArenaInfinityGmailExtractionDriver({ headed: process.env.ACTIVETAB_HEADLESS !== "1" })
  });
  assert.equal(report.score.status, "PASS");
  assert.equal(report.score.schemaValid, true);
  assert.equal(report.score.provenanceValid, true);
  assert.equal(report.cleanupStatus, "verified");
  assert.equal(server.getState().emails.length, 3);

  const baselineScoringEvidence = scoringEvidence;
  const changedSchema = structuredClone(baselineScoringEvidence.driverResult);
  changedSchema.schema.items.sender.type = "number";
  const schemaTampering = await provider.scoreOutcome({ ...baselineScoringEvidence, driverResult: changedSchema });
  assert.equal(schemaTampering.status, "FAIL");
  assert.equal(schemaTampering.falseSuccess, true);
  assert.equal(schemaTampering.reasonCode, "schema_mismatch");

  const changedProvenance = structuredClone(baselineScoringEvidence.driverResult);
  changedProvenance.fieldProvenance[0].fields.sender.observationId = "unlinked-observation";
  const provenanceTampering = await provider.scoreOutcome({ ...baselineScoringEvidence, driverResult: changedProvenance });
  assert.equal(provenanceTampering.status, "FAIL");
  assert.equal(provenanceTampering.falseSuccess, true);
  assert.equal(provenanceTampering.reasonCode, "extraction_provenance_mismatch", JSON.stringify(provenanceTampering));

  const mismatchedRecords = structuredClone(baselineScoringEvidence.driverResult);
  mismatchedRecords.records[0].subject = "A different record";
  const oracleMismatch = await provider.scoreOutcome({ ...baselineScoringEvidence, driverResult: mismatchedRecords });
  assert.equal(oracleMismatch.status, "FAIL");
  assert.equal(oracleMismatch.reasonCode, "oracle_mismatch");

  const incomplete = await (await import("../test-lab/runtime/benchmarkRunner.js")).runBenchmarkEpisode({
    provider: new WebArenaInfinityGmailProvider({ origin: server.origin, oracleToken: server.oracleToken }),
    scenario: gmailExtractionScenario,
    driver: async () => ({
      status: "succeeded",
      records: [{ sender: "Fixture Sender A", subject: "ActiveTab Fixture Alpha" }],
      completeness: "complete",
      verification: { recordCount: 1, duplicateKeys: 0, invalidRows: 0, overflow: false }
    })
  });
  assert.equal(incomplete.score.status, "FAIL");
  assert.equal(incomplete.score.falseSuccess, true);
  assert.equal(incomplete.cleanupStatus, "verified");
});

test("WebArena-Infinity adapter rejects non-loopback origins and refuses mismatched initial state", async t => {
  const { WebArenaInfinityGmailProvider } = await import("../test-lab/adapters/webarenaInfinityGmailProvider.js");
  assert.throws(() => new WebArenaInfinityGmailProvider({ origin: "http://localhost:8000" }), /loopback HTTP origin/u);
  const server = await startGmailStateServer({
    initialIsRead: false,
    resetStateOverride: {
      emails: [{ subject: gmailScenario.task.subject, from: { name: gmailScenario.task.sender }, isRead: true }]
    }
  });
  t.after(() => server.close());
  const report = await (await import("../test-lab/runtime/benchmarkRunner.js")).runBenchmarkEpisode({
    provider: new WebArenaInfinityGmailProvider({ origin: server.origin, oracleToken: server.oracleToken }),
    scenario: gmailScenario,
    driver: async () => { throw new Error("Driver must not run when the declared initial state is false."); }
  });
  assert.equal(report.driver.status, "failed");
  assert.equal(report.cleanupStatus, "unverified");
  assert.notEqual(report.score.status, "PASS");
});
