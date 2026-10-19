import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { RunStateStore } from "../src/testing/runState.js";
import { exportRedactedTrace, formatOperatorMarkdown, inspectDurableRun, inspectOperatorEnvironment } from "../src/diagnostics/operator.js";
import { indexMarkdownDocument } from "../src/observe/responseBodyInspector.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("operator doctor reports configuration presence without exposing credential values", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await inspectOperatorEnvironment({
    cwd: directory,
    profilesDir: join(projectRoot, "profiles"),
    fixtureScenarioDir: join(projectRoot, "test-lab", "catalog", "scenarios"),
    extensionDir: join(projectRoot, "extension"),
    profileId: "cloud-agent-staging",
    env: {
      ACTIVETAB_STATE_DIR: join(directory, "browser-state"),
      ACTIVETAB_RUN_STATE_DIR: join(directory, "runs"),
      ACTIVETAB_TELEMETRY_DB: join(directory, "telemetry.sqlite"),
      ACTIVETAB_REPORT_DIR: join(directory, "reports"),
      ACTIVETAB_CDP_ENDPOINT: "http://127.0.0.1:1",
      ACTIVETAB_MODEL_ENDPOINT: "https://model.example.test/v1",
      ACTIVETAB_MODEL: "fixture-model",
      ACTIVETAB_MODEL_API_KEY: "fixture-model-secret",
      ACTIVETAB_MODEL_IMAGE_INPUT: "1",
      ACTIVETAB_MODEL_ALLOW_SCREENSHOTS: "1",
      ACTIVETAB_JEV_KEY_FILE: "/private/jev-key-file",
      OPENROUTER_API_KEY: "fixture-secret",
      ACTIVETAB_SEMANTIC_API_KEY: "fixture-semantic-secret",
      ACTIVETAB_HEADLESS: "1"
    }
  });

  assert.equal(report.checks.find(check => check.id === "browser_mode").detail, "headless (explicit opt-in)");
  assert.equal(report.checks.find(check => check.id === "jev_reviewer").status, "configured");
  assert.equal(report.checks.find(check => check.id === "image_support").status, "configured");
  assert.equal(report.checks.find(check => check.id === "cdp_session").status, "not_attached");
  assert.equal(report.checks.find(check => check.id === "cdp_session").detail, "Doctor does not probe or attach to browser targets.");
  assert.equal(report.checks.find(check => check.id === "browser_permissions").liveGrantInspected, false);
  assert.equal(report.checks.find(check => check.id === "policy_bindings").profileId, "cloud-agent-staging");
  assert.ok(report.checks.find(check => check.id === "fixture_lab").scenarioCount > 0);
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(report).includes("fixture-semantic-secret"), false);
  assert.equal(JSON.stringify(report).includes("fixture-model-secret"), false);
  assert.equal(JSON.stringify(report).includes("/private/jev-key-file"), false);
});

test("operator doctor recognizes the shared semantic endpoint and FreeInference key for auto planning", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-doctor-auto-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await inspectOperatorEnvironment({
    cwd: directory,
    env: {
      ACTIVETAB_SEMANTIC_ENDPOINT: "https://freeinference.example.test/v1",
      ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT: "1",
      FREEINFERENCE_API_KEY: "fixture-freeinference-secret"
    }
  });
  const provider = report.checks.find(check => check.id === "model_provider");
  assert.equal(provider.status, "configured");
  assert.equal(provider.endpointConfigured, true);
  assert.equal(provider.modelConfigured, true);
  assert.equal(provider.pageContentConsent, true);
  assert.equal(provider.credentialConfigured, true);
  assert.equal(JSON.stringify(report).includes("fixture-freeinference-secret"), false);
});

test("operator doctor honors explicit screenshot capability for FreeInference GLM", async t => {
  const report = await inspectOperatorEnvironment({
    env: {
      ACTIVETAB_SEMANTIC_ENDPOINT: "https://freeinference.org/v1",
      ACTIVETAB_MODEL_IMAGE_INPUT: "1",
      ACTIVETAB_MODEL_ALLOW_SCREENSHOTS: "1"
    }
  });
  const check = report.checks.find(item => item.id === "image_support");
  assert.equal(check.status, "configured");
  assert.equal(check.providerImageInput, true);
  assert.equal(check.screenshotPrivacyOptIn, true);
  assert.match(check.recommendation, /provider pretest/u);
});

test("doctor honors an invalid explicitly selected Jev key file before environment fallback", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-doctor-jev-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "jev.txt");
  await writeFile(credentialFile, "not a recognized credential entry\n", { mode: 0o600 });
  await chmod(credentialFile, 0o600);
  const report = await inspectOperatorEnvironment({
    cwd: directory,
    env: { ACTIVETAB_JEV_KEY_FILE: credentialFile, OPENROUTER_API_KEY: "fixture-secret" }
  });
  assert.equal(report.checks.find(check => check.id === "jev_reviewer").status, "invalid");
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(report).includes(credentialFile), false);
});

test("inspect-run returns a safe progress projection without initializing missing state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-inspect-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runStateDir = join(directory, "runs");
  const telemetryDb = join(directory, "decision-events.sqlite");
  const eventStore = new DecisionEventStore({ databasePath: telemetryDb });
  const episode = eventStore.startEpisode({ runId: "run_fixture", workflowId: "workflow_fixture", applicationId: "fixture", environmentClass: "local" });
  const store = new RunStateStore(runStateDir);
  await store.init();
  await store.create({
    runId: "run_fixture",
    workflowId: "workflow_fixture",
    workflowName: "Fixture workflow",
    targetId: "target_fixture",
    environmentId: "environment_fixture",
    principalId: "principal_fixture",
    episodeId: episode.episodeId
  });
  await store.updateCheckpoint("run_fixture", {
    stepId: "step_fixture",
    type: "click",
    status: "PASS",
    evidenceIds: ["observation_fixture"]
  });
  await store.updateCheckpoint("run_fixture", { stepId: "step_failure", type: "verify", status: "FAIL", evidenceIds: ["observation_failure"] });
  await store.reserveOperation("run_fixture", {
    operationId: "operation_fixture",
    stepId: "step_failure",
    action: "click",
    effectDigest: createHash("sha256").update("operation_fixture").digest("hex"),
    environmentId: "environment_fixture",
    targetId: "target_fixture"
  });
  await store.recordOperationDispatch("run_fixture", { operationId: "operation_fixture", status: "UNCERTAIN", receiptId: "observation_dispatch" });
  await store.update("run_fixture", { rawGoal: "fixture-secret" });
  eventStore.append({
    episodeId: episode.episodeId, runId: "run_fixture", stepId: "step_failure", decisionId: "decision_jev",
    eventType: "decision.failed",
    payload: { provider: "openrouter", model: "typesafe/jev-1.14", rubricId: "intent_alignment", rubricVersion: "rubric_v1", questionType: "score", failureCode: "timeout" }
  });
  eventStore.append({
    episodeId: episode.episodeId, runId: "run_fixture", stepId: "step_failure", decisionId: "decision_policy",
    observationId: "observation_before", eventType: "policy.adjudicated",
    payload: { disposition: "deny", reasonCode: "authorization_denied", policyVersion: "policy_fixture" }
  });
  eventStore.append({
    episodeId: episode.episodeId, runId: "run_fixture", stepId: "step_failure", decisionId: "decision_dispatch",
    observationId: "observation_before", eventType: "execution.dispatched",
    payload: { operation: "click", targetRole: "button", dispatchStatus: "uncertain", operationId: "operation_fixture" }
  });
  eventStore.append({
    episodeId: episode.episodeId, runId: "run_fixture", stepId: "step_failure", decisionId: "decision_verify",
    observationId: "observation_after", eventType: "verification.completed",
    payload: { status: "uncertain", oracleType: "visible_postcondition", reasonCode: "reconciliation_required", evidenceRefs: ["observation_before", "observation_after"] }
  });
  store.close();
  eventStore.close();

  const report = await inspectDurableRun("run_fixture", { runStateDir, telemetryDb });
  assert.equal(report.status, "available");
  assert.equal(report.run.status, "created");
  assert.equal(report.run.progress.completedSteps[0].stepId, "step_fixture");
  assert.equal(report.run.progress.latestVerifiedEvidenceId, null);
  assert.equal(report.failedPhase.stepId, "step_failure");
  assert.equal(report.firstDivergence.eventType, "policy.adjudicated");
  assert.equal(report.firstDivergence.failureCode, "authorization_denied");
  assert.equal(report.firstDivergence.category, "authorization");
  assert.equal(report.firstDivergence.phase, "authorization");
  assert.equal(report.firstDivergence.automatedContinuationPermitted, false);
  assert.match(report.firstDivergence.safeNextAction, /Do not retry/u);
  assert.equal(report.failureClassification, "authorization");
  assert.equal(report.authorizationResult.disposition, "deny");
  assert.equal(report.dispatchResult.dispatchStatus, "uncertain");
  assert.equal(report.postcondition.reasonCode, "reconciliation_required");
  assert.equal(report.resumeSafety.status, "unsafe_pending_reconciliation");
  assert.ok(report.evidenceRefs.includes("observation_after"));
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);

  const markdown = formatOperatorMarkdown(report, "inspect-run");
  const markdownIndex = indexMarkdownDocument(markdown);
  assert.ok(markdownIndex.sections.some(section => section.id === "run-state"));
  assert.ok(markdownIndex.sections.some(section => section.id === "authorization-and-outcome"));
  assert.match(markdown, /\| Field \| Type \| Value \|/u, "nested diagnostics are decomposed into readable tables");
  assert.match(markdown, /safeNextAction/u, "causal remediation is available as a decomposable Markdown field");
  const focused = formatOperatorMarkdown(report, "inspect-run", { sectionId: "authorization-and-outcome" });
  assert.match(focused, /authorizationResult/u);
  assert.match(focused, /Complete section data/u);
  assert.doesNotMatch(focused, /## Model accounting/u, "section selection returns only the selected subtree");

  const missingDir = join(directory, "missing");
  const missing = await inspectDurableRun("run_missing", { runStateDir: missingDir });
  assert.equal(missing.status, "not_found");
});

test("export-trace verifies the hash chain, redacts sensitive payload fields, and reads without writing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-export-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "decision-events.sqlite");
  const store = new DecisionEventStore({ databasePath });
  const runId = "run_trace_fixture";
  const episode = store.startEpisode({ runId, workflowId: "workflow_fixture", applicationId: "fixture", environmentClass: "local" });
  store.append({
    episodeId: episode.episodeId,
    runId,
    stepId: "step_fixture",
    decisionId: "decision_fixture",
    observationId: "observation_fixture",
    eventType: "decision.predicted",
    payload: {
      provider: "fixture_provider",
      model: "fixture-model",
      rubricId: "fixture_rubric",
      rubricVersion: "v1",
      questionType: "choice",
      reviewDisposition: "supported",
      answer: {
        type: "choice",
        choice: "fixture-secret",
        probabilities: { "fixture-secret": 0.8, alternative: 0.2 },
        confidence: 0.8
      },
      inputFingerprint: createHash("sha256").update("fixture").digest("hex"),
      inputEventIds: [],
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, cost: 0.001 }
    }
  });
  store.append({
    episodeId: episode.episodeId,
    runId,
    stepId: "step_fixture",
    decisionId: "decision_workflow",
    eventType: "workflow.plan_synthesized",
    payload: {
      provider: "fixture_provider",
      model: "fixture-model",
      planVersion: 1,
      planHash: createHash("sha256").update("workflow plan").digest("hex"),
      inputFingerprint: createHash("sha256").update("workflow input").digest("hex"),
      stepCount: 1,
      planProjection: [{
        stepId: "step_fixture", capabilityId: "capability_fixture", effectClass: "read", targetRole: "product",
        verificationCode: "records_complete", requiresApproval: false, dependsOn: [], condition: null,
        purposeCodes: ["extract_records"], preconditionCodes: ["observed_page"], postconditionCodes: ["records_complete"]
      }],
      usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 0, cost: 0.002 }
    }
  });
  store.append({
    episodeId: episode.episodeId,
    runId,
    stepId: "step_fixture",
    decisionId: "qualification_fixture",
    eventType: "qualification.completed",
    payload: {
      qualificationId: "qualification_fixture",
      automationRunId: "automation_fixture",
      scenarioId: "scenario_fixture",
      providerId: "provider_fixture",
      trigger: "workflow_reuse",
      principalId: "principal_fixture",
      strategyFingerprint: createHash("sha256").update("strategy").digest("hex"),
      qualificationStatus: "qualified",
      reasonCode: "strategy_qualified",
      fixtureSeed: 41002,
      qualificationLevel: "outcome",
      providerIdentity: "webarena_infinity_gmail_state_oracle_v1",
      scenarioSeed: 41002,
      sourceRevision: "webarena_infinity_1ca77813bf8d8e4011aa3fb1f740f70d78bd522d",
      oracleReference: "webarena_gmail_email_read_state_oracle_v1",
      independentApplicationOutcome: true,
      cleanupResult: { status: "verified" },
      applicationBuild: "fixture_build_1",
      evidenceRefs: ["fixture_evidence"]
    }
  });
  store.close();
  const before = await readFile(databasePath);
  const report = await exportRedactedTrace(runId, { databasePath });
  const after = await readFile(databasePath);

  assert.equal(report.status, "available");
  assert.equal(report.redacted, true);
  assert.equal(report.episodes[0].integrity.ok, true);
  assert.equal(report.episodes[0].integrity.eventCount, 4);
  assert.equal(report.episodes[0].events[1].stepId, "step_fixture");
  assert.equal(report.episodes[0].events[1].payload.answer, "[REDACTED]");
  assert.deepEqual(report.episodes[0].events[1].payload.usage, { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, cost: 0.001 }, "token accounting is diagnostic metadata, not a credential");
  assert.equal(report.workflow[0].planHash, createHash("sha256").update("workflow plan").digest("hex"));
  assert.equal(report.modelAccounting.modelCallCount, 2);
  assert.equal(report.modelAccounting.inputTokens, 32);
  assert.equal(report.jevReview[0].disposition, "supported");
  assert.equal(report.fixtureQualifications[0].fixtureSeed, 41002);
  assert.equal(report.fixtureQualifications[0].qualificationLevel, "outcome");
  assert.equal(report.fixtureQualifications[0].scenarioSeed, 41002);
  assert.equal(report.fixtureQualifications[0].independentApplicationOutcome, true);
  assert.deepEqual(report.fixtureQualifications[0].cleanupResult, { status: "verified" });
  assert.ok(report.evidenceRefs.includes("fixture_evidence"));
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);

  const markdown = formatOperatorMarkdown(report, "export-trace");
  const markdownIndex = indexMarkdownDocument(markdown);
  assert.ok(markdownIndex.sections.some(section => section.id === "causal-bundle"));
  assert.ok(markdownIndex.sections.some(section => section.id === "episode-1"));
  assert.ok(markdownIndex.sections.some(section => section.id === "event-1"));
  assert.match(markdown, /\| answer \| string \|/u, "event payloads are decomposed into field tables");
  assert.match(markdown, /\| inputTokens \| number \| 12 \|/u, "token usage remains visible in the diagnostic projection");
  assert.equal(markdown.includes("fixture-secret"), false);
  assert.deepEqual(after, before);
});
