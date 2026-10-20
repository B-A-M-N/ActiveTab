import { DiagnosticCorrelator } from "../../diagnostics/correlator.js";
import { OPERATION } from "../../diagnostics/contracts.js";
import { DiagnosticReport, FINDING_LEVEL, deriveRunInvestigationStatus } from "../../diagnostics/report.js";
import { InvestigationEngine } from "../../investigation/engine.js";
import { buildDurableRunReport } from "../../testing/durableRunReport.js";
import { selectBrowserSession } from "../session-selection.js";

/** Read-only MCP diagnostics bound to server-owned runs and attached sessions. */
export function createDiagnosticToolHandlers({ testRuns, sessions, runStateStore }) {
  return Object.freeze({
    collect_diagnostics: async args => {
      const run = testRuns.get(args.runId);
      if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
      const results = await run.collector.collectAll([
        { sourceId: "browser-network", operation: OPERATION.READ },
        { sourceId: "browser-lifecycle", operation: OPERATION.READ }
      ]);
      return { runId: args.runId, results };
    },

    investigate_failure: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      const run = args.runId ? testRuns.get(args.runId) : null;
      const collector = run?.collector ?? null;
      const correlator = run?.correlator ?? new DiagnosticCorrelator();
      const engine = new InvestigationEngine({ collector, correlator, session, runStateStore });
      return await engine.investigate({
        subject: args.subject,
        reason: args.reason,
        runId: args.runId ?? null,
        stepId: args.stepId ?? null,
        operationId: args.operationId ?? null
      });
    },

    get_test_report: async args => {
      const run = testRuns.get(args.runId);
      if (!run) {
        const durableState = await runStateStore.getFresh(args.runId);
        if (!durableState) throw new Error(`No test run found for runId '${args.runId}'.`);
        return buildDurableRunReport(durableState);
      }
      const receipt = await run.runPromise;
      const durableState = await runStateStore.getFresh(args.runId).catch(() => null);
      const report = new DiagnosticReport({ runId: args.runId, title: `Test run: ${receipt.workflowName}` });
      report.setCorrelationSummary(run.correlator.summary());
      for (const step of receipt.steps) {
        const level = step.status === "PASS" ? FINDING_LEVEL.CONFIRMED
          : step.status === "FAIL" ? FINDING_LEVEL.LIKELY
          : step.status === "BLOCKED" ? FINDING_LEVEL.BLOCKED
          : FINDING_LEVEL.INSUFFICIENT;
        report.addFinding({ level, subject: `Step ${step.stepId} (${step.type})`, description: step.reason, evidenceIds: step.evidenceIds });
      }
      const cloudDiagnosticSources = new Set((run.cloudAgentEvidenceResults ?? []).map(result => result.sourceId));
      for (const entry of run.collector.getSnapshots()) {
        if (cloudDiagnosticSources.has(entry.sourceId)) continue;
        report.logSourceAccess({ sourceId: entry.sourceId, operation: entry.operation, status: "ok" });
      }
      for (const result of run.cloudAgentEvidenceResults ?? []) {
        report.logSourceAccess({
          sourceId: result.sourceId,
          operation: OPERATION.READ_SCOPED,
          status: result.status,
          ...(result.status === "error" ? { error: result.error } : {})
        });
      }
      const assessment = deriveRunInvestigationStatus({
        receipt: receipt.toObject(),
        durableStateAvailable: durableState !== null,
        durableRunStatus: durableState?.status ?? null,
        unresolvedOperations: (durableState?.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status)),
        testOwnedResources: durableState?.testOwnedResources ?? [],
        integration: run.integration?.verificationRequired ? {
          ...run.integration,
          outcomeStatus: run.cloudAgentOutcome?.status,
          cloudAgentRunId: run.cloudAgentRunId,
          correlationStrength: run.cloudAgentCorrelation?.strength
        } : null,
        diagnosticResults: run.cloudAgentEvidenceResults ?? []
      });
      report.setInvestigationStatus(assessment.status);
      for (const limitation of assessment.limitations) report.addLimitation(limitation);
      return report.redacted();
    }
  });
}
