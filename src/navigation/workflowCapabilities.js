/**
 * Capabilities available to every profile. These are intentionally limited
 * to following a visible link already present in fresh browser evidence.
 * Application profiles may register additional typed capabilities.
 */
export function createGenericWorkflowCapabilities() {
  return Object.freeze([Object.freeze({
    id: "follow_observed_link",
    action: "click",
    effectClass: "navigation",
    targetRole: "authorized_navigation_link",
    observedRoles: Object.freeze(["link"]),
    observedTags: Object.freeze(["a"]),
    resolveTarget(observation) {
      return (observation?.candidates ?? [])
        .filter(candidate => candidate.visible === true && candidate.disabled !== true
          && (candidate.role === "link" || candidate.tag === "a"))
        .map(candidate => candidate.identity);
    },
    verificationCodes: Object.freeze(["authorized_route_changed"]),
    verify({ verificationCode, beforeObservation, afterObservation }) {
      if (verificationCode !== "authorized_route_changed") return { status: "uncertain", reasonCode: "verification_code_unsupported" };
      if (!beforeObservation?.page?.url || !afterObservation?.page?.url) return { status: "uncertain", reasonCode: "route_evidence_missing" };
      return beforeObservation.page.url !== afterObservation.page.url
        ? { status: "verified", reasonCode: "route_changed", evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId].filter(Boolean) }
        : { status: "failed", reasonCode: "route_unchanged", evidenceRefs: [beforeObservation.evidenceId, afterObservation.evidenceId].filter(Boolean) };
    }
  })]);
}
