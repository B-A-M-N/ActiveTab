import { BrowserSession } from "./session.js";
import { resolveAuthorizedTarget, validateLoopbackEndpoint } from "./targets.js";

function canonicalEndpoint(value) {
  try { return validateLoopbackEndpoint(value).origin; }
  catch { return null; }
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function authorizedOrigins(environment, initialUrl) {
  const configured = environment?.authorizedOrigins;
  const values = Array.isArray(configured) ? configured : [initialUrl];
  return new Set(values.map(safeOrigin).filter(Boolean));
}

function failure(message, code) {
  return Object.assign(new Error(message), { reattachFailureCode: code });
}

/** Build a trusted reattacher for the exact direct-CDP target held by a durable lease. */
export function createAuthorizedSameTargetReattacher({
  session: originalSession,
  environment = null,
  assertLeaseTokenCurrent,
  bindSession,
  onSessionCreated = null,
  onSessionCommitted = null,
  authorizeUrl = null,
  resolveTarget = resolveAuthorizedTarget,
  createSession = target => new BrowserSession(target)
} = {}) {
  const targetId = originalSession?.target?.id;
  const endpoint = canonicalEndpoint(originalSession?.target?.reattachEndpoint ?? originalSession?.target?.endpoint);
  if (typeof targetId !== "string" || !targetId || !endpoint) {
    throw new Error("Same-target reattachment requires an exact target on a loopback CDP endpoint.");
  }
  if (typeof assertLeaseTokenCurrent !== "function" || typeof bindSession !== "function") {
    throw new Error("Same-target reattachment requires the live durable target lease.");
  }
  const allowedOrigins = authorizedOrigins(environment, originalSession?.target?.url);

  const assertLease = async () => {
    try { await assertLeaseTokenCurrent(); }
    catch (error) {
      if (error && typeof error === "object") error.reattachFailureCode ??= "lease_rebind_failed";
      throw error;
    }
  };

  return async ({ targetId: requestedTargetId, endpoint: requestedEndpoint, selectionGoal } = {}) => {
    if (requestedTargetId !== targetId || canonicalEndpoint(requestedEndpoint) !== endpoint) {
      throw failure("Reattachment was requested for a different target or CDP endpoint.", "target_scope_rejected");
    }
    await assertLease();

    let nextSession = null;
    let reattachFailureCode = "target_not_found";
    try {
      const target = await resolveTarget(endpoint, targetId, targetId);
      const targetEndpoint = canonicalEndpoint(target?.endpoint);
      const targetOrigin = safeOrigin(target?.url);
      if (target?.id !== targetId || targetEndpoint !== endpoint || !targetOrigin
        || !allowedOrigins.has(targetOrigin) || authorizeUrl?.(target.url, target) === false) {
        reattachFailureCode = "target_scope_rejected";
        throw new Error("The exact target is outside the authorized endpoint or origin scope.");
      }

      nextSession = createSession(target);
      onSessionCreated?.(nextSession);
      reattachFailureCode = "reattach_attach_failed";
      await nextSession.attach();
      await assertLease();

      reattachFailureCode = "reattach_observation_failed";
      const observation = await nextSession.observe({ profile: "interaction", selectionGoal });
      const observedOrigin = safeOrigin(observation?.page?.url);
      if (nextSession.attached !== true || nextSession.target?.id !== targetId
        || canonicalEndpoint(nextSession.target?.endpoint) !== endpoint
        || observation?.targetId !== targetId || !observedOrigin
        || !allowedOrigins.has(observedOrigin)
        || authorizeUrl?.(observation.page.url, target, observation) === false) {
        reattachFailureCode = "reattach_identity_mismatch";
        throw new Error("The fresh observation no longer matches the authorized target and origin.");
      }
      await assertLease();

      let committed = false;
      return {
        session: nextSession,
        observation,
        async commit() {
          if (committed) return;
          await assertLease();
          try {
            if (nextSession.attached !== true || nextSession.target?.id !== targetId
              || canonicalEndpoint(nextSession.target?.endpoint) !== endpoint) {
              throw new Error("The replacement session detached before lease rebinding.");
            }
            await bindSession(nextSession);
            await onSessionCommitted?.(nextSession);
            committed = true;
          } catch (error) {
            if (error && typeof error === "object") error.reattachFailureCode ??= "lease_rebind_failed";
            throw error;
          }
        }
      };
    } catch (error) {
      if (error && typeof error === "object") error.reattachFailureCode ??= reattachFailureCode;
      await nextSession?.close?.().catch(() => {});
      throw error;
    }
  };
}

export function supportsAuthorizedSameTargetReattachment(session) {
  return typeof session?.target?.id === "string"
    && Boolean(canonicalEndpoint(session?.target?.reattachEndpoint ?? session?.target?.endpoint));
}
