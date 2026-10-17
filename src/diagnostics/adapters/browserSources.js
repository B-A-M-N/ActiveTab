/**
 * BrowserDiagnosticSources — factory for registering CDP-backed network
 * and lifecycle diagnostic sources with a DiagnosticCollector. Returns
 * metadata-first snapshots with explicit evidence IDs and coverage.
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";

export function registerBrowserDiagnosticSources(session, collector) {
  if (!session || !collector) throw new Error("registerBrowserDiagnosticSources requires a session and collector.");

  collector.register(
    createDiagnosticContract({
      id: "browser-network", authority: AUTHORITY.BROWSER_CDP,
      operations: [OPERATION.READ], scope: `target:${session.target?.id ?? "unknown"}`,
      sensitivity: SENSITIVITY.METADATA_ONLY,
      description: "CDP network request metadata from the attached tab."
    }),
    async () => {
      const evidenceId = session.latestEvidenceId;
      if (typeof evidenceId !== "string" || !evidenceId) {
        return { status: "unavailable", reason: "No browser observation evidence has been captured.", evidenceId: null, requests: [] };
      }
      const evidence = session.observer?.getEvidence?.(evidenceId, { facets: ["networkActivity"] });
      if (evidence?.status !== "available") {
        return { status: "unavailable", reason: `Browser evidence '${evidenceId}' is expired or unavailable.`, evidenceId, requests: [] };
      }
      const requests = Array.isArray(evidence.networkActivity) ? evidence.networkActivity : [];
      return {
        status: requests.length > 0 ? "available" : "empty",
        evidenceId,
        capturedAt: evidence.capturedAt,
        coverage: evidence.networkActivityCoverage ?? null,
        requests
      };
    }
  );

  collector.register(
    createDiagnosticContract({
      id: "browser-lifecycle", authority: AUTHORITY.BROWSER_CDP,
      operations: [OPERATION.READ], scope: `target:${session.target?.id ?? "unknown"}`,
      sensitivity: SENSITIVITY.METADATA_ONLY,
      description: "CDP lifecycle events from the attached tab."
    }),
    async () => {
      const evidenceId = session.latestEvidenceId;
      if (typeof evidenceId !== "string" || !evidenceId) {
        return { status: "unavailable", reason: "No browser observation evidence has been captured.", evidenceId: null, events: [] };
      }
      const evidence = session.observer?.getEvidence?.(evidenceId, { facets: ["lifecycleEvents"] });
      if (evidence?.status !== "available") {
        return { status: "unavailable", reason: `Browser evidence '${evidenceId}' is expired or unavailable.`, evidenceId, events: [] };
      }
      const events = Array.isArray(evidence.lifecycleEvents) ? evidence.lifecycleEvents : [];
      return {
        status: events.length > 0 ? "available" : "empty",
        evidenceId,
        capturedAt: evidence.capturedAt,
        coverage: evidence.lifecycleEventCoverage ?? null,
        events
      };
    }
  );
  return collector;
}
