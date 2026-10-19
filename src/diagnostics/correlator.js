/**
 * Diagnostic correlator — associates actions, network events, and
 * application records by evidence, not temporal adjacency.
 *
 * Correlation strength classes:
 *   direct    — a verified identifier with a complete run and target scope
 *   probable  — an explicitly typed pair-specific inference
 *   temporal  — events near each other without sufficient proof of causality
 *   unknown   — available evidence cannot establish a relationship
 */

export const CORRELATION_STRENGTH = Object.freeze({
  DIRECT: "direct",
  PROBABLE: "probable",
  TEMPORAL: "temporal",
  UNKNOWN: "unknown"
});

const REQUIRED_SCOPE = Object.freeze(["environmentId", "targetId", "runId", "principalId", "operationNamespace"]);
const VERIFIED_PAIR_KINDS = new Set(["freeinference_cloud_agent_run"]);
const INFERRED_PAIR_KINDS = new Set(["workflow_step_diagnostic"]);

function correlationEvidence(event) {
  const correlation = event?.correlation;
  if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)
    || typeof correlation.namespace !== "string" || !correlation.namespace || correlation.namespace.length > 96
    || typeof correlation.value !== "string" || !correlation.value || correlation.value.length > 512
    || typeof correlation.pairKind !== "string" || !correlation.pairKind || correlation.pairKind.length > 96
    || !correlation.scope || typeof correlation.scope !== "object" || Array.isArray(correlation.scope)
    || !REQUIRED_SCOPE.every(key => typeof correlation.scope[key] === "string" && correlation.scope[key].length > 0 && correlation.scope[key].length <= 256)
    || !Array.isArray(correlation.evidenceRefs) || correlation.evidenceRefs.length < 2
    || correlation.evidenceRefs.some(value => typeof value !== "string" || !value || value.length > 256)) return null;
  const evidenceRefs = [...new Set(correlation.evidenceRefs)].sort();
  if (evidenceRefs.length < 2 || !evidenceRefs.includes(event.evidenceId)) return null;
  return {
    namespace: correlation.namespace,
    value: correlation.value,
    pairKind: correlation.pairKind,
    provenance: correlation.provenance,
    scope: Object.fromEntries(REQUIRED_SCOPE.map(key => [key, correlation.scope[key]])),
    evidenceRefs
  };
}

function sameCorrelation(left, right) {
  return left && right
    && left.namespace === right.namespace
    && left.value === right.value
    && left.pairKind === right.pairKind
    && left.provenance === right.provenance
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs);
}

export class DiagnosticCorrelator {
  constructor({ maxLinks = 512, temporalWindowMs = 5_000 } = {}) {
    this.maxLinks = Math.max(1, Math.min(maxLinks, 4_096));
    this.temporalWindowMs = Math.max(100, Math.min(temporalWindowMs, 60_000));
    this.events = [];
    this.links = [];
  }

  addEvent(event) {
    if (!event || typeof event !== "object") throw new Error("Correlator event must be an object.");
    if (typeof event.eventId !== "string" || !event.eventId) {
      throw new Error("Correlator event requires an eventId.");
    }
    if (this.events.length >= this.maxLinks * 4) {
      this.events.shift();
    }
    this.events.push({
      ...event,
      recordedAt: new Date().toISOString()
    });
    return this;
  }

  /**
   * Raw shared strings and generic metadata are weak clues. Only an explicit,
   * evidence-backed pair rule with a complete scope can produce direct or
   * probable correlation.
   */
  correlate(eventIdA, eventIdB) {
    const a = this.events.find(e => e.eventId === eventIdA);
    const b = this.events.find(e => e.eventId === eventIdB);
    if (!a || !b) throw new Error("Both eventId values must be added before correlating.");

    const left = correlationEvidence(a);
    const right = correlationEvidence(b);
    if (sameCorrelation(left, right)) {
      if (left.provenance === "verified_in_browser_and_backend"
        && VERIFIED_PAIR_KINDS.has(left.pairKind)
        && [a.sourceType, b.sourceType].includes("browser_ui")
        && [a.sourceType, b.sourceType].includes("cloud_agent_backend")) {
        return this.#record(a, b, CORRELATION_STRENGTH.DIRECT, { pairKind: left.pairKind, namespace: left.namespace, scope: left.scope, evidenceRefs: left.evidenceRefs });
      }
      if (left.provenance === "pair_specific_inference"
        && INFERRED_PAIR_KINDS.has(left.pairKind)
        && [a.sourceType, b.sourceType].includes("browser_action")
        && [a.sourceType, b.sourceType].includes("diagnostic_snapshot")) {
        return this.#record(a, b, CORRELATION_STRENGTH.PROBABLE, { pairKind: left.pairKind, namespace: left.namespace, scope: left.scope, evidenceRefs: left.evidenceRefs });
      }
    }

    // Temporal proximity only
    const proximity = this.#temporalProximity(a, b);
    if (proximity) {
      return this.#record(a, b, CORRELATION_STRENGTH.TEMPORAL, { proximity });
    }

    return this.#record(a, b, CORRELATION_STRENGTH.UNKNOWN, {});
  }

  #temporalProximity(a, b) {
    const ta = Date.parse(a.observedAt ?? a.recordedAt);
    const tb = Date.parse(b.observedAt ?? b.recordedAt);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
    const deltaMs = Math.abs(ta - tb);
    if (deltaMs <= this.temporalWindowMs) return { deltaMs, withinWindow: true };
    return null;
  }

  #record(a, b, strength, evidence) {
    const link = {
      linkId: `link:${a.eventId}:${b.eventId}`,
      eventIdA: a.eventId,
      eventIdB: b.eventId,
      strength,
      evidence,
      createdAt: new Date().toISOString()
    };
    this.links.push(link);
    while (this.links.length > this.maxLinks) this.links.shift();
    return link;
  }

  getLinks({ eventId = null, strength = null } = {}) {
    return this.links.filter(link =>
      (eventId === null || link.eventIdA === eventId || link.eventIdB === eventId) &&
      (strength === null || link.strength === strength)
    );
  }

  /**
   * Build a correlation summary for a report.
   * Returns counts by strength plus the strongest chain for each event pair.
   */
  summary() {
    const counts = { direct: 0, probable: 0, temporal: 0, unknown: 0 };
    for (const link of this.links) counts[link.strength]++;
    return {
      totalLinks: this.links.length,
      totalEvents: this.events.length,
      counts,
      temporalWindowMs: this.temporalWindowMs
    };
  }
}
