/**
 * Diagnostic report — qualified output from collected evidence and
 * correlated events. Reports distinguish confirmed findings from
 * unsupported claims.
 */

import { CORRELATION_STRENGTH } from "./correlator.js";

export const FINDING_LEVEL = Object.freeze({
  CONFIRMED: "confirmed",
  LIKELY: "likely",
  NARROWED: "narrowed",
  INSUFFICIENT: "insufficient",
  BLOCKED: "environmental_or_authorization_blocker"
});

export const INVESTIGATION_STATUS = Object.freeze({
  CONFIRMED: "confirmed",
  NARROWED: "narrowed",
  INCONCLUSIVE: "inconclusive",
  COMPLETE: "complete",
  BUDGET_EXHAUSTED: "budget_exhausted",
  BLOCKED: "blocked"
});

const UNRESOLVED_OPERATION_STATUSES = new Set(["RESERVED", "DISPATCHED", "UNCERTAIN"]);
const VERIFIED_CLEANUP_STATUSES = new Set(["PASS", "verified", "not_required"]);

/**
 * Derive report completion from the durable execution and evidence state.
 * A terminal browser receipt alone cannot complete a Cloud Agent report.
 */
export function deriveRunInvestigationStatus({
  receipt,
  integration = null,
  diagnosticResults = [],
  unresolvedOperations = [],
  testOwnedResources = [],
  durableRunStatus = null,
  durableStateAvailable = true
} = {}) {
  const limitations = [];
  const inconclusive = reason => {
    limitations.push(reason);
    return { status: INVESTIGATION_STATUS.INCONCLUSIVE, limitations };
  };

  if (!receipt || typeof receipt.status !== "string") {
    return inconclusive("A durable execution receipt is unavailable.");
  }
  if (!durableStateAvailable) {
    return inconclusive("Durable run state could not be loaded; operation and cleanup obligations remain unverified.");
  }
  if (durableRunStatus !== receipt.status.toLowerCase()) {
    return inconclusive("The durable run status does not confirm the receipt's final status.");
  }
  if (["RUNNING", "CREATED", "DISCOVERING", "DISPATCHING", "WAITING_FOR_HUMAN_DECISION", "WAITING_FOR_AUTHENTICATION"].includes(receipt.status)) {
    return inconclusive(`The run is not terminal (status: ${receipt.status}).`);
  }
  if (receipt.status === "BLOCKED" || (receipt.steps ?? []).some(step => step.status === "BLOCKED")) {
    return {
      status: INVESTIGATION_STATUS.BLOCKED,
      limitations: ["The run encountered an authorization, environment, or execution blocker."]
    };
  }
  if (receipt.status === "UNCERTAIN" || (receipt.steps ?? []).some(step => step.status === "UNCERTAIN" || step.status === "SUSPENDED")) {
    return inconclusive("At least one operation or step still has an uncertain outcome.");
  }
  if (!new Set(["PASSED", "FAILED", "CANCELED"]).has(receipt.status)) {
    return inconclusive(`The receipt has an unrecognized or nonterminal status (${receipt.status}).`);
  }
  if (receipt.status === "CANCELED") return inconclusive("The run was canceled before its requested outcome was fully established.");
  if (unresolvedOperations.some(operation => UNRESOLVED_OPERATION_STATUSES.has(operation.status))) {
    return inconclusive("A reserved or dispatched operation still requires reconciliation.");
  }
  if ((receipt.cleanup ?? []).some(item => !VERIFIED_CLEANUP_STATUSES.has(item.status))) {
    return inconclusive("At least one cleanup obligation is pending, failed, or unverified.");
  }
  if (testOwnedResources.some(resource => resource.cleanupStatus !== "verified")) {
    return inconclusive("At least one test-owned resource lacks independently verified cleanup.");
  }

  if (integration?.verificationRequired === true) {
    if (!["VERIFIED", "FAILED"].includes(integration.outcomeStatus)) {
      return inconclusive("The Cloud Agent task has no independently verified terminal outcome.");
    }
    if (integration.correlationStrength !== "direct") {
      return inconclusive("The browser task and backend run are not joined by exact direct correlation.");
    }
    const expectedSources = new Set([
      "cloud-agent-runs",
      "cloud-agent-steps",
      "cloud-agent-usage",
      ...(integration.diagnosticSources ?? [])
    ]);
    for (const sourceId of expectedSources) {
      const result = diagnosticResults.find(item => item.sourceId === sourceId);
      if (result?.status !== "ok" || !result.snapshot?.data || result.snapshot.data.status !== "available") {
        return inconclusive(`Required diagnostic source '${sourceId}' is unavailable or was not collected.`);
      }
      if (sourceId === "cloud-agent-runs") {
        const runId = integration.cloudAgentRunId;
        const exactRecord = result.snapshot.data.records?.find(record => record.id === runId);
        if (!runId || !exactRecord) {
          return inconclusive("The diagnostic evidence does not contain the exact correlated Cloud Agent run record.");
        }
      }
    }
  }

  return { status: INVESTIGATION_STATUS.COMPLETE, limitations };
}

export class DiagnosticReport {
  constructor({ runId, title = "Diagnostic report" } = {}) {
    if (typeof runId !== "string" || !runId) throw new Error("DiagnosticReport requires a runId.");
    this.runId = String(runId);
    this.title = String(title);
    this.createdAt = new Date().toISOString();
    this.findings = [];
    this.correlationSummary = null;
    this.sourceAccessLog = [];
    this.investigationStatus = INVESTIGATION_STATUS.INCONCLUSIVE;
    this.limitations = [];
  }

  addFinding({ level, subject, description, evidenceIds = [], limitations = [] }) {
    if (!Object.values(FINDING_LEVEL).includes(level)) {
      throw new Error(`Unknown finding level '${level}'.`);
    }
    if (typeof subject !== "string" || !subject) throw new Error("Finding requires a subject.");
    if (typeof description !== "string" || !description) throw new Error("Finding requires a description.");
    this.findings.push({
      level,
      subject,
      description,
      evidenceIds: [...evidenceIds],
      limitations: [...limitations],
      reportedAt: new Date().toISOString()
    });
    return this;
  }

  setCorrelationSummary(summary) {
    this.correlationSummary = summary;
    return this;
  }

  logSourceAccess({ sourceId, operation, status, error = null }) {
    this.sourceAccessLog.push({
      sourceId,
      operation,
      status,
      ...(error ? { error } : {}),
      loggedAt: new Date().toISOString()
    });
    return this;
  }

  addLimitation(text) {
    if (typeof text !== "string" || !text) throw new Error("Limitation requires text.");
    this.limitations.push(text);
    return this;
  }

  setInvestigationStatus(status) {
    if (!Object.values(INVESTIGATION_STATUS).includes(status)) {
      throw new Error(`Unknown investigation status '${status}'.`);
    }
    this.investigationStatus = status;
    return this;
  }

  toObject() {
    return {
      runId: this.runId,
      title: this.title,
      createdAt: this.createdAt,
      investigationStatus: this.investigationStatus,
      findings: [...this.findings],
      correlationSummary: this.correlationSummary,
      sourceAccessLog: [...this.sourceAccessLog],
      limitations: [...this.limitations]
    };
  }

  /**
   * Redacted projection safe for external model context.
   * Removes private content, keeps structural findings and evidence IDs.
   */
  redacted() {
    const obj = this.toObject();
    return {
      ...obj,
      findings: obj.findings.map(f => ({
        level: f.level,
        subject: f.subject,
        description: f.description,
        evidenceIds: f.evidenceIds,
        limitations: f.limitations
      })),
      sourceAccessLog: obj.sourceAccessLog.map(entry => ({
        sourceId: entry.sourceId,
        operation: entry.operation,
        status: entry.status
      }))
    };
  }
}
