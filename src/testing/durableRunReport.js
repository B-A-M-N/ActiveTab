import { DiagnosticCorrelator } from "../diagnostics/correlator.js";
import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS, deriveRunInvestigationStatus } from "../diagnostics/report.js";
import { receiptFromRunState } from "./receipts.js";

/** Build a restart-safe report from bounded run state without inventing lost evidence. */
export function buildDurableRunReport(runState) {
  if (!runState || typeof runState.runId !== "string") throw new Error("A durable run record is required to build a report.");
  const receipt = receiptFromRunState(runState);
  const report = new DiagnosticReport({ runId: runState.runId, title: `Test run: ${receipt.workflowName}` });
  report.setCorrelationSummary(new DiagnosticCorrelator().summary());
  for (const step of receipt.steps) {
    const level = step.status === "PASS" ? FINDING_LEVEL.CONFIRMED
      : step.status === "FAIL" ? FINDING_LEVEL.LIKELY
      : step.status === "BLOCKED" ? FINDING_LEVEL.BLOCKED
      : FINDING_LEVEL.INSUFFICIENT;
    report.addFinding({ level, subject: `Step ${step.stepId} (${step.type})`, description: step.reason, evidenceIds: step.evidenceIds });
  }

  const assessment = deriveRunInvestigationStatus({
    receipt: receipt.toObject(),
    durableStateAvailable: true,
    durableRunStatus: runState.status,
    unresolvedOperations: (runState.pendingOperations ?? []).filter(operation => ["RESERVED", "DISPATCHED", "UNCERTAIN"].includes(operation.status)),
    testOwnedResources: runState.testOwnedResources ?? []
  });
  const status = assessment.status === INVESTIGATION_STATUS.BLOCKED
    ? INVESTIGATION_STATUS.BLOCKED
    : INVESTIGATION_STATUS.INCONCLUSIVE;
  report.setInvestigationStatus(status);
  for (const limitation of assessment.limitations) report.addLimitation(limitation);
  report.addLimitation("This report was reconstructed after restart from durable checkpoints. Process-local observations, diagnostic snapshots, and correlation links were unavailable, so the end-to-end investigation remains inconclusive.");
  return report.redacted();
}
