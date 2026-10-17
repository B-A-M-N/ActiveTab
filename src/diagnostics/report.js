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

export class DiagnosticReport {
  constructor({ runId, title = "Diagnostic report" } = {}) {
    if (typeof runId !== "string" || !runId) throw new Error("DiagnosticReport requires a runId.");
    this.runId = String(runId);
    this.title = String(title);
    this.createdAt = new Date().toISOString();
    this.findings = [];
    this.correlationSummary = null;
    this.sourceAccessLog = [];
    this.investigationStatus = INVESTIGATION_STATUS.COMPLETE;
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
