import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { visualEvidenceProjection } from "../navigation/visualEvidence.js";
import { isLowercaseCode, isSafeTelemetryCode, isSha256Digest, normalizeObservedRole, normalizeObservedTag } from "../telemetry/privacy.js";
import { isJevImageSizeSupported, jpegDimensions } from "./imagePreparation.js";

export const JEV_MODEL_ID = "typesafe/jev-1.14";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MAX_STATE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 1_500_000;

export function isPinnedJevModel(value) {
  return value === JEV_MODEL_ID || /^typesafe\/jev-1\.14(?:-\d{8})?$/u.test(String(value ?? ""));
}

function validateJevImageEvidence(imageEvidence) {
  exactKeys(imageEvidence, ["evidenceId", "targetId", "documentGeneration", "viewport", "deviceScaleFactor", "screenshotBase64"], ["evidenceId", "targetId", "documentGeneration", "viewport", "screenshotBase64"], "visual evidence");
  exactKeys(imageEvidence.viewport, ["width", "height"], ["width", "height"], "visual viewport");
  if (typeof imageEvidence?.evidenceId !== "string" || !imageEvidence.evidenceId || imageEvidence.evidenceId.length > 128
    || typeof imageEvidence.targetId !== "string" || !imageEvidence.targetId || imageEvidence.targetId.length > 256
    || !Number.isSafeInteger(imageEvidence.documentGeneration) || imageEvidence.documentGeneration < 0
    || !imageEvidence.viewport || !Number.isInteger(imageEvidence.viewport.width) || imageEvidence.viewport.width < 1 || imageEvidence.viewport.width > 16_384
    || !Number.isInteger(imageEvidence.viewport.height) || imageEvidence.viewport.height < 1 || imageEvidence.viewport.height > 16_384
    || typeof imageEvidence.screenshotBase64 !== "string" || !imageEvidence.screenshotBase64) {
    throw new JevRequestError("privacy", "Jev visual evidence is not bound to a fresh target observation.");
  }
  const bytes = Buffer.from(imageEvidence.screenshotBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== imageEvidence.screenshotBase64) {
    throw new JevRequestError("size", "Jev JPEG evidence is invalid or exceeds the configured byte limit.");
  }
  const dimensions = jpegDimensions(bytes);
  const pixels = dimensions ? dimensions.width * dimensions.height : 0;
  if (!dimensions || !isJevImageSizeSupported(dimensions)) {
    throw new JevRequestError("size", "Jev image preview accepts JPEGs from 280 to 1,568 pixels per side and 78,400 to 2,458,624 pixels total.");
  }
  const projection = visualEvidenceProjection(imageEvidence);
  if (!projection) throw new JevRequestError("privacy", "Jev visual evidence mapping metadata is invalid.");
  return {
    screenshotBase64: imageEvidence.screenshotBase64,
    projection
  };
}

export class JevRequestError extends Error {
  constructor(kind, message, { status = null, retriable = false, usage = null } = {}) {
    super(message);
    this.name = "JevRequestError";
    this.kind = kind;
    this.status = status;
    this.retriable = retriable;
    this.usage = usage;
  }
}

export function defaultJevCredentialFile(env = process.env, { cwd = process.cwd(), home = homedir() } = {}) {
  if (env.ACTIVETAB_JEV_KEY_FILE) return env.ACTIVETAB_JEV_KEY_FILE;
  const workingDirectoryFile = resolve(cwd, "JEV.txt");
  try {
    lstatSync(workingDirectoryFile);
    return workingDirectoryFile;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolve(home, "JEV.txt");
}

function readApiKeyFile(filePath) {
  const path = resolve(filePath);
  let stat;
  try { stat = lstatSync(path); }
  catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Jev credential file must be a regular, non-symlink file.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Jev credential file permissions must be owner-only.");
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1).trim() : line.trim())
    .filter(line => line && !line.startsWith("#"));
  if (lines.length !== 1) throw new Error("Jev credential file does not contain one valid key entry.");
  const line = lines[0];
  const separator = line.indexOf("=");
  let key;
  if (separator >= 0) {
    const name = line.slice(0, separator).trim();
    if (name !== "OPENROUTER_API_KEY" && name !== "JEV_API_KEY") throw new Error("Jev credential file does not contain one valid key entry.");
    key = line.slice(separator + 1).trim();
    const first = key[0];
    const last = key.at(-1);
    if ((first === "'" || first === '"') && last === first) key = key.slice(1, -1);
    else if (first === "'" || first === '"' || last === "'" || last === '"') throw new Error("Jev credential file does not contain one valid key entry.");
  } else {
    key = line;
  }
  let containsWhitespace = false;
  for (const character of key) if (character.trim() === "") containsWhitespace = true;
  if (!key || key.length > 512 || containsWhitespace) throw new Error("Jev credential file does not contain one valid key entry.");
  return key;
}

export function resolveJevApiKey({ env = process.env, apiKeyFile = defaultJevCredentialFile(env) } = {}) {
  return readApiKeyFile(apiKeyFile) ?? env.OPENROUTER_API_KEY ?? env.JEV_API_KEY ?? null;
}

function requireCode(value, field, { maxLength = 96 } = {}) {
  if (!isLowercaseCode(value, { maxLength })) throw new Error(`Jev ${field} must be a bounded lowercase structural code.`);
  return value;
}

function exactKeys(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Jev ${label} must be a typed object.`);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Jev ${label} does not match the minimized structural evidence contract.`);
  }
}

function normalizeControl(value) {
  exactKeys(value, ["candidate_ref", "role", "tag", "visible", "disabled"], ["candidate_ref", "role", "tag", "visible", "disabled"], "proposed control");
  if (!isSafeTelemetryCode(value.candidate_ref, { maxLength: 128 })) throw new Error("Jev candidate reference is invalid.");
  if (typeof value.visible !== "boolean" || typeof value.disabled !== "boolean") throw new Error("Jev control state flags must be boolean.");
  return {
    candidate_ref: value.candidate_ref,
    role: normalizeObservedRole(value.role),
    tag: normalizeObservedTag(value.tag),
    visible: value.visible,
    disabled: value.disabled
  };
}

const OPERATION_CLASSES = new Set(["read", "navigation", "test_owned_mutation", "shared_mutation", "security_change", "unknown"]);

function normalizeState(state, reviewKind) {
  if (reviewKind === "pre_action_review") {
    const allowed = ["operation_code", "operation_class", "requested_target_role", "task_purpose_code", "proposed_control", "page_surface", "alternative_count", "semantic_annotation"];
    exactKeys(state, allowed, ["operation_code", "operation_class", "requested_target_role", "proposed_control", "page_surface", "alternative_count"], "pre-action state");
    if (state.page_surface !== "observed_browser_surface") throw new Error("Jev page surface is unsupported.");
    requireCode(state.operation_class, "operation class");
    if (!Number.isInteger(state.alternative_count) || state.alternative_count < 0 || state.alternative_count > 100) throw new Error("Jev alternative count is outside its bound.");
    const normalized = {
      operation_code: requireCode(state.operation_code, "operation"),
      operation_class: requireCode(state.operation_class, "operation class"),
      requested_target_role: requireCode(state.requested_target_role, "target role"),
      ...(Object.hasOwn(state, "task_purpose_code") ? { task_purpose_code: requireCode(state.task_purpose_code, "task purpose") } : {}),
      proposed_control: normalizeControl(state.proposed_control),
      page_surface: state.page_surface,
      alternative_count: state.alternative_count
    };
    if (Object.hasOwn(state, "semantic_annotation")) {
      const annotation = state.semantic_annotation;
      exactKeys(annotation, ["role", "result_code", "confidence"], ["role", "result_code", "confidence"], "semantic annotation");
      if (!Number.isFinite(annotation.confidence) || annotation.confidence < 0 || annotation.confidence > 1) throw new Error("Jev semantic confidence is invalid.");
      normalized.semantic_annotation = {
        role: requireCode(annotation.role, "semantic role"),
        result_code: requireCode(annotation.result_code, "semantic result"),
        confidence: annotation.confidence
      };
    }
    return normalized;
  }

  if (reviewKind === "outcome_review") {
    exactKeys(state, ["expected_outcome", "browser_outcome", "backend_outcome"], ["expected_outcome", "browser_outcome", "backend_outcome"], "outcome state");
    return {
      expected_outcome: requireCode(state.expected_outcome, "expected outcome"),
      browser_outcome: requireCode(state.browser_outcome, "browser outcome"),
      backend_outcome: requireCode(state.backend_outcome, "backend outcome")
    };
  }
  if (reviewKind === "workflow_plan_review") {
    exactKeys(state, ["plan_version", "step_count", "task_outcome_code", "review_binding_hash", "steps"], ["plan_version", "step_count", "task_outcome_code", "review_binding_hash", "steps"], "workflow-plan state");
    if (state.plan_version !== 1 || !Number.isInteger(state.step_count) || state.step_count < 1 || state.step_count > 24
      || !Array.isArray(state.steps) || state.steps.length !== state.step_count
      || !isSha256Digest(state.review_binding_hash)) throw new Error("Jev workflow plan is outside its supported bounds.");
    const validStatuses = new Set(["passed", "failed", "blocked", "uncertain", "skipped"]);
    const stepIds = new Set();
    const steps = state.steps.map((step, index) => {
      exactKeys(step,
        ["step_id", "capability_id", "effect_class", "target_role", "verification_code", "requires_approval", "depends_on", "condition", "purpose_codes", "precondition_codes", "postcondition_codes"],
        ["step_id", "capability_id", "effect_class", "target_role", "verification_code", "requires_approval", "depends_on", "condition", "purpose_codes", "precondition_codes", "postcondition_codes"],
        `workflow step ${index}`);
      const stepId = requireCode(step.step_id, "workflow step ID", { maxLength: 64 });
      if (stepIds.has(stepId)) throw new Error("Jev workflow step IDs must be unique.");
      stepIds.add(stepId);
      if (!OPERATION_CLASSES.has(step.effect_class)) throw new Error("Jev workflow effect class is unsupported.");
      if (typeof step.requires_approval !== "boolean") throw new Error("Jev workflow approval requirement must be boolean.");
      if (!Array.isArray(step.depends_on) || step.depends_on.length > 24
        || new Set(step.depends_on).size !== step.depends_on.length) throw new Error("Jev workflow dependencies are outside their bound.");
      const codes = (value, label, { required = false } = {}) => {
        if (!Array.isArray(value) || value.length > 24 || (required && value.length === 0)) throw new Error(`Jev workflow ${label} are outside their bound.`);
        const normalized = value.map(code => requireCode(code, label, { maxLength: 64 }));
        if (new Set(normalized).size !== normalized.length) throw new Error(`Jev workflow ${label} must be unique.`);
        return normalized;
      };
      let condition = null;
      if (step.condition !== null) {
        exactKeys(step.condition, ["step_id", "status"], ["step_id", "status"], "workflow condition");
        if (!validStatuses.has(step.condition.status)) throw new Error("Jev workflow condition status is unsupported.");
        condition = { step_id: requireCode(step.condition.step_id, "condition step ID", { maxLength: 64 }), status: step.condition.status };
      }
      return {
        step_id: stepId,
        capability_id: requireCode(step.capability_id, "workflow capability ID"),
        effect_class: step.effect_class,
        target_role: requireCode(step.target_role, "workflow target role"),
        verification_code: requireCode(step.verification_code, "workflow verification code"),
        requires_approval: step.requires_approval,
        depends_on: step.depends_on.map(value => requireCode(value, "workflow dependency", { maxLength: 64 })),
        condition,
        purpose_codes: codes(step.purpose_codes, "purpose codes", { required: true }),
        precondition_codes: codes(step.precondition_codes, "precondition codes"),
        postcondition_codes: codes(step.postcondition_codes, "postcondition codes", { required: true })
      };
    });
    const prior = new Set();
    for (const step of steps) {
      if (step.depends_on.some(id => !prior.has(id))) throw new Error("Jev workflow dependencies must refer to earlier steps.");
      if (step.condition && !step.depends_on.includes(step.condition.step_id)) throw new Error("Jev workflow condition must depend on its source step.");
      prior.add(step.step_id);
    }
    return {
      plan_version: 1,
      task_outcome_code: requireCode(state.task_outcome_code, "task outcome code"),
      review_binding_hash: state.review_binding_hash.toLowerCase(),
      step_count: state.step_count,
      steps
    };
  }
  if (reviewKind === "visual_assessment_review") {
    exactKeys(state, ["task_code", "current", "before", "expected_outcome_code", "target_role_code"], ["task_code", "current"], "visual assessment state");
    const taskCode = requireCode(state.task_code, "visual task");
    if (!["page_classification", "obstruction_detection", "outcome_assessment", "target_grounding"].includes(taskCode)) {
      throw new Error("Jev visual task is unsupported.");
    }
    const snapshot = (value, label) => {
      exactKeys(value, ["document_generation", "candidate_count", "visible_candidate_count", "dialog_count", "ready_state"], ["document_generation", "candidate_count", "visible_candidate_count", "dialog_count", "ready_state"], `${label} snapshot`);
      if (!Number.isSafeInteger(value.document_generation) || value.document_generation < 0
        || !Number.isInteger(value.candidate_count) || value.candidate_count < 0 || value.candidate_count > 10_000
        || !Number.isInteger(value.visible_candidate_count) || value.visible_candidate_count < 0 || value.visible_candidate_count > value.candidate_count
        || !Number.isInteger(value.dialog_count) || value.dialog_count < 0 || value.dialog_count > value.candidate_count
        || !["loading", "interactive", "complete", "unknown"].includes(value.ready_state)) {
        throw new Error(`Jev ${label} snapshot is outside its bounds.`);
      }
      return {
        document_generation: value.document_generation,
        candidate_count: value.candidate_count,
        visible_candidate_count: value.visible_candidate_count,
        dialog_count: value.dialog_count,
        ready_state: value.ready_state
      };
    };
    const normalized = { task_code: taskCode, current: snapshot(state.current, "current") };
    if (taskCode === "outcome_assessment") {
      if (!Object.hasOwn(state, "before") || !Object.hasOwn(state, "expected_outcome_code")) {
        throw new Error("Jev visual outcome assessment requires before-state and expected-outcome codes.");
      }
      normalized.before = snapshot(state.before, "before");
      normalized.expected_outcome_code = requireCode(state.expected_outcome_code, "expected visual outcome");
    } else if (taskCode === "target_grounding") {
      if (!Object.hasOwn(state, "target_role_code") || Object.hasOwn(state, "before") || Object.hasOwn(state, "expected_outcome_code")) {
        throw new Error("Jev target grounding requires a target-role code and excludes outcome-only state.");
      }
      normalized.target_role_code = requireCode(state.target_role_code, "visual target role");
    } else if (Object.hasOwn(state, "before") || Object.hasOwn(state, "expected_outcome_code")) {
      throw new Error("Jev page and obstruction reviews cannot include outcome-only fields.");
    } else if (Object.hasOwn(state, "target_role_code")) {
      throw new Error("Jev page and obstruction reviews cannot include target-grounding fields.");
    }
    return normalized;
  }
  throw new Error("Jev decision review kind is unsupported.");
}

function normalizeQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new Error("Jev requests require named typed questions.");
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > 32) throw new Error("Jev requests require between 1 and 32 questions.");
  const normalized = {};
  for (const [id, question] of entries) {
    if (!isLowercaseCode(id, { maxLength: 64 }) || !question || typeof question.instructions !== "string" || question.instructions.length === 0 || question.instructions.length > 1000) throw new Error("Jev question ID or instructions are invalid.");
    if (question.type === "noul") {
      exactKeys(question, ["type", "instructions"], ["type", "instructions"], "Noul question");
      normalized[id] = { type: "noul", instructions: question.instructions };
    } else if (question.type === "choice") {
      exactKeys(question, ["type", "instructions", "criteria"], ["type", "instructions", "criteria"], "Choice question");
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 32) throw new Error("Jev Choice questions require 2–32 named criteria.");
      for (const [criterion, description] of Object.entries(criteria)) {
        if (!isLowercaseCode(criterion, { maxLength: 64 }) || typeof description !== "string" || description.length === 0 || description.length > 500) throw new Error("Jev Choice criteria are invalid.");
      }
      normalized[id] = { type: "choice", instructions: question.instructions, criteria };
    } else if (question.type === "score") {
      exactKeys(question, ["type", "instructions", "criteria"], ["type", "instructions", "criteria"], "Score question");
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 32 || question.criteria.some(item => typeof item !== "string" || item.length > 500)) throw new Error("Jev Score questions require 2–32 bounded levels.");
      normalized[id] = { type: "score", instructions: question.instructions, criteria: question.criteria };
    } else if (question.type === "box") {
      exactKeys(question, ["type", "instructions"], ["type", "instructions"], "Box question");
      normalized[id] = { type: "box", instructions: question.instructions };
    } else {
      throw new Error(`Unsupported Jev question type '${String(question.type)}'.`);
    }
  }
  if (Object.values(normalized).some(question => question.type === "box")
    && !Object.values(normalized).some(question => question.type === "noul")) {
    throw new Error("Jev Box questions require a paired Noul target-presence question.");
  }
  return normalized;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const normalized = {};
  for (const [source, target] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"]]) {
    if (Number.isInteger(usage[source]) && usage[source] >= 0) normalized[target] = usage[source];
  }
  const cachedInputTokens = usage.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cache_read_input_tokens;
  if (Number.isInteger(cachedInputTokens) && cachedInputTokens >= 0
      && (normalized.inputTokens === undefined || cachedInputTokens <= normalized.inputTokens)) {
    normalized.cachedInputTokens = cachedInputTokens;
  }
  if (Number.isFinite(usage.cost) && usage.cost >= 0) normalized.cost = usage.cost;
  return Object.keys(normalized).length ? normalized : null;
}

async function readBoundedJson(response) {
  if (!response.body?.getReader) throw new JevRequestError("schema", "Jev response does not support bounded streaming.");
  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new JevRequestError("response_too_large", "Jev response exceeded the configured byte limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(text); } catch { throw new JevRequestError("schema", "Jev returned a non-JSON response."); }
}

function normalizeAnswers(answers, questions) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new JevRequestError("schema", "Jev response did not contain typed answers.");
  const normalized = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || answer.type !== question.type) throw new JevRequestError("schema", `Jev answer '${id}' did not match its declared type.`);
    if (question.type === "noul") {
      if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new JevRequestError("schema", `Jev Noul answer '${id}' is invalid.`);
      normalized[id] = { type: "noul", probabilityYes: answer.noul };
    } else if (question.type === "box") {
      const box = answer.box;
      if (!box || typeof box !== "object" || Array.isArray(box)
        || Object.keys(answer).some(key => !["type", "box", "confidence"].includes(key))
        || Object.keys(box).length !== 4 || Object.keys(box).some(key => !["top", "bottom", "left", "right"].includes(key))
        || [box.top, box.bottom, box.left, box.right].some(value => !Number.isFinite(value) || value < 0 || value > 1)
        || !(box.left < box.right) || !(box.top < box.bottom)
        || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
        throw new JevRequestError("schema", `Jev Box answer '${id}' is invalid.`);
      }
      normalized[id] = { type: "box", box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, confidence: answer.confidence };
    } else if (question.type === "choice") {
      const choice = answer.choice;
      const probabilities = answer.probabilities;
      if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice) || !probabilities || typeof probabilities !== "object") throw new JevRequestError("schema", `Jev Choice answer '${id}' is invalid.`);
      const normalizedProbabilities = {};
      for (const key of Object.keys(question.criteria)) {
        const probability = probabilities[key];
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new JevRequestError("schema", `Jev Choice probability '${id}.${key}' is invalid.`);
        normalizedProbabilities[key] = probability;
      }
      normalized[id] = { type: "choice", choice, probabilities: normalizedProbabilities, ...(Number.isFinite(answer.confidence) ? { confidence: answer.confidence } : {}) };
    } else {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) throw new JevRequestError("schema", `Jev Score answer '${id}' is invalid.`);
      const probabilities = answer.probabilities;
      if (!probabilities || typeof probabilities !== "object") throw new JevRequestError("schema", `Jev Score distribution '${id}' is missing.`);
      const normalizedProbabilities = {};
      for (let index = 0; index < question.criteria.length; index++) {
        const probability = probabilities[String(index)];
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new JevRequestError("schema", `Jev Score probability '${id}.${index}' is invalid.`);
        normalizedProbabilities[String(index)] = probability;
      }
      normalized[id] = { type: "score", score: answer.score, probabilities: normalizedProbabilities, ...(Number.isFinite(answer.confidence) ? { confidence: answer.confidence } : {}) };
    }
  }
  return normalized;
}

export class JevDecisionClient {
  #apiKey;

  constructor({ apiKey = null, apiKeyFile = defaultJevCredentialFile(), model = JEV_MODEL_ID, fetchImpl = fetch, timeoutMs = 20_000, maxRetries = 0, allowImages = process.env.ACTIVETAB_JEV_ALLOW_IMAGES === "1" && process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1" && process.env.ACTIVETAB_JEV_CATALOG_IMAGE_INPUT !== "0" } = {}) {
    if (model !== JEV_MODEL_ID) throw new Error(`Jev model is pinned to ${JEV_MODEL_ID}.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("Jev timeout must be between 1000 and 120000 ms.");
    this.#apiKey = apiKey ?? resolveJevApiKey({ apiKeyFile });
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, Math.min(3, Number.isInteger(maxRetries) ? maxRetries : 0));
    this.allowImages = allowImages === true;
    this.requiresScreenshot = false;
  }

  async decide({ state, questions, reviewKind = "pre_action_review", imageEvidence = null, signal } = {}) {
    if (!this.#apiKey) throw new JevRequestError("configuration", "Jev review credential is unavailable; the decision boundary cannot be reviewed.");
    let safeState;
    try { safeState = normalizeState(state, reviewKind); }
    catch { throw new JevRequestError("privacy", "Jev state did not match the minimized typed evidence contract."); }
    const stateBytes = Buffer.byteLength(JSON.stringify(safeState), "utf8");
    if (stateBytes > MAX_STATE_BYTES) throw new JevRequestError("privacy", "Jev state exceeded the minimized evidence byte limit.");
    const safeQuestions = normalizeQuestions(questions);
    let requestState = safeState;
    let visualProjection = null;
    if (imageEvidence) {
      if (!this.allowImages) throw new JevRequestError("privacy", "Jev image input requires both explicit Jev image opt-in and screenshot privacy opt-in.");
      const image = validateJevImageEvidence(imageEvidence);
      visualProjection = image.projection;
      requestState = [
        JSON.stringify({ browserState: safeState, visualEvidence: visualProjection }),
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.screenshotBase64}` } }
      ];
    }
    if (reviewKind === "visual_assessment_review" && !imageEvidence) {
      throw new JevRequestError("privacy", "Jev visual assessments require bound screenshot evidence.");
    }
    if (Object.values(safeQuestions).some(question => question.type === "box") && !imageEvidence) {
      throw new JevRequestError("privacy", "Jev Box questions require bound visual evidence.");
    }
    const requestBody = JSON.stringify({ model: this.model, state: requestState, questions: safeQuestions });
    const deadline = Date.now() + this.timeoutMs;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw abortError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JevRequestError("timeout", "Jev decision exceeded the total request deadline.", { retriable: true });
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, remaining);
      let response;
      try {
        response = await this.fetch(OPENROUTER_DECISIONS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", ...(visualProjection ? { "TypeSafe-Danger-Zone-Images": "true" } : {}) },
          body: requestBody,
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) throw abortError();
        if (error?.kind === "budget_exhausted") throw error;
        lastError = new JevRequestError(controller.signal.aborted ? "timeout" : "transport", controller.signal.aborted ? "Jev decision exceeded the total request deadline." : "Jev request failed before receiving a response.", { retriable: true });
        if (attempt >= this.maxRetries || Date.now() >= deadline) throw lastError;
        await delay(Math.min(250 * 2 ** attempt, Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      try {
        if (!response.ok) {
          const retriable = response.status === 429 || response.status >= 500;
          throw new JevRequestError("http", `OpenRouter Decisions API returned HTTP ${response.status}.`, { status: response.status, retriable });
        }
        const payload = await readBoundedJson(response);
        if (payload?.model !== undefined && !isPinnedJevModel(payload.model)) {
          throw new JevRequestError("schema", "Jev response model did not match the pinned decision model.");
        }
        const answers = normalizeAnswers(payload?.answers, safeQuestions);
        return {
          model: this.model,
          modelSnapshot: isPinnedJevModel(payload.model) ? payload.model : this.model,
          requestId: typeof payload.id === "string" ? payload.id : null,
          answers,
          usage: normalizeUsage(payload.usage)
        };
      } catch (error) {
        lastError = error;
        const retriable = error instanceof JevRequestError && error.retriable;
        if (!retriable || attempt >= this.maxRetries || Date.now() >= deadline) throw error;
        await delay(Math.min(250 * 2 ** attempt, Math.max(0, deadline - Date.now())), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw lastError ?? new JevRequestError("transport", "Jev request failed.");
  }
}

function abortError() { const error = new Error("Jev decision was canceled."); error.name = "AbortError"; error.code = 20; return error; }
function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveDelay(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
