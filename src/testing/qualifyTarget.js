import { verifyObservedUrl } from "../environments/model.js";

/** Resolve the exact independently authorized browser target, then verify its observed environment. */
export function selectAuthorizedStagingTarget(targets, authorizedTargetId, environment) {
  if (typeof authorizedTargetId !== "string" || !authorizedTargetId) {
    return { ok: false, reason: "An independently authorized target ID is required." };
  }
  const target = (targets ?? []).find(item => item?.id === authorizedTargetId);
  if (!target) return { ok: false, reason: "The independently authorized target is not currently available." };
  const identity = verifyObservedUrl(environment, target.url);
  if (!identity.ok) return { ok: false, reason: identity.reason, target };
  return { ok: true, target, identity };
}
