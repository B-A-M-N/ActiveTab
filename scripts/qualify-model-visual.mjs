import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createDecisionRuntime } from "../src/decisions/runtime.js";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { createConfiguredWorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { preflightModelCapabilities, writeModelPreflightSummary } from "../src/navigation/modelPreflight.js";

let currentStage = "startup_preflight";
let workflowProviderDiagnostic = null;

function requireValue(value, name) {
  if (!value) throw Object.assign(new Error(`Missing ${name}.`), { kind: "configuration", missingConfiguration: name });
}

function hasJevCredential() {
  if (process.env.OPENROUTER_API_KEY || process.env.JEV_API_KEY) return true;
  const candidates = [
    process.env.ACTIVETAB_JEV_KEY_FILE,
    resolve(process.cwd(), "JEV.txt"),
    resolve(homedir(), "JEV.txt")
  ].filter(Boolean);
  return candidates.some(path => {
    try { return existsSync(path) && statSync(path).isFile(); }
    catch { return false; }
  });
}

function safeErrorLocation(error) {
  const matches = typeof error?.stack === "string"
    ? error.stack.match(/(?:src|scripts)\/[A-Za-z0-9_./-]+:\d+:\d+/gu)
    : null;
  return matches?.[0]?.slice(0, 160);
}

function safeFailure(error) {
  const kind = ["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted", "unknown"].includes(error?.kind)
    ? error.kind : "pretest_failed";
  const errorType = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(error.name)
    ? error.name : "Error";
  const providerCode = typeof error?.code === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(error.code)
    ? error.code : undefined;
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    scope: "provider_protocol_only",
    stage: currentStage,
    failureCode: kind,
    errorType,
    ...(safeErrorLocation(error) ? { errorLocation: safeErrorLocation(error) } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(error?.missingConfiguration ? { missingConfiguration: error.missingConfiguration } : {}),
    ...(currentStage === "workflow_synthesis_image" && workflowProviderDiagnostic
      ? { workflowProvider: workflowProviderDiagnostic } : {})
  })}\n`);
  process.exitCode = 1;
}

async function main() {
  currentStage = "model_capability_preflight";
  const modelPreflight = await preflightModelCapabilities();
  writeModelPreflightSummary(modelPreflight);
  if (process.argv.includes("--secondary-image-only")) return await qualifySecondaryImagePath();
  if (process.argv.includes("--secondary-only")) return await qualifySecondaryTextPath();
  if (process.argv.includes("--jev-only")) return await qualifyJevImagePath();

  requireValue(process.env.ACTIVETAB_MODEL_ENDPOINT || process.env.ACTIVETAB_SEMANTIC_ENDPOINT, "ACTIVETAB_MODEL_ENDPOINT or ACTIVETAB_SEMANTIC_ENDPOINT");
  requireValue(process.env.ACTIVETAB_SEMANTIC_IMAGE_INPUT === "1", "image-capable semantic model route from startup preflight");
  requireValue(process.env.ACTIVETAB_WORKFLOW_IMAGE_INPUT === "1", "image-capable workflow model route from startup preflight");
  requireValue(process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1", "ACTIVETAB_MODEL_ALLOW_SCREENSHOTS=1");
  requireValue(process.env.ACTIVETAB_JEV_ALLOW_IMAGES === "1", "ACTIVETAB_JEV_ALLOW_IMAGES=1");
  requireValue(hasJevCredential(), "OPENROUTER_API_KEY, JEV_API_KEY, or an owner-only JEV.txt file");
  const screenshotPath = resolve("docs/assets/first-run.jpg");
  const screenshotBase64 = readFileSync(screenshotPath).toString("base64");
  const observation = {
    evidenceId: "visual_qualification_observation",
    targetId: "visual_qualification_target",
    documentGeneration: 1,
    viewport: { width: 780, height: 437 },
    page: { url: "https://fixture.activetab.invalid/account", title: "Account" },
    headings: [{ level: 1, text: "Account" }],
    candidates: [{
      identity: "candidate_open_account",
      tag: "button",
      role: "button",
      visible: true,
      disabled: false
    }],
    scrollTargets: [],
    visualEvidence: {
      evidenceId: "visual_qualification_observation",
      targetId: "visual_qualification_target",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      screenshotBase64
    }
  };

  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore });
  const runId = "visual_model_qualification";
  const episode = runtime.startEpisode({
    runId,
    workflowId: "visual_model_qualification",
    applicationId: "activetab_fixture",
    environmentClass: "local",
    executionMode: "standalone"
  });
  try {
    requireValue(runtime.semanticAnalyzer, "a configured secondary inference endpoint");
    requireValue(runtime.semanticAnalyzer.allowScreenshots, "secondary inference screenshot opt-in");
    const workflowSynthesizer = createConfiguredWorkflowSynthesizer({
      eventStore,
      fetchImpl: runtime.budgetedFetch("workflow_synthesis")
    });
    requireValue(workflowSynthesizer, "a configured workflow synthesis endpoint");
    requireValue(workflowSynthesizer.allowScreenshots, "workflow screenshot opt-in");
    let workflowProviderCalls = 0;
    const originalWorkflowRequest = workflowSynthesizer.provider.requestStructured.bind(workflowSynthesizer.provider);
    workflowSynthesizer.provider.requestStructured = async (...args) => {
      workflowProviderCalls++;
      try {
        return await originalWorkflowRequest(...args);
      } catch (error) {
        const kind = ["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted"].includes(error?.kind)
          ? error.kind : "unknown";
        const errorType = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(error.name)
          ? error.name : "Error";
        workflowProviderDiagnostic = { calls: workflowProviderCalls, outcome: "error", failureCode: kind, errorType };
        throw error;
      }
    };
    requireValue(runtime.jevClient?.allowImages === true, "Jev image opt-in and screenshot privacy opt-in");

    currentStage = "secondary_semantic_image";
    const semantic = await runtime.withInferenceBudget({ runId }, () => runtime.semanticAnalyzer.analyzePage({
      observation,
      requestedRoles: ["account_open_button"],
      intentHints: ["account", "open"],
      useVisualEvidence: true,
      episodeId: episode.episodeId,
      runId,
      stepId: "semantic_visual_qualification",
      decisionId: "semantic_visual_qualification"
    }));
    if (semantic.annotations.length !== 1 || semantic.annotations[0].resultCode !== "mapped"
      || semantic.annotations[0].candidateRef !== "candidate_open_account") {
      throw Object.assign(new Error("Secondary inference did not map the image-grounded action to the observed candidate."), { kind: "schema" });
    }

    currentStage = "workflow_synthesis_image";
    let synthesized;
    try {
      synthesized = await runtime.withInferenceBudget({ runId }, () => workflowSynthesizer.synthesize({
        taskIntent: { purposeCode: "open_account", outcomeCode: "account_opened" },
        observation,
        capabilities: [{
          id: "open_account",
          action: "click",
          effectClass: "navigation",
          targetRole: "account_open_button",
          observedRoles: ["button"],
          observedTags: ["button"],
          verificationCodes: ["account_view_observed"]
        }],
        episodeId: episode.episodeId,
        runId,
        stepId: "workflow_visual_qualification",
        imageEvidence: observation.visualEvidence
      }));
    } catch (error) {
      const kind = ["configuration", "privacy", "size", "timeout", "transport", "http", "schema", "response_too_large", "refusal", "budget_exhausted"].includes(error?.kind)
        ? error.kind : "unknown";
      const errorType = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(error.name)
        ? error.name : "Error";
      workflowProviderDiagnostic ??= {
        calls: workflowProviderCalls,
        outcome: "threw",
        failureCode: kind,
        errorType,
        ...(safeErrorLocation(error) ? { errorLocation: safeErrorLocation(error) } : {})
      };
      throw error;
    }
    workflowProviderDiagnostic ??= {
      calls: workflowProviderCalls,
      outcome: synthesized.status === "synthesized" ? "response" : "unavailable",
      ...(typeof synthesized.failureCode === "string" ? { failureCode: synthesized.failureCode } : {})
    };
    if (synthesized.status !== "synthesized" || synthesized.plan.steps[0]?.capabilityId !== "open_account") {
      throw Object.assign(new Error("Secondary inference did not synthesize a plan using the observed capability."), { kind: synthesized.failureCode ?? "schema" });
    }

    currentStage = "jev_workflow_plan_review";
    const review = await runtime.withInferenceBudget({ runId }, () => runtime.reviewWorkflowPlan({
      episodeId: episode.episodeId,
      runId,
      stepId: "jev_visual_qualification",
      decisionId: "jev_visual_qualification",
      observationId: observation.evidenceId,
      observation,
      imageEvidence: observation.visualEvidence,
      planProjection: synthesized.planProjection
    }));
    if (review.status !== "reviewed" || review.authorizesOperation !== false) {
      throw Object.assign(new Error("Jev did not return a valid advisory review for the image-grounded workflow."), { kind: review.failureCode ?? "schema" });
    }

    currentStage = "visual_telemetry_validation";
    const events = eventStore.getEvents(episode.episodeId);
    const imageInputEvents = events.filter(event => event.eventType === "decision.input_captured" || event.eventType === "semantic.input_captured");
    const hasImageDigests = imageInputEvents.some(event => JSON.stringify(event.payload.inputProjection ?? {}).includes("imageSha256"));
    const hasImageModality = events.some(event => ["decision.input_captured", "semantic.input_captured", "workflow.plan_synthesized"]
      .includes(event.eventType) && event.payload.inputModality === "text_plus_visual");
    if (!hasImageDigests || !hasImageModality) throw Object.assign(new Error("Visual evidence modality was not linked into the provider pretest trace."), { kind: "schema" });

    process.stdout.write(`${JSON.stringify({
      status: "pretest_passed",
      scope: "provider_protocol_only",
      screenshotInput: "jpeg",
      secondaryInference: { model: semantic.model, annotation: semantic.annotations[0].resultCode, observedCandidate: semantic.annotations[0].candidateRef },
      workflowSynthesis: { model: workflowSynthesizer.model, status: synthesized.status, steps: synthesized.plan.steps.length },
      jev: { model: review.reviewer.model, status: review.status, disposition: review.disposition, advisoryOnly: review.authorizesOperation === false },
      visualEvidenceLinked: hasImageDigests,
      inputModality: hasImageModality ? "text_plus_visual" : "unknown"
    })}\n`);
  } finally {
    runtime.close();
  }
}

async function qualifySecondaryImagePath() {
  currentStage = "secondary_semantic_image";
  const endpoint = process.env.ACTIVETAB_MODEL_ENDPOINT ?? process.env.ACTIVETAB_SEMANTIC_ENDPOINT;
  requireValue(endpoint, "ACTIVETAB_MODEL_ENDPOINT or ACTIVETAB_SEMANTIC_ENDPOINT");
  requireValue((process.env.ACTIVETAB_SEMANTIC_IMAGE_INPUT ?? process.env.ACTIVETAB_MODEL_IMAGE_INPUT) === "1", "image-capable semantic model route from startup preflight");
  requireValue(process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1", "ACTIVETAB_MODEL_ALLOW_SCREENSHOTS=1");

  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  const observationId = "secondary_image_pretest_observation";
  const observation = {
    evidenceId: observationId,
    targetId: "synthetic_provider_pretest",
    documentGeneration: 1,
    viewport: { width: 780, height: 437 },
    page: { url: "https://fixture.activetab.invalid/account", title: "Account" },
    headings: [{ level: 1, text: "Account" }],
    candidates: [
      { identity: "candidate_open_account", tag: "button", role: "button", name: "Open account", contextName: "Account", visible: true, disabled: false },
      { identity: "candidate_help", tag: "link", role: "link", name: "Help", contextName: "Support", visible: true, disabled: false }
    ],
    scrollTargets: [],
    visualEvidence: {
      evidenceId: observationId,
      targetId: "synthetic_provider_pretest",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      screenshotBase64
    }
  };
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore });
  const runId = "secondary_image_pretest";
  const episode = runtime.startEpisode({
    runId,
    workflowId: runId,
    applicationId: "activetab_provider_pretest",
    environmentClass: "local",
    executionMode: "standalone"
  });
  try {
    requireValue(runtime.semanticAnalyzer, "a configured secondary inference endpoint");
    requireValue(runtime.semanticAnalyzer.allowScreenshots, "secondary inference screenshot opt-in");
    const result = await runtime.withInferenceBudget({ runId }, () => runtime.semanticAnalyzer.analyzePage({
      observation,
      requestedRoles: ["account_open_button"],
      intentHints: ["open_account"],
      episodeId: episode.episodeId,
      runId,
      stepId: "secondary_image_mapping",
      decisionId: "secondary_image_mapping",
      includePageLabels: true,
      useVisualEvidence: true
    }));
    const annotation = result.annotations[0];
    const events = eventStore.getEvents(episode.episodeId);
    const imageInputEvent = events.find(event => event.eventType === "semantic.input_captured"
      && JSON.stringify(event.payload.inputProjection ?? {}).includes("imageSha256"));
    const visualEvidenceLinked = Boolean(imageInputEvent);
    const inputModality = imageInputEvent?.payload.inputModality ?? null;
    const visualMatch = result.annotations.length === 1
      && annotation?.resultCode === "mapped"
      && annotation.candidateRef === "candidate_open_account"
      && visualEvidenceLinked
      && inputModality === "text_plus_visual";
    process.stdout.write(`${JSON.stringify({
      status: visualMatch ? "pretest_passed" : "model_call_passed_visual_check_missed",
      scope: "provider_protocol_only",
      route: "secondary_image_input",
      model: result.model,
      annotation: annotation?.resultCode ?? "missing",
      observedCandidate: annotation?.candidateRef ?? null,
      visualEvidenceLinked,
      inputModality,
      screenshotBytes: Buffer.byteLength(screenshotBase64, "base64"),
      usage: result.usage,
      browserEffects: 0
    })}\n`);
    if (!visualMatch) throw Object.assign(new Error("Secondary inference did not map the visual role to the observed candidate."), { kind: "schema" });
  } finally {
    runtime.close();
  }
}

async function qualifySecondaryTextPath() {
  currentStage = "secondary_semantic_text";
  requireValue(process.env.ACTIVETAB_MODEL_ENDPOINT || process.env.ACTIVETAB_SEMANTIC_ENDPOINT, "ACTIVETAB_MODEL_ENDPOINT or ACTIVETAB_SEMANTIC_ENDPOINT");
  requireValue(process.env.ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT === "1", "ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1");
  requireValue(process.env.ACTIVETAB_SEMANTIC_ALLOW_PAGE_LABELS === "1", "ACTIVETAB_SEMANTIC_ALLOW_PAGE_LABELS=1");

  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore });
  const runId = "secondary_text_qualification";
  const episode = runtime.startEpisode({
    runId,
    workflowId: "secondary_text_qualification",
    applicationId: "activetab_fixture",
    environmentClass: "local",
    executionMode: "standalone"
  });
  const observation = {
    evidenceId: "secondary_text_qualification_observation",
    targetId: "secondary_text_qualification_target",
    documentGeneration: 1,
    viewport: { width: 1280, height: 720 },
    page: { url: "https://fixture.activetab.invalid/account", title: "Account" },
    headings: [{ level: 1, text: "Account" }],
    candidates: [
      { identity: "candidate_open_account", tag: "button", role: "button", name: "Open account", contextName: "Account access", visible: true, disabled: false },
      { identity: "candidate_open_help", tag: "link", role: "link", name: "Help", contextName: "Support", visible: true, disabled: false }
    ],
    scrollTargets: []
  };
  try {
    requireValue(runtime.semanticAnalyzer, "a configured secondary inference endpoint");
    const result = await runtime.withInferenceBudget({ runId }, () => runtime.semanticAnalyzer.analyzePage({
      observation,
      requestedRoles: ["account_open_button"],
      intentHints: ["open_account"],
      episodeId: episode.episodeId,
      runId,
      stepId: "secondary_text_mapping",
      decisionId: "secondary_text_mapping"
    }));
    const annotation = result.annotations[0];
    const inputModality = eventStore.getEvents(episode.episodeId)
      .find(event => event.eventType === "semantic.input_captured")?.payload.inputModality ?? null;
    if (result.annotations.length !== 1 || annotation?.resultCode !== "mapped"
      || annotation.candidateRef !== "candidate_open_account" || inputModality !== "text_only") {
      throw Object.assign(new Error("Secondary inference did not map the requested role or record a text-only input."), { kind: "schema" });
    }
    process.stdout.write(`${JSON.stringify({
      status: "pretest_passed",
      scope: "provider_protocol_only",
      route: "secondary_text_only",
      provider: result.provider,
      model: result.model,
      annotation: annotation.resultCode,
      observedCandidate: annotation.candidateRef,
      inputModality,
      confidence: annotation.confidence,
      pageLabelsTrainingExcluded: eventStore.getEvents(episode.episodeId).some(event => event.eventType === "semantic.input_captured" && event.trainingEligibility === "excluded"),
      browserEffects: 0
    })}\n`);
  } finally {
    runtime.close();
  }
}

async function qualifyJevImagePath() {
  currentStage = "jev_visual_classification";
  requireValue(process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1", "ACTIVETAB_MODEL_ALLOW_SCREENSHOTS=1");
  requireValue(process.env.ACTIVETAB_JEV_ALLOW_IMAGES === "1", "ACTIVETAB_JEV_ALLOW_IMAGES=1");
  requireValue(hasJevCredential(), "OPENROUTER_API_KEY, JEV_API_KEY, or an owner-only JEV.txt file");

  const screenshotBase64 = readFileSync(resolve("docs/assets/first-run.jpg")).toString("base64");
  const observation = {
    evidenceId: "jev_visual_qualification_observation",
    targetId: "jev_visual_qualification_target",
    documentGeneration: 1,
    viewport: { width: 780, height: 437 },
    page: { url: "https://fixture.activetab.invalid/account", title: "Account" },
    candidates: [{
      identity: "candidate_open_account",
      tag: "button",
      role: "button",
      visible: true,
      disabled: false
    }],
    visualEvidence: {
      evidenceId: "jev_visual_qualification_observation",
      targetId: "jev_visual_qualification_target",
      documentGeneration: 1,
      viewport: { width: 780, height: 437 },
      screenshotBase64
    }
  };
  const eventStore = new DecisionEventStore({ databasePath: ":memory:" });
  const runtime = createDecisionRuntime({ eventStore, semanticAnalyzer: null });
  const runId = "jev_visual_qualification";
  const episode = runtime.startEpisode({
    runId,
    workflowId: "jev_visual_qualification",
    applicationId: "activetab_fixture",
    environmentClass: "local",
    executionMode: "standalone"
  });
  try {
    requireValue(runtime.jevClient?.allowImages === true, "Jev image opt-in and screenshot privacy opt-in");
    const result = await runtime.withInferenceBudget({ runId }, () => runtime.visualDecisionService.classifyPage(observation, {
      episodeId: episode.episodeId,
      runId,
      stepId: "jev_visual_qualification",
      decisionId: "jev_visual_qualification"
    }));
    if (result.status !== "reviewed" || result.authorizesOperation !== false || !result.answers.page_state) {
      throw Object.assign(new Error("Jev did not return a typed visual classification for the fixture."), { kind: result.failureCode ?? "schema" });
    }
    const jevImageInput = eventStore.getEvents(episode.episodeId).find(event => event.eventType === "decision.input_captured"
      && JSON.stringify(event.payload.inputProjection ?? {}).includes("imageSha256"));
    if (jevImageInput?.payload.inputModality !== "text_plus_visual") {
      throw Object.assign(new Error("Jev visual input modality was not recorded."), { kind: "schema" });
    }
    currentStage = "jev_visual_box_grounding";
    const grounding = await runtime.withInferenceBudget({ runId }, () => runtime.visualDecisionService.groundTarget(observation, {
      episodeId: episode.episodeId,
      runId,
      stepId: "jev_visual_box_grounding",
      decisionId: "jev_visual_box_grounding",
      targetRoleCode: "visible_primary_button",
      allowedCandidateIds: [],
      imageEvidence: observation.visualEvidence
    }));
    if (grounding.status !== "reviewed"
      || grounding.answers?.target_present?.type !== "noul"
      || grounding.answers?.target_box?.type !== "box"
      || grounding.authorizesOperation !== false) {
      throw Object.assign(new Error("Jev did not return the paired typed Noul and Box answers."), { kind: grounding.failureCode ?? "schema" });
    }
    const groundingInput = eventStore.getEvents(episode.episodeId).find(event => event.eventType === "decision.input_captured"
      && event.decisionId === "jev_visual_box_grounding");
    if (groundingInput?.payload.inputModality !== "text_plus_visual") {
      throw Object.assign(new Error("Jev Box input modality was not recorded."), { kind: "schema" });
    }
    process.stdout.write(`${JSON.stringify({
      status: "pretest_passed",
      scope: "provider_protocol_only",
      reviewer: result.reviewer,
      pageState: result.answers.page_state.choice,
      typedAnswers: Object.keys(result.answers),
      targetGrounding: {
        status: grounding.status,
        presenceAnswer: grounding.answers.target_present.type,
        boxAnswer: grounding.answers.target_box.type,
        geometryMatchedSyntheticCandidate: grounding.grounding?.status === "grounded"
      },
      advisoryOnly: result.authorizesOperation === false,
      visualEvidenceLinked: Boolean(jevImageInput) && Boolean(groundingInput),
      inputModality: groundingInput.payload.inputModality
    })}\n`);
  } finally {
    runtime.close();
  }
}

main().catch(safeFailure);
