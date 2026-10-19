/**
 * Bounded investigation engine — after a failure, classifies the observed
 * failure, identifies available evidence, generates competing causal
 * hypotheses, selects safe discriminating checks, and produces a qualified
 * report. Never assumes a root cause merely because one hypothesis explains
 * the symptoms.
 */

import { DiagnosticReport, FINDING_LEVEL, INVESTIGATION_STATUS } from "../diagnostics/report.js";
import { CORRELATION_STRENGTH } from "../diagnostics/correlator.js";
import { classifyFailureReasonCode, FAILURE_CLASSIFICATION } from "../diagnostics/failureTaxonomy.js";
import { STEP_STATUS } from "../testing/schema.js";

export { FAILURE_CLASSIFICATION } from "../diagnostics/failureTaxonomy.js";

function safeUrlMetadata(value) {
  if (typeof value !== "string" || value.length > 4096) return { validUrl: false, length: typeof value === "string" ? value.length : null };
  try {
    const url = new URL(value);
    return {
      validUrl: true,
      origin: url.origin,
      pathDepth: url.pathname.split("/").filter(Boolean).length,
      queryParameterCount: [...url.searchParams.keys()].length,
      hasFragment: Boolean(url.hash)
    };
  } catch { return { validUrl: false }; }
}

function safeRequestMetadata(request) {
  return {
    method: typeof request?.method === "string" && /^[A-Z]{1,16}$/iu.test(request.method) ? request.method.toUpperCase() : "UNKNOWN",
    ...(Number.isInteger(request?.status) ? { status: request.status } : {}),
    url: safeUrlMetadata(request?.url)
  };
}

function summarizeSnapshot(snapshot) {
  const data = snapshot?.data;
  return {
    snapshotId: snapshot?.snapshotId ?? null,
    sourceId: snapshot?.sourceId ?? null,
    operation: snapshot?.operation ?? null,
    collectedAt: snapshot?.collectedAt ?? null,
    evidenceId: snapshot?.evidenceId ?? null,
    status: snapshot?.status ?? null,
    ...(Array.isArray(data?.requests) ? { requestCount: data.requests.length } : {}),
    ...(Array.isArray(data?.events) ? { eventCount: data.events.length } : {}),
    ...(data && !Array.isArray(data) && typeof data === "object" ? { dataFieldNames: Object.keys(data).slice(0, 32) } : {})
  };
}

function operationDisposition(status) {
  if (status === "VERIFIED") return "reconciled_verified";
  if (status === "FAILED") return "reconciled_failed";
  if (status === "REFUSED") return "refused_before_dispatch";
  if (status === "OBSERVED") return "effect_observed_but_not_verified";
  return "may_have_dispatched_or_still_be_in_flight";
}

export const CAUSAL_CONFIDENCE = Object.freeze({
  CONFIRMED: "confirmed",
  LIKELY: "likely",
  NARROWED: "narrowed",
  INSUFFICIENT: "insufficient",
  BLOCKED: "environmental_or_authorization_blocker"
});

export class InvestigationEngine {
  constructor({ collector, correlator, session, runStateStore = null, maxHypotheses = 5, maxChecks = 8, signal } = {}) {
    this.collector = collector;
    this.correlator = correlator;
    this.session = session;
    this.runStateStore = runStateStore;
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
    const providedReasonCode = failure.reasonCode ?? failure.failureCode ?? null;
    const stableReasonCodeRecognized = classifyFailureReasonCode(providedReasonCode) !== null;
    const availableEvidence = this.#identifyEvidence(failure);
    const hypotheses = this.#generateHypotheses(failure, classification, availableEvidence);
    const discriminatingChecks = this.#selectDiscriminatingChecks(hypotheses);
    const executed = await this.#executeChecks(discriminatingChecks, { failure, classification });
    const updated = this.#reviseHypotheses(hypotheses, executed);
    const report = this.#buildReport(failure, classification, updated, executed);

    return {
      classification,
      classificationBasis: stableReasonCodeRecognized ? "stable_reason_code" : providedReasonCode ? "unrecognized_reason_code" : "legacy_reason_text",
      failureCode: typeof providedReasonCode === "string" && /^[a-z][a-z0-9_:-]{0,95}$/iu.test(providedReasonCode) ? providedReasonCode.toLowerCase() : null,
      automatedContinuationPermitted: false,
      availableEvidence,
      hypotheses: updated,
      executedChecks: executed,
      report
    };
  }

  #classifyFailure(failure) {
    const reasonCode = failure.reasonCode ?? failure.failureCode;
    if (typeof reasonCode === "string") {
      return classifyFailureReasonCode(reasonCode) ?? FAILURE_CLASSIFICATION.UNKNOWN;
    }
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
      evidence.collectorSnapshots = this.collector.getSnapshots().slice(0, 20).map(summarizeSnapshot);
    }
    if (this.correlator) {
      evidence.correlationLinks = this.correlator.getLinks().slice(0, 50).map(link => ({
        linkId: link.linkId,
        strength: link.strength,
        eventIdA: link.eventIdA,
        eventIdB: link.eventIdB
      }));
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
          { id: "h2", description: "A runtime or infrastructure issue caused the failure.", discriminatingCheck: "inspect prior dispatch evidence without replay" }
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
          case "inspect prior dispatch evidence without replay":
            result = await this.#investigatePriorDispatch(failure);
            break;
          case "report the authorization boundary and required capability":
            result = { status: STEP_STATUS.BLOCKED, reason: "Authorization boundary requires manual handoff." };
            break;
          default:
            result = { status: STEP_STATUS.UNCERTAIN, reason: `No executor for check '${check}'.` };
        }
        executed.push({ hypothesisId, check, ...result });
      } catch (error) {
        executed.push({ hypothesisId, check, status: STEP_STATUS.UNCERTAIN, reason: "The diagnostic check failed; no effect was replayed." });
      }
    }
    return executed;
  }

  async #reObservePage() {
    if (this.session) {
      const observation = await this.session.observe({ profile: "lightweight" });
      return {
        status: STEP_STATUS.PASS,
        reason: "A fresh lightweight page observation was captured.",
        evidence: {
          url: safeUrlMetadata(observation?.page?.url),
          titleCharacterLength: typeof observation?.page?.title === "string" ? [...observation.page.title].length : null
        },
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
      const observation = await this.session.observe({ profile: "lightweight" });
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
    const observation = await this.session.observe({ profile: "lightweight" });
    return {
      status: STEP_STATUS.PASS,
      reason: "Delayed lightweight re-observation captured.",
      evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean),
      evidence: {
        page: {
          url: safeUrlMetadata(observation?.page?.url),
          titleCharacterLength: typeof observation?.page?.title === "string" ? [...observation.page.title].length : null
        }
      }
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
    const valueType = Array.isArray(observed) ? "array" : typeof observed;
    const characterLength = typeof observed === "string" ? [...observed].length : null;
    const byteLength = typeof observed === "string" && observed.length <= 1_000_000 ? Buffer.byteLength(observed, "utf8") : null;
    return {
      status: STEP_STATUS.UNCERTAIN,
      reason: "Observed value content was withheld from the investigation report; only structural metadata is included.",
      evidence: { observedValue: { redacted: true, valueType, characterLength, byteLength } }
    };
  }

  async #compareNetworkActivity() {
    if (!this.collector) return { status: "UNCERTAIN", reason: "No collector available." };
    const snapshots = this.collector.getSnapshots({ sourceId: "browser-network" });
    if (snapshots.length < 2) return { status: "UNCERTAIN", reason: "Fewer than two network snapshots." };
    const before = new Set(snapshots[0].data.requests?.map(r => `${r.method}:${r.url}`) ?? []);
    const after = new Set(snapshots[1].data.requests?.map(r => `${r.method}:${r.url}`) ?? []);
    const afterRequests = snapshots[1].data.requests ?? [];
    const newRequests = afterRequests.filter(request => !before.has(`${request.method}:${request.url}`));
    if (newRequests.length > 0) {
      return { status: "PASS", reason: `${newRequests.length} new request(s) after the action.`, evidence: { newRequests: newRequests.slice(0, 10).map(safeRequestMetadata) } };
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
      return { status: "PASS", reason: `${non2xx.length} request(s) with status >= 400.`, evidence: { requests: non2xx.slice(0, 10).map(safeRequestMetadata) } };
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

  async #investigatePriorDispatch(failure) {
    if (!failure?.runId || typeof this.runStateStore?.getFresh !== "function") {
      return { status: STEP_STATUS.UNCERTAIN, reason: "Durable dispatch evidence is unavailable; the prior effect was not replayed." };
    }
    const run = await this.runStateStore.getFresh(failure.runId);
    if (!run) return { status: STEP_STATUS.UNCERTAIN, reason: "The durable run record was not found; the prior effect was not replayed." };

    const statusRank = { RESERVED: 1, DISPATCHED: 2, UNCERTAIN: 3, OBSERVED: 4, VERIFIED: 5, FAILED: 5, REFUSED: 5 };
    const operations = new Map();
    for (const operation of [...(run.pendingOperations ?? []), ...(run.uncertainOperations ?? [])]) {
      if (typeof operation?.operationId !== "string") continue;
      const previous = operations.get(operation.operationId);
      if (!previous || (statusRank[operation.status] ?? 0) >= (statusRank[previous.status] ?? 0)) {
        operations.set(operation.operationId, operation);
      }
    }
    const matches = [...operations.values()].filter(operation =>
      (failure.operationId ? operation.operationId === failure.operationId : true)
      && (failure.stepId ? operation.stepId === failure.stepId : true));
    if (matches.length !== 1) {
      return {
        status: STEP_STATUS.UNCERTAIN,
        reason: matches.length ? "Multiple durable operations match this failure; no outcome was inferred and no effect was replayed." : "No exact durable operation matched this failure; no effect was replayed.",
        evidence: { matchingOperationCount: matches.length, runStatus: run.status ?? null }
      };
    }

    const operation = matches[0];
    const operationEvidenceIds = [...new Set([...(operation.evidenceIds ?? []), operation.receiptId].filter(value => typeof value === "string" && value))];
    const evidenceSet = new Set(operationEvidenceIds);
    const relatedLinks = (this.correlator?.getLinks() ?? []).filter(link => {
      const references = [link.eventIdA, link.eventIdB, ...(link.evidence?.evidenceRefs ?? [])];
      return references.some(reference => evidenceSet.has(reference));
    }).map(link => ({ linkId: link.linkId, strength: link.strength, eventIdA: link.eventIdA, eventIdB: link.eventIdB }));
    const dispatchTime = Date.parse(operation.dispatchedAt ?? operation.reservedAt ?? "");
    const subsequentSnapshots = Number.isFinite(dispatchTime) && this.collector
      ? this.collector.getSnapshots().filter(snapshot => Date.parse(snapshot.collectedAt ?? "") >= dispatchTime).slice(0, 20).map(summarizeSnapshot)
      : [];
    return {
      status: STEP_STATUS.UNCERTAIN,
      reason: `Durable operation evidence reports ${operation.status ?? "unknown"}; this check only inspected the reservation and collected evidence. No effect was replayed.`,
      evidenceIds: operationEvidenceIds,
      evidence: {
        effectDisposition: operationDisposition(operation.status),
        operation: {
          operationId: operation.operationId,
          stepId: operation.stepId,
          action: operation.action,
          status: operation.status,
          targetId: operation.targetId ?? null,
          reservedAt: operation.reservedAt ?? null,
          dispatchedAt: operation.dispatchedAt ?? null,
          reconciledAt: operation.reconciledAt ?? null,
          evidenceIds: operationEvidenceIds
        },
        correlatedLinks: relatedLinks,
        subsequentSnapshots
      }
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
    const allBlocked = executed.length > 0 && executed.every(e => e.status === "BLOCKED");
    const reportStatus = allBlocked ? INVESTIGATION_STATUS.BLOCKED
      : hasFailures ? INVESTIGATION_STATUS.NARROWED
      : hasConfirmingEvidence ? INVESTIGATION_STATUS.NARROWED
      : INVESTIGATION_STATUS.INCONCLUSIVE;
    report.setInvestigationStatus(reportStatus);
    return report;
  }
}
