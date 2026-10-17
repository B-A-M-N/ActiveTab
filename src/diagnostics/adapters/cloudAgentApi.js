/**
 * CloudAgentDiagnosticAdapter — authenticated HTTP adapter for the
 * Cloud Agent control plane's admin diagnostic surfaces.
 *
 * Connects to a Cloud Agent instance (local or remote) using its
 * ADMIN_TOKEN and retrieves run/steps/usage/audit/sandbox diagnostics.
 * All operations are read-only and scoped to the adapter's declared
 * authority and sensitivity.
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";

export class CloudAgentDiagnosticAdapter {
  constructor({ baseUrl, adminToken, timeoutMs = 10_000, maxBytes = 262_144, applicationId = "cloud-agent", environment = "staging" } = {}) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("CloudAgentDiagnosticAdapter requires a baseUrl.");
    if (typeof adminToken !== "string" || !adminToken) throw new Error("CloudAgentDiagnosticAdapter requires an adminToken.");
    try { new URL(baseUrl); } catch { throw new Error(`CloudAgentDiagnosticAdapter baseUrl is not a valid URL: '${baseUrl}'.`); }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.adminToken = adminToken;
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs, 60_000));
    this.maxBytes = Math.max(1, Math.min(maxBytes, 8 * 1024 * 1024));
    this.applicationId = applicationId;
    this.environment = environment;
  }

  async #fetch(path, { method = "GET", body = null, query = {} } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.adminToken}`
        },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      const text = await response.text();
      if (text.length > this.maxBytes) {
        return { status: "truncated", httpStatus: response.status, data: null, reason: `Response exceeded ${this.maxBytes} bytes.` };
      }
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { parsed = text; }
      return { status: response.ok ? "ok" : "error", httpStatus: response.status, data: parsed };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { status: "error", httpStatus: null, data: null, reason: `Request timed out after ${this.timeoutMs}ms.` };
      }
      return { status: "error", httpStatus: null, data: null, reason: String(error.message ?? error).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Create diagnostic source contracts and register them on a collector.
   */
  registerSources(collector) {
    const sources = [
      {
        id: "cloud-agent-runs",
        path: "/admin/agent/runs",
        description: "Recent agent run execution records."
      },
      {
        id: "cloud-agent-steps",
        path: "/admin/agent/steps",
        description: "Per-step execution telemetry."
      },
      {
        id: "cloud-agent-usage",
        path: "/admin/agent/usage",
        description: "Aggregated model usage and cost attribution."
      },
      {
        id: "cloud-agent-audit-log",
        path: "/admin/agent/audit-log",
        description: "Administrative audit trail entries."
      },
      {
        id: "cloud-agent-sandboxes",
        path: "/admin/agent/sandboxes",
        description: "Active sandbox instances and their health."
      },
      {
        id: "cloud-agent-conversations",
        path: "/admin/agent/conversations",
        description: "Recent agent conversation records."
      },
      {
        id: "cloud-agent-measurements",
        path: "/admin/agent/measurements",
        description: "Operational profiling measurements."
      },
      {
        id: "cloud-agent-settings",
        path: "/admin/agent/settings",
        description: "Current service configuration (non-secret fields only)."
      }
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
          const query = {};
          if (options.since) query.since = options.since;
          if (options.until) query.until = options.until;
          if (options.state) query.state = options.state;
          if (options.repo) query.repo = options.repo;
          if (options.limit) query.limit = options.limit;
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
          // Extract the meaningful records array from the known response shapes.
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

  /**
   * Retrieve detailed diagnostics for a specific run, including its
   * attempts and usage. Returns the raw AdminRunDetail response.
   */
  async getRunDetail(jobId) {
    if (typeof jobId !== "string" || !jobId) throw new Error("getRunDetail requires a jobId.");
    return await this.#fetch(`/admin/agent/runs/${encodeURIComponent(jobId)}`);
  }

  /**
   * Retrieve the activity page (steps/events) for a specific run.
   */
  async getRunActivity(jobId, { cursor = null, limit = 50 } = {}) {
    if (typeof jobId !== "string" || !jobId) throw new Error("getRunActivity requires a jobId.");
    const query = {};
    if (cursor) query.cursor = cursor;
    if (limit) query.limit = limit;
    return await this.#fetch(`/admin/agent/runs/${encodeURIComponent(jobId)}/activity`, { query });
  }

  /**
   * Test connectivity and authority.
   */
  async healthCheck() {
    const result = await this.#fetch("/healthz");
    if (result.status !== "ok") {
      return { healthy: false, reason: result.reason ?? `HTTP ${result.httpStatus}.` };
    }
    if (result.data?.status !== "ok") {
      return { healthy: false, reason: `Unexpected healthz response: ${JSON.stringify(result.data).slice(0, 200)}` };
    }
    // Verify admin access by querying a low-cost admin endpoint.
    const adminProbe = await this.#fetch("/admin/agent/runs");
    if (adminProbe.httpStatus === 401 || adminProbe.httpStatus === 403) {
      return { healthy: false, reason: "Admin token was rejected by the control plane." };
    }
    if (adminProbe.status !== "ok") {
      return { healthy: false, reason: `Admin endpoint failed: ${adminProbe.reason ?? `HTTP ${adminProbe.httpStatus}`}.` };
    }
    return { healthy: true, applicationId: this.applicationId, environment: this.environment };
  }
}

/**
 * Create a CloudAgentDiagnosticAdapter from environment variables.
 * Returns null when no Cloud Agent endpoint is configured.
 * Requires both ACTIVETAB_CLOUD_AGENT_URL and ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN.
 */
export function cloudAgentAdapterFromEnv(env = process.env) {
  const baseUrl = env.ACTIVETAB_CLOUD_AGENT_URL;
  const adminToken = env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;
  if (!baseUrl || !adminToken) return null;
  return new CloudAgentDiagnosticAdapter({ baseUrl, adminToken });
}
