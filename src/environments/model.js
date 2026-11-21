/**
 * Application/environment model — unified identity and routing for the
 * FreeInference staging platform.
 *
 * Corrects the architectural defect where a locally forwarded diagnostic
 * endpoint (e.g. an SSH tunnel to a backend control plane) was treated as
 * the browser application entry point. The three paths are distinct:
 *
 *   Browser path:        applicationEntryUrl  → the actual website
 *   Diagnostic path:     diagnosticEndpoint   → authorized backend interface
 *   Control transports:  browserControlEndpoint (CDP / extension broker)
 *
 * A localhost diagnosticEndpoint is permitted ONLY when it is explicitly
 * configured AND its remote staging target is independently established
 * (diagnosticTransport === "ssh_tunnel" with remoteTarget set). It must
 * never become a browser navigation target by default.
 */

import { createHash } from "node:crypto";

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PROFILE_WORKFLOW_OPERATIONS = new Set(["fill", "select", "toggle", "apply_filter"]);
const WORKFLOW_OPERATION_ID = /^[a-z][a-z0-9_]{0,95}$/u;

function workflowOperationsForApplication(application, environmentId) {
  const configured = application.workflow_operations;
  if (configured === undefined) return null;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.keys(configured).some(operation => !PROFILE_WORKFLOW_OPERATIONS.has(operation))) {
    throw new Error(`Environment '${environmentId}' contains unsupported application workflow operations.`);
  }
  const result = {};
  for (const [operation, operationId] of Object.entries(configured)) {
    if (typeof operationId !== "string" || !WORKFLOW_OPERATION_ID.test(operationId)) {
      throw new Error(`Environment '${environmentId}' contains an invalid '${operation}' workflow operation ID.`);
    }
    result[operation] = operationId;
  }
  return Object.freeze(result);
}

export function isLoopbackUrl(value) {
  try {
    const url = new URL(String(value));
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch { return false; }
}

export function normalizeOrigin(value) {
  try { return new URL(String(value)).origin; } catch { return null; }
}

/**
 * Build a validated environment binding from a profile's environment block.
 * Throws when the routing contract is violated:
 *  - the application entry must not be a loopback URL;
 *  - a loopback diagnostic endpoint requires an explicit ssh_tunnel
 *    transport with a verified remote target;
 *  - authorized_origins must include the application entry origin.
 */
export function buildEnvironmentBinding(profile = {}) {
  const env = profile.environment ?? {};
  const environmentId = String(env.environment_id ?? profile.profile_id ?? "");
  if (!environmentId) throw new Error("Environment binding requires an environment_id.");
  const profileId = typeof profile.profile_id === "string" ? profile.profile_id : environmentId;

  const applicationEntryUrl = String(env.application_entry_url ?? "");
  if (!applicationEntryUrl) throw new Error(`Environment '${environmentId}' requires an application_entry_url.`);
  let entryOrigin;
  try { entryOrigin = new URL(applicationEntryUrl).origin; }
  catch { throw new Error(`Environment '${environmentId}': application_entry_url is not a valid URL.`); }
  if (isLoopbackUrl(applicationEntryUrl)) {
    throw new Error(
      `Environment '${environmentId}': application_entry_url must be the real application (got loopback '${applicationEntryUrl}'). ` +
      `Loopback is transport infrastructure for CDP/tunnels, never the application being tested.`
    );
  }

  const applications = (env.applications ?? []).map(app => {
    const workflowOperations = workflowOperationsForApplication(app, environmentId);
    return {
      applicationId: String(app.application_id ?? ""),
      authenticationRealm: app.authentication_realm ?? null,
      candidateEntry: app.candidate_entry ?? null,
      ...(Array.isArray(app.entry_link_labels)
        ? { entryLinkLabels: Object.freeze([...new Set(app.entry_link_labels.filter(label => typeof label === "string" && label.trim()).map(label => label.trim()))]) }
        : {}),
      status: app.status ?? "candidate",
      ...(app.final_origin ? { finalOrigin: app.final_origin } : {}),
      ...(workflowOperations ? { workflowOperations } : {})
    };
  });
  const authenticationRealms = (profile.authentication_realms ?? []).map(realm => {
    if (!realm || typeof realm !== "object" || typeof realm.realm_id !== "string" || !realm.realm_id
      || !Array.isArray(realm.scope) || realm.scope.some(scope => typeof scope !== "string" || !scope)) {
      throw new Error(`Environment '${environmentId}' contains an invalid authentication realm binding.`);
    }
    return Object.freeze({
      realmId: realm.realm_id,
      scope: Object.freeze([...new Set(realm.scope)].sort()),
      separateCredentials: realm.separate_credentials === true
    });
  }).sort((left, right) => left.realmId.localeCompare(right.realmId));

  const authorizedOrigins = new Set(
    (env.authorized_origins ?? [entryOrigin]).map(normalizeOrigin).filter(Boolean)
  );
  authorizedOrigins.add(entryOrigin);

  const diagnosticTransport = env.diagnostic_transport ?? null;
  const diagnosticEndpoint = env.diagnostic_endpoint ?? null;
  const remoteTarget = env.remote_target ?? null;
  const diagnosticEndpointBindings = Object.freeze(Array.isArray(env.diagnostic_endpoint_bindings)
    ? env.diagnostic_endpoint_bindings.map(binding => Object.freeze({ ...binding }))
    : []);
  if (diagnosticEndpoint) {
    if (!diagnosticTransport) {
      throw new Error(`Environment '${environmentId}': diagnostic_endpoint requires an explicit diagnostic_transport.`);
    }
    if (!["direct", "ssh_tunnel", "verified_service"].includes(diagnosticTransport)) {
      throw new Error(`Environment '${environmentId}': unsupported diagnostic_transport '${diagnosticTransport}'.`);
    }
    if (isLoopbackUrl(diagnosticEndpoint)) {
      if (diagnosticTransport !== "ssh_tunnel") {
        throw new Error(`Environment '${environmentId}': a loopback diagnostic_endpoint is only permitted with diagnostic_transport 'ssh_tunnel'.`);
      }
      if (!remoteTarget) {
        throw new Error(`Environment '${environmentId}': a tunnel diagnostic_endpoint requires a verified remote_target.`);
      }
    }
  }

  return Object.freeze({
    profileId,
    environmentId,
    applicationEntryUrl,
    entryOrigin,
    browserControlEndpoint: env.browser_control_endpoint ?? null,
    ...(diagnosticEndpoint ? { diagnosticEndpoint, diagnosticTransport, remoteTarget } : {}),
    diagnosticEndpointBindings,
    authorizedOrigins: Object.freeze([...authorizedOrigins]),
    applications: Object.freeze(applications),
    authenticationRealms: Object.freeze(authenticationRealms),
    platform: env.platform ?? null
  });
}

/**
 * Build a run-local, single-origin binding after the operator authorizes the
 * observed origin. This grants navigation scope only; it adds no profile
 * operation IDs and is never persisted as a reusable application profile.
 */
export function buildEphemeralCurrentOriginBinding(observedUrl) {
  let url;
  try { url = new URL(String(observedUrl)); }
  catch { throw new Error("Current-origin scope requires a valid observed page URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || isLoopbackUrl(url.href)) {
    throw new Error("Current-origin scope requires an operator-authorized non-loopback HTTP or HTTPS origin.");
  }
  const origin = url.origin;
  const suffix = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  const profileId = `ephemeral_public_${suffix}`;
  const binding = buildEnvironmentBinding({
    profile_id: profileId,
    environment: {
      environment_id: profileId,
      application_entry_url: `${origin}/`,
      authorized_origins: [origin],
      applications: [{
        application_id: "ephemeral_public_site",
        candidate_entry: `${origin}/`,
        status: "candidate"
      }]
    }
  });
  return Object.freeze({ ...binding, environmentClass: "unknown", scopeKind: "current_origin", ephemeral: true });
}

/**
 * Verify that an observed browser URL belongs to this environment.
 * The browser's current URL must be independently observed and matched
 * against the authorized origins; redirects to unrelated origins are not
 * automatically trusted.
 */
export function verifyObservedUrl(binding, observedUrl) {
  const origin = normalizeOrigin(observedUrl);
  if (!origin) return { ok: false, reason: `Observed URL '${String(observedUrl).slice(0, 120)}' is not a valid URL.` };
  if (!binding.authorizedOrigins.includes(origin)) {
    return {
      ok: false,
      reason: `Observed origin '${origin}' is not authorized for environment '${binding.environmentId}' (authorized: ${binding.authorizedOrigins.join(", ")}).`,
      origin
    };
  }
  return { ok: true, origin, environmentId: binding.environmentId };
}

/** Resolve an authorized live URL to exactly one profile-declared application route. */
export function resolveObservedApplication(binding, observedUrl, { authenticationRealm = null } = {}) {
  if (!binding || typeof binding !== "object" || !Array.isArray(binding.authorizedOrigins)) {
    return { status: "unmatched", reason: "A validated environment binding is required." };
  }
  const verified = verifyObservedUrl(binding, observedUrl);
  if (!verified.ok) return { status: "unmatched", reason: verified.reason, origin: verified.origin ?? null };
  let observed;
  try { observed = new URL(observedUrl); }
  catch { return { status: "unmatched", reason: "Observed URL is invalid.", origin: verified.origin };
  }

  const matches = [];
  for (const application of binding.applications ?? []) {
    if (typeof application?.applicationId !== "string" || !application.applicationId) continue;
    let entry;
    try {
      const candidateEntry = application.candidateEntry ?? application.origin ?? "/";
      entry = new URL(candidateEntry, binding.entryOrigin ?? `${verified.origin}/`);
      if (entry.username || entry.password || entry.search || entry.hash) continue;
    } catch { continue; }
    const routeOrigin = application.finalOrigin ? normalizeOrigin(application.finalOrigin) : entry.origin;
    if (routeOrigin !== verified.origin) continue;
    const routePath = entry.pathname.replace(/\/+$/u, "") || "/";
    const observedPath = observed.pathname.replace(/\/+$/u, "") || "/";
    const routeMatches = routePath === "/" || observedPath === routePath || observedPath.startsWith(`${routePath}/`);
    if (!routeMatches) continue;
    const realmId = application.authenticationRealm ?? null;
    if (realmId && Array.isArray(binding.authenticationRealms)
      && !binding.authenticationRealms.some(realm => realm.realmId === realmId)) continue;
    matches.push({ application, routePath, routeLength: routePath.length, realmId });
  }

  if (!matches.length) return {
    status: "unmatched",
    origin: verified.origin,
    pathname: observed.pathname,
    reason: authenticationRealm ? "No profile application route matches the observed URL and verified authentication realm." : "No profile application route matches the observed URL."
  };
  matches.sort((left, right) => right.routeLength - left.routeLength);
  const longest = matches[0].routeLength;
  let specific = matches.filter(match => match.routeLength === longest);
  if (authenticationRealm) {
    specific = specific.filter(match => match.realmId === authenticationRealm);
    if (!specific.length) return {
      status: "unmatched",
      origin: verified.origin,
      pathname: observed.pathname,
      reason: "The observed application route does not match the supplied verified authentication realm."
    };
  }
  if (specific.length !== 1) return {
    status: "ambiguous",
    origin: verified.origin,
    pathname: observed.pathname,
    candidateApplicationIds: [...new Set(specific.map(match => match.application.applicationId))].sort()
  };
  const { application, routePath, realmId } = specific[0];
  return {
    status: "matched",
    origin: verified.origin,
    pathname: observed.pathname,
    applicationId: application.applicationId,
    authenticationRealm: realmId,
    routePath,
    application
  };
}
