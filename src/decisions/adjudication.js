/**
 * Deterministic interpretation of independent model review.
 *
 * A reviewer may stop an operation for more evidence or agent review. A
 * reviewer can never grant permission: deterministic runtime policy remains
 * the only authority that admits an operation.
 */
export function adjudicatePreActionReview(review) {
  if (review?.jev?.disposition === "needs_agent_review") {
    return {
      allowed: false,
      grantsAuthority: false,
      category: "independent_review_required",
      reason: "Jev flagged the proposed operation for agent review; no browser effect was dispatched."
    };
  }
  if (review?.evidenceStatus === "insufficient_evidence" || review?.jev?.disposition === "insufficient_evidence") {
    return {
      allowed: true,
      grantsAuthority: false,
      category: "insufficient_review_evidence",
      reason: "The advisory review lacked enough intent-bound evidence to assess the target; deterministic policy remains authoritative."
    };
  }
  return {
    allowed: true,
    grantsAuthority: false,
    category: review?.jevFailureCode ? "deterministic_fallback" : "review_clear_or_unavailable",
    reason: review?.jevFailureCode
      ? "Jev review was unavailable; deterministic runtime policy remains authoritative."
      : null
  };
}
