/**
 * Centralized browser-action execution boundary (P0-1).
 *
 * Every effectful browser action must pass through this executor, regardless
 * of whether the caller is a planner-driven navigation engine, a declarative
 * test step, a cleanup step, or an API consumer. The executor:
 *
 *  1. Verifies the target has an active authorized attachment lease.
 *  2. Verifies the observed page against the environment binding.
 *  3. Applies the navigation action policy to the selected candidate.
 *  4. Dispatches through the browser session's revalidation path.
 *  5. Records the dispatch outcome in a typed receipt.
 */

import { authorizePlannedAction } from "../navigation/actionPolicy.js";
import { normalizeOrigin, verifyObservedUrl, isLoopbackUrl } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "./controlRestrictions.js";

const SUPPORTED_ACTIONS = new Set(["navigate", "click", "fill", "select", "toggle", "upload", "scroll", "type"]);

function refused(reason, observation = null, category = "authorization_refused") {
  return { status: "refused", dispatched: false, authorized: false, category, reason, observation };
}

function navigationTarget(url, { environment, localFixture, authorizedOrigins }) {
  let destination;
  try { destination = new URL(String(url)); }
  catch { return { error: "Navigation requires a valid absolute URL." }; }
  if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) {
    return { error: "Navigation is limited to credential-free HTTP or HTTPS URLs." };
  }
  if (localFixture) {
    if (!isLoopbackUrl(destination.href)) return { error: "The local-fixture capability is limited to loopback destinations." };
  } else if (!authorizedOrigins.includes(destination.origin)) {
    return { error: `Navigation target origin '${destination.origin}' is outside the authorized environment.` };
  }
  return { destination };
}

function boundOrigins(session, environment, localFixture, observation) {
  if (environment?.authorizedOrigins?.length) return environment.authorizedOrigins;
  if (localFixture) {
    if (!isLoopbackUrl(observation?.page?.url)) return null;
    const origin = normalizeOrigin(observation.page.url);
    return origin ? [origin] : null;
  }
  const origin = normalizeOrigin(session.target?.url);
  return origin ? [origin] : null;
}

function sameFreshCandidate(candidate, observation, action, session) {
  if (!candidate || !session.target?.id) return candidate;
  if (typeof candidate.identity !== "string" || !candidate.identity) return null;
  const pool = action === "scroll" ? observation.scrollTargets : observation.candidates;
  const fresh = (pool ?? []).find(item => item.identity === candidate.identity
    && item.targetId === candidate.targetId
    && item.documentGeneration === candidate.documentGeneration
    && (action === "scroll" || item.backendNodeId === candidate.backendNodeId));
  return fresh ?? null;
}

function authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId, operationAuthorizer }) {
  const policyAction = action === "toggle" ? "click" : action;
  const policy = authorizePlannedAction(goal, candidate, policyAction);
  const adapterEligible = ["unsupported_action", "unclassified_form_submission", "unknown_control_effect"].includes(policy.category);
  if (!policy.authorized && (!adapterEligible || !operationAuthorizer || typeof operationId !== "string" || !operationId)) {
    return { allowed: false, category: policy.category, reason: policy.reason };
  }
  if (operationId && !operationAuthorizer) {
    return { allowed: false, category: "operation_contract_unavailable", reason: "A declared typed operation requires its trusted application contract." };
  }
  if (operationAuthorizer && operationId) {
    return Promise.resolve(operationAuthorizer.authorize({
      operationId, action, candidate, value, url, observation, environment
    })).then(decision => decision?.allowed === true
      ? { allowed: true, category: decision.category ?? policy.category }
      : { allowed: false, category: "operation_contract_refused", reason: decision?.reason ?? "Typed application operation is outside its registered contract." });
  }
  return { allowed: true, category: policy.category };
}

function sameObservationBinding(before, after, session) {
  if (!after?.page?.url || !before?.page?.url || after.page.url !== before.page.url) return false;
  if (before.targetId && after.targetId !== before.targetId) return false;
  if (session.target?.id && after.targetId !== session.target.id) return false;
  if (before.documentGeneration !== undefined && after.documentGeneration !== before.documentGeneration) return false;
  return true;
}

/**
 * Authorize and dispatch one effectful browser action. Returns a typed
 * result; it never dispatches when authorization or freshness fails.
 */
export async function executeAuthorizedAction({
  session, environment = null, goal = null, action, candidate = null, value = null, filePaths = null, url = null, expectedUrlPattern = null, localFixture = false, recovery = false,
  onAdmission = null, onReserve = null, onDispatch = null, operationId = null, operationAuthorizer = null
}) {
  if (!session) throw new Error("Authorized executor requires a browser session.");
  if (!SUPPORTED_ACTIONS.has(action)) {
    return refused(`Unsupported action '${action}'.`, null, "unsupported_action");
  }
  if (session.target?.id && session.attached !== true) return refused("The selected browser target is not attached.", null, "target_unattached");

  let observation = null;
  let origins = null;
  if (action === "navigate") {
    if (!localFixture && (!environment || !Array.isArray(environment.authorizedOrigins) || environment.authorizedOrigins.length === 0)) {
      return refused("Navigation requires an explicitly bound authorized environment.", null, "environment_unbound");
    }
    observation = await session.observe().catch(() => null);
    if (!observation?.page?.url) return refused("A fresh browser observation is required before navigation.", observation, "observation_unavailable");
    if (observation.targetId && session.target?.id && observation.targetId !== session.target.id) return refused("The observation belongs to a different browser target.", observation, "target_mismatch");
    origins = boundOrigins(session, environment, localFixture, observation);
    if (!origins?.length && !localFixture) return refused("Navigation requires an authorized environment or a target with a bound origin.", observation, "environment_unbound");
    if (localFixture && !isLoopbackUrl(observation.page.url) && new URL(observation.page.url).protocol !== "about:") {
      return refused("The local-fixture capability is limited to a loopback browser target.", observation, "environment_mismatch");
    }
    if (environment && !recovery) {
      const current = verifyObservedUrl(environment, observation.page.url);
      if (!current.ok && new URL(observation.page.url).protocol !== "about:") return refused(current.reason, observation, "environment_mismatch");
    }
    if (url && isOperatorProhibitedNavigation(url)) return refused("Navigation to the operator-prohibited Admin Console Audit Log is not permitted.", observation, "operator_prohibited");
    const target = navigationTarget(url, { environment, localFixture, authorizedOrigins: origins ?? [] });
    if (target.error) return refused(target.error, observation, "environment_mismatch");
  } else {
    observation = await session.observe().catch(() => null);
    if (!observation?.page?.url) return refused("A fresh browser observation is required before interaction.", observation, "observation_unavailable");
    if (observation.targetId && session.target?.id && observation.targetId !== session.target.id) return refused("The observation belongs to a different browser target.", observation, "target_mismatch");
    origins = boundOrigins(session, environment, localFixture, observation);
    if (environment) {
      const current = verifyObservedUrl(environment, observation.page.url);
      if (!current.ok) return refused(current.reason, observation, "environment_mismatch");
    } else if (localFixture) {
      if (!isLoopbackUrl(observation.page.url)) return refused("The local-fixture capability is limited to a loopback browser target.", observation, "environment_mismatch");
    } else if (session.target?.id && (!origins?.length || !origins.includes(normalizeOrigin(observation.page.url)))) {
      return refused("The observed page is outside the origin bound to this browser target.", observation, "environment_mismatch");
    }
    if (action === "scroll") {
      if (!observation.scrollTargets?.length) return refused("No scroll targets are available in the current observation.", observation, "candidate_unavailable");
    } else if (!observation.candidates?.length) return refused("No candidates are available in the current observation.", observation, "candidate_unavailable");
    const freshCandidate = sameFreshCandidate(candidate, observation, action, session);
    if (!freshCandidate) return refused("The selected target is absent or stale in the fresh observation.", observation, "candidate_stale");
    candidate = freshCandidate;
    if (action === "click" && typeof candidate.href === "string" && candidate.href.length > 0) {
      let destination;
      try { destination = new URL(candidate.href, observation.page.url); }
      catch { return refused("The selected link has an invalid destination.", observation, "invalid_navigation_target"); }
      // A caller-selected, attached target supplies a narrow same-origin
      // environment when no application profile was configured. This keeps
      // ordinary site navigation usable while preventing a page link from
      // expanding authority to another origin. Cross-origin transitions
      // still require an explicitly bound profile (or local-fixture grant).
      if (!origins?.length) {
        return refused("Following a link requires an authorized target origin.", observation, "environment_unbound");
      }
      if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password || !origins?.includes(destination.origin)) {
        return refused("The selected link destination is outside the authorized environment.", observation, "navigation_target_untrusted");
      }
    }
    // A declared typed operation is always checked by its trusted contract,
    // including when generic browser policy would otherwise allow the UI.
    try {
      const decision = await authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId, operationAuthorizer });
      if (!decision.allowed) return refused(decision.reason, observation, decision.category);
    } catch {
      return refused("Typed application operation authorization failed.", observation, "operation_contract_refused");
    }
  }

  const admittedObservation = observation;
  try {
    const admission = await onAdmission?.({ action, candidate, url, observation });
    if (admission?.allowed === false) {
      return refused(
        admission.reason ?? "Pre-dispatch review requires further review.",
        observation,
        admission.category ?? "pre_dispatch_review_required"
      );
    }
  } catch {
    return refused("Pre-dispatch admission recording failed.", observation, "admission_recording_failed");
  }

  // Review and durable reservation callbacks may take time. Re-observe the
  // exact page and target after they finish, then rerun policy and application
  // contracts against the fresh candidate immediately before CDP dispatch.
  observation = await session.observe().catch(() => null);
  if (!sameObservationBinding(admittedObservation, observation, session)) {
    return refused("The authorized page or target changed during pre-dispatch review.", observation, "pre_dispatch_state_changed");
  }
  if (action === "navigate") {
    const currentOrigin = normalizeOrigin(observation.page.url);
    if (environment && currentOrigin !== null && !origins?.includes(currentOrigin)
      && new URL(observation.page.url).protocol !== "about:") {
      return refused("The current page left the authorized environment during review.", observation, "environment_mismatch");
    }
    if (url && isOperatorProhibitedNavigation(url)) return refused("Navigation to the operator-prohibited Admin Console Audit Log is not permitted.", observation, "operator_prohibited");
    const target = navigationTarget(url, { environment, localFixture, authorizedOrigins: origins ?? [] });
    if (target.error) return refused(target.error, observation, "environment_mismatch");
  } else {
    const freshCandidate = sameFreshCandidate(candidate, observation, action, session);
    if (!freshCandidate) return refused("The selected target changed during pre-dispatch review.", observation, "candidate_stale");
    candidate = freshCandidate;
    if (environment) {
      const current = verifyObservedUrl(environment, observation.page.url);
      if (!current.ok) return refused(current.reason, observation, "environment_mismatch");
    } else if (localFixture && !isLoopbackUrl(observation.page.url)) {
      return refused("The local-fixture capability is limited to a loopback browser target.", observation, "environment_mismatch");
    }
    if (action === "click" && typeof candidate.href === "string" && candidate.href.length > 0) {
      let destination;
      try { destination = new URL(candidate.href, observation.page.url); }
      catch { return refused("The selected link has an invalid destination.", observation, "invalid_navigation_target"); }
      if (!origins?.includes(destination.origin)) return refused("The selected link destination is outside the authorized environment.", observation, "navigation_target_untrusted");
    }
    try {
      const decision = await authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId, operationAuthorizer });
      if (!decision.allowed) return refused(decision.reason, observation, decision.category);
    } catch {
      return refused("Typed application operation authorization failed.", observation, "operation_contract_refused");
    }
  }

  try {
    const reservation = await onReserve?.({ action, candidate, url, observation, operationId });
    if (reservation?.allowed === false) {
      return refused(reservation.reason ?? "Operation reservation was refused.", observation, reservation.category ?? "operation_reservation_refused");
    }
  } catch {
    return refused("Durable pre-dispatch reservation failed.", observation, "operation_reservation_failed");
  }

  let dispatchResult = null;
  try {
    switch (action) {
      case "navigate": {
        await session.client.send("Page.navigate", { url });
        break;
      }
      case "click": case "toggle": {
        dispatchResult = await session.click(candidate);
        break;
      }
      case "fill": {
        dispatchResult = await session.fillField(candidate, value ?? "");
        break;
      }
      case "select": {
        dispatchResult = await session.selectOption(candidate, value ?? "");
        break;
      }
      case "upload": {
        dispatchResult = await session.uploadFile(candidate, filePaths ?? []);
        break;
      }
      case "scroll": {
        dispatchResult = await session.scroll(candidate);
        break;
      }
      case "type": {
        dispatchResult = await session.typeSearchPhrase(candidate, value ?? "");
        break;
      }
    }
  } catch (error) {
    let telemetryError = false;
    try { await onDispatch?.({ action, candidate, url, observation, dispatchResult, dispatchStatus: "uncertain" }); }
    catch { telemetryError = true; }
    let operationError = false;
    try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchStatus: "uncertain" }); }
    catch { operationError = true; }
    return {
      status: "uncertain", dispatched: false, authorized: true,
      reason: `Dispatch failed: ${String(error.message ?? error).slice(0, 300)}`,
      effectStatus: "uncertain",
      verificationStatus: "not_verified",
      observation,
      ...(telemetryError ? { telemetryError: true } : {}),
      ...(operationError ? { operationError: true } : {})
    };
  }
  let telemetryError = false;
  try { await onDispatch?.({ action, candidate, url, observation, dispatchResult, dispatchStatus: "dispatched" }); }
  catch { telemetryError = true; }
  let operationError = false;
  try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchStatus: "dispatched" }); }
  catch { operationError = true; }
  return { status: "dispatched", dispatched: true, authorized: true, effectStatus: "unknown", verificationStatus: "not_verified", dispatchResult, observation, ...(telemetryError ? { telemetryError: true } : {}), ...(operationError ? { operationError: true } : {}) };
}
