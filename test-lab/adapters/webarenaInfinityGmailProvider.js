import { FixtureProvider } from "../runtime/fixtureProvider.js";
import { assertValidScenario } from "../runtime/scenario.js";

const MAX_STATE_BYTES = 4 * 1024 * 1024;

async function readBytesBounded(response, maxBytes = MAX_STATE_BYTES) {
  if (!response.body) throw new Error("External fixture response has no body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("External fixture state exceeded its response bound.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBounded(response, maxBytes = MAX_STATE_BYTES) {
  return JSON.parse(new TextDecoder().decode(await readBytesBounded(response, maxBytes)));
}

function localHttpOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("WebArena-Infinity Gmail provider accepts only an explicit loopback HTTP origin.");
  }
  return parsed.origin;
}

/**
 * Adapter for the independently maintained WebArena-Infinity Gmail app.
 * The app process remains an external target; its loopback state endpoint is
 * used only by the provider-side oracle and is never included in the binding.
 */
export class WebArenaInfinityGmailProvider extends FixtureProvider {
  #origin;
  #episodeId = null;
  #scenario = null;
  #disposed = false;
  #oracleToken;

  constructor({ origin = "http://127.0.0.1:8000", oracleToken = process.env.ACTIVETAB_WEBARENA_ORACLE_TOKEN } = {}) {
    super();
    this.#origin = localHttpOrigin(origin);
    if (typeof oracleToken !== "string" || oracleToken.length < 32 || oracleToken.length > 512) throw new Error("WebArena-Infinity requires a separately configured fixture-oracle token.");
    this.#oracleToken = oracleToken;
  }

  async provision({ episodeId, scenario } = {}) {
    assertValidScenario(scenario);
    if (scenario.site_family !== "webarena-infinity-gmail") throw new Error("Scenario does not belong to WebArena-Infinity Gmail.");
    if (this.#episodeId) throw new Error("WebArena-Infinity provider is already bound to an episode.");
    const response = await fetch(this.#origin, { redirect: "error" });
    if (!response.ok) throw new Error("WebArena-Infinity Gmail app is unavailable.");
    const document = new TextDecoder().decode(await readBytesBounded(response, 256 * 1024));
    if (!document.includes("Gmail")) throw new Error("Loopback target did not identify as the WebArena-Infinity Gmail app.");
    this.#episodeId = episodeId;
    this.#scenario = structuredClone(scenario);
    this.#disposed = false;
  }

  async seed({ episodeId, signal } = {}) {
    this.#assertEpisode(episodeId);
    if (signal?.aborted) throw new Error("External benchmark setup was canceled.");
    const oracleOptions = { redirect: "error", headers: { "x-activetab-fixture-oracle": this.#oracleToken } };
    const target = this.#scenario.task;
    const response = await fetch(`${this.#origin}/api/oracle/seed`, {
      method: "POST",
      ...oracleOptions,
      headers: { ...oracleOptions.headers, "content-type": "application/json" },
      body: JSON.stringify({ emails: [{ subject: target.subject, from: { name: target.sender }, isRead: target.initialIsRead }] })
    });
    if (!response.ok) throw new Error("WebArena-Infinity reset endpoint refused fixture setup.");
    const reset = await readJsonBounded(response);
    if (reset.seed_created !== true) throw new Error("WebArena-Infinity did not confirm its isolated fixture seed.");
    const stateResponse = await fetch(`${this.#origin}/api/state`, oracleOptions);
    if (!stateResponse.ok) throw new Error("WebArena-Infinity seeded state is unavailable.");
    const state = await readJsonBounded(stateResponse);
    const targets = (state.emails ?? []).filter(email => email.subject === this.#scenario.task.subject
      && email.from?.name === this.#scenario.task.sender);
    if (targets.length !== 1 || targets[0].isRead !== this.#scenario.task.initialIsRead) {
      throw new Error("WebArena-Infinity target is not in the scenario's declared initial state.");
    }
  }

  getTargetBinding() {
    if (!this.#episodeId) throw new Error("WebArena-Infinity provider has not been provisioned.");
    return Object.freeze({
      environment: Object.freeze({
        profileId: "webarena-infinity-gmail",
        environmentId: "webarena-infinity-local",
        environmentClass: "local",
        applicationEntryUrl: this.#origin,
        authorizedOrigins: Object.freeze([this.#origin]),
        applications: Object.freeze([Object.freeze({
          applicationId: "webarena-infinity-gmail",
          authenticationRealm: "local-synthetic-account",
          candidateEntry: this.#origin,
          finalOrigin: this.#origin,
          status: "authorized"
        })])
      }),
      entryUrl: this.#origin,
      applicationOrigins: Object.freeze([this.#origin]),
      targetIdentity: Object.freeze({
        siteFamily: "webarena-infinity-gmail",
        build: this.#scenario.application.build,
        episodeId: this.#episodeId
      })
    });
  }

  async injectFault() {
    throw new Error("WebArena-Infinity Gmail adapter does not inject faults into the external application.");
  }

  async reset({ episodeId } = {}) {
    this.#assertEpisode(episodeId);
    const response = await fetch(`${this.#origin}/api/reset`, { method: "POST", redirect: "error", headers: { "x-activetab-fixture-oracle": this.#oracleToken } });
    if (!response.ok) throw new Error("WebArena-Infinity reset failed.");
    return Object.freeze({ status: "reset" });
  }

  async verifyOutcome({ episodeId, scenario } = {}) {
    this.#assertEpisode(episodeId);
    if (scenario.scenario_id !== this.#scenario.scenario_id || scenario.task?.operation !== "mark_email_read") {
      throw new Error("WebArena-Infinity oracle request is outside the registered task contract.");
    }
    const response = await fetch(`${this.#origin}/api/state`, { redirect: "error", headers: { "x-activetab-fixture-oracle": this.#oracleToken } });
    if (!response.ok) throw new Error("WebArena-Infinity state oracle is unavailable.");
    const state = await readJsonBounded(response);
    const matches = (state.emails ?? []).filter(email => email.subject === scenario.task.subject
      && email.from?.name === scenario.task.sender);
    const exactTarget = matches.length === 1 ? matches[0] : null;
    return Object.freeze({
      verified: Boolean(exactTarget),
      outcomeMatches: exactTarget?.isRead === scenario.task.expectedIsRead,
      initialValue: scenario.task.initialIsRead,
      finalValue: typeof exactTarget?.isRead === "boolean" ? exactTarget.isRead : null,
      exactTargetCount: matches.length,
      evidenceRefs: [`webarena-state:${scenario.scenario_id}`]
    });
  }

  async scoreOutcome({ driverResult, oracle, cleanupVerified }) {
    const exactTarget = oracle?.verified === true && oracle.exactTargetCount === 1;
    const statusMatch = oracle?.outcomeMatches === true;
    const verifiedPass = driverResult?.status === "succeeded" && exactTarget && statusMatch && cleanupVerified;
    return Object.freeze({
      status: verifiedPass ? "PASS" : "FAIL",
      falseSuccess: driverResult?.status === "succeeded" && !verifiedPass,
      driverClaimsSuccess: driverResult?.status === "succeeded",
      exactTarget,
      statusMatch,
      cleanupVerified,
      evidenceRefs: oracle?.evidenceRefs ?? []
    });
  }

  async dispose({ episodeId } = {}) {
    if (this.#disposed) return { status: "verified", evidenceRef: `webarena-cleanup:${this.#episodeId}` };
    this.#assertEpisode(episodeId);
    const headers = { "x-activetab-fixture-oracle": this.#oracleToken };
    const reset = await fetch(`${this.#origin}/api/reset`, { method: "POST", redirect: "error", headers });
    if (!reset.ok) return { status: "unverified" };
    const resetResult = await readJsonBounded(reset);
    if (resetResult.seed_restored !== true) return { status: "unverified" };
    const stateResponse = await fetch(`${this.#origin}/api/state`, { redirect: "error", headers });
    if (!stateResponse.ok) return { status: "unverified" };
    const state = await readJsonBounded(stateResponse);
    const original = (state.emails ?? []).filter(email => email.subject === this.#scenario.task.subject
      && email.from?.name === this.#scenario.task.sender);
    if (original.length !== 1 || original[0].isRead !== this.#scenario.task.initialIsRead) return { status: "unverified" };
    this.#disposed = true;
    return { status: "verified", evidenceRef: `webarena-cleanup:${this.#episodeId}` };
  }

  #assertEpisode(episodeId) {
    if (!this.#episodeId || episodeId !== this.#episodeId) throw new Error("WebArena-Infinity operation is not bound to its fixture episode.");
  }
}

export function createWebArenaInfinityGmailProvider(options) {
  return new WebArenaInfinityGmailProvider(options);
}
