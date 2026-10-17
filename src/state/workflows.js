import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_FILE_BYTES = 1_000_000;
const MAX_WORKFLOWS = 100;
const MAX_STEPS = 10;
const SCROLL_POSITION_TOLERANCE = 0.025;
const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function routeFingerprint(value) {
  try {
    const url = new URL(value);
    return hash(`${url.origin}${url.pathname}`);
  } catch { return ""; }
}

export function targetSignature(candidate) {
  const name = normalize(candidate?.name);
  if (!name) return null;
  const contextName = normalize(candidate?.contextName);
  let hrefFingerprint = null;
  try {
    if (candidate.href) {
      const href = new URL(candidate.href);
      hrefFingerprint = hash(`${href.origin}${href.pathname}`);
    }
  } catch { /* ignore malformed or non-URL links */ }
  return {
    tag: String(candidate.tag ?? "").toLowerCase().slice(0, 32),
    role: String(candidate.role ?? "").toLowerCase().slice(0, 64),
    nameFingerprint: hash(name),
    contextFingerprint: contextName ? hash(contextName) : null,
    hrefFingerprint
  };
}

export function matchesTargetSignature(candidate, signature) {
  const current = targetSignature(candidate);
  return current !== null && current.tag === signature.tag && current.role === signature.role &&
    current.nameFingerprint === signature.nameFingerprint && current.hrefFingerprint === signature.hrefFingerprint &&
    (signature.contextFingerprint === undefined || current.contextFingerprint === signature.contextFingerprint) &&
    candidate.disabled !== true && candidate.visible === true;
}

export function scrollTargetSignature(target) {
  const label = normalize(target?.name || target?.role || target?.tag);
  if (!label) return null;
  const contextName = normalize(target?.contextName);
  return {
    kind: String(target.kind ?? "").toLowerCase().slice(0, 32),
    tag: String(target.tag ?? "").toLowerCase().slice(0, 32),
    role: String(target.role ?? "").toLowerCase().slice(0, 64),
    nameFingerprint: hash(label),
    contextFingerprint: contextName ? hash(contextName) : null
  };
}

export function matchesScrollTargetSignature(target, signature) {
  const current = scrollTargetSignature(target);
  return current !== null && target.visible === true && current.kind === signature.kind && current.tag === signature.tag &&
    current.role === signature.role && current.nameFingerprint === signature.nameFingerprint &&
    current.contextFingerprint === signature.contextFingerprint;
}

export function scrollPositionFraction(target) {
  const top = Number(target?.scrollTop);
  const maximum = Number(target?.maxScrollTop);
  if (!Number.isFinite(top) || !Number.isFinite(maximum) || maximum <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, top / maximum)) * 10_000) / 10_000;
}

export function scrollPositionMatches(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= SCROLL_POSITION_TOLERANCE;
}

export function visibleCandidatesFingerprint(observation) {
  const candidates = (observation.candidates ?? [])
    .filter(candidate => candidate.visible === true && candidate.disabled !== true)
    .map(targetSignature)
    .filter(Boolean)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash(JSON.stringify(candidates));
}

function fingerprintObservation(observation, includeTargetIdentity) {
  const candidates = (observation.candidates ?? [])
    .filter(candidate => candidate.visible === true && candidate.disabled !== true)
    .map(candidate => {
      const signature = targetSignature(candidate);
      return includeTargetIdentity ? { identity: String(candidate.identity ?? "").slice(0, 256), signature } : signature;
    })
    .filter(candidate => includeTargetIdentity ? candidate.signature : candidate)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const headings = (observation.headings ?? []).map(item => hash(normalize(item.text))).sort();
  const titleFingerprint = hash(normalize(observation.page?.title));
  const scrollPositions = (observation.scrollTargets ?? []).map(target => [target.identity, Number(target.scrollTop ?? 0), target.canScrollDown === true]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return hash(JSON.stringify({ route: routeFingerprint(observation.page?.url), titleFingerprint, headings, candidates, scrollPositions }));
}

export function observationStateFingerprint(observation) {
  return fingerprintObservation(observation, true);
}

export function observationSemanticFingerprint(observation) {
  return fingerprintObservation(observation, false);
}

function validSignature(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["tag", "role", "nameFingerprint", "contextFingerprint", "hrefFingerprint"].includes(key)) &&
    typeof value.tag === "string" && value.tag.length <= 32 && typeof value.role === "string" && value.role.length <= 64 &&
    validHash(value.nameFingerprint) &&
    (value.contextFingerprint === undefined || value.contextFingerprint === null || validHash(value.contextFingerprint)) &&
    (value.hrefFingerprint === undefined || value.hrefFingerprint === null || validHash(value.hrefFingerprint));
}

function validScrollSignature(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["kind", "tag", "role", "nameFingerprint", "contextFingerprint"].includes(key)) &&
    typeof value.kind === "string" && value.kind.length <= 32 && typeof value.tag === "string" && value.tag.length <= 32 &&
    typeof value.role === "string" && value.role.length <= 64 && validHash(value.nameFingerprint) &&
    (value.contextFingerprint === null || validHash(value.contextFingerprint));
}

function validClickStep(step, legacy) {
  const keys = legacy ? ["routeFingerprint", "target"] : ["action", "routeFingerprint", "target"];
  return Object.keys(step).every(key => keys.includes(key)) &&
    (legacy || step.action === "click") && validHash(step.routeFingerprint) && validSignature(step.target);
}

function validScrollStep(step) {
  return Object.keys(step).every(key => ["action", "routeFingerprint", "scrollTarget", "beforePositionFraction", "afterPositionFraction", "beforeCandidatesFingerprint", "afterCandidatesFingerprint"].includes(key)) &&
    step.action === "scroll" && validHash(step.routeFingerprint) && validScrollSignature(step.scrollTarget) &&
    Number.isFinite(step.beforePositionFraction) && step.beforePositionFraction >= 0 && step.beforePositionFraction < 1 &&
    Number.isFinite(step.afterPositionFraction) && step.afterPositionFraction > step.beforePositionFraction && step.afterPositionFraction <= 1 &&
    validHash(step.beforeCandidatesFingerprint) && validHash(step.afterCandidatesFingerprint);
}

function validateStore(value) {
  if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.workflows) || value.workflows.length > MAX_WORKFLOWS ||
      Object.keys(value).some(key => !["schemaVersion", "workflows"].includes(key))) {
    throw new Error("Workflow store is invalid or unsupported.");
  }
  for (const workflow of value.workflows) {
    if (![1, 2].includes(workflow?.version) || (value.schemaVersion === 1 && workflow.version !== 1) || typeof workflow.id !== "string" ||
        !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(workflow.id) ||
        !validHash(workflow.goalFingerprint) || !validHash(workflow.initialRouteFingerprint) ||
        !Array.isArray(workflow.steps) || workflow.steps.length < 1 || workflow.steps.length > MAX_STEPS ||
        Object.keys(workflow).some(key => !["id", "version", "goalFingerprint", "initialRouteFingerprint", "createdAt", "updatedAt", "steps"].includes(key)) ||
        workflow.steps.some(step => !step || typeof step !== "object" || Array.isArray(step) ||
          (workflow.version === 1 ? !validClickStep(step, true) : step.action === "scroll" ? !validScrollStep(step) : !validClickStep(step, false)))) {
      throw new Error("Workflow store is invalid or unsupported.");
    }
  }
  return value;
}

async function readData(path) {
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) throw new Error("Workflow store exceeds its size limit.");
    return validateStore(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 2, workflows: [] };
    if (error instanceof SyntaxError) throw new Error("Workflow store contains invalid JSON.");
    throw error;
  }
}

export class WorkflowStore {
  constructor(path) { this.path = path; }

  async find(goal, observation) {
    const goalFingerprint = hash(normalize(goal));
    const initialRouteFingerprint = routeFingerprint(observation.page?.url);
    if (!initialRouteFingerprint) return undefined;
    const data = await readData(this.path);
    return data.workflows.find(workflow => workflow.goalFingerprint === goalFingerprint && workflow.initialRouteFingerprint === initialRouteFingerprint);
  }

  async record(goal, initialRouteFingerprint, attempts) {
    if (!/^[a-f0-9]{64}$/.test(initialRouteFingerprint) || !Array.isArray(attempts) || attempts.length < 1 || attempts.length > MAX_STEPS) return false;
    const validAttempt = attempt => {
      if (!attempt || attempt.error || !validHash(attempt.beforeRouteFingerprint)) return false;
      if (attempt.action === "scroll") {
        return validScrollSignature(attempt.scrollTargetSignature) &&
          Number.isFinite(attempt.beforePositionFraction) && attempt.beforePositionFraction >= 0 && attempt.beforePositionFraction < 1 &&
          Number.isFinite(attempt.afterPositionFraction) && attempt.afterPositionFraction > attempt.beforePositionFraction && attempt.afterPositionFraction <= 1 &&
          validHash(attempt.beforeCandidatesFingerprint) && validHash(attempt.afterCandidatesFingerprint) && attempt.scrollProgressObserved === true;
      }
      return attempt.action === "click" && validSignature(attempt.targetSignature);
    };
    if (attempts.some(attempt => !validAttempt(attempt))) return false;
    const data = await readData(this.path);
    const goalFingerprint = hash(normalize(goal));
    const id = `${goalFingerprint}:${initialRouteFingerprint}`;
    const now = new Date().toISOString();
    const workflow = {
      id,
      version: 2,
      goalFingerprint,
      initialRouteFingerprint,
      createdAt: data.workflows.find(item => item.id === id)?.createdAt ?? now,
      updatedAt: now,
      steps: attempts.map(attempt => attempt.action === "scroll"
        ? {
            action: "scroll",
            routeFingerprint: attempt.beforeRouteFingerprint,
            scrollTarget: attempt.scrollTargetSignature,
            beforePositionFraction: attempt.beforePositionFraction,
            afterPositionFraction: attempt.afterPositionFraction,
            beforeCandidatesFingerprint: attempt.beforeCandidatesFingerprint,
            afterCandidatesFingerprint: attempt.afterCandidatesFingerprint
          }
        : { action: "click", routeFingerprint: attempt.beforeRouteFingerprint, target: attempt.targetSignature })
    };
    const workflows = [workflow, ...data.workflows.filter(item => item.id !== id)].slice(0, MAX_WORKFLOWS);
    await this.#write({ schemaVersion: 2, workflows });
    return true;
  }

  async invalidate(goal, initialRouteFingerprint) {
    const goalFingerprint = hash(normalize(goal));
    const id = `${goalFingerprint}:${initialRouteFingerprint}`;
    const data = await readData(this.path);
    const workflows = data.workflows.filter(item => item.id !== id);
    if (workflows.length === data.workflows.length) return false;
    await this.#write({ schemaVersion: 2, workflows });
    return true;
  }

  async #write(value) {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) throw new Error("Workflow store exceeds its size limit.");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, this.path);
  }

  async clear() { await rm(this.path, { force: true }); }
}
