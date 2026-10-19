import { readdir, lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test-lab/catalog/live/public-search");
const FIELDS = new Set(["schemaVersion", "scenarioId", "siteId", "qualificationTier", "authorizationProfileId", "entryUrl", "entryPathPrefixes", "searchPath", "searchQueryParameter", "destinationOrigin", "destinationPathPrefixes", "queryPoolId", "allowedEffects", "limits", "cleanup"]);

const TOPIC_POOLS = Object.freeze({
  neutral_public_topics_v1: Object.freeze([
    Object.freeze({ code: "aurora", query: "how auroras form", goalTarget: "aurora", terms: ["aurora", "auroras"] }),
    Object.freeze({ code: "octopus-camouflage", query: "how octopuses use camouflage", goalTarget: "octopus", terms: ["octopus", "octopuses", "camouflage"] }),
    Object.freeze({ code: "basalt-columns", query: "how basalt columns form", goalTarget: "basalt", terms: ["basalt", "column", "columns"] }),
    Object.freeze({ code: "honeybee-dance", query: "how honeybees communicate with dance", goalTarget: "waggle dance", terms: ["honeybee", "honeybees", "honey bee", "bee", "bees", "waggle", "dance"] }),
    Object.freeze({ code: "tidal-locking", query: "what tidal locking means", goalTarget: "tidal locking", terms: ["tidal", "locking"] }),
    Object.freeze({ code: "antikythera", query: "what the Antikythera mechanism did", goalTarget: "antikythera", terms: ["antikythera"] }),
    Object.freeze({ code: "bioluminescence", query: "how bioluminescence works", goalTarget: "bioluminescence", terms: ["bioluminescence", "bioluminescent"] }),
    Object.freeze({ code: "mantis-shrimp", query: "how mantis shrimp see color", goalTarget: "mantis shrimp", terms: ["mantis", "shrimp"] }),
    Object.freeze({ code: "sundial", query: "how an analemmatic sundial works", goalTarget: "sundial", terms: ["analemmatic", "sundial"] }),
    Object.freeze({ code: "mycelium", query: "how mycelium networks grow", goalTarget: "mycelium", terms: ["mycelium"] }),
    Object.freeze({ code: "pumice", query: "why pumice can float", goalTarget: "pumice", terms: ["pumice"] }),
    Object.freeze({ code: "water-bear", query: "how tardigrades survive extreme conditions", goalTarget: "tardigrade", terms: ["tardigrade", "tardigrades"] })
  ])
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some(key => !keys.has(key))) throw new Error(`${label} contains unsupported or missing fields.`);
}

function httpsOrigin(value, label) {
  if (typeof value !== "string" || value.length > 512) throw new Error(`${label} must be a bounded HTTPS origin.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid HTTPS origin.`); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return url.origin;
}

function pathPrefixes(values, label) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) throw new Error(`${label} must be a bounded path-prefix list.`);
  const normalized = values.map((value, index) => {
    if (typeof value !== "string" || !value.startsWith("/") || value.length > 256 || value.includes("?") || value.includes("#")
      || value.includes("\\") || value.split("/").some(segment => segment === "." || segment === "..")) {
      throw new Error(`${label}[${index}] must be an absolute path prefix without traversal.`);
    }
    return value.endsWith("/") ? value : `${value}/`;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique.`);
  return Object.freeze(normalized);
}

export function validatePublicSearchScenario(value) {
  const normalized = value && typeof value === "object" && Object.hasOwn(value, "entryOrigin");
  exactKeys(value, normalized ? new Set([...FIELDS, "entryOrigin"]) : FIELDS, "Public-search scenario");
  if (value.schemaVersion !== 1 || !ID.test(value.scenarioId ?? "") || !ID.test(value.siteId ?? "")
    || !ID.test(value.authorizationProfileId ?? "") || value.qualificationTier !== "public_live_readonly") {
    throw new Error("Public-search scenario identity or tier is unsupported.");
  }
  const entry = new URL(value.entryUrl);
  const entryOrigin = httpsOrigin(entry.origin, "entryUrl origin");
  if (normalized && value.entryOrigin !== entryOrigin) throw new Error("Normalized public-search entry origin does not match entryUrl.");
  if (entry.href !== value.entryUrl || entry.search || entry.hash || entry.username || entry.password) throw new Error("entryUrl must be a clean HTTPS page URL.");
  const entryPathPrefixes = pathPrefixes(value.entryPathPrefixes, "entryPathPrefixes");
  if (!entryPathPrefixes.some(prefix => entry.pathname === prefix.slice(0, -1) || entry.pathname.startsWith(prefix))) throw new Error("entryUrl is outside its admitted path scope.");
  if (typeof value.searchPath !== "string" || !value.searchPath.startsWith("/") || value.searchPath.length > 256
    || value.searchPath.includes("?") || value.searchPath.includes("#") || value.searchPath.includes("\\")
    || value.searchPath.split("/").some(segment => segment === "." || segment === "..")
    || !entryPathPrefixes.some(prefix => value.searchPath === prefix.slice(0, -1) || value.searchPath.startsWith(prefix))) {
    throw new Error("searchPath must remain inside the admitted search-engine path scope.");
  }
  if (typeof value.searchQueryParameter !== "string" || !/^[a-z][a-z0-9_]{0,31}$/u.test(value.searchQueryParameter)) {
    throw new Error("searchQueryParameter must be a bounded query parameter name.");
  }
  const destinationOrigin = httpsOrigin(value.destinationOrigin, "destinationOrigin");
  if (destinationOrigin === entryOrigin) throw new Error("The public search scenario must browse to a distinct origin.");
  const destinationPathPrefixes = pathPrefixes(value.destinationPathPrefixes, "destinationPathPrefixes");
  if (value.queryPoolId !== "neutral_public_topics_v1") throw new Error("Unknown public search query pool.");
  if (!Array.isArray(value.allowedEffects) || value.allowedEffects.length !== 4
    || new Set(value.allowedEffects).size !== 4
    || ["read", "navigate", "search_query", "scroll"].some(effect => !value.allowedEffects.includes(effect))) {
    throw new Error("Public search allows only read, search query, same-scope navigation, and scrolling.");
  }
  exactKeys(value.limits, new Set(["maxActions", "maxModelAttempts", "maxRequestsPerMinute", "maxDurationSeconds"]), "Public-search limits");
  const limits = value.limits;
  if (!Number.isInteger(limits.maxActions) || limits.maxActions < 2 || limits.maxActions > 8
    || !Number.isInteger(limits.maxModelAttempts) || limits.maxModelAttempts < 1 || limits.maxModelAttempts > 4
    || !Number.isInteger(limits.maxRequestsPerMinute) || limits.maxRequestsPerMinute < 2 || limits.maxRequestsPerMinute > 12
    || !Number.isInteger(limits.maxDurationSeconds) || limits.maxDurationSeconds < 30 || limits.maxDurationSeconds > 180) {
    throw new Error("Public-search limits are outside the bounded live qualification envelope.");
  }
  exactKeys(value.cleanup, new Set(["kind"]), "Public-search cleanup");
  if (value.cleanup.kind !== "remove_ephemeral_browser_state_keep_learning_history") throw new Error("Public-search cleanup must preserve durable ActiveTab history.");
  return Object.freeze({
    ...value,
    entryUrl: entry.href,
    entryOrigin,
    entryPathPrefixes,
    destinationOrigin,
    destinationPathPrefixes,
    allowedEffects: Object.freeze([...value.allowedEffects]),
    limits: Object.freeze({ ...limits }),
    cleanup: Object.freeze({ ...value.cleanup })
  });
}

export async function listPublicSearchScenarios({ directory = ROOT } = {}) {
  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Public-search catalog must be a real directory.");
  const scenarios = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name.slice(0, -5);
    if (!ID.test(id)) continue;
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) throw new Error(`Unsafe public-search manifest '${entry.name}'.`);
    const scenario = validatePublicSearchScenario(JSON.parse(await readFile(path, "utf8")));
    if (scenario.scenarioId !== id) throw new Error(`Public-search manifest filename does not match '${id}'.`);
    scenarios.push(scenario);
  }
  return Object.freeze(scenarios);
}

export async function loadPublicSearchScenario(scenarioId, options = {}) {
  if (!ID.test(scenarioId ?? "")) throw new Error("A registered public-search scenario ID is required.");
  const matches = (await listPublicSearchScenarios(options)).filter(scenario => scenario.scenarioId === scenarioId);
  if (matches.length !== 1) throw new Error(`No unique public-search scenario '${scenarioId}' is registered.`);
  return matches[0];
}

export function chooseNeutralTopic(queryPoolId = "neutral_public_topics_v1", randomIntImpl = randomInt) {
  const pool = TOPIC_POOLS[queryPoolId];
  if (!pool) throw new Error("The public search scenario references an unknown topic pool.");
  const topic = pool[randomIntImpl(pool.length)];
  return Object.freeze({ ...topic, query: `${topic.query} site:en.wikipedia.org` });
}

export function buildPublicSearchUrl(scenario, topic) {
  if (!scenario || typeof topic?.query !== "string" || !topic.query.trim() || topic.query.length > 500) {
    throw new Error("A validated scenario and bounded neutral topic are required to build the search URL.");
  }
  const url = new URL(scenario.entryUrl);
  url.pathname = scenario.searchPath;
  url.search = "";
  url.hash = "";
  url.searchParams.set(scenario.searchQueryParameter, topic.query);
  if (url.origin !== scenario.entryOrigin || !scenario.entryPathPrefixes.some(prefix => url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix))) {
    throw new Error("The generated public-search URL escaped the admitted search-engine scope.");
  }
  return url.href;
}

export function publicSearchGoals(topic) {
  if (!topic || typeof topic.query !== "string" || typeof topic.code !== "string" || typeof topic.goalTarget !== "string") throw new Error("A validated neutral query-pool topic is required.");
  return Object.freeze({
    search: `Search for ${topic.query}`,
    browse: `Open the ${topic.goalTarget} page on Wikipedia`
  });
}
