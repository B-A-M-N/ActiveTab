/**
 * Provider-neutral OpenAI-compatible chat client used by the optional
 * model planner. Works with any provider exposing an OpenAI-compatible
 * /chat/completions endpoint; nothing provider-specific is embedded here.
 *
 * Contract guarantees:
 * - Per-request deadlines (default 30 s, hard cap 5 min).
 * - AbortSignal propagation: cancellation aborts the in-flight request.
 * - Strict structured-response validation: a malformed or missing JSON
 *   payload is a MODEL error, never a browser action.
 * - Transport errors get bounded retries with exponential backoff;
 *   HTTP 4xx, schema, and refusal responses are never retried.
 * - Provider-reported usage is recorded when present and returned to the
 *   caller; nothing is fabricated when a provider omits it.
 * - Provider credentials travel only in request headers and are never
 *   logged, journaled, or embedded in evidence.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TRANSPORT_RETRIES = 2;

export class ModelRequestError extends Error {
  constructor(kind, message, { usage = null, retriable = false } = {}) {
    super(message);
    this.name = "ModelRequestError";
    this.kind = kind; // "transport" | "http" | "schema" | "refusal"
    this.usage = usage;
    this.retriable = retriable;
  }
}

export class OpenAICompatibleProvider {
  constructor({ endpoint, apiKey, model, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!endpoint || !model) throw new Error("A model endpoint and model name are required.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`Model request timeout must be between 1000 and ${MAX_TIMEOUT_MS} ms.`);
    }
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send one chat completion and parse the reply content as JSON.
   * @param {Array} messages - OpenAI-style message list.
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Caller cancellation.
   * @param {number} [options.temperature] - Sampling temperature (default 0).
   * @param {string[]} [options.jsonActions] - Allowed "action" values for strict validation.
   * @returns {Promise<{decision: object, usage: object|null, raw: string}>}
   */
  async decide(messages, { signal, temperature = 0, jsonActions } = {}) {
    const url = `${this.endpoint}/chat/completions`;
    let attempt = 0;
    let lastError;
    while (attempt <= MAX_TRANSPORT_RETRIES) {
      try {
        return await this.#requestOnce(url, messages, { signal, temperature, jsonActions });
      } catch (error) {
        lastError = error;
        if (error instanceof ModelRequestError && error.kind === "transport" && attempt < MAX_TRANSPORT_RETRIES && !signal?.aborted) {
          attempt++;
          const delay = 250 * 2 ** (attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async #requestOnce(url, messages, { signal, temperature, jsonActions }) {
    const controller = new AbortController();
    const timers = [];
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const onFetchAbort = () => {};
    controller.signal.addEventListener("abort", onFetchAbort);
    timers.push(setTimeout(() => controller.abort(), this.timeoutMs));
    try {
      let response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.model, temperature, messages }),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted) {
            const abortError = new Error("The model request was canceled.");
            abortError.name = "AbortError";
            abortError.code = 20;
            throw abortError;
          }
          throw new ModelRequestError("transport", `Model request exceeded the ${this.timeoutMs} ms deadline.`, { retriable: true });
        }
        throw new ModelRequestError("transport", `Model request failed: ${String(error?.message ?? error).slice(0, 200)}`, { retriable: true });
      }

      if (!response.ok) {
        // 4xx (auth, model, payload) is never retried; 5xx and 429 are transport-class.
        const retriable = response.status === 429 || response.status >= 500;
        throw new ModelRequestError("http", `Model endpoint returned HTTP ${response.status}.`, { retriable });
      }

      let payload;
      try { payload = await response.json(); }
      catch { throw new ModelRequestError("schema", "Model endpoint returned a non-JSON payload."); }

      const usage = normalizeUsage(payload?.usage);
      const content = payload?.choices?.[0]?.message?.content;
      const finishReason = payload?.choices?.[0]?.finish_reason;

      if (finishReason === "length") {
        throw new ModelRequestError("schema", "Model response was truncated (finish_reason=length); treating as unusable.", { usage });
      }
      if (typeof content !== "string" || !content.trim()) {
        throw new ModelRequestError("refusal", "Model returned no usable content.", { usage });
      }

      let decision;
      try { decision = JSON.parse(content); }
      catch { throw new ModelRequestError("schema", "Model response did not contain the required JSON decision shape.", { usage }); }
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        throw new ModelRequestError("schema", "Model decision must be a JSON object.", { usage });
      }
      if (jsonActions && !jsonActions.includes(decision.action)) {
        throw new ModelRequestError("schema", `Model decision action "${String(decision.action).slice(0, 64)}" is not one of the supported actions.`, { usage });
      }
      return { decision, usage, raw: content };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onFetchAbort);
      signal?.removeEventListener?.("abort", onCallerAbort);
    }
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (Number.isFinite(usage[key])) result[key] = usage[key];
  }
  return Object.keys(result).length ? result : null;
}
