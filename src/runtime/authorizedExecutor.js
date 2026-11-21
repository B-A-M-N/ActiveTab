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
import { normalizeOrigin, resolveObservedApplication, verifyObservedUrl, isLoopbackUrl } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "./controlRestrictions.js";
import { DISPATCH_DISPOSITION, dispatchStatusForDisposition } from "./dispatchDisposition.js";

const SUPPORTED_ACTIONS = new Set(["navigate", "click", "fill", "select", "toggle", "upload", "scroll", "type"]);

function refused(reason, observation = null, category = "authorization_refused") {
  return {
    status: "refused",
    dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
    dispatchStatus: "refused",
    browserEffectPossible: false,
    retryWithoutReconciliation: true,
    reasonCode: category,
    dispatched: false,
    authorized: false,
    category,
    reason,
    observation
  };
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

function isObservedAnchor(candidate) {
  return String(candidate?.tag ?? "").toLowerCase() === "a"
    && typeof candidate?.href === "string" && candidate.href.length > 0;
}

function authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId, operationAuthorizer }) {
  const policyAction = action === "toggle" ? "click" : action;
  const policy = authorizePlannedAction(goal, candidate, policyAction);
  const adapterEligible = ["unsupported_action", "unsupported_text_entry", "unclassified_form_submission", "unknown_control_effect"].includes(policy.category);
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
  if (!isCurrentObservation(session, after)) return false;
  if (!after?.page?.url || !before?.page?.url || after.page.url !== before.page.url) return false;
  if (before.targetId && after.targetId !== before.targetId) return false;
  if (session.target?.id && after.targetId !== session.target.id) return false;
  if (before.documentGeneration !== undefined && after.documentGeneration !== before.documentGeneration) return false;
  return true;
}

function isCurrentObservation(session, observation) {
  if (observation?.historical === true) return false;
  // BrowserSession owns an observation sequence. Once that authoritative
  // sequence exists, every dispatch must carry the complete publication
  // binding; omitted metadata is not interpreted as a legacy-compatible pass.
  if (Number.isSafeInteger(session?.observationGeneration)) {
    const targetId = session?.target?.id;
    const generation = session?.documentGeneration;
    const coherence = observation?.captureCoherence;
    const start = coherence?.start;
    const end = coherence?.end;
    if (typeof targetId !== "string" || !targetId
      || typeof observation?.evidenceId !== "string" || !observation.evidenceId
      || observation.targetId !== targetId
      || !Number.isSafeInteger(generation) || !Number.isSafeInteger(observation.documentGeneration)
      || observation.documentGeneration !== generation
      || coherence?.status !== "stable"
      || !Number.isSafeInteger(observation.observationSequence)
      || observation.observationSequence !== session.observationGeneration
      || !start || !end
      || start.targetId !== targetId || end.targetId !== targetId
      || start.documentGeneration !== generation || end.documentGeneration !== generation) return false;
  }
  if (observation?.captureCoherence?.status
    && observation.captureCoherence.status !== "stable") return false;
  if (session?.target?.id && observation?.targetId && observation.targetId !== session.target.id) return false;
  if (Number.isInteger(observation?.documentGeneration) && Number.isInteger(session?.documentGeneration)
    && observation.documentGeneration !== session.documentGeneration) return false;
  const observedMutationCount = observation?.captureCoherence?.end?.totalDomMutationCount;
  if (Number.isInteger(observedMutationCount) && Number.isInteger(session?.activity?.totalDomMutations)
    && observedMutationCount !== session.activity.totalDomMutations) return false;
  return !Number.isInteger(observation?.observationSequence)
    || observation.observationSequence === session?.observationGeneration;
}

function assertCurrentObservation(session, observation) {
  if (isCurrentObservation(session, observation)) return;
  throw Object.assign(new Error("The observation was superseded before dispatch; observe again before acting."), {
    dispatchDisposition: DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH,
    reasonCode: "observation_superseded"
  });
}

function retainedObservationUrl(session, observation) {
  const retained = session?.observer?.getEvidence?.(observation?.evidenceId, {
    facets: ["page"], includeSensitiveUrlData: true
  });
  return retained?.status === "available" && typeof retained.page?.url === "string"
    ? retained.page.url : observation?.page?.url ?? null;
}

function sameCandidateBinding(before, after) {
  return before?.identity === after?.identity
    && before?.backendNodeId === after?.backendNodeId
    && before?.targetId === after?.targetId
    && before?.documentGeneration === after?.documentGeneration
    && before?.tag === after?.tag
    && before?.type === after?.type
    && before?.role === after?.role
    && before?.name === after?.name
    && before?.href === after?.href
    && before?.frameTargetId === after?.frameTargetId;
}

async function revalidateInteractionTarget(session, candidate, observation, action) {
  const expectedUrl = retainedObservationUrl(session, observation);
  if (typeof session?.validateObservedCandidate === "function") {
    const targeted = await session.validateObservedCandidate(candidate, { action, expectedUrl }).catch(() => null);
    if (targeted?.status === "valid" && targeted.targetId === session.target?.id
      && targeted.documentGeneration === session.documentGeneration
      && targeted.backendNodeId === candidate?.backendNodeId && targeted.url === expectedUrl) {
      return { observation, candidate };
    }
  }
  // A stale, ambiguous, or unavailable targeted check escalates to a full
  // observation. Rebinding is permitted only when the exact target semantics
  // and private route remain unchanged.
  const freshObservation = await session.observe().catch(() => null);
  if (!sameObservationBinding(observation, freshObservation, session)
    || retainedObservationUrl(session, freshObservation) !== expectedUrl) {
    return { errorCode: "pre_dispatch_state_changed" };
  }
  const freshCandidate = sameFreshCandidate(candidate, freshObservation, action, session);
  if (!freshCandidate || !sameCandidateBinding(candidate, freshCandidate)) return { errorCode: "candidate_stale" };
  return { observation: freshObservation, candidate: freshCandidate };
}

function interactionBindingError({ session, environment, localFixture, origins, observation }) {
  if (!observation?.page?.url) return "A fresh browser observation is required before the composite suboperation.";
  if (environment) {
    const current = verifyObservedUrl(environment, observation.page.url);
    if (!current.ok) return current.reason;
  } else if (localFixture) {
    if (!isLoopbackUrl(observation.page.url)) return "The local-fixture capability is limited to a loopback browser target.";
  } else if (session.target?.id && (!origins?.length || !origins.includes(normalizeOrigin(observation.page.url)))) {
    return "The observed page is outside the origin bound to this browser target.";
  }
  return null;
}

function workflowTargetBindingError(validateActionTarget, candidate, observation) {
  if (typeof validateActionTarget !== "function") return null;
  try {
    if (validateActionTarget(candidate, observation) === true) return null;
  } catch { /* A trusted capability validator fails closed. */ }
  return "The selected target no longer matches its trusted workflow capability scope.";
}

function uploadGrantContext({ session, environment, principalId, operationId, candidate, observation }) {
  if (!environment || typeof principalId !== "string" || !principalId
    || typeof operationId !== "string" || !operationId || !session?.target?.id
    || !candidate?.identity || !observation?.page?.url) return null;
  const application = resolveObservedApplication(environment, observation.page.url);
  const environmentId = environment.environmentId ?? environment.id ?? null;
  if (application.status !== "matched" || !environmentId) return null;
  return {
    principalId,
    targetId: session.target.id,
    candidateIdentity: candidate.identity,
    operationId,
    environmentId,
    applicationId: application.applicationId
  };
}

async function checkUploadGrant({ store, grantId, session, environment, principalId, operationId, candidate, observation }) {
  if (!store || typeof grantId !== "string" || !grantId) return { ok: false, reasonCode: "upload_grant_required" };
  const context = uploadGrantContext({ session, environment, principalId, operationId, candidate, observation });
  if (!context) return { ok: false, reasonCode: "upload_grant_scope_unavailable" };
  return { ...await store.verify(grantId, context), context };
}

/**
 * Authorize and dispatch one effectful browser action. Returns a typed
 * result; it never dispatches when authorization or freshness fails.
 */
export async function executeAuthorizedAction({
  session, environment = null, goal = null, action, candidate = null, value = null, filePaths = null, uploadGrantStore = null, uploadGrantId = null, principalId = null, url = null, expectedUrlPattern = null, localFixture = false, recovery = false,
  onAdmission = null, onReserve = null, onDispatch = null, operationId = null, operationAuthorizer = null, assertExecutionLease = null,
  validateActionTarget = null, sameTargetNavigation = false
}) {
  if (!session) throw new Error("Authorized executor requires a browser session.");
  if (validateActionTarget !== null && typeof validateActionTarget !== "function") {
    return refused("A workflow target validator must be trusted code.", null, "workflow_capability_scope_invalid");
  }
  if (!SUPPORTED_ACTIONS.has(action)) {
    return refused(`Unsupported action '${action}'.`, null, "unsupported_action");
  }
  if (session.target?.id && session.attached !== true) return refused("The selected browser target is not attached.", null, "target_unattached");
  if (session.target?.id && session.attached === true && typeof assertExecutionLease !== "function") {
    return refused("A durable browser target execution lease is required before dispatch.", null, "target_lease_unavailable");
  }

  let observation = null;
  let origins = null;
  let deferNewTargetAuthorization = false;
  if (action === "navigate") {
    if (!localFixture && (!environment || !Array.isArray(environment.authorizedOrigins) || environment.authorizedOrigins.length === 0)) {
      return refused("Navigation requires an explicitly bound authorized environment.", null, "environment_unbound");
    }
    observation = await session.observe().catch(() => null);
    if (!observation?.page?.url) return refused("A fresh browser observation is required before navigation.", observation, "observation_unavailable");
    if (!isCurrentObservation(session, observation)) return refused("A superseded observation cannot authorize navigation.", observation, "observation_superseded");
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
    if (!isCurrentObservation(session, observation)) return refused("A superseded observation cannot authorize an interaction.", observation, "observation_superseded");
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
    if (action === "click" && candidate.opensNewTarget === true && sameTargetNavigation !== true) {
      return refused("The selected link opens another browser target; explicit same-target navigation is required to stay within the active lease.", observation, "new_target_requires_authorization");
    }
    deferNewTargetAuthorization = action === "click" && sameTargetNavigation === true && isObservedAnchor(candidate);
    const workflowBindingError = workflowTargetBindingError(validateActionTarget, candidate, observation);
    if (workflowBindingError) return refused(workflowBindingError, observation, "workflow_capability_scope_mismatch");
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
      const decision = await authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId: deferNewTargetAuthorization ? null : operationId, operationAuthorizer: deferNewTargetAuthorization ? null : operationAuthorizer });
      if (!decision.allowed) return refused(decision.reason, observation, decision.category);
    } catch {
      return refused("Typed application operation authorization failed.", observation, "operation_contract_refused");
    }
    if (action === "upload") {
      const grant = await checkUploadGrant({ store: uploadGrantStore, grantId: uploadGrantId, session, environment, principalId, operationId, candidate, observation });
      if (!grant.ok) return refused("The exact file upload grant is unavailable or no longer matches this operation.", observation, grant.reasonCode);
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

  // Review may take time. Revalidate the exact node with a small native CDP
  // check; only fall back to a full observation when that check cannot prove
  // the existing binding.
  if (action === "navigate") {
    observation = await session.observe({ profile: "lightweight" }).catch(() => null);
    if (!sameObservationBinding(admittedObservation, observation, session)
      || retainedObservationUrl(session, observation) !== retainedObservationUrl(session, admittedObservation)) {
      return refused("The authorized page or target changed during pre-dispatch review.", observation, "pre_dispatch_state_changed");
    }
  } else {
    const refreshed = await revalidateInteractionTarget(session, candidate, admittedObservation, action);
    if (!refreshed?.observation || !isCurrentObservation(session, refreshed.observation)) return refused("The selected target became stale during pre-dispatch review.", admittedObservation, refreshed?.errorCode ?? "candidate_stale");
    observation = refreshed.observation;
    candidate = refreshed.candidate;
  }
  if (action === "navigate") {
    const currentOrigin = normalizeOrigin(observation.page.url);
    if (!recovery && environment && currentOrigin !== null && !origins?.includes(currentOrigin)
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
    const workflowBindingError = workflowTargetBindingError(validateActionTarget, candidate, observation);
    if (workflowBindingError) return refused(workflowBindingError, observation, "workflow_capability_scope_mismatch");
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
      const decision = await authorizeInteraction({ goal, action, candidate, value, url, observation, environment, operationId: deferNewTargetAuthorization ? null : operationId, operationAuthorizer: deferNewTargetAuthorization ? null : operationAuthorizer });
      if (!decision.allowed) return refused(decision.reason, observation, decision.category);
    } catch {
      return refused("Typed application operation authorization failed.", observation, "operation_contract_refused");
    }
    if (action === "upload") {
      const grant = await checkUploadGrant({ store: uploadGrantStore, grantId: uploadGrantId, session, environment, principalId, operationId, candidate, observation });
      if (!grant.ok) return refused("The exact file upload grant is unavailable or no longer matches this operation.", observation, grant.reasonCode);
    }
  }

  try { await assertExecutionLease?.(); }
  catch { return refused("The browser target execution lease was lost before dispatch.", observation, "target_lease_lost"); }

  try {
    const reservation = await onReserve?.({ action, candidate, url, observation, operationId });
    if (reservation?.allowed === false) {
      return refused(reservation.reason ?? "Operation reservation was refused.", observation, reservation.category ?? "operation_reservation_refused");
    }
  } catch {
    return refused("Durable pre-dispatch reservation failed.", observation, "operation_reservation_failed");
  }

  // Reservations can block on durable storage. Recheck target scope after
  // reservation, before the final lease assertion and the browser command.
  if (action === "navigate") {
    const current = await session.observe({ profile: "lightweight" }).catch(() => null);
    if (!sameObservationBinding(observation, current, session)
      || retainedObservationUrl(session, current) !== retainedObservationUrl(session, observation)) {
      return refused("The authorized page or target changed after operation reservation.", current, "pre_dispatch_state_changed");
    }
    observation = current;
  } else {
    const refreshed = await revalidateInteractionTarget(session, candidate, observation, action);
    if (!refreshed?.observation) return refused("The selected target became stale after operation reservation.", observation, refreshed?.errorCode ?? "candidate_stale");
    observation = refreshed.observation;
    candidate = refreshed.candidate;
    const workflowBindingError = workflowTargetBindingError(validateActionTarget, candidate, observation);
    if (workflowBindingError) return refused(workflowBindingError, observation, "workflow_capability_scope_mismatch");
    try {
      const decision = await authorizeInteraction({ goal, action, candidate, value, url, observation, environment,
        operationId: deferNewTargetAuthorization ? null : operationId,
        operationAuthorizer: deferNewTargetAuthorization ? null : operationAuthorizer });
      if (!decision.allowed) return refused(decision.reason, observation, decision.category);
    } catch {
      return refused("Typed application operation authorization failed.", observation, "operation_contract_refused");
    }
    if (action === "upload") {
      const grant = await checkUploadGrant({ store: uploadGrantStore, grantId: uploadGrantId, session, environment, principalId, operationId, candidate, observation });
      if (!grant.ok) return refused("The exact file upload grant is unavailable or no longer matches this operation.", observation, grant.reasonCode);
    }
  }

  try { await assertExecutionLease?.(); }
  catch {
    try { await onDispatch?.({ action, candidate, url, observation, dispatchResult: null, dispatchStatus: "refused" }); }
    catch { /* The lease loss already prevents this operation from dispatching. */ }
    return refused("The browser target execution lease was lost after reservation and before dispatch.", observation, "target_lease_lost");
  }

  if (!isCurrentObservation(session, observation)) {
    try { await onDispatch?.({ action, candidate, url, observation, dispatchResult: null, dispatchStatus: "refused" }); }
    catch { /* The newer observation still prevents this operation from dispatching. */ }
    try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchResult: null, dispatchStatus: "refused" }); }
    catch { /* Preserve the typed refusal if operation telemetry storage fails. */ }
    return refused("The observation was superseded after reservation; no browser input was sent.", observation, "observation_superseded");
  }

  let dispatchResult = null;
  try {
    switch (action) {
      case "navigate": {
        assertCurrentObservation(session, observation);
        await session.client.send("Page.navigate", { url });
        break;
      }
      case "click": case "toggle": {
        dispatchResult = action === "toggle" && typeof session.setCheckboxState === "function"
          && ["checked", "unchecked"].includes(value)
          ? await session.setCheckboxState(candidate, value === "checked", { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } })
          : action === "click" && sameTargetNavigation === true && isObservedAnchor(candidate)
          ? await session.navigateObservedLinkInSameTarget(candidate, {
            beforeDispatch: async ({ href }) => {
              await assertExecutionLease?.();
              const refreshed = await revalidateInteractionTarget(session, candidate, observation, "click");
              if (!refreshed?.observation || !isCurrentObservation(session, refreshed.observation)) assertCurrentObservation(session, refreshed?.observation ?? { historical: true });
              const currentObservation = refreshed.observation;
              const freshCandidate = refreshed.candidate;
              if (!freshCandidate || !isObservedAnchor(freshCandidate)) {
                throw new Error("The selected target changed before same-target navigation.");
              }
              const destination = navigationTarget(href, { environment, localFixture, authorizedOrigins: origins ?? [] });
              if (destination.error) throw new Error(destination.error);
              const decision = await authorizeInteraction({
                goal,
                action: "click",
                candidate: { ...freshCandidate, href },
                value,
                url: href,
                observation: currentObservation,
                environment,
                operationId,
                operationAuthorizer
              });
              if (!decision.allowed) throw new Error(decision.reason ?? "Typed application operation is outside its registered contract.");
              observation = currentObservation;
              candidate = freshCandidate;
              assertCurrentObservation(session, observation);
            }
          })
          : await session.click(candidate, { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } });
        break;
      }
      case "fill": {
        dispatchResult = await session.fillField(candidate, value ?? "", { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } });
        break;
      }
      case "select": {
        const exactValue = value ?? "";
        const customCombobox = String(candidate?.tag ?? "").toLowerCase() !== "select";
        if (!customCombobox) {
          dispatchResult = await session.selectOption(candidate, exactValue, { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } });
          break;
        }

        const allowedSuboperations = Object.freeze(["open_observed_combobox", "select_exact_controlled_option"]);
        const actionEnvelope = Object.freeze({
          type: "aria_combobox_select",
          version: 1,
          action: "select",
          targetId: session.target?.id ?? candidate.targetId,
          candidateIdentity: candidate.identity,
          documentGeneration: candidate.documentGeneration,
          value: exactValue,
          allowedSuboperations
        });
        let nextSuboperation = 0;
        let pendingSuboperation = null;
        let pendingCandidateIdentity = null;
        let pendingMenuIdentity = null;
        const authorizeSuboperation = async request => {
          const { stage, suboperation, candidate: subCandidate, menuCandidate } = request ?? {};
          if (stage === "prepare") {
            if (pendingSuboperation || allowedSuboperations[nextSuboperation] !== suboperation) {
              return { allowed: false, reason: "Composite selection attempted an unapproved or out-of-order suboperation.", category: "composite_suboperation_refused" };
            }
            if (actionEnvelope.targetId !== subCandidate?.targetId
              || actionEnvelope.documentGeneration !== subCandidate?.documentGeneration
              || actionEnvelope.targetId !== menuCandidate?.targetId
              || actionEnvelope.candidateIdentity !== menuCandidate?.identity) {
              return { allowed: false, reason: "Composite selection target does not match its approved action envelope.", category: "composite_suboperation_refused" };
            }
            try { await assertExecutionLease?.(); }
            catch { return { allowed: false, reason: "The browser target execution lease was lost before a composite suboperation.", category: "target_lease_lost" }; }
            const current = await session.observe().catch(() => null);
            if (!sameObservationBinding(admittedObservation, current, session)) {
              return { allowed: false, reason: "The authorized page or target changed between composite selection suboperations.", category: "pre_dispatch_state_changed" };
            }
            observation = current;
            const bindingError = interactionBindingError({ session, environment, localFixture, origins, observation: current });
            if (bindingError) return { allowed: false, reason: bindingError, category: "environment_mismatch" };

            const freshMenu = sameFreshCandidate(menuCandidate, current, "select", session);
            if (!freshMenu || freshMenu.identity !== actionEnvelope.candidateIdentity) {
              return { allowed: false, reason: "The approved combobox is absent or stale in the current observation.", category: "candidate_stale" };
            }
            const workflowBindingError = workflowTargetBindingError(validateActionTarget, freshMenu, current);
            if (workflowBindingError) return { allowed: false, reason: workflowBindingError, category: "workflow_capability_scope_mismatch" };
            let freshSubCandidate;
            if (suboperation === "open_observed_combobox") {
              freshSubCandidate = sameFreshCandidate(subCandidate, current, "select", session);
              if (!freshSubCandidate || freshSubCandidate.identity !== actionEnvelope.candidateIdentity
                || String(freshSubCandidate.role ?? "").toLowerCase() !== "combobox") {
                return { allowed: false, reason: "The approved combobox changed before it could be opened.", category: "candidate_stale" };
              }
            } else if (suboperation === "select_exact_controlled_option") {
              freshSubCandidate = sameFreshCandidate(subCandidate, current, "select", session);
              if (!freshSubCandidate || String(freshSubCandidate.role ?? "").toLowerCase() !== "option"
                || freshSubCandidate.name !== exactValue || freshSubCandidate.visible !== true || freshSubCandidate.disabled === true
                || freshSubCandidate.frameTargetId != null || menuCandidate?.identity !== actionEnvelope.candidateIdentity) {
                return { allowed: false, reason: "The exact visible option is absent from the current observation.", category: "candidate_stale" };
              }
            } else {
              return { allowed: false, reason: "The composite selection envelope does not permit this suboperation.", category: "composite_suboperation_refused" };
            }

            try {
              const decision = await authorizeInteraction({
                goal, action: "select", candidate: freshMenu, value: exactValue, url, observation: current,
                environment, operationId, operationAuthorizer
              });
              if (!decision.allowed) return { allowed: false, reason: decision.reason, category: decision.category };
            } catch {
              return { allowed: false, reason: "Typed application operation authorization failed for a composite suboperation.", category: "operation_contract_refused" };
            }
            pendingSuboperation = suboperation;
            pendingCandidateIdentity = freshSubCandidate.identity;
            pendingMenuIdentity = freshMenu.identity;
            return { allowed: true, candidate: freshSubCandidate, menuCandidate: freshMenu };
          }
          if (stage === "dispatch") {
            if (pendingSuboperation !== suboperation
              || subCandidate?.identity !== pendingCandidateIdentity
              || menuCandidate?.identity !== pendingMenuIdentity) {
              return { allowed: false, reason: "Composite suboperation was not prepared for this exact control.", category: "composite_suboperation_refused" };
            }
            try { await assertExecutionLease?.(); }
            catch { return { allowed: false, reason: "The browser target execution lease was lost immediately before a composite suboperation.", category: "target_lease_lost" }; }
            try { assertCurrentObservation(session, observation); }
            catch { return { allowed: false, reason: "The observation was superseded before a composite suboperation.", category: "observation_superseded" }; }
            return { allowed: true };
          }
          if (stage === "completed") {
            if (pendingSuboperation !== suboperation || allowedSuboperations[nextSuboperation] !== suboperation
              || subCandidate?.identity !== pendingCandidateIdentity || menuCandidate?.identity !== pendingMenuIdentity) {
              return { allowed: false, reason: "Composite suboperation completion did not match its approved action envelope.", category: "composite_suboperation_refused" };
            }
            pendingSuboperation = null;
            pendingCandidateIdentity = null;
            pendingMenuIdentity = null;
            nextSuboperation++;
            return { allowed: true };
          }
          return { allowed: false, reason: "Composite selection requested an unsupported authorization stage.", category: "composite_suboperation_refused" };
        };

        dispatchResult = await session.selectOption(candidate, exactValue, { actionEnvelope, authorizeSuboperation });
        if (dispatchResult?.selectionStatus === "selected" && nextSuboperation !== allowedSuboperations.length) {
          throw new Error("Composite selection completed without authorizing every suboperation.");
        }
        break;
      }
      case "upload": {
        const grant = await uploadGrantStore.beginDispatch(uploadGrantId,
          uploadGrantContext({ session, environment, principalId, operationId, candidate, observation }) ?? {});
        if (!grant.ok) return refused("The approved upload source changed or its scoped grant expired before dispatch.", observation, grant.reasonCode);
        try {
          dispatchResult = await session.uploadFile(candidate, grant.stagedPaths, {
            grantToken: grant.dispatchToken,
            beforeDispatch: async () => {
              await assertExecutionLease?.();
              assertCurrentObservation(session, observation);
              const stillCurrent = await uploadGrantStore.assertDispatchToken(grant.dispatchToken, {
                targetId: session.target?.id,
                candidateIdentity: candidate.identity
              });
              if (!stillCurrent.ok) throw new Error("The approved upload source changed before CDP dispatch.");
            }
          });
        } finally { await uploadGrantStore.complete(uploadGrantId); }
        break;
      }
      case "scroll": {
        dispatchResult = await session.scroll(candidate, { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } });
        break;
      }
      case "type": {
        dispatchResult = await session.typeSearchPhrase(candidate, value ?? "", observation, { beforeDispatch: async () => { await assertExecutionLease?.(); assertCurrentObservation(session, observation); } });
        break;
      }
    }
  } catch (error) {
    const definitelyRefused = error?.dispatchDisposition === DISPATCH_DISPOSITION.REFUSED_PRE_DISPATCH;
    const dispatchStatus = definitelyRefused ? "refused" : "uncertain";
    let telemetryError = false;
    try { await onDispatch?.({ action, candidate, url, observation, dispatchResult, dispatchStatus }); }
    catch { telemetryError = true; }
    let operationError = false;
    try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchResult, dispatchStatus }); }
    catch { operationError = true; }
    if (definitelyRefused) {
      return {
        ...refused(String(error.message ?? error).slice(0, 300), observation, error.reasonCode ?? "pre_dispatch_refused"),
        authorized: true,
        ...(telemetryError ? { telemetryError: true } : {}),
        ...(operationError ? { operationError: true } : {})
      };
    }
    return {
      status: "uncertain",
      dispatchDisposition: DISPATCH_DISPOSITION.UNCERTAIN,
      dispatchStatus: "uncertain",
      browserEffectPossible: true,
      retryWithoutReconciliation: false,
      reasonCode: "dispatch_exception",
      dispatched: false,
      authorized: true,
      reason: `Dispatch failed: ${String(error.message ?? error).slice(0, 300)}`,
      effectStatus: "uncertain",
      verificationStatus: "not_verified",
      observation,
      ...(telemetryError ? { telemetryError: true } : {}),
      ...(operationError ? { operationError: true } : {})
    };
  }
  const isCompositeSelect = action === "select" && String(candidate?.tag ?? "").toLowerCase() !== "select";
  if (isCompositeSelect && dispatchResult?.dispatched !== true) {
    const category = dispatchResult?.category ?? "composite_suboperation_refused";
    const reason = dispatchResult?.reason ?? "Composite selection was refused before any browser effect.";
    try { await onDispatch?.({ action, candidate, url, observation, dispatchResult, dispatchStatus: "refused" }); }
    catch { /* The refusal remains authoritative if telemetry storage fails. */ }
    try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchResult, dispatchStatus: "refused" }); }
    catch { /* Preserve the refusal if operation telemetry storage fails. */ }
    return refused(reason, observation, category);
  }
  const partialCompositeSelect = isCompositeSelect && dispatchResult?.selectionStatus !== "selected";
  const finalDispatchStatus = partialCompositeSelect ? "uncertain" : "dispatched";
  const dispatchDisposition = partialCompositeSelect
    ? DISPATCH_DISPOSITION.PARTIALLY_DISPATCHED_UNCERTAIN
    : DISPATCH_DISPOSITION.DISPATCHED_UNVERIFIED;
  let telemetryError = false;
  try { await onDispatch?.({ action, candidate, url, observation, dispatchResult, dispatchStatus: finalDispatchStatus }); }
  catch { telemetryError = true; }
  let operationError = false;
  try { await operationAuthorizer?.recordDispatch?.({ operationId, action, candidate, value, observation, dispatchResult, dispatchStatus: finalDispatchStatus }); }
  catch { operationError = true; }
  return {
    status: partialCompositeSelect ? "partial" : "dispatched",
    dispatchDisposition,
    dispatchStatus: dispatchStatusForDisposition(dispatchDisposition),
    browserEffectPossible: true,
    retryWithoutReconciliation: false,
    reasonCode: partialCompositeSelect ? "partial_composite_select" : "dispatch_sent",
    ...(partialCompositeSelect && dispatchResult?.reason ? { reason: dispatchResult.reason } : {}),
    dispatched: true,
    authorized: true,
    effectStatus: partialCompositeSelect ? "partial" : "unknown",
    verificationStatus: "not_verified",
    dispatchResult,
    observation,
    ...(telemetryError ? { telemetryError: true } : {}),
    ...(operationError ? { operationError: true } : {})
  };
}
