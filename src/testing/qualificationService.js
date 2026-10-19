import { randomUUID } from "node:crypto";
import { isSafeTelemetryCode, isSha256Digest } from "../telemetry/privacy.js";
import { runBenchmarkEpisode } from "../../test-lab/runtime/benchmarkRunner.js";
import { assertValidScenario } from "../../test-lab/runtime/scenario.js";

const TRIGGERS = new Set([
  "ambiguous_target",
  "observed_failure",
  "workflow_reuse",
  "ui_drift",
  "uncertain_operation"
]);

const QUALIFICATION_STATUSES = new Set(["qualified", "not_qualified", "inconclusive", "unavailable"]);

function normalizeCatalog(catalog) {
  if (catalog instanceof Map) return catalog;
  if (Array.isArray(catalog)) return new Map(catalog.map(scenario => [scenario.scenario_id, scenario]));
  return new Map();
}

function normalizeRegistry(registry) {
  if (registry instanceof Map) return registry;
  if (registry && typeof registry === "object" && !Array.isArray(registry)) return new Map(Object.entries(registry));
  return new Map();
}

function appendQualificationEvent(runtime, input) {
  const store = runtime?.eventStore;
  if (!store || typeof store.append !== "function") throw new Error("Decision event store unavailable.");
  return store.append({ ...input, trainingEligibility: "pending" });
}

function safeSourceEventIds(values) {
  if (!Array.isArray(values) || values.length > 32) throw new Error("Qualification source events must be a bounded list.");
  return [...new Set(values.map(value => {
    if (!isSafeTelemetryCode(value, { maxLength: 96 })) throw new Error("Qualification source event IDs must be structural identifiers.");
    return value;
  }))];
}

function qualifyStatus(report) {
  if (report?.cleanupStatus !== "verified") return "inconclusive";
  if (report?.score?.status === "PASS") return "qualified";
  if (report?.score?.status === "FAIL") return "not_qualified";
  return "inconclusive";
}

/**
 * Coordinates optional fixture qualification inside an ActiveTab run.
 * Scenario resolution, fixture provisioning, browser driving, and scoring
 * are injected so only trusted application composition can select them.
 */
export class QualificationService {
  constructor({ decisionRuntime, scenarioCatalog = [], scenarioResolver = null, providers = {}, drivers = {} } = {}) {
    this.decisionRuntime = decisionRuntime;
    this.scenarioCatalog = normalizeCatalog(scenarioCatalog);
    this.scenarioResolver = scenarioResolver;
    this.providers = normalizeRegistry(providers);
    this.drivers = normalizeRegistry(drivers);
  }

  async qualify({
    runId,
    episodeId,
    stepId,
    scenarioId,
    providerId,
    trigger,
    principalId = "unknown",
    strategyFingerprint,
    sourceEventIds = [],
    evidenceRefs = [],
    signal
  } = {}) {
    const qualificationId = randomUUID();
    const automationRunId = randomUUID();
    const sourceIds = safeSourceEventIds(sourceEventIds);
    if (!isSafeTelemetryCode(runId) || !isSafeTelemetryCode(episodeId) || !isSafeTelemetryCode(stepId)
      || !isSafeTelemetryCode(scenarioId) || !isSafeTelemetryCode(providerId)
      || !isSafeTelemetryCode(principalId) || !isSha256Digest(strategyFingerprint)
      || !TRIGGERS.has(trigger) || !Array.isArray(evidenceRefs) || evidenceRefs.length > 32
      || evidenceRefs.some(ref => !isSafeTelemetryCode(ref, { maxLength: 128 }))) {
      throw new Error("Qualification request is outside its typed, bounded contract.");
    }

    const eventStore = this.decisionRuntime?.eventStore;
    const episode = eventStore?.getEpisode?.(episodeId);
    if (!episode || episode.run_id !== runId) {
      return this.#unavailable({ qualificationId, automationRunId, reasonCode: "parent_episode_unavailable" });
    }
    const existingEvents = new Set((eventStore.getEvents?.(episodeId) ?? []).map(event => event.eventId));
    if (sourceIds.some(eventId => !existingEvents.has(eventId))) {
      return this.#unavailable({ qualificationId, automationRunId, reasonCode: "source_event_unavailable" });
    }

    const commonEvent = {
      episodeId,
      runId,
      stepId,
      decisionId: qualificationId,
      trainingEligibility: "pending"
    };
    let startedEvent;
    try {
      startedEvent = appendQualificationEvent(this.decisionRuntime, {
        ...commonEvent,
        eventType: "qualification.started",
        payload: {
          qualificationId,
          automationRunId,
          scenarioId,
          providerId,
          trigger,
          principalId,
          strategyFingerprint,
          sourceEventIds: sourceIds,
          evidenceRefs
        }
      });
    } catch {
      return this.#unavailable({ qualificationId, automationRunId, reasonCode: "telemetry_unavailable" });
    }

    let status = "unavailable";
    let reasonCode = "qualification_provider_unavailable";
    let report = null;
    let fixtureSeed = null;
    let applicationBuild = null;
    let qualificationProvenance = null;
    let cleanupResult = { status: "not_run", reasonCode: "fixture_not_started" };
    try {
      const scenario = await this.#resolveScenario({ scenarioId, trigger, runId, episodeId, stepId, sourceEventIds: sourceIds, evidenceRefs });
      if (scenario) {
        assertValidScenario(scenario);
        const qualification = scenario.qualification;
        if (qualification?.provider_id !== providerId) throw new Error("Scenario provider binding mismatch.");
        if (qualification?.level === "live") throw new Error("Live qualification requires a separately authorized live-target runtime.");
        qualificationProvenance = {
          level: qualification.level,
          providerId: qualification.provider_id,
          providerIdentity: qualification.provider_identity,
          scenarioSeed: scenario.seed,
          sourceRevision: qualification.source_revision,
          oracleReference: qualification.oracle_reference,
          independentApplicationOutcome: false
        };
      }
      if (Number.isSafeInteger(scenario?.seed) && scenario.seed >= 0) fixtureSeed = scenario.seed;
      if (typeof scenario?.application?.build === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(scenario.application.build)) {
        applicationBuild = scenario.application.build;
      }
      const providerFactory = this.providers.get(providerId);
      const driver = this.drivers.get(providerId);
      if (!scenario) reasonCode = "scenario_unavailable";
      else if (typeof providerFactory !== "function" || typeof driver !== "function") reasonCode = "qualification_adapter_unavailable";
      else {
        const provider = await providerFactory({ qualificationId, automationRunId, scenario, signal });
        report = await runBenchmarkEpisode({ provider, scenario, driver, signal, automationRunId });
        qualificationProvenance = report.qualification;
        cleanupResult = report.qualification.cleanupResult;
        status = qualifyStatus(report);
        reasonCode = status === "qualified" ? "strategy_qualified"
          : status === "not_qualified" ? "strategy_not_qualified"
            : report?.cleanupStatus !== "verified" ? "fixture_lifecycle_unverified" : "qualification_inconclusive";
      }
    } catch (error) {
      status = "inconclusive";
      reasonCode = /Live qualification/u.test(error?.message ?? "") ? "live_target_requires_authorized_runtime"
        : /provider binding mismatch/u.test(error?.message ?? "") ? "scenario_provider_mismatch"
          : "qualification_execution_inconclusive";
    }

    const resultEvidenceRefs = [...new Set([
      ...evidenceRefs,
      ...(report?.score?.evidenceRefs ?? []),
      ...(report?.cleanupStatus === "verified" ? [`fixture-cleanup:${report.episodeId}`] : [])
    ])].filter(ref => isSafeTelemetryCode(ref, { maxLength: 128 })).slice(0, 32);
    try {
      appendQualificationEvent(this.decisionRuntime, {
        ...commonEvent,
        parentEventId: startedEvent.eventId,
        eventType: "qualification.completed",
        payload: {
          qualificationId,
          automationRunId,
          scenarioId,
          providerId,
          trigger,
          principalId,
          strategyFingerprint,
          qualificationStatus: status,
          reasonCode,
          ...(fixtureSeed !== null ? { fixtureSeed } : {}),
          ...(qualificationProvenance ? {
            qualificationLevel: qualificationProvenance.level,
            providerIdentity: qualificationProvenance.providerIdentity,
            scenarioSeed: qualificationProvenance.scenarioSeed,
            sourceRevision: qualificationProvenance.sourceRevision,
            oracleReference: qualificationProvenance.oracleReference,
            independentApplicationOutcome: qualificationProvenance.independentApplicationOutcome
          } : {}),
          ...(applicationBuild ? { applicationBuild } : {}),
          cleanupResult,
          evidenceRefs: resultEvidenceRefs
        }
      });
    } catch {
      return this.#unavailable({ qualificationId, automationRunId, reasonCode: "qualification_receipt_unavailable" });
    }

    return Object.freeze({
      qualificationId,
      automationRunId,
      scenarioId,
      providerId,
      status,
      reasonCode,
      ...(qualificationProvenance ? { qualification: qualificationProvenance } : {}),
      cleanupResult,
      evidenceRefs: resultEvidenceRefs,
      report
    });
  }

  async #resolveScenario(request) {
    if (typeof this.scenarioResolver === "function") return await this.scenarioResolver(request);
    return this.scenarioCatalog.get(request.scenarioId) ?? null;
  }

  #unavailable({ qualificationId, automationRunId, reasonCode }) {
    return Object.freeze({
      qualificationId,
      automationRunId,
      status: "unavailable",
      reasonCode,
      evidenceRefs: [],
      report: null
    });
  }
}

export { QUALIFICATION_STATUSES };
