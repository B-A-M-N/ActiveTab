import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isLowercaseCode, isSafeTelemetryCode, normalizeObservedRole, normalizeObservedTag } from "../telemetry/privacy.js";

export const JEV_MODEL_ID = "typesafe/jev-1.14";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MAX_STATE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

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

function normalizeState(state) {
  if (state && typeof state === "object" && Object.hasOwn(state, "operation_code")) {
    const allowed = ["operation_code", "operation_class", "requested_target_role", "proposed_control", "page_surface", "alternative_count", "semantic_annotation"];
    exactKeys(state, allowed, ["operation_code", "operation_class", "requested_target_role", "proposed_control", "page_surface", "alternative_count"], "pre-action state");
    if (state.page_surface !== "observed_browser_surface") throw new Error("Jev page surface is unsupported.");
    if (!Number.isInteger(state.alternative_count) || state.alternative_count < 0 || state.alternative_count > 100) throw new Error("Jev alternative count is outside its bound.");
    const normalized = {
      operation_code: requireCode(state.operation_code, "operation"),
      operation_class: requireCode(state.operation_class, "operation class"),
      requested_target_role: requireCode(state.requested_target_role, "target role"),
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

  exactKeys(state, ["expected_outcome", "browser_outcome", "backend_outcome"], ["expected_outcome", "browser_outcome", "backend_outcome"], "outcome state");
  return {
    expected_outcome: requireCode(state.expected_outcome, "expected outcome"),
    browser_outcome: requireCode(state.browser_outcome, "browser outcome"),
    backend_outcome: requireCode(state.backend_outcome, "backend outcome")
  };
}

function normalizeQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new Error("Jev requests require named typed questions.");
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > 32) throw new Error("Jev requests require between 1 and 32 questions.");
  const normalized = {};
  for (const [id, question] of entries) {
    if (!isLowercaseCode(id, { maxLength: 64 }) || !question || typeof question.instructions !== "string" || question.instructions.length === 0 || question.instructions.length > 1000) throw new Error("Jev question ID or instructions are invalid.");
    if (question.type === "noul") {
      normalized[id] = { type: "noul", instructions: question.instructions };
    } else if (question.type === "choice") {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 32) throw new Error("Jev Choice questions require 2–32 named criteria.");
      for (const [criterion, description] of Object.entries(criteria)) {
        if (!isLowercaseCode(criterion, { maxLength: 64 }) || typeof description !== "string" || description.length === 0 || description.length > 500) throw new Error("Jev Choice criteria are invalid.");
      }
      normalized[id] = { type: "choice", instructions: question.instructions, criteria };
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 32 || question.criteria.some(item => typeof item !== "string" || item.length > 500)) throw new Error("Jev Score questions require 2–32 bounded levels.");
      normalized[id] = { type: "score", instructions: question.instructions, criteria: question.criteria };
    } else {
      throw new Error(`Unsupported Jev question type '${String(question.type)}'.`);
    }
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

  constructor({ apiKey = process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY ?? null, apiKeyFile = process.env.ACTIVETAB_JEV_KEY_FILE ?? resolve(process.cwd(), "JEV.txt"), model = JEV_MODEL_ID, fetchImpl = fetch, timeoutMs = 20_000, maxRetries = 2 } = {}) {
    if (model !== JEV_MODEL_ID) throw new Error(`Jev model is pinned to ${JEV_MODEL_ID}.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("Jev timeout must be between 1000 and 120000 ms.");
    this.#apiKey = apiKey ?? readApiKeyFile(apiKeyFile);
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, Math.min(3, Number.isInteger(maxRetries) ? maxRetries : 2));
  }

  async decide({ state, questions, signal } = {}) {
    if (!this.#apiKey) throw new JevRequestError("configuration", "Jev review credential is unavailable; the decision boundary cannot be reviewed.");
    let safeState;
    try { safeState = normalizeState(state); }
    catch { throw new JevRequestError("privacy", "Jev state did not match the minimized typed evidence contract."); }
    const stateBytes = Buffer.byteLength(JSON.stringify(safeState), "utf8");
    if (stateBytes > MAX_STATE_BYTES) throw new JevRequestError("privacy", "Jev state exceeded the minimized evidence byte limit.");
    const safeQuestions = normalizeQuestions(questions);
    const requestBody = JSON.stringify({ model: this.model, state: safeState, questions: safeQuestions });
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
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
          body: requestBody,
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) throw abortError();
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
        if (payload?.model !== undefined && payload.model !== JEV_MODEL_ID) {
          throw new JevRequestError("schema", "Jev response model did not match the pinned decision model.");
        }
        const answers = normalizeAnswers(payload?.answers, safeQuestions);
        return {
          model: this.model,
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
