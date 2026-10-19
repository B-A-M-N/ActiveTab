import { STEP_STATUS } from "../schema.js";
import { OutputAccumulator } from "../../extraction/outputAccumulator.js";
import { verifyExtractionResult } from "../../extraction/extractionVerifier.js";
import { executeExtractionCapability } from "../../capabilities/recipeExecutor.js";
import { discoverTableCapabilities } from "../../capabilities/capabilityDiscovery.js";
import { projectExtractionOutput } from "../../extraction/outputRelease.js";
import { resolveObservedApplication } from "../../environments/model.js";
import { collectExtractionPages } from "../../extraction/collectionService.js";

/** Runs read-only registered extraction capabilities and verifies final outputs. */
export class ExtractionStepHandler {
  constructor({ session, environment = null, principalId = null, capabilityRegistry = null, capabilityService = null, authorizeField = null, authorizeRelease = null, advancePage = null, onOutput = null, onDiscovery = null } = {}) {
    this.session = session;
    this.environment = environment;
    this.principalId = principalId;
    this.capabilityRegistry = capabilityRegistry;
    this.capabilityService = capabilityService;
    this.authorizeField = authorizeField;
    this.authorizeRelease = authorizeRelease;
    this.advancePage = advancePage;
    this.onOutput = onOutput ?? (() => {});
    this.onDiscovery = onDiscovery ?? (() => {});
    this.accumulators = new Map();
    this.contracts = new Map();
  }

  async executeDiscoverTables(step, receipt, startedAt) {
    if (!this.session || typeof this.session.observe !== "function" || typeof this.session.observer?.getEvidence !== "function") {
      const reason = "Capability discovery requires an attached browser observation store.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const observation = await this.session.observe();
    if (!observation?.evidenceId || observation.documentGeneration !== this.session.documentGeneration) {
      const reason = "Capability discovery requires fresh retained browser evidence.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: [observation?.evidenceId].filter(Boolean) });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const evidence = this.session.observer.getEvidence(observation.evidenceId, { facets: ["domSnapshot"] });
    if (evidence?.status !== "available" || !evidence.domSnapshot) {
      const reason = "Retained sanitized DOM evidence is unavailable.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    let discovered;
    if (this.capabilityService?.discover) {
      // CapabilityService reobserves to bind the candidate to the live
      // target and retains only bounded structural metadata.
      discovered = await this.capabilityService.discover({
        session: this.session,
        environment: this.environment,
        principalId: this.principalId
      });
    } else {
      const application = resolveObservedApplication(this.environment, observation.page.url);
      discovered = application.status !== "matched"
        ? { status: "unavailable", candidates: [], reasonCode: `application_identity_${application.status}` }
        : discoverTableCapabilities({
          observation,
          domSnapshot: evidence.domSnapshot,
          environmentId: this.environment?.environmentId ?? this.environment?.id ?? null,
          applicationId: application.applicationId,
          principalId: this.principalId
        });
    }
    this.onDiscovery(discovered);
    const reason = discovered.status === "candidate"
      ? `Discovered ${discovered.candidates.length} visible structured-source candidate(s); records and page text were not returned.`
      : "Discovery completed; no visible HTML tables or repeated record groups were found.";
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status: STEP_STATUS.PASS,
      reason,
      startedAt,
      evidenceIds: [observation.evidenceId],
      details: { candidateCount: discovered.candidates.length, candidateKinds: [...new Set(discovered.candidates.map(item => item.kind))] }
    });
    return { status: STEP_STATUS.PASS, reason };
  }

  async executeExtractRecords(step, receipt, startedAt) {
    const result = await executeExtractionCapability({
      capabilityId: step.capabilityId,
      capabilityVersion: step.capabilityVersion ?? 1,
      registry: this.capabilityRegistry,
      session: this.session,
      environment: this.environment,
      principalId: this.principalId,
      authorizeField: this.authorizeField
    });
    if (result.status !== "available") {
      if (result.contract && result.observation) {
        const accumulator = this.accumulators.get(step.outputName) ?? new OutputAccumulator();
        this.accumulators.set(step.outputName, accumulator);
        this.contracts.set(step.outputName, result.contract);
        accumulator.append(step.outputName, `${result.capabilityId}@${result.capabilityVersion}`, {
          records: [],
          evidence: [],
          truncated: false
        }, {
          observationId: result.observation.evidenceId,
          pageUrl: result.pageUrl,
          maxRecords: result.contract.maxRecords
        });
        this.onOutput(step.outputName, accumulator.finalize(step.outputName, result.contract));
      }
      const status = result.status === "blocked" ? STEP_STATUS.BLOCKED
        : result.status === "incomplete" ? STEP_STATUS.FAIL : STEP_STATUS.UNCERTAIN;
      const reason = `Extraction ${result.status}: ${result.reasonCode}.`;
      receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, evidenceIds: [result.evidenceId].filter(Boolean) });
      return { status, reason };
    }
    const accumulator = this.accumulators.get(step.outputName) ?? new OutputAccumulator();
    this.accumulators.set(step.outputName, accumulator);
    this.contracts.set(step.outputName, result.contract);
    const recordCount = accumulator.append(step.outputName, `${result.capabilityId}@${result.capabilityVersion}`, {
      records: result.records,
      truncated: result.truncated,
      evidence: result.evidence
    }, {
      observationId: result.observation.evidenceId,
      pageUrl: result.pageUrl,
      maxRecords: result.contract.maxRecords
    });
    const reason = `Collected ${result.records.length} visible records from fresh browser evidence; overall output remains unverified until finalized.`;
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status: STEP_STATUS.PASS,
      reason,
      startedAt,
      evidenceIds: [result.observation.evidenceId],
      details: { pageRecordCount: result.records.length, accumulatedRecordCount: recordCount, capabilityId: step.capabilityId }
    });
    return { status: STEP_STATUS.PASS, reason };
  }

  async executeCollectRecords(step, receipt, startedAt) {
    const accumulator = this.accumulators.get(step.outputName) ?? new OutputAccumulator();
    this.accumulators.set(step.outputName, accumulator);
    const capabilityVersion = step.capabilityVersion ?? 1;
    const collection = await collectExtractionPages({
      outputName: step.outputName,
      capabilityId: step.capabilityId,
      capabilityVersion,
      accumulator,
      initialContract: this.contracts.get(step.outputName) ?? null,
      executePage: () => executeExtractionCapability({
        capabilityId: step.capabilityId,
        capabilityVersion,
        registry: this.capabilityRegistry,
        session: this.session,
        environment: this.environment,
        principalId: this.principalId,
        authorizeField: this.authorizeField
      }),
      advancePage: typeof this.advancePage === "function"
        ? details => this.advancePage({ ...details, receipt, stepId: step.id })
        : null,
      maxPages: Math.min(100, this.contracts.get(step.outputName)?.pagination?.maxPages ?? 100)
    });
    if (collection.contract) this.contracts.set(step.outputName, collection.contract);
    const output = collection.output;
    if (output) this.onOutput(step.outputName, output);
    const status = collection.status === "complete" ? STEP_STATUS.PASS
      : collection.status === "blocked" ? STEP_STATUS.BLOCKED
        : collection.status === "uncertain" ? STEP_STATUS.UNCERTAIN : STEP_STATUS.FAIL;
    const reason = collection.status === "complete"
      ? `Collected and independently validated ${output.records.length} records across ${collection.pageCount} page(s).`
      : `Collection ${status.toLocaleLowerCase()}: ${collection.reasonCode}.`;
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status,
      reason,
      startedAt,
      evidenceIds: output?.verification?.evidenceIds ?? [],
      details: { pageCount: collection.pageCount, completeness: output?.completeness ?? "incomplete", reasonCode: collection.reasonCode ?? null, ...(output?.verification ?? {}) }
    });
    return { status, reason, output };
  }

  executeEmitOutput(step, receipt, startedAt) {
    const contract = this.contracts.get(step.outputName);
    const accumulator = this.accumulators.get(step.outputName);
    if (!contract || !accumulator || `${contract.id}@${step.capabilityVersion ?? 1}` !== accumulator.get(step.outputName)?.contractId
      || contract.id !== step.capabilityId) {
      const reason = "No matching registered extraction capability produced this output.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const extracted = accumulator.finalize(step.outputName, contract);
    const output = projectExtractionOutput(extracted, this.authorizeRelease, {
      principalId: this.principalId,
      outputName: step.outputName
    });
    const verification = verifyExtractionResult(output);
    const evidenceIds = output.verification.evidenceIds;
    const status = verification.status === "complete" ? STEP_STATUS.PASS : STEP_STATUS.FAIL;
    const reason = status === STEP_STATUS.PASS
      ? "Structured output passed schema, field provenance, record-count, uniqueness, and completeness checks."
      : verification.reason;
    this.onOutput(step.outputName, output);
    receipt.recordStep({
      stepId: step.id,
      type: step.type,
      status,
      reason,
      startedAt,
      evidenceIds,
      details: { completeness: output.completeness, ...output.verification }
    });
    return { status, reason, output };
  }
}
