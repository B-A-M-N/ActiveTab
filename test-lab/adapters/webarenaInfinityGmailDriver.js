import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOwnedChrome } from "../../src/browser/ownedChrome.js";
import { CapabilityQualifier } from "../../src/capabilities/capabilityQualifier.js";
import { CapabilityService } from "../../src/capabilities/capabilityService.js";
import { CapabilityRegistry } from "../../src/capabilities/capabilityRegistry.js";
import { TestRunner } from "../../src/testing/runner.js";
import { verifyExtractionResult } from "../../src/extraction/extractionVerifier.js";
import { qualifyExtractionManifest } from "../fixtures/extractionQualification.js";
import { acquireBrowserTargetLease, RunStateStore } from "../../src/testing/runState.js";

const FIELD_SOURCES = Object.freeze([
  Object.freeze({ name: "sender", sourceKey: "email-sender", type: "string", required: true }),
  Object.freeze({ name: "subject", sourceKey: "email-subject-text", type: "string", required: true })
]);

function safeOrigin(value, environment) {
  try {
    const origin = new URL(value).origin;
    return environment?.authorizedOrigins?.includes(origin) ? origin : null;
  } catch { return null; }
}

/** Extract seeded inbox rows through ActiveTab's qualified capability path. */
export function createWebArenaInfinityGmailExtractionDriver({
  decisionRuntime = null,
  launchBrowser = launchOwnedChrome,
  headed = true
} = {}) {
  if (typeof launchBrowser !== "function") throw new TypeError("A trusted owned-Chrome launcher is required.");
  return async function driveInboxExtraction({ automationRunId, targetBinding, task, signal } = {}) {
    const environment = targetBinding?.environment;
    const origin = safeOrigin(targetBinding?.entryUrl, environment);
    if (task?.operation !== "extract_inbox_records" || !origin) {
      return { status: "blocked", reasonCode: "benchmark_task_or_environment_invalid" };
    }

    const stateDirectory = await mkdtemp(join(tmpdir(), "activetab-webarena-extraction-"));
    let owned = null;
    let runStateStore = null;
    let targetLease = null;
    let failureStage = "browser_launch";
    try {
      owned = await launchBrowser({
        initialUrl: targetBinding.entryUrl,
        headed,
        signal,
        keepBrowserOpen: false,
        preserveProfile: false,
        reuseExisting: false
      });
      failureStage = "target_lease";
      runStateStore = new RunStateStore(stateDirectory);
      await runStateStore.init();
      targetLease = await acquireBrowserTargetLease(runStateStore, owned.session, automationRunId);

      const principalId = "webarena-infinity-fixture";
      const registry = new CapabilityRegistry();
      const allowedSourceKeys = new Set(FIELD_SOURCES.map(field => field.sourceKey));
      const capabilityService = new CapabilityService({
        registry,
        qualifier: new CapabilityQualifier({ runQualification: qualifyExtractionManifest }),
        classifyField: field => field.origin === origin
          && field.environmentId === environment.environmentId
          && field.applicationId === "webarena-infinity-gmail"
          && allowedSourceKeys.has(field.sourceKey)
          ? "public" : null
      });
      failureStage = "extraction_discovery";
      const discovery = await capabilityService.discover({ session: owned.session, environment, principalId });
      const candidates = discovery.candidates.filter(candidate => candidate.kind === "visible_record_group"
        && FIELD_SOURCES.every(field => candidate.fields.some(source => source.sourceKey === field.sourceKey)));
      if (candidates.length !== 1) return { status: "failed", reasonCode: "extraction_discovery_failed", detailCode: "visible_inbox_record_group_not_unique" };
      const expectedRecords = candidates[0].visibleRowCount;
      if (!Number.isInteger(expectedRecords) || expectedRecords < 2 || expectedRecords > 20) {
        return { status: "failed", reasonCode: "extraction_discovery_failed", detailCode: "visible_inbox_record_count_out_of_scope" };
      }

      failureStage = "qualification";
      const compiled = await capabilityService.compile({
        candidateId: candidates[0].candidateId,
        capabilityId: "webarena.gmail.inbox",
        capabilityVersion: 1,
        fields: FIELD_SOURCES,
        session: owned.session,
        environment,
        principalId,
        maxRecords: expectedRecords,
        minRecords: expectedRecords,
        expectedRecords,
        completionPolicy: "exact_count",
        uniqueBy: ["subject"]
      });
      const qualification = await capabilityService.qualify(compiled.recipeId, { variants: 30, session: owned.session, environment, principalId, signal });
      if (qualification.status !== "qualified") {
        return { status: "failed", reasonCode: "qualification_failed", detailCode: qualification.reasonCode ?? "capability_qualification_failed" };
      }

      failureStage = "workflow";
      const runner = new TestRunner({
        session: owned.session,
        environment,
        principalId,
        capabilityRegistry: registry,
        decisionRuntime,
        runStateStore,
        authorizeExtractionField: field => field.origin === origin
          && field.environmentId === environment.environmentId
          && field.applicationId === "webarena-infinity-gmail"
          && allowedSourceKeys.has(field.sourceKey)
          && field.dataClass === "public",
        authorizeExtractionRelease: field => field.origin === origin
          && field.environmentId === environment.environmentId
          && field.applicationId === "webarena-infinity-gmail"
          && allowedSourceKeys.has(field.sourceKey)
          && field.dataClass === "public",
        targetLease
      });
      const receipt = await runner.run({
        id: "webarena-gmail-extract",
        name: "Extract the visible synthetic inbox",
        steps: [
          { id: "collect", type: "collect_records", capabilityId: "webarena.gmail.inbox", capabilityVersion: 1, outputName: "messages" },
          { id: "emit", type: "emit_output", capabilityId: "webarena.gmail.inbox", capabilityVersion: 1, outputName: "messages" }
        ]
      }, { runId: automationRunId });
      const output = runner.outputResults.messages;
      const verification = verifyExtractionResult(output);
      const succeeded = receipt.status === "PASSED" && verification.status === "complete";
      return Object.freeze({
        status: succeeded ? "succeeded" : "failed",
        reasonCode: succeeded ? null : receipt.status !== "PASSED" ? "workflow_failed" : "extraction_incomplete",
        detailCode: succeeded ? null : receipt.status !== "PASSED" ? "workflow_receipt_not_passed" : verification.reasonCode ?? "extraction_contract_incomplete",
        scope: output?.scope ?? null,
        schema: output?.schema ?? null,
        records: output?.records ?? [],
        fieldProvenance: output?.fieldProvenance ?? [],
        completeness: output?.completeness ?? "incomplete",
        verification: output?.verification ?? null
      });
    } catch (error) {
      const reasonCode = error?.name === "AbortError" ? "benchmark_canceled"
        : failureStage === "browser_launch" ? "browser_launch_failed"
          : failureStage === "target_lease" ? "target_lease_failed"
            : failureStage === "extraction_discovery" ? "extraction_discovery_failed"
              : failureStage === "qualification" ? "qualification_failed" : "workflow_failed";
      return { status: "failed", reasonCode, detailCode: typeof error?.kind === "string" ? error.kind : error?.name ?? "Error" };
    } finally {
      try { await owned?.close(); }
      finally {
        try { await targetLease?.release(); }
        finally {
          runStateStore?.close();
          await rm(stateDirectory, { recursive: true, force: true });
        }
      }
    }
  };
}
