import { discoverVisibleNextPage } from "../extraction/recordResolver.js";
import { resolveObservedApplication } from "../environments/model.js";
import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";

export function createRegisteredPaginationButtonAuthorizer({ registry, environment, principalId, session, getSession = null, details }) {
  const currentSession = () => typeof getSession === "function" ? getSession() ?? session : session;
  return Object.freeze({
    authorize({ action, candidate, observation } = {}) {
      const activeSession = currentSession();
      let page;
      try { page = new URL(details.fromPageUrl); } catch { return { allowed: false, reason: "The registered pagination source URL is invalid." }; }
      const application = resolveObservedApplication(environment, page.href);
      const manifest = application.status === "matched" ? registry?.resolve?.(details.capabilityId, {
        capabilityVersion: details.capabilityVersion,
        origin: page.origin,
        environmentId: environment?.environmentId ?? environment?.id,
        applicationId: application.applicationId,
        principalId
      }) : null;
      const locator = details.nextPage?.target;
      const allowed = action === "click" && Boolean(manifest)
        && manifest.extractionContract?.pagination?.kind === "explicit_next_same_path"
        && candidate?.targetId === activeSession?.target?.id
        && candidate?.backendNodeId === locator?.backendNodeId
        && candidate?.frameId === locator?.frameId
        && candidate?.tag === locator?.tag
        && candidate?.visible === true && candidate?.disabled !== true
        && observation?.targetId === activeSession?.target?.id
        && observation?.page?.url === details.fromPageUrl;
      return allowed
        ? { allowed: true, category: "registered_pagination_button" }
        : { allowed: false, reason: "The next-page button is outside the registered extraction capability." };
    }
  });
}

/** Advance only a freshly observed registered same-path pagination control. */
export async function advanceRegisteredPagination({ session, environment, assertExecutionLease, url, fromPageUrl, nextPage, kind = "rel_next_same_path", queryParameter = null, signal, paginationOperationId = null, paginationOperationAuthorizer = null } = {}) {
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_before_pagination" };
  if (!session || typeof session.observe !== "function") return { status: "blocked", reasonCode: "pagination_session_unavailable" };
  if (kind === "virtualized_list") {
    const before = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!before?.page?.url || before.targetId && before.targetId !== session.target?.id) return { status: "blocked", reasonCode: "pagination_observation_unavailable" };
    let current;
    try { current = new URL(before.page.url); } catch { return { status: "blocked", reasonCode: "pagination_url_invalid" }; }
    if (fromPageUrl !== before.page.url) return { status: "blocked", reasonCode: "pagination_source_changed" };
    const target = (before.scrollTargets ?? []).find(item => item.identity === nextPage?.identity
      && item.targetId === session.target?.id && item.documentGeneration === before.documentGeneration
      && item.visible === true && item.canScrollDown === true && item.frameTargetId == null);
    if (!target) return { status: "blocked", reasonCode: "pagination_scroll_target_stale" };
    const dispatch = await executeAuthorizedAction({
      session,
      environment,
      goal: "Scroll down to reveal the next visible records",
      action: "scroll",
      candidate: target,
      assertExecutionLease,
      validateActionTarget: (candidate, observation) => candidate?.identity === target.identity
        && candidate?.canScrollDown === true && candidate?.visible === true
        && candidate?.frameTargetId == null && observation?.page?.url === current.href
    });
    if (!dispatch.dispatched) return {
      status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
      reasonCode: dispatch.category ?? "pagination_scroll_refused"
    };
    if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_scroll" };
    await Promise.resolve(session.waitForChange?.(2_000, {
      pageChangeFingerprint: before.pageChangeFingerprint,
      domMutationCount: before.domMutationCount,
      lifecycleEventCount: before.lifecycleEventCount,
      scrollTarget: { identity: target.identity, scrollTop: target.scrollTop }
    })).catch(() => {});
    const after = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!after?.page?.url || after.targetId !== session.target?.id || after.page.url !== before.page.url) {
      return { status: "uncertain", reasonCode: "pagination_scroll_post_observation_unavailable" };
    }
    const afterTarget = (after.scrollTargets ?? []).find(item => item.identity === target.identity);
    if (!afterTarget || !(afterTarget.scrollTop > Number(target.scrollTop ?? 0) + 2)) {
      return { status: "failed", reasonCode: "pagination_scroll_stalled" };
    }
    return { status: "verified", reasonCode: "virtualized_list_scroll_progress_observed", progressVerified: true };
  }
  if (kind === "explicit_next_same_path" && nextPage?.action === "click") {
    const before = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!before?.page?.url || before.targetId !== session.target?.id || before.page.url !== fromPageUrl) {
      return { status: "blocked", reasonCode: "pagination_source_changed" };
    }
    const retained = session.observer?.getEvidence?.(before.evidenceId, { facets: ["domSnapshot"] });
    if (retained?.status !== "available" || !retained.domSnapshot) return { status: "blocked", reasonCode: "pagination_dom_evidence_unavailable" };
    const fresh = discoverVisibleNextPage(retained.domSnapshot, before.page.url, { kind });
    const target = fresh.status === "available" && fresh.action === "click"
      && fresh.target?.backendNodeId === nextPage.target?.backendNodeId
      && fresh.target?.frameId === nextPage.target?.frameId
      ? (before.candidates ?? []).filter(candidate => candidate.backendNodeId === fresh.target.backendNodeId
        && candidate.frameId === fresh.target.frameId && candidate.tag === fresh.target.tag
        && candidate.visible === true && candidate.disabled !== true)
      : [];
    if (target.length !== 1) return { status: "blocked", reasonCode: "pagination_control_not_current" };
    const dispatch = await executeAuthorizedAction({
      session,
      environment,
      goal: "Open the explicitly registered next collection page",
      action: "click",
      candidate: target[0],
      operationId: paginationOperationId,
      operationAuthorizer: paginationOperationAuthorizer,
      assertExecutionLease,
      validateActionTarget: (candidate, observation) => candidate?.identity === target[0].identity
        && candidate?.backendNodeId === fresh.target.backendNodeId
        && candidate?.frameId === fresh.target.frameId
        && candidate?.visible === true && candidate?.disabled !== true
        && observation?.page?.url === before.page.url
    });
    if (!dispatch.dispatched) return {
      status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
      reasonCode: dispatch.category ?? "pagination_button_refused"
    };
    if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_click" };
    await Promise.resolve(session.waitForChange?.(2_000, {
      pageChangeFingerprint: before.pageChangeFingerprint,
      domMutationCount: before.domMutationCount,
      lifecycleEventCount: before.lifecycleEventCount
    })).catch(() => {});
    const after = await Promise.resolve().then(() => session.observe({ profile: "interaction" })).catch(() => null);
    if (!after?.page?.url || after.targetId !== session.target.id
      || after.pageChangeFingerprint === before.pageChangeFingerprint) {
      return { status: "uncertain", reasonCode: "pagination_button_progress_unconfirmed" };
    }
    try {
      const oldUrl = new URL(before.page.url);
      const newUrl = new URL(after.page.url);
      if (oldUrl.origin !== newUrl.origin || oldUrl.pathname !== newUrl.pathname) {
        return { status: "failed", reasonCode: "pagination_button_scope_changed" };
      }
    } catch { return { status: "uncertain", reasonCode: "pagination_button_post_url_invalid" }; }
    return { status: "verified", reasonCode: "explicit_pagination_button_progress_observed" };
  }
  const before = await Promise.resolve().then(() => session.observe()).catch(() => null);
  let current;
  let destination;
  try {
    current = new URL(before?.page?.url);
    destination = new URL(url, current);
  } catch { return { status: "blocked", reasonCode: "pagination_url_invalid" }; }
  if (!before?.page?.url || before.page.url !== fromPageUrl
    || destination.origin !== current.origin || destination.pathname !== current.pathname
    || destination.username || destination.password || !["http:", "https:"].includes(destination.protocol)) {
    return { status: "blocked", reasonCode: "pagination_scope_changed" };
  }
  destination.hash = "";
  const retained = session.observer?.getEvidence?.(before.evidenceId, { facets: ["domSnapshot"] });
  if (retained?.status !== "available" || !retained.domSnapshot) {
    return { status: "blocked", reasonCode: "pagination_dom_evidence_unavailable" };
  }
  const freshNextPage = discoverVisibleNextPage(retained.domSnapshot, current.href, { kind, queryParameter });
  if (freshNextPage.status !== "available" || freshNextPage.url !== destination.href) {
    return { status: "blocked", reasonCode: "pagination_control_not_current" };
  }
  let dispatch;
  try {
    dispatch = await executeAuthorizedAction({
      session,
      environment,
      action: "navigate",
      url: destination.href,
      assertExecutionLease
    });
  } catch { return { status: "uncertain", reasonCode: "pagination_navigation_result_unknown" }; }
  if (!dispatch.dispatched) return {
    status: dispatch.status === "uncertain" ? "uncertain" : "blocked",
    reasonCode: dispatch.category ?? "pagination_navigation_refused"
  };
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_dispatch" };
  await Promise.resolve(session.waitForChange?.(2_000, {
    pageChangeFingerprint: before.pageChangeFingerprint,
    domMutationCount: before.domMutationCount,
    lifecycleEventCount: before.lifecycleEventCount
  })).catch(() => {});
  const after = await Promise.resolve().then(() => session.observe()).catch(() => null);
  if (!after?.page?.url || before.targetId && after.targetId !== before.targetId) {
    return { status: "uncertain", reasonCode: "pagination_post_observation_unavailable" };
  }
  let observed;
  try { observed = new URL(after.page.url); }
  catch { return { status: "uncertain", reasonCode: "pagination_post_url_invalid" }; }
  if (observed.origin !== destination.origin || observed.pathname !== destination.pathname || observed.search !== destination.search) {
    return { status: "failed", reasonCode: "pagination_destination_mismatch" };
  }
  if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_pagination_observation" };
  return { status: "verified", reasonCode: "registered_pagination_destination_observed" };
}
