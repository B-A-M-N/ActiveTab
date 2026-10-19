import { randomUUID, createHash } from "node:crypto";
import { DecisionEventStore } from "../telemetry/eventStore.js";
import { TRAINING_ELIGIBILITY } from "../telemetry/decisionEvents.js";
import { defaultJevCredentialFile, JEV_MODEL_ID, resolveJevApiKey } from "../decisions/jevClient.js";

const MAX_CATALOG_BYTES = 128 * 1024;
const PREFLIGHT_TIMEOUT_MS = 4_000;
const SUPPORTED_MODALITIES = new Set(["text", "image", "audio", "video"]);

function routeConfig(env) {
  const semanticEndpoint = env.ACTIVETAB_SEMANTIC_ENDPOINT ?? env.ACTIVETAB_MODEL_ENDPOINT;
  const plannerEndpoint = env.ACTIVETAB_MODEL_ENDPOINT ?? env.ACTIVETAB_SEMANTIC_ENDPOINT;
  const workflowEndpoint = env.ACTIVETAB_WORKFLOW_ENDPOINT ?? env.ACTIVETAB_SEMANTIC_ENDPOINT ?? env.ACTIVETAB_MODEL_ENDPOINT;
  const semanticModel = env.ACTIVETAB_SEMANTIC_MODEL ?? "glm-5.3-flash";
  const plannerModel = env.ACTIVETAB_MODEL ?? env.ACTIVETAB_SEMANTIC_MODEL
    ?? ((env.ACTIVETAB_MODEL_ENDPOINT || env.ACTIVETAB_SEMANTIC_ENDPOINT) ? "glm-5.3-flash" : undefined);
  const workflowModel = env.ACTIVETAB_WORKFLOW_MODEL ?? env.ACTIVETAB_SEMANTIC_MODEL ?? "glm-5.3-flash";
  const routes = [
    {
      role: "semantic", endpoint: semanticEndpoint, model: semanticModel,
      apiKey: env.ACTIVETAB_SEMANTIC_API_KEY ?? env.ACTIVETAB_MODEL_API_KEY ?? env.FREEINFERENCE_API_KEY,
      imageEnv: "ACTIVETAB_SEMANTIC_IMAGE_INPUT",
      fallbackImageInput: env.ACTIVETAB_SEMANTIC_IMAGE_INPUT === "1" || env.ACTIVETAB_MODEL_IMAGE_INPUT === "1"
    },
    {
      role: "planner", endpoint: plannerEndpoint, model: plannerModel,
      apiKey: env.ACTIVETAB_MODEL_API_KEY ?? env.ACTIVETAB_SEMANTIC_API_KEY ?? env.FREEINFERENCE_API_KEY,
      imageEnv: "ACTIVETAB_MODEL_IMAGE_INPUT",
      fallbackImageInput: env.ACTIVETAB_MODEL_IMAGE_INPUT === "1"
    },
    {
      role: "workflow", endpoint: workflowEndpoint, model: workflowModel,
      apiKey: env.ACTIVETAB_WORKFLOW_API_KEY ?? env.ACTIVETAB_SEMANTIC_API_KEY ?? env.ACTIVETAB_MODEL_API_KEY ?? env.FREEINFERENCE_API_KEY,
      imageEnv: "ACTIVETAB_WORKFLOW_IMAGE_INPUT",
      fallbackImageInput: env.ACTIVETAB_WORKFLOW_IMAGE_INPUT === "1" || env.ACTIVETAB_MODEL_IMAGE_INPUT === "1"
    }
  ].filter(route => typeof route.endpoint === "string" && route.endpoint.length > 0 && typeof route.model === "string" && route.model.length > 0);
  try {
    const apiKeyFile = defaultJevCredentialFile(env);
    const apiKey = resolveJevApiKey({ env, apiKeyFile });
    if (apiKey) routes.push({
      role: "jev",
      endpoint: `https://openrouter.ai/api/v1/model/${JEV_MODEL_ID}`,
      catalogKind: "openrouter_model",
      model: JEV_MODEL_ID,
      apiKey,
      imageEnv: "ACTIVETAB_JEV_CATALOG_IMAGE_INPUT",
      fallbackImageInput: env.ACTIVETAB_JEV_ALLOW_IMAGES === "1"
    });
  } catch {
    // An invalid or inaccessible optional Jev credential is handled by the
    // decision runtime as unavailable; it must not prevent deterministic work.
  }
  return routes;
}

function catalogUrl(endpoint) {
  const url = new URL(endpoint);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("unsupported_protocol");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/models")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url;
}

async function readBoundedJson(response) {
  if (!response.body?.getReader) throw new Error("catalog_body_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("catalog_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function normalizeModalities(value) {
  if (!Array.isArray(value) || value.length > 16) return null;
  const modalities = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const modality = item.toLowerCase() === "vision" ? "image" : item.toLowerCase();
    if (SUPPORTED_MODALITIES.has(modality)) modalities.add(modality);
  }
  return [...modalities].sort();
}

function modalitiesForModel(entry) {
  return normalizeModalities(entry?.input_modalities)
    ?? normalizeModalities(entry?.architecture?.input_modalities)
    ?? normalizeModalities(entry?.modalities)
    ?? normalizeModalities(entry?.capabilities?.input_modalities)
    ?? normalizeModalities(entry?.capabilities?.modalities);
}

async function fetchCatalog(route, fetchImpl) {
  const url = route.catalogKind === "openrouter_model"
    ? new URL(route.endpoint)
    : catalogUrl(route.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {})
      },
      signal: controller.signal
    });
    if (!response.ok) return { status: "unknown", source: "configured_fallback", inputModalities: [], outputModalities: [] };
    const payload = await readBoundedJson(response);
    let entry;
    if (route.catalogKind === "openrouter_model") {
      entry = payload?.data?.id === route.model ? payload.data : null;
    } else {
      if (!Array.isArray(payload?.data) || payload.data.length > 10_000) {
        return { status: "unknown", source: "configured_fallback", inputModalities: [], outputModalities: [] };
      }
      entry = payload.data.find(item => item?.id === route.model);
    }
    if (!entry) return { status: "unavailable", source: "authenticated_catalog", inputModalities: [], outputModalities: [] };
    const modalities = modalitiesForModel(entry);
    const outputModalities = normalizeModalities(entry.output_modalities)
      ?? normalizeModalities(entry.architecture?.output_modalities)
      ?? normalizeModalities(entry.capabilities?.output_modalities)
      ?? [];
    if (!modalities) return { status: "unknown", source: "configured_fallback", inputModalities: [], outputModalities };
    if (!modalities.includes("text")) return { status: "unavailable", source: "authenticated_catalog", inputModalities: modalities, outputModalities };
    return { status: "available", source: "authenticated_catalog", inputModalities: modalities, outputModalities };
  } catch {
    return { status: "unknown", source: "configured_fallback", inputModalities: [], outputModalities: [] };
  } finally {
    clearTimeout(timer);
  }
}

function privateEndpointKey(route) {
  // Catalog capability is model-specific even when several roles share the
  // same endpoint and credential. This private key is never emitted.
  return createHash("sha256").update(`${route.endpoint}\0${route.apiKey ?? ""}\0${route.catalogKind ?? "openai_compatible"}\0${route.model}`).digest("hex");
}

function recordPreflightEvents(results, databasePath) {
  const store = new DecisionEventStore(databasePath ? { databasePath } : {});
  try {
    const runId = randomUUID();
    const episode = store.startEpisode({
      runId,
      workflowId: "model_capability_preflight",
      applicationId: "active_tab",
      environmentClass: "unknown",
      executionMode: "standalone",
      policyVersion: "model_capability_preflight_v1",
      workflowKind: "model_capability_preflight",
      trainingEligibility: TRAINING_ELIGIBILITY.EXCLUDED
    });
    for (const result of results) {
      store.append({
        episodeId: episode.episodeId,
        runId,
        stepId: "startup_preflight",
        decisionId: randomUUID(),
        eventType: "model.capability_preflight",
        trainingEligibility: "excluded",
        payload: {
          providerRole: result.role,
          model: result.model,
          capabilityStatus: result.status,
          capabilitySource: result.source,
          inputModalities: result.inputModalities,
          outputModalities: result.outputModalities,
          imageCapability: result.imageCapability
        }
      });
    }
    store.append({
      episodeId: episode.episodeId,
      runId,
      eventType: "episode.completed",
      trainingEligibility: "excluded",
      payload: { status: results.every(result => result.status === "available") ? "passed" : "uncertain", cleanupStatus: "not_required" }
    });
  } finally {
    store.close();
  }
}

/**
 * Inspect each configured OpenAI-compatible model route at process startup.
 * Catalog failures leave text inference configured and use an explicit image
 * capability declaration only as a fallback. Screenshot privacy consent is
 * checked separately by each inference client.
 */
export async function preflightModelCapabilities({ env = process.env, fetchImpl = fetch, databasePath } = {}) {
  const routes = routeConfig(env);
  if (!routes.length) return Object.freeze({ status: "skipped", routes: [] });

  const catalogByEndpoint = new Map();
  const results = await Promise.all(routes.map(async route => {
    let catalogPromise = catalogByEndpoint.get(privateEndpointKey(route));
    if (!catalogPromise) {
      catalogPromise = fetchCatalog(route, fetchImpl);
      catalogByEndpoint.set(privateEndpointKey(route), catalogPromise);
    }
    const capability = await catalogPromise;
    const imageCapability = capability.status === "available"
      ? capability.inputModalities.includes("image")
      : capability.status === "unavailable" ? false : route.fallbackImageInput;
    env[route.imageEnv] = imageCapability ? "1" : "0";
    return Object.freeze({
      role: route.role,
      model: route.model,
      status: capability.status,
      source: capability.source,
      inferenceReachability: "not_probed",
      inputModalities: capability.inputModalities,
      outputModalities: capability.outputModalities,
      imageCapability
    });
  }));

  let telemetryRecorded = true;
  try {
    recordPreflightEvents(results, databasePath);
  } catch {
    // Startup must preserve text-only operation if the local audit store is unavailable.
    telemetryRecorded = false;
  }
  return Object.freeze({
    status: results.every(result => result.status === "available") ? "available" : "partial",
    routes: Object.freeze(results),
    telemetryRecorded
  });
}

export function writeModelPreflightSummary(result, output = process.stderr) {
  if (!result || result.status === "skipped") return;
  const safeSummary = {
    event: "model.capability_preflight.summary",
    status: result.status,
    telemetryRecorded: result.telemetryRecorded === true,
    routes: result.routes.map(({ role, model, status, source, inferenceReachability, inputModalities, outputModalities, imageCapability }) => ({
      role, model, status, source, inferenceReachability, inputModalities, outputModalities, imageCapability
    }))
  };
  output.write(`[ActiveTab] ${JSON.stringify(safeSummary)}\n`);
}
