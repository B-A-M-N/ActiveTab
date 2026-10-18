/**
 * Request security for the ActiveTab local API server.
 *
 * - Loopback Host validation (DNS-rebinding guard).
 * - Browser-origin validation (chrome-extension:// and loopback http(s)
 *   origins are allowed; everything else is rejected).
 * - Local bearer-token authentication for state-changing requests,
 *   constant-time compared, never honored for cross-site browser origins.
 */
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(host) {
  const name = String(host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name);
}

export function parseOrigin(value) {
  if (!value) return null;
  try { return new URL(value); } catch { return null; }
}

export function isAllowedBrowserOrigin(origin) {
  if (!origin) return false;
  if (origin.protocol === "chrome-extension:") return true;
  return (origin.protocol === "http:" || origin.protocol === "https:") && isLoopbackHost(origin.hostname);
}

/** Verify the request Host header; returns true when acceptable. */
export function checkHost(req, res, sendError) {
  if (!isLoopbackHost(req.headers.host ?? "")) {
    sendError(res, 403, 99403, "Forbidden");
    return false;
  }
  return true;
}

/** Verify the request Origin header (when present); returns true when acceptable. */
export function checkOrigin(req, res, sendError) {
  const origin = parseOrigin(req.headers.origin);
  if (origin && !isAllowedBrowserOrigin(origin)) {
    sendError(res, 403, 99403, "Origin not allowed.");
    return false;
  }
  return true;
}

/**
 * Build an authorization closure for state-changing requests.
 * `token === null` means the deployment runs without a token (local
 * single-user); the bearer token is otherwise required and is never
 * accepted from a browser-origin request.
 */
export function createMutationAuthorizer(token, { allowUnauthenticated = false } = {}) {
  return req => {
    if (!token) {
      // Explicitly configured unauthenticated mode is only allowed when the
      // deployment opts in. This is not the default.
      if (allowUnauthenticated === true) return true;
      return false;
    }
    const presented = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const ok = presented !== null &&
      Buffer.byteLength(presented) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(token));
    // Bearer tokens are not accepted from cross-site browser origins,
    // but a trusted extension origin with a valid token is allowed.
    const origin = parseOrigin(req.headers.origin);
    if (origin && !isAllowedBrowserOrigin(origin)) return false;
    return ok;
  };
}

/**
 * Authenticate the independently configured local operator channel.
 * The returned identity is server-owned; request JSON never supplies it.
 */
export function createOperatorAuthenticator(token, operatorId) {
  return req => {
    if (typeof token !== "string" || !token || typeof operatorId !== "string" || !operatorId) return null;
    const presented = req.headers["x-activetab-operator-token"];
    const ok = typeof presented === "string" &&
      Buffer.byteLength(presented) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(token));
    const origin = parseOrigin(req.headers.origin);
    if (!ok || (origin && !isAllowedBrowserOrigin(origin))) return null;
    return operatorId;
  };
}
