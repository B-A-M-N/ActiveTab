/**
 * CloudAgentDiagnosticAdapter — authenticated HTTP adapter for the
 * Cloud Agent control plane's admin diagnostic surfaces.
 *
 * This is an OPTIONAL BACKEND DIAGNOSTIC SOURCE associated with a real
 * staging application run (P1-1). It is never the browser entry point:
 * its baseUrl must never be used as a navigation target, and a
 * loopback baseUrl is permitted only when the transport is an explicitly
 * configured, verified SSH tunnel whose remote staging target is known.
 *
 * The adapter validates backend service identity, authentication
 * authority, environment binding, allowed endpoints, response shape, data
 * sensitivity, and request limits. Redirects are restricted to same-origin
 * (or explicitly allowed) destinations and the admin bearer token is
 * never forwarded to any redirect target, preventing credential leakage
 * outside the verified diagnostic service.
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";
import { isLoopbackUrl } from "../../environments/model.js";

const DEFAULT_ALLOWED_PREFIXES = ["/healthz", "/admin/agent/"];

export class CloudAgentDiagnosticAdapter {
  constructor({
    baseUrl, adminToken, timeoutMs = 10_000, maxBytes = 262_144,
    applicationId = "cloud-agent", environment = "staging",
    environmentBinding = null, diagnosticTransport = null, remoteTarget = null,
    allowedPrefixes = DEFAULT_ALLOWED_PREFIXES, maxRequests = 32
  } = {}) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("CloudAgentDiagnosticAdapter requires a baseUrl.");
    if (typeof adminToken !== "string" || !adminToken) throw new Error("CloudAgentDiagnosticAdapter requires an adminToken.");
    try { new URL(baseUrl); } catch { throw new Error(`CloudAgentDiagnosticAdapter baseUrl is not a valid URL: '${baseUrl}'.`); }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.adminToken = adminToken;
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs, 60_000));
    this.maxBytes = Math.max(1, Math.min(maxBytes, 8 * 1024 * 1024));
    this.applicationId = applicationId;
    this.environment = environment;
    this.environmentBinding = environmentBinding;
    this.diagnosticTransport = diagnosticTransport;
    this.remoteTarget = remoteTarget;
    this.allowedPrefixes = allowedPrefixes.map(p => String(p));
    this.maxRequests = Math.max(1, Math.min(maxRequests, 256));
    this.requestCount = 0;

    // A loopback diagnostic endpoint is permitted only when it is an
    // explicitly configured SSH tunnel with a verified remote target. It
    // must never silently become the definition of the website under test.
    if (isLoopbackUrl(this.baseUrl) && diagnosticTransport !== "ssh_tunnel") {
      throw new Error(
        "A loopback Cloud Agent diagnostic endpoint requires diagnosticTransport 'ssh_tunnel' " +
        "with a verified remoteTarget; loopback is transport infrastructure, not the application."
      );
    }
    if (diagnosticTransport === "ssh_tunnel" && !remoteTarget) {
      throw new Error("A tunnel diagnostic endpoint requires a verified remoteTarget.");
    }
  }

  #assertAllowedPath(path) {
    if (!this.allowedPrefixes.some(prefix => path === prefix || path.startsWith(prefix))) {
      throw new Error(`Diagnostic path '${path}' is not in the adapter's allowed endpoints.`);
    }
    if (this.requestCount >= this.maxRequests) {
      throw new Error(`Diagnostic request limit (${this.maxRequests}) reached for this run.`);
    }
  }

  async #fetch(path, { method = "GET", body = null, query = {} } = {}) {
    this.#assertAllowedPath(path);
    let current = new URL(`${this.baseUrl}${path}`);
    // Restrict redirects: never follow a redirect to a different origin
    // (or a non-allowed destination) and never forward the admin bearer
    // token to any redirect target.
    for (let redirect = 0; redirect <= 3; redirect++) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) current.searchParams.set(key, String(value));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await fetch(current, {
          method,
          redirect: "manual",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.adminToken}`
          },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (error?.name === "AbortError") return { status: "error", httpStatus: null, data: null, reason: `Request timed out after ${this.timeoutMs}ms.` };
        return { status: "error", httpStatus: null, data: null, reason: String(error.message ?? error).slice(0, 300) };
      }
      clearTimeout(timer);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        let next;
        try { next = new URL(location, current); } catch { return { status: "error", httpStatus: response.status, data: null, reason: `Redirect to an invalid location '${String(location).slice(0, 120)}'.` }; }
        const sameDestination = next.origin === new URL(this.baseUrl).origin;
        const allowed = this.allowedPrefixes.some(prefix => next.pathname === prefix || next.pathname.startsWith(prefix));
        if (!sameDestination || !allowed) {
          // Do not forward the admin token to an unverified destination.
          return { status: "error", httpStatus: response.status, data: null, reason: `Redirect to '${next.origin}${next.pathname}' rejected: destination is outside the verified diagnostic service.` };
        }
        current = next;
        continue;
      }
      this.requestCount++;
      const text = await response.text();
      if (text.length > this.maxBytes) {
        return { status: "truncated", httpStatus: response.status, data: null, reason: `Response exceeded ${this.maxBytes} bytes.` };
      }
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { parsed = text; }
      return { status: response.ok ? "ok" : "error", httpStatus: response.status, data: parsed };
    }
    return { status: "error", httpStatus: null, data: null, reason: "Too many redirects." };
  }

  /**
   * Create diagnostic source contracts and register them on a collector.
   * All sources are run-scoped and metadata-first by default.
   */
  registerSources(collector) {
    const sources = [
      { id: "cloud-agent-runs", path: "/admin/agent/runs", description: "Recent agent run execution records." },
      { id: "cloud-agent-steps", path: "/admin/agent/steps", description: "Per-step execution telemetry." },
      { id: "cloud-agent-usage", path: "/admin/agent/usage", description: "Aggregated model usage and cost attribution." },
      { id: "cloud-agent-audit-log", path: "/admin/agent/audit-log", description: "Administrative audit trail entries." },
      { id: "cloud-agent-sandboxes", path: "/admin/agent/sandboxes", description: "Active sandbox instances and their health." },
      { id: "cloud-agent-conversations", path: "/admin/agent/conversations", description: "Recent agent conversation records." },
      { id: "cloud-agent-measurements", path: "/admin/agent/measurements", description: "Operational profiling measurements." },
      { id: "cloud-agent-settings", path: "/admin/agent/settings", description: "Current service configuration (non-secret fields only)." }
    ];

    for (const source of sources) {
      collector.register(
        createDiagnosticContract({
          id: source.id,
          authority: AUTHORITY.ADMIN_SESSION,
          operations: [OPERATION.READ],
          scope: `${this.applicationId}:${this.environment}:admin-read`,
          sensitivity: SENSITIVITY.METADATA_ONLY,
          description: source.description
        }),
        async (operation, options = {}) => {
          // Run-scoped queries preferred: narrow to the operation under
          // investigation instead of broad tenant-wide collection.
          const query = {};
          if (options.since) query.since = options.since;
          if (options.until) query.until = options.until;
          if (options.state) query.state = options.state;
          if (options.repo) query.repo = options.repo;
          if (options.limit) query.limit = Math.min(Number(options.limit) || 50, 200);
          const result = await this.#fetch(source.path, { query });
          if (result.status !== "ok") {
            return {
              status: "unavailable",
              sourceId: source.id,
              httpStatus: result.httpStatus,
              reason: result.reason ?? `HTTP ${result.httpStatus}.`,
              records: []
            };
          }
          let records = [];
          if (Array.isArray(result.data?.runs)) records = result.data.runs;
          else if (Array.isArray(result.data?.steps)) records = result.data.steps;
          else if (Array.isArray(result.data?.entries)) records = result.data.entries;
          else if (Array.isArray(result.data?.sandboxes)) records = result.data.sandboxes;
          else if (Array.isArray(result.data?.conversations)) records = result.data.conversations;
          else if (Array.isArray(result.data?.measurements)) records = result.data.measurements;
          else if (Array.isArray(result.data?.days)) records = result.data.days;
          else if (result.data?.summary) records = [result.data.summary];
          else if (Array.isArray(result.data?.definitions)) records = result.data.definitions.map(d => ({ key: d.key, kind: d.kind, default: d.default, secret: d.secret, read_only: d.read_only }));

          // Redact before any model exposure.
          records = records.map(record => this.#redact(record));
          return {
            status: records.length > 0 ? "available" : "empty",
            sourceId: source.id,
            httpStatus: result.httpStatus,
            evidenceId: result.data?.evidenceId ?? `admin:${source.id}`,
            recordCount: records.length,
            records
          };
        }
      );
    }
    return collector;
  }

  #redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") {
      const text = String(value);
      if (/^(sk-|Bearer\s+|eyJ)[A-Za-z0-9._-]{8,}/.test(text)) return "[redacted]";
      return value;
    }
    if (depth > 6) return "[depth-limited]";
    if (Array.isArray(value)) return value.slice(0, 100).map(item => this.#redact(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/token|secret|password|credential|apikey|api_key|authorization/i.test(key)) out[key] = item == null ? item : "[redacted]";
      else out[key] = this.#redact(item, depth + 1);
    }
    return out;
  }

  /** Run detail: attempts, usage, and terminal state for one execution. */
  async getRunDetail(jobId) {
    if (typeof jobId !== "string" || !jobId) throw new Error("getRunDetail requires a jobId.");
    return await this.#fetch(`/admin/agent/runs/${encodeURIComponent(jobId)}`);
  }

  /** Activity (steps/events) for a specific run. */
  async getRunActivity(jobId, { cursor = null, limit = 50 } = {}) {
    if (typeof jobId !== "string" || !jobId) throw new Error("getRunActivity requires a jobId.");
    const query = {};
    if (cursor) query.cursor = cursor;
    if (limit) query.limit = Math.min(Number(limit) || 50, 200);
    return await this.#fetch(`/admin/agent/runs/${encodeURIComponent(jobId)}/activity`, { query });
  }

  /**
   * Test connectivity, backend identity, and admin authority. When an
   * environment binding is present, the adapter checks that its declared
   * application/environment match the binding's diagnostic destination.
   */
  async healthCheck() {
    const result = await this.#fetch("/healthz");
    if (result.status !== "ok") {
      return { healthy: false, reason: result.reason ?? `HTTP ${result.httpStatus}.` };
    }
    if (result.data?.status !== "ok") {
      return { unhealthy: true, reason: `Unexpected healthz response: ${JSON.stringify(result.data).slice(0, 200)}` };
    }
    // Validate intended backend service identity + authentication authority.
    const adminProbe = await this.#fetch("/admin/agent/runs");
    if (adminProbe.httpStatus === 401 || adminProbe.httpStatus === 403) {
      return { healthy: false, reason: "Admin token was rejected by the control plane." };
    }
    if (adminProbe.status !== "ok") {
      return { healthy: false, reason: `Admin endpoint failed: ${adminProbe.reason ?? `HTTP ${adminProbe.httpStatus}`}.` };
    }
    if (this.environmentBinding && this.environmentBinding.environmentId !== this.environment) {
      return { healthy: false, reason: `Adapter environment '${this.environment}' does not match the verified environment binding '${this.environmentBinding.environmentId}'.` };
    }
    return {
      healthy: true,
      applicationId: this.applicationId,
      environment: this.environment,
      transport: this.diagnosticTransport ?? "direct",
      ...(this.remoteTarget ? { remoteTarget: this.remoteTarget } : {})
    };
  }
}

/**
 * Create a CloudAgentDiagnosticAdapter from environment variables.
 * Returns null when no Cloud Agent diagnostic endpoint is configured.
 *
 * ACTIVETAB_CLOUD_AGENT_URL is the DIAGNOSTIC endpoint (control plane) —
 * never a browser navigation target. A loopback value requires
 * ACTIVETAB_CLOUD_AGENT_TRANSPORT=ssh_tunnel and
 * ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET set to the verified remote host.
 */
export function cloudAgentAdapterFromEnv(env = process.env, { environmentBinding = null } = {}) {
  const baseUrl = env.ACTIVETAB_CLOUD_AGENT_URL;
  const adminToken = env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;
  if (!baseUrl || !adminToken) return null;
  return new CloudAgentDiagnosticAdapter({
    baseUrl,
    adminToken,
    environmentBinding,
    diagnosticTransport: env.ACTIVETAB_CLOUD_AGENT_TRANSPORT ?? null,
    remoteTarget: env.ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET ?? null
  });
}
