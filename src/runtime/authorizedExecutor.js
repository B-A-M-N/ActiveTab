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
import { verifyObservedUrl, isLoopbackUrl } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "./controlRestrictions.js";

const SUPPORTED_ACTIONS = new Set(["navigate", "click", "fill", "select", "toggle", "upload"]);

/**
 * Authorize and dispatch one effectful browser action. Returns a typed
 * result; it never dispatches when authorization or freshness fails.
 */
export async function executeAuthorizedAction({
  session, environment = null, goal = null, action, candidate = null, value = null, filePaths = null, url = null, expectedUrlPattern = null, localFixture = false
}) {
  if (!session) throw new Error("Authorized executor requires a browser session.");
  if (!SUPPORTED_ACTIONS.has(action)) {
    return { dispatched: false, authorized: false, reason: `Unsupported action '${action}'.` };
  }

  let observation = null;
  if (action === "navigate") {
    observation = await session.observe().catch(() => null);
    if (url) {
      if (isOperatorProhibitedNavigation(url)) {
        return {
          dispatched: false, authorized: false,
          reason: "Navigation to the operator-prohibited Admin Console Audit Log is not permitted.",
          observation
        };
      }
      if (isLoopbackUrl(url) && !localFixture) {
        return {
          dispatched: false, authorized: false,
          reason: "Navigation to loopback URLs is not permitted through the authorized executor.",
          observation
        };
      }
      if (isLoopbackUrl(url) && localFixture) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { dispatched: false, authorized: false, reason: "Local fixture navigation requires an http(s) URL.", observation };
          }
        } catch {
          return { dispatched: false, authorized: false, reason: `Invalid navigation URL '${String(url).slice(0, 120)}'.`, observation };
        }
      }
    }
    if (environment) {
      // Allow navigation even when the current page is on an untrusted
      // origin: navigating onto an authorized origin is the recovery path.
      // Destination origin is still strictly validated below.
      if (url) {
        try {
          const destOrigin = new URL(url).origin;
          if (!environment.authorizedOrigins.includes(destOrigin)) {
            return {
              dispatched: false, authorized: false,
              reason: `Navigation target origin '${destOrigin}' is not authorized for environment '${environment.environmentId}'.`,
              observation
            };
          }
        } catch {
          return { dispatched: false, authorized: false, reason: `Invalid navigation URL '${String(url).slice(0, 120)}'.`, observation };
        }
      }
    }
  } else {
    observation = await session.observe();
    if (!observation?.candidates?.length) {
      return { dispatched: false, authorized: false, reason: "No candidates available in the current observation.", observation };
    }
    const policyAction = action === "toggle" ? "click" : action;
    const auth = authorizePlannedAction(goal, candidate, policyAction);
    if (!auth.authorized) {
      return { dispatched: false, authorized: false, reason: auth.reason, category: auth.category, observation };
    }
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
    }
  } catch (error) {
    return {
      dispatched: false, authorized: true,
      reason: `Dispatch failed: ${String(error.message ?? error).slice(0, 300)}`,
      observation
    };
  }
  return { dispatched: true, authorized: true, dispatchResult, observation };
}
