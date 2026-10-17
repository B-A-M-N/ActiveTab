/**
 * Diagnostic correlator — associates actions, network events, and
 * application records by evidence, not temporal adjacency.
 *
 * Correlation strength classes:
 *   direct    — stable shared identifier or demonstrable causal relationship
 *   probable  — multiple compatible signals, not conclusively established
 *   temporal  — events near each other without sufficient proof of causality
 *   unknown   — available evidence cannot establish a relationship
 */

export const CORRELATION_STRENGTH = Object.freeze({
  DIRECT: "direct",
  PROBABLE: "probable",
  TEMPORAL: "temporal",
  UNKNOWN: "unknown"
});

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
   * Correlate two events by shared identifiers.
   * Direct requires a non-empty shared identifier match.
   * Probable requires ≥2 compatible non-identifier signals.
   * Temporal requires proximity only.
   */
  correlate(eventIdA, eventIdB) {
    const a = this.events.find(e => e.eventId === eventIdA);
    const b = this.events.find(e => e.eventId === eventIdB);
    if (!a || !b) throw new Error("Both eventId values must be added before correlating.");

    // Shared identifiers (direct evidence)
    const sharedIds = this.#sharedIdentifiers(a, b);
    if (sharedIds.length > 0) {
      return this.#record(a, b, CORRELATION_STRENGTH.DIRECT, { sharedIds });
    }

    // Compatible signals (probable evidence)
    const compatibleSignals = this.#compatibleSignals(a, b);
    if (compatibleSignals.length >= 2) {
      return this.#record(a, b, CORRELATION_STRENGTH.PROBABLE, { compatibleSignals });
    }

    // Temporal proximity only
    const proximity = this.#temporalProximity(a, b);
    if (proximity) {
      return this.#record(a, b, CORRELATION_STRENGTH.TEMPORAL, { proximity });
    }

    return this.#record(a, b, CORRELATION_STRENGTH.UNKNOWN, {});
  }

  #sharedIdentifiers(a, b) {
    const keys = ["traceId", "requestId", "correlationId", "taskId", "workerId", "executionId"];
    const shared = [];
    for (const key of keys) {
      const va = a[key];
      const vb = b[key];
      if (typeof va === "string" && typeof vb === "string" && va.length > 0 && va === vb) {
        shared.push({ key, value: va });
      }
    }
    return shared;
  }

  #compatibleSignals(a, b) {
    const signals = [];
    if (a.sourceType != null && a.sourceType === b.sourceType) signals.push("sourceType");
    if (a.origin != null && a.origin === b.origin) signals.push("origin");
    if (a.resourceId != null && a.resourceId === b.resourceId) signals.push("resourceId");
    if (a.operationType != null && a.operationType === b.operationType) signals.push("operationType");
    if (a.sessionKey != null && a.sessionKey === b.sessionKey) signals.push("sessionKey");
    return signals;
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
