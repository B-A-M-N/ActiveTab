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

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

  const applications = (env.applications ?? []).map(app => ({
    applicationId: String(app.application_id ?? ""),
    authenticationRealm: app.authentication_realm ?? null,
    candidateEntry: app.candidate_entry ?? null,
    status: app.status ?? "candidate",
    ...(app.final_origin ? { finalOrigin: app.final_origin } : {})
  }));

  const authorizedOrigins = new Set(
    (env.authorized_origins ?? [entryOrigin]).map(normalizeOrigin).filter(Boolean)
  );
  authorizedOrigins.add(entryOrigin);

  const diagnosticTransport = env.diagnostic_transport ?? null;
  const diagnosticEndpoint = env.diagnostic_endpoint ?? null;
  const remoteTarget = env.remote_target ?? null;
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
    environmentId,
    applicationEntryUrl,
    entryOrigin,
    browserControlEndpoint: env.browser_control_endpoint ?? null,
    ...(diagnosticEndpoint ? { diagnosticEndpoint, diagnosticTransport, remoteTarget } : {}),
    authorizedOrigins: Object.freeze([...authorizedOrigins]),
    applications: Object.freeze(applications),
    platform: env.platform ?? null
  });
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
