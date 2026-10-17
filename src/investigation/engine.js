/**
 * Bounded investigation engine — after a failure, classifies the observed
 * failure, identifies available evidence, generates competing causal
 * hypotheses, selects safe discriminating checks, and produces a qualified
 * report. Never assumes a root cause merely because one hypothesis explains
 * the symptoms.
 */

import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS } from "../diagnostics/report.js";
import { CORRELATION_STRENGTH } from "../diagnostics/correlator.js";
import { STEP_STATUS } from "../testing/schema.js";

export const FAILURE_CLASSIFICATION = Object.freeze({
  NAVIGATION: "navigation",
  ASSERTION: "assertion",
  NETWORK: "network",
  AUTHORIZATION: "authorization",
  DIAGNOSTIC: "diagnostic",
  UNKNOWN: "unknown"
});

export const CAUSAL_CONFIDENCE = Object.freeze({
  CONFIRMED: "confirmed",
  LIKELY: "likely",
  NARROWED: "narrowed",
  INSUFFICIENT: "insufficient",
  BLOCKED: "environmental_or_authorization_blocker"
});

export class InvestigationEngine {
  constructor({ collector, correlator, session, testRunner, maxHypotheses = 5, maxChecks = 8, signal } = {}) {
    this.collector = collector;
    this.correlator = correlator;
    this.session = session;
    this.testRunner = testRunner;
    this.maxHypotheses = Math.max(1, Math.min(maxHypotheses, 16));
    this.maxChecks = Math.max(1, Math.min(maxChecks, 32));
    this.signal = signal;
  }

  /**
   * Investigate a failed step or run.
   * @param {object} failure - { subject, reason, stepId, evidenceIds, observations }
   */
  async investigate(failure) {
    if (!failure || typeof failure !== "object") throw new Error("Investigation requires a failure object.");
    const classification = this.#classifyFailure(failure);
    const availableEvidence = this.#identifyEvidence(failure);
    const hypotheses = this.#generateHypotheses(failure, classification, availableEvidence);
    const discriminatingChecks = this.#selectDiscriminatingChecks(hypotheses);
    const executed = await this.#executeChecks(discriminatingChecks, { failure, classification });
    const updated = this.#reviseHypotheses(hypotheses, executed);
    const report = this.#buildReport(failure, classification, updated, executed);

    return {
      classification,
      availableEvidence,
      hypotheses: updated,
      executedChecks: executed,
      report
    };
  }

  #classifyFailure(failure) {
    const reason = String(failure.reason ?? "").toLowerCase();
    if (reason.includes("unauthorized") || reason.includes("401") || reason.includes("403") || reason.includes("permission") || reason.includes("authorized")) return FAILURE_CLASSIFICATION.AUTHORIZATION;
    if (reason.includes("network") || reason.includes("request") || reason.includes("fetch") || reason.includes("status")) return FAILURE_CLASSIFICATION.NETWORK;
    if (reason.includes("navigate") || reason.includes("page") || reason.includes("url")) return FAILURE_CLASSIFICATION.NAVIGATION;
    if (reason.includes("assert") || reason.includes("expect") || reason.includes("title") || reason.includes("element")) return FAILURE_CLASSIFICATION.ASSERTION;
    if (reason.includes("diagnostic") || reason.includes("collector") || reason.includes("source")) return FAILURE_CLASSIFICATION.DIAGNOSTIC;
    return FAILURE_CLASSIFICATION.UNKNOWN;
  }

  #identifyEvidence(failure) {
    const evidence = {
      failureReason: failure.reason ?? null,
      stepId: failure.stepId ?? null,
      evidenceIds: [...(failure.evidenceIds ?? [])],
      collectorSnapshots: [],
      correlationLinks: []
    };
    if (this.collector) {
      evidence.collectorSnapshots = this.collector.getSnapshots().slice(0, 20);
    }
    if (this.correlator) {
      evidence.correlationLinks = this.correlator.getLinks().slice(0, 50);
    }
    return evidence;
  }

  #generateHypotheses(failure, classification, evidence) {
    const hypotheses = [];
    switch (classification) {
      case FAILURE_CLASSIFICATION.NAVIGATION:
        hypotheses.push(
          { id: "h1", description: "Target page did not load or redirected to an unexpected URL.", discriminatingCheck: "re-observe current URL and title" },
          { id: "h2", description: "Session expired and redirected to login.", discriminatingCheck: "check for login-page markers in current observation" },
          { id: "h3", description: "Target control was removed or renamed.", discriminatingCheck: "compare control name in current observation against the failing step's expected value" }
        );
        break;
      case FAILURE_CLASSIFICATION.ASSERTION:
        hypotheses.push(
          { id: "h1", description: "Expected text was not present at assertion time (timing or dynamic content).", discriminatingCheck: "re-observe after a bounded wait and re-evaluate" },
          { id: "h2", description: "The application state did not change (action had no effect).", discriminatingCheck: "compare before/after state fingerprints" },
          { id: "h3", description: "The assertion pattern was incorrect.", discriminatingCheck: "log the actual observed value for the caller to evaluate" }
        );
        break;
      case FAILURE_CLASSIFICATION.NETWORK:
        hypotheses.push(
          { id: "h1", description: "The expected request was not sent (UI action did not trigger it).", discriminatingCheck: "compare network activity before and after the action" },
          { id: "h2", description: "The request failed with a non-2xx status.", discriminatingCheck: "inspect the response status of matching requests" },
          { id: "h3", description: "The request was not observed because diagnostics were not collected.", discriminatingCheck: "collect diagnostics and re-check" }
        );
        break;
      case FAILURE_CLASSIFICATION.AUTHORIZATION:
        hypotheses.push(
          { id: "h1", description: "The session expired or the token was invalid.", discriminatingCheck: "check the current page for login markers" },
          { id: "h2", description: "The caller's authority does not permit the operation.", discriminatingCheck: "report the authorization boundary and required capability" }
        );
        break;
      case FAILURE_CLASSIFICATION.DIAGNOSTIC:
        hypotheses.push(
          { id: "h1", description: "The diagnostic source is not registered for this run.", discriminatingCheck: "list registered sources and compare with the requested source" },
          { id: "h2", description: "The diagnostic source's rate limit was exceeded.", discriminatingCheck: "check the call count against the contract's rate limit" }
        );
        break;
      default:
        hypotheses.push(
          { id: "h1", description: "An application error or unexpected state caused the failure.", discriminatingCheck: "collect a fresh diagnostic snapshot" },
          { id: "h2", description: "A runtime or infrastructure issue caused the failure.", discriminatingCheck: "re-run the failing step with fresh evidence" }
        );
    }
    return hypotheses.slice(0, this.maxHypotheses);
  }

  #selectDiscriminatingChecks(hypotheses) {
    const checks = [];
    const seen = new Set();
    for (const hypothesis of hypotheses) {
      if (!hypothesis.discriminatingCheck) continue;
      const key = hypothesis.discriminatingCheck.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push({ hypothesisId: hypothesis.id, check: hypothesis.discriminatingCheck });
    }
    return checks.slice(0, this.maxChecks);
  }

  async #executeChecks(checks, { failure, classification }) {
    const executed = [];
    for (const { hypothesisId, check } of checks) {
      if (this.signal?.aborted) break;
      try {
        let result;
        switch (check) {
          case "re-observe current URL and title":
            result = await this.#reObservePage();
            break;
          case "check for login-page markers in current observation":
            result = await this.#checkLoginMarkers();
            break;
          case "compare control name in current observation against the failing step's expected value":
            result = await this.#compareControlName(failure);
            break;
          case "re-observe after a bounded wait and re-evaluate":
            result = await this.#reObserveAfterWait();
            break;
          case "compare before/after state fingerprints":
            result = await this.#compareFingerprints();
            break;
          case "log the actual observed value for the caller to evaluate":
            result = await this.#logObservedValue(failure);
            break;
          case "compare network activity before and after the action":
            result = await this.#compareNetworkActivity();
            break;
          case "inspect the response status of matching requests":
            result = await this.#inspectResponseStatus();
            break;
          case "collect diagnostics and re-check":
            result = await this.#collectAndRecheck();
            break;
          case "list registered sources and compare with the requested source":
            result = await this.#listSources();
            break;
          case "check the call count against the contract's rate limit":
            result = await this.#checkRateLimit();
            break;
          case "collect a fresh diagnostic snapshot":
            result = await this.#collectFreshSnapshot();
            break;
          case "re-run the failing step with fresh evidence":
            result = await this.#reRunStep(failure);
            break;
          case "report the authorization boundary and required capability":
            result = { status: STEP_STATUS.BLOCKED, reason: "Authorization boundary requires manual handoff." };
            break;
          default:
            result = { status: STEP_STATUS.UNCERTAIN, reason: `No executor for check '${check}'.` };
        }
        executed.push({ hypothesisId, check, ...result });
      } catch (error) {
        executed.push({ hypothesisId, check, status: STEP_STATUS.FAIL, reason: String(error?.message ?? error).slice(0, 200) });
      }
    }
    return executed;
  }

  async #reObservePage() {
    if (this.session) {
      const observation = await this.session.observe();
      return {
        status: STEP_STATUS.PASS,
        reason: `Current page: ${observation?.page?.url ?? "unknown"}`,
        evidence: { url: observation?.page?.url, title: observation?.page?.title },
        evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean)
      };
    }
    if (!this.collector) return { status: STEP_STATUS.UNCERTAIN, reason: "No browser session or collector available." };
    const snapshots = this.collector.getSnapshots({ sourceId: "browser-lifecycle" });
    const latest = snapshots.slice(-1)[0];
    const events = latest?.data?.events ?? [];
    if (!events.length) return { status: STEP_STATUS.UNCERTAIN, reason: "No lifecycle events collected." };
    const lastNavigated = events.filter(e => e.event === "Page.frameNavigated" || e.event === "Page.navigatedWithinDocument").slice(-1)[0];
    if (!lastNavigated) return { status: STEP_STATUS.UNCERTAIN, reason: "No recent navigation event." };
    return { status: STEP_STATUS.PASS, reason: `Last navigation: ${lastNavigated.url ?? "unknown"}`, evidence: { url: lastNavigated.url }, evidenceIds: [latest.evidenceId ?? ""].filter(Boolean) };
  }

  async #checkLoginMarkers() {
    if (this.session) {
      const observation = await this.session.observe();
      const url = String(observation?.page?.url ?? "").toLowerCase();
      const title = String(observation?.page?.title ?? "").toLowerCase();
      const hasLoginMarker = url.includes("login") || url.includes("signin") || title.includes("login") || title.includes("sign in");
      return {
        status: hasLoginMarker ? "PASS" : "UNCERTAIN",
        reason: hasLoginMarker ? "Login page detected in current observation." : "No login marker in current observation.",
        evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean)
      };
    }
    if (!this.collector) return { status: "UNCERTAIN", reason: "No browser session or collector available." };
    const snapshots = this.collector.getSnapshots({ sourceId: "browser-lifecycle" });
    const latest = snapshots.slice(-1)[0];
    const events = latest?.data?.events ?? [];
    if (!events.length) return { status: "UNCERTAIN", reason: "No lifecycle events collected." };
    const hasLoginMarker = events.some(e => e.url?.includes("login") || e.url?.includes("signin"));
    return { status: hasLoginMarker ? "PASS" : "UNCERTAIN", reason: hasLoginMarker ? "Login page detected in recent lifecycle events." : "No login marker in recent lifecycle events.", evidenceIds: [latest.evidenceId ?? ""].filter(Boolean) };
  }

  async #compareControlName(failure) {
    if (!this.session) return { status: "UNCERTAIN", reason: "No browser session available for control-name comparison." };
    const observation = await this.session.observe();
    const expected = failure.expectedControlName;
    if (!expected) return { status: "UNCERTAIN", reason: "Failure does not record an expectedControlName for comparison." };
    const found = (observation.candidates ?? []).some(c => c.name === expected);
    return {
      status: found ? "PASS" : "FAIL",
      reason: found ? `Control '${expected}' is present in the current observation.` : `Control '${expected}' is not present in the current observation.`,
      evidenceIds: [observation.evidenceId ?? ""].filter(Boolean)
    };
  }

  async #reObserveAfterWait() {
    if (!this.session) return { status: "UNCERTAIN", reason: "No browser session available for delayed re-observation." };
    await new Promise(resolve => setTimeout(resolve, 1000));
    const observation = await this.session.observe();
    return {
      status: STEP_STATUS.PASS,
      reason: `Delayed re-observation captured. Page: ${observation?.page?.url ?? "unknown"}`,
      evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean),
      evidence: { page: observation?.page }
    };
  }

  #compareFingerprints() {
    return { status: "UNCERTAIN", reason: "State fingerprint comparison requires evidence references." };
  }

  async #logObservedValue(failure) {
    const observed = failure?.observedValue;
    if (observed === undefined || observed === null) {
      return { status: "UNCERTAIN", reason: "No observedValue was provided in the failure record; cannot log a meaningful value." };
    }
    return {
      status: STEP_STATUS.PASS,
      reason: `Observed value recorded: ${String(observed).slice(0, 200)}`,
      evidence: { observedValue: String(observed).slice(0, 200) }
    };
  }

  async #compareNetworkActivity() {
    if (!this.collector) return { status: "UNCERTAIN", reason: "No collector available." };
    const snapshots = this.collector.getSnapshots({ sourceId: "browser-network" });
    if (snapshots.length < 2) return { status: "UNCERTAIN", reason: "Fewer than two network snapshots." };
    const before = new Set(snapshots[0].data.requests?.map(r => `${r.method}:${r.url}`) ?? []);
    const after = new Set(snapshots[1].data.requests?.map(r => `${r.method}:${r.url}`) ?? []);
    const newRequests = [...after].filter(r => !before.has(r));
    if (newRequests.length > 0) {
      return { status: "PASS", reason: `${newRequests.length} new request(s) after the action.`, evidence: { newRequests: newRequests.slice(0, 10) } };
    }
    return { status: "FAIL", reason: "No new requests after the action." };
  }
  async #inspectResponseStatus() {
    if (!this.collector) return { status: "UNCERTAIN", reason: "No collector available." };
    const snapshots = this.collector.getSnapshots({ sourceId: "browser-network" });
    const latest = snapshots.slice(-1)[0];
    const requests = latest?.data?.requests ?? [];
    const non2xx = requests.filter(r => typeof r.status === "number" && r.status >= 400);
    if (non2xx.length > 0) {
      return { status: "PASS", reason: `${non2xx.length} request(s) with status >= 400.`, evidence: { requests: non2xx.slice(0, 10).map(r => ({ url: r.url, status: r.status })) } };
    }
    return { status: "FAIL", reason: "No request with status >= 400 in latest network snapshot." };
  }

  async #collectAndRecheck() {
    return { status: "UNCERTAIN", reason: "Collect-and-recheck requires an active collection loop; not available in this engine." };
  }

  async #listSources() {
    if (!this.collector) return { status: "UNCERTAIN", reason: "No collector available." };
    const sources = this.collector.listSources();
    return { status: "PASS", reason: `${sources.length} source(s) registered: ${sources.map(s => s.id).join(", ")}`, evidence: { sources: sources.map(s => s.id) } };
  }

  async #checkRateLimit() {
    if (!this.collector) return { status: "UNCERTAIN", reason: "No collector available." };
    return { status: "UNCERTAIN", reason: "Rate-limit introspection is not yet exposed by the collector." };
  }

  async #collectFreshSnapshot() {
    if (!this.collector) return { status: STEP_STATUS.UNCERTAIN, reason: "No collector available." };
    if (this.session) {
      // Trigger a fresh observation so browser diagnostic sources have evidence.
      await this.session.observe();
    }
    const sourceIds = this.collector.listSources().map(s => s.id);
    if (!sourceIds.length) return { status: STEP_STATUS.UNCERTAIN, reason: "No diagnostic sources registered." };
    const results = await this.collector.collectAll(sourceIds.map(id => ({ sourceId: id, operation: "read" })));
    const ok = results.filter(r => r.status === "ok");
    return {
      status: ok.length > 0 ? STEP_STATUS.PASS : STEP_STATUS.FAIL,
      reason: `Collected from ${ok.length}/${sourceIds.length} sources.`,
      evidenceIds: ok.map(r => r.snapshot?.evidenceId ?? r.snapshot?.sourceId ?? "").filter(Boolean)
    };
  }

  async #reRunStep(failure) {
    if (!this.testRunner) return { status: "UNCERTAIN", reason: "No test runner reference available for step re-execution." };
    if (!failure?.workflow || !failure?.stepId) return { status: "UNCERTAIN", reason: "Failure does not include workflow and stepId for re-execution." };
    const step = failure.workflow.steps?.find(s => s.id === failure.stepId);
    if (!step) return { status: "UNCERTAIN", reason: `Step '${failure.stepId}' not found in workflow for re-execution.` };
    const receipt = await this.testRunner.run(
      { ...failure.workflow, id: `reinvestigate-${failure.stepId}`, steps: [step] },
      { runId: failure.runId }
    );
    const stepResult = receipt.steps.at(-1);
    return {
      status: stepResult?.status ?? STEP_STATUS.UNCERTAIN,
      reason: stepResult?.reason ?? "Step re-execution returned no result.",
      evidenceIds: stepResult?.evidenceIds ?? []
    };
  }

  #reviseHypotheses(hypotheses, executed) {
    for (const hypothesis of hypotheses) {
      const checks = executed.filter(e => e.hypothesisId === hypothesis.id);
      const passes = checks.filter(e => e.status === "PASS").length;
      const fails = checks.filter(e => e.status === "FAIL").length;
      const blocked = checks.filter(e => e.status === "BLOCKED").length;
      if (blocked > 0) { hypothesis.confidence = CAUSAL_CONFIDENCE.BLOCKED; continue; }
      if (passes > 0 && fails === 0) hypothesis.confidence = CAUSAL_CONFIDENCE.LIKELY;
      else if (fails > 0) hypothesis.confidence = CAUSAL_CONFIDENCE.INSUFFICIENT;
      else hypothesis.confidence = CAUSAL_CONFIDENCE.INSUFFICIENT;
    }
    return hypotheses;
  }

  #buildReport(failure, classification, hypotheses, executed) {
    const report = new DiagnosticReport({ runId: failure.runId ?? "investigation", title: `Investigation: ${failure.subject ?? "failure"}` });
    for (const hypothesis of hypotheses) {
      const level = hypothesis.confidence === CAUSAL_CONFIDENCE.LIKELY ? FINDING_LEVEL.LIKELY
        : hypothesis.confidence === CAUSAL_CONFIDENCE.BLOCKED ? FINDING_LEVEL.BLOCKED
        : FINDING_LEVEL.INSUFFICIENT;
      report.addFinding({
        level,
        subject: `Hypothesis: ${hypothesis.description}`,
        description: `Classification: ${classification}. Checks: ${executed.filter(e => e.hypothesisId === hypothesis.id).map(c => `${c.check} → ${c.status}`).join("; ") || "none"}.`,
        evidenceIds: hypothesis.evidenceIds ?? []
      });
    }
    report.setCorrelationSummary(this.correlator?.summary() ?? null);
    const hasConfirmingEvidence = executed.some(e => e.status === "PASS" && e.evidenceIds?.length > 0);
    const hasFailures = executed.some(e => e.status === "FAIL");
    const allBlocked = executed.length > 0 && executed.every(e => e.status === "BLOCKED" || e.status === "UNCERTAIN");
    const reportStatus = allBlocked ? INVESTIGATION_STATUS.BLOCKED
      : hasFailures ? INVESTIGATION_STATUS.NARROWED
      : hasConfirmingEvidence ? INVESTIGATION_STATUS.NARROWED
      : INVESTIGATION_STATUS.INCONCLUSIVE;
    report.setInvestigationStatus(reportStatus);
    return report;
  }
}
