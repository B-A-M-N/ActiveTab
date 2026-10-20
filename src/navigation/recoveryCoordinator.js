import { normalizeOrigin } from "../environments/model.js";

/** Owns bounded post-action observation recovery without redispatching actions. */
export class RecoveryCoordinator {
  constructor({ getSession, setSession, getLatestObservation, reattachSameTarget, environment, assertExecutionLease, selectionGoal, isAbortError, throwIfAborted } = {}) {
    this.getSession = getSession;
    this.setSession = setSession;
    this.getLatestObservation = getLatestObservation;
    this.reattachSameTarget = reattachSameTarget;
    this.environment = environment;
    this.assertExecutionLease = assertExecutionLease;
    this.selectionGoal = selectionGoal;
    this.isAbortError = isAbortError;
    this.throwIfAborted = throwIfAborted;
  }

  async observeAfterChange(timeoutMs, baseline, attempt = null) {
    const reattachToSameTarget = async error => {
      const session = this.getSession();
      const errorText = String(error?.message ?? error).toLocaleLowerCase();
      const detached = session.attached === false || ["detached", "closed"].includes(session.targetLifecycle)
        || /target.{0,24}(detached|closed)|(?:detached|closed).{0,24}target/u.test(errorText);
      if (!detached || typeof this.reattachSameTarget !== "function"
        || attempt?.action !== "click" || attempt?.dispatchStatus !== "dispatched") {
        if (error && typeof error === "object") error.observationAttempts = 1;
        throw error;
      }

      let replacement;
      try {
        const originalTarget = session.target;
        replacement = await this.reattachSameTarget({
          targetId: originalTarget?.id,
          endpoint: originalTarget?.reattachEndpoint ?? originalTarget?.endpoint ?? "local-cdp",
          environment: this.environment,
          selectionGoal: this.selectionGoal
        });
        const nextSession = replacement?.session;
        const observation = replacement?.observation;
        const targetId = originalTarget?.id;
        const endpointValue = originalTarget?.reattachEndpoint ?? originalTarget?.endpoint ?? "local-cdp";
        const replacementEndpointValue = nextSession?.target?.reattachEndpoint ?? nextSession?.target?.endpoint ?? "local-cdp";
        const endpoint = (() => { try { return new URL(endpointValue).origin; } catch { return endpointValue; } })();
        const replacementEndpoint = (() => { try { return new URL(replacementEndpointValue).origin; } catch { return replacementEndpointValue; } })();
        if (!nextSession || nextSession.attached !== true || nextSession.target?.id !== targetId
          || replacementEndpoint !== endpoint || observation?.targetId !== targetId) {
          throw Object.assign(new Error("Same-target reattachment did not return a fresh observation from the exact leased target."), {
            reattachFailureCode: "reattach_identity_mismatch"
          });
        }
        let observedUrl;
        try { observedUrl = new URL(observation.page?.url ?? ""); }
        catch { throw Object.assign(new Error("Same-target reattachment returned an invalid observed page URL."), { reattachFailureCode: "target_scope_rejected" }); }
        const allowedOriginValues = Array.isArray(this.environment?.authorizedOrigins)
          ? this.environment.authorizedOrigins
          : [originalTarget?.url ?? this.getLatestObservation()?.page?.url];
        const allowedOrigins = allowedOriginValues.map(normalizeOrigin).filter(Boolean);
        if (!allowedOrigins.includes(normalizeOrigin(observedUrl.origin)) || observedUrl.username || observedUrl.password) {
          throw Object.assign(new Error("Same-target reattachment observed a page outside the authorized environment."), { reattachFailureCode: "target_scope_rejected" });
        }
        if (typeof replacement.commit === "function") await replacement.commit();
        this.setSession(nextSession);
        try { await this.assertExecutionLease?.(); }
        catch (leaseError) {
          if (leaseError && typeof leaseError === "object") leaseError.reattachFailureCode ??= "lease_rebind_failed";
          throw leaseError;
        }
        attempt.reconnectedObservation = true;
        return observation;
      } catch (reattachError) {
        await replacement?.session?.close?.().catch(() => {});
        if (reattachError && typeof reattachError === "object") {
          reattachError.observationAttempts = 2;
          reattachError.reattachFailureCode ??= "unknown";
        }
        throw reattachError;
      }
    };

    try {
      await this.getSession().waitForChange(timeoutMs, baseline);
      return await this.getSession().observe({ selectionGoal: this.selectionGoal });
    } catch (firstError) {
      if (this.isAbortError(firstError)) throw firstError;
      const currentSession = this.getSession();
      const stillAttached = currentSession.attached !== false
        && !["detached", "closed"].includes(currentSession.targetLifecycle);
      if (!stillAttached) return await reattachToSameTarget(firstError);
      await new Promise(resolve => setTimeout(resolve, 100));
      this.throwIfAborted();
      try {
        return await this.getSession().observe({ selectionGoal: this.selectionGoal });
      } catch (secondError) {
        const secondErrorText = String(secondError?.message ?? secondError).toLocaleLowerCase();
        const currentSession = this.getSession();
        const detachedAfterRetry = currentSession.attached === false
          || ["detached", "closed"].includes(currentSession.targetLifecycle)
          || /target.{0,24}(detached|closed)|(?:detached|closed).{0,24}target/u.test(secondErrorText);
        if (detachedAfterRetry) return await reattachToSameTarget(secondError);
        if (secondError && typeof secondError === "object") secondError.observationAttempts = 2;
        throw secondError;
      }
    }
  }
}
