import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { preflightModelCapabilities, writeModelPreflightSummary } from "../src/navigation/modelPreflight.js";

test("startup preflight discovers each configured model role without sending page evidence or logging credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-model-preflight-"));
  const databasePath = join(directory, "preflight.sqlite");
  const env = {
    ACTIVETAB_SEMANTIC_ENDPOINT: "https://fi.example/v1",
    ACTIVETAB_SEMANTIC_MODEL: "glm-5.3-flash",
    ACTIVETAB_SEMANTIC_API_KEY: "fixture-fi-secret",
    ACTIVETAB_JEV_KEY_FILE: join(directory, "missing-JEV.txt"),
    JEV_API_KEY: "fixture-jev-secret",
    ACTIVETAB_JEV_ALLOW_IMAGES: "1"
  };
  const requests = [];
  try {
    const result = await preflightModelCapabilities({
      env,
      databasePath,
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        if (String(url) === "https://fi.example/v1/models") {
          return new Response(JSON.stringify({ data: [{
            id: "glm-5.3-flash",
            input_modalities: ["text", "image"],
            output_modalities: ["text"]
          }] }), { status: 200 });
        }
        if (String(url) === "https://openrouter.ai/api/v1/model/typesafe/jev-1.14") {
          return new Response(JSON.stringify({ data: {
            id: "typesafe/jev-1.14",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }
          } }), { status: 200 });
        }
        throw new Error("unexpected catalog request");
      }
    });

    assert.equal(result.status, "available");
    assert.deepEqual(result.routes.map(route => route.role), ["semantic", "planner", "workflow", "jev"]);
    assert.ok(result.routes.every(route => route.inputModalities.includes("text")));
    assert.ok(result.routes.every(route => route.inferenceReachability === "not_probed"),
      "catalog modality does not claim that inference is currently reachable");
    assert.ok(result.routes.every(route => route.imageCapability));
    assert.equal(env.ACTIVETAB_SEMANTIC_IMAGE_INPUT, "1");
    assert.equal(env.ACTIVETAB_MODEL_IMAGE_INPUT, "1");
    assert.equal(env.ACTIVETAB_WORKFLOW_IMAGE_INPUT, "1");
    assert.equal(env.ACTIVETAB_JEV_CATALOG_IMAGE_INPUT, "1");
    assert.equal(requests.length, 2, "identical configured routes share a catalog fetch");
    assert.ok(requests.some(request => request.options.headers.authorization === "Bearer fixture-fi-secret"));
    assert.ok(requests.some(request => request.options.headers.authorization === "Bearer fixture-jev-secret"));
    assert.ok(requests.every(request => request.options.method === undefined));
    assert.ok(requests.every(request => request.options.body === undefined));

    const summary = { write(value) { this.value = value; } };
    writeModelPreflightSummary(result, summary);
    assert.equal(summary.value.includes("fixture-fi-secret"), false);
    assert.equal(summary.value.includes("fixture-jev-secret"), false);
    assert.match(summary.value, /"inferenceReachability":"not_probed"/u);

    const store = new DecisionEventStore({ databasePath });
    try {
      const events = store.getEvents(store.listEpisodes()[0].episode_id);
      assert.deepEqual(events.filter(event => event.eventType === "model.capability_preflight").map(event => event.payload.providerRole), ["semantic", "planner", "workflow", "jev"]);
      assert.ok(events.every(event => event.trainingEligibility === "excluded"));
      assert.equal(JSON.stringify(events).includes("fixture-jev-secret"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup preflight disables image capability when a catalog explicitly reports text-only input", async () => {
  const env = {
    ACTIVETAB_SEMANTIC_ENDPOINT: "https://fi.example/v1",
    ACTIVETAB_SEMANTIC_MODEL: "glm-5.3-flash",
    ACTIVETAB_SEMANTIC_API_KEY: "fixture-fi-secret",
    ACTIVETAB_JEV_KEY_FILE: join(tmpdir(), "activetab-missing-jev-model-preflight-key"),
    ACTIVETAB_SEMANTIC_IMAGE_INPUT: "1",
    ACTIVETAB_MODEL_IMAGE_INPUT: "1",
    ACTIVETAB_WORKFLOW_IMAGE_INPUT: "1"
  };
  const result = await preflightModelCapabilities({
    env,
    databasePath: ":memory:",
    fetchImpl: async () => new Response(JSON.stringify({ data: [{
      id: "glm-5.3-flash",
      input_modalities: ["text"],
      output_modalities: ["text"]
    }] }), { status: 200 })
  });

  assert.equal(result.routes.length, 3);
  assert.ok(result.routes.every(route => route.status === "available" && route.imageCapability === false));
  assert.equal(env.ACTIVETAB_SEMANTIC_IMAGE_INPUT, "0");
  assert.equal(env.ACTIVETAB_MODEL_IMAGE_INPUT, "0");
  assert.equal(env.ACTIVETAB_WORKFLOW_IMAGE_INPUT, "0");
});

test("startup preflight resolves modalities per configured model when roles share an endpoint", async () => {
  const env = {
    ACTIVETAB_SEMANTIC_ENDPOINT: "https://shared.example/v1",
    ACTIVETAB_SEMANTIC_MODEL: "text-model",
    ACTIVETAB_SEMANTIC_API_KEY: "shared-secret",
    ACTIVETAB_MODEL_ENDPOINT: "https://shared.example/v1",
    ACTIVETAB_MODEL: "vision-model",
    ACTIVETAB_MODEL_API_KEY: "shared-secret",
    ACTIVETAB_WORKFLOW_ENDPOINT: "https://shared.example/v1",
    ACTIVETAB_WORKFLOW_MODEL: "text-model",
    ACTIVETAB_WORKFLOW_API_KEY: "shared-secret",
    ACTIVETAB_SEMANTIC_IMAGE_INPUT: "1",
    ACTIVETAB_MODEL_IMAGE_INPUT: "1",
    ACTIVETAB_WORKFLOW_IMAGE_INPUT: "1",
    ACTIVETAB_JEV_KEY_FILE: join(tmpdir(), "activetab-missing-shared-model-preflight-jev")
  };
  const requested = [];
  const result = await preflightModelCapabilities({
    env,
    databasePath: ":memory:",
    fetchImpl: async url => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: [
        { id: "text-model", input_modalities: ["text"], output_modalities: ["text"] },
        { id: "vision-model", input_modalities: ["text", "image"], output_modalities: ["text"] }
      ] }), { status: 200 });
    }
  });
  assert.equal(requested.length, 2, "the shared text model is fetched once while the distinct vision model gets its own lookup");
  assert.deepEqual(result.routes.map(route => [route.role, route.model, route.imageCapability]), [
    ["semantic", "text-model", false],
    ["planner", "vision-model", true],
    ["workflow", "text-model", false]
  ]);
  assert.equal(env.ACTIVETAB_SEMANTIC_IMAGE_INPUT, "0");
  assert.equal(env.ACTIVETAB_MODEL_IMAGE_INPUT, "1");
  assert.equal(env.ACTIVETAB_WORKFLOW_IMAGE_INPUT, "0");
});
