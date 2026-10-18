import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, ModelRequestError } from "../src/navigation/modelProvider.js";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return new Response(JSON.stringify(payload), { status: ok ? status : status || 500, headers: { "content-type": "application/json" } });
}

test("provider returns the parsed decision and records usage when provided", async () => {
  let seen;
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1/",
    apiKey: "provider-secret",
    model: "test-model",
    fetchImpl: async (url, options) => {
      seen = { url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "click", identity: "c-1" }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
  });
  const { decision, usage } = await provider.decide([{ role: "user", content: "hi" }]);
  assert.deepEqual(decision, { action: "click", identity: "c-1" });
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(seen.url, "https://model.example.test/v1/chat/completions", "trailing slashes are normalized");
  assert.equal(seen.body.model, "test-model");
  assert.equal(seen.headers.authorization, "Bearer provider-secret");
  assert.equal(Object.hasOwn(provider, "apiKey"), false, "provider credentials are held in a private class field");
  assert.equal(JSON.stringify(provider).includes("provider-secret"), false);
});

test("malformed JSON is a schema error, never a decision", async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "not json at all" } }] })
  });
  await assert.rejects(provider.decide([{ role: "user", content: "x" }]), error => {
    assert.ok(error instanceof ModelRequestError);
    assert.equal(error.kind, "schema");
    return true;
  });
});

test("out-of-schema actions are rejected by strict validation", async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "delete_account" }) } }] })
  });
  await assert.rejects(provider.decide([{ role: "user", content: "x" }], { jsonActions: ["click", "scroll", "stop"] }), /not one of the supported actions/);
});

test("caller cancellation aborts the in-flight request", async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      assert.ok(options.signal, "request carries an AbortSignal");
      options.signal.addEventListener("abort", () => {
        const error = new Error("canceled");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  const controller = new AbortController();
  const pending = provider.decide([{ role: "user", content: "x" }], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
});

test("caller cancellation while reading a response body remains an abort, not a schema failure", async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      }
    }))
  });
  const controller = new AbortController();
  const pending = provider.decide([{ role: "user", content: "x" }], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
});

test("the total request deadline covers response-body reading", async () => {
  let attempts = 0;
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    timeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => {
      attempts++;
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        }
      }));
    }
  });
  await assert.rejects(provider.decide([{ role: "user", content: "x" }]), error => error.kind === "timeout");
  assert.equal(attempts, 1, "an expired total deadline does not start another attempt");
});

test("transport failures retry with backoff; HTTP 4xx never retries", async () => {
  let attempts = 0;
  const flaky = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => {
      attempts++;
      if (attempts < 3) throw new Error("network down");
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "stop", reason: "done" }) } }] });
    }
  });
  const { decision } = await flaky.decide([{ role: "user", content: "x" }]);
  assert.equal(decision.action, "stop");
  assert.equal(attempts, 3);

  let hardAttempts = 0;
  const unauthorized = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => { hardAttempts++; return jsonResponse({}, { ok: false, status: 401 }); }
  });
  await assert.rejects(unauthorized.decide([{ role: "user", content: "x" }]), /HTTP 401/);
  assert.equal(hardAttempts, 1, "4xx responses are not retried");
});

test("structured requests use declared provider format, token bounds, schema validation, and usage", async () => {
  let request;
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "GLM5.3-flash",
    structuredOutput: "json_schema",
    maxTokens: 512,
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ observationId: "obs-1", annotations: [] }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 8 } }
      });
    }
  });
  const schema = {
    type: "object", required: ["observationId", "annotations"], additionalProperties: false,
    properties: { observationId: { type: "string" }, annotations: { type: "array", items: { type: "object" } } }
  };
  const result = await provider.requestStructured({ task: "map_controls", instructions: "Annotate only.", input: { observationId: "obs-1" }, schema });
  assert.equal(result.result.observationId, "obs-1");
  assert.equal(result.model, "GLM5.3-flash");
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, cached_tokens: 8 });
  assert.equal(request.body.max_tokens, 512);
  assert.equal(request.body.response_format.type, "json_schema");
  assert.deepEqual(request.body.response_format.json_schema.schema, schema);
});

test("structured inference retries rate limits and rejects schema-invalid annotations", async () => {
  let attempts = 0;
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => {
      attempts++;
      if (attempts < 2) return jsonResponse({}, { ok: false, status: 429 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ result: "invented" }) } }] });
    }
  });
  await assert.rejects(provider.requestStructured({
    task: "classify_page",
    instructions: "Return a category.",
    input: { pageType: "unknown" },
    schema: { type: "object", required: ["result"], additionalProperties: false, properties: { result: { type: "string", enum: ["form", "list"] } } }
  }), error => error.kind === "schema");
  assert.equal(attempts, 2, "HTTP 429 is retried within the total request deadline.");
});

test("OpenAI-compatible response bodies are byte bounded", async () => {
  const provider = new OpenAICompatibleProvider({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    fetchImpl: async () => new Response(`${JSON.stringify({ choices: [] })}${" ".repeat(256 * 1024)}`)
  });
  await assert.rejects(provider.decide([{ role: "user", content: "x" }]), error => error.kind === "response_too_large");
});

test("provider constructor validates endpoint, model, and timeout bounds", () => {
  assert.throws(() => new OpenAICompatibleProvider({ model: "m" }), /endpoint and model/);
  assert.throws(() => new OpenAICompatibleProvider({ endpoint: "https://x.test/v1", model: "m", timeoutMs: 10 }), /between 1000 and/);
});

test("planner surfaces measured usage and model failures stay distinct from navigation decisions", async () => {
  const { OpenAICompatiblePlanner } = await import("../src/navigation/planner.js");
  const planner = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "click", identity: "candidate-1" }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  });
  const observation = { page: { url: "https://example.test", title: "T" }, headings: [], frames: [], candidates: [{ identity: "candidate-1", tag: "button", role: "button", name: "Go", visible: true }] };
  const plan = await planner.plan("Go", observation);
  assert.equal(plan.status, "planned");
  assert.equal(plan.modelUsage.calls, 1);
  assert.equal(plan.modelUsage.total_tokens, 5);

  // A model-side failure must surface as an error (model failure), and the
  // caller decides; it is never silently converted into a browser action.
  const failing = new OpenAICompatiblePlanner({
    endpoint: "https://model.example.test/v1",
    model: "test-model",
    allowPageContent: true,
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 })
  });
  await assert.rejects(failing.plan("Go", observation), /HTTP 500/);
});

test("second provider: Ollama via OpenAI-compatible endpoint", { timeout: 30_000 }, async t => {
  const endpoint = process.env.ACTIVETAB_SECOND_PROVIDER_ENDPOINT;
  const model = process.env.ACTIVETAB_SECOND_PROVIDER_MODEL;
  if (!endpoint || !model) {
    t.skip("Set ACTIVETAB_SECOND_PROVIDER_ENDPOINT and ACTIVETAB_SECOND_PROVIDER_MODEL to verify a second provider.");
    return;
  }
  const provider = new OpenAICompatibleProvider({ endpoint, apiKey: "not-required", model, timeoutMs: 20_000 });
  const { decision, usage } = await provider.decide([
    { role: "system", content: "Return only JSON: {\"action\":\"stop\",\"reason\":\"...\"}." },
    { role: "user", content: "Test: return a stop action." }
  ], { jsonActions: ["stop"] });
  assert.equal(decision.action, "stop");
  assert.ok(typeof decision.reason === "string");
  if (usage) {
    assert.ok(typeof usage.total_tokens === "number");
    t.diagnostic(`Ollama provider usage: ${JSON.stringify(usage)}`);
  }
});
