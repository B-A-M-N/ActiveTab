/**
 * CloudAgentDiagnosticAdapter — authenticated HTTP adapter for the
 * Cloud Agent control plane's admin diagnostic surfaces.
 *
 * This is an OPTIONAL BACKEND DIAGNOSTIC SOURCE associated with a real
 * staging application run (P1-1). It is never the browser entry point:
 * its baseUrl must never be used as a navigation target. Reads are limited
 * to exact run detail/activity paths after the ID is visible in fresh UI
 * evidence.
 *
 * The adapter validates transport configuration, environment binding,
 * registered endpoint identity, response shape, field projection and
 * request limits. Redirects are refused; the bearer token is never replayed.
 */

import { createDiagnosticContract, AUTHORITY, OPERATION, SENSITIVITY } from "../contracts.js";
import { isLoopbackUrl } from "../../environments/model.js";

const ENDPOINT_NAMES = new Set(["health", "runDetail", "runActivity"]);

function isSafeRunIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  if (value === "." || value === "..") return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || character === "-" || character === "_" || character === "." || character === ":")) return false;
  }
  return true;
}

const SAFE_STATUS_VALUES = new Set([
  "queued", "pending", "running", "started", "completed", "succeeded", "success",
  "failed", "error", "canceled", "cancelled", "timed_out", "timeout", "paused"
]);
const SAFE_OPERATION_CODES = new Set([
  "sandbox_startup", "terminal_opening", "file_listing", "file_opening", "agent_step",
  "model_request", "tool_call", "verification", "cleanup", "unknown"
]);
const NUMERIC_FIELDS = new Set([
  "attempt_count", "step_count", "request_count", "input_tokens", "output_tokens",
  "total_tokens", "prompt_tokens", "completion_tokens", "tool_calls", "duration_ms",
  "queue_duration_ms", "execution_duration_ms", "cost_usd"
]);

function safeCode(value, maxLength = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || character === "-" || character === "_" || character === "." || character === ":" || character === "/")) return null;
  }
  return value;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function projectRun(run, expectedRunId) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const returnedId = run.id ?? run.run_id ?? run.runId ?? run.job_id ?? run.jobId;
  if (returnedId !== expectedRunId) return null;
  const projected = { id: expectedRunId };
  const status = typeof run.status === "string" ? run.status.toLowerCase() : null;
  if (status && SAFE_STATUS_VALUES.has(status)) projected.status = status;
  for (const [output, candidates] of Object.entries({
    model: ["model", "model_id"], provider: ["provider", "provider_id"], sandbox_id: ["sandbox_id", "sandboxId"],
    created_at: ["created_at", "createdAt", "started_at", "startedAt"],
    completed_at: ["completed_at", "completedAt", "finished_at", "finishedAt"]
  })) {
    const key = candidates.find(candidate => run[candidate] !== undefined);
    if (!key) continue;
    const value = output.endsWith("_at") ? safeTimestamp(run[key]) : safeCode(run[key]);
    if (value !== null) projected[output] = value;
  }
  for (const [key, value] of Object.entries(run)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (NUMERIC_FIELDS.has(normalized) && Number.isFinite(value) && value >= 0) projected[normalized] = value;
  }
  return projected;
}

function projectUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const projected = {};
  for (const [key, value] of Object.entries(usage)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (NUMERIC_FIELDS.has(normalized) && Number.isFinite(value) && value >= 0) projected[normalized] = value;
    else if (normalized === "currency" && typeof value === "string" && value.length <= 8) {
      const code = safeCode(value, 8);
      if (code) projected.currency = code;
    }
  }
  return projected;
}

function projectSteps(data, expectedRunId) {
  const source = Array.isArray(data?.steps) ? data.steps : Array.isArray(data?.events) ? data.events : [];
  return source.slice(0, 200).flatMap(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const parentId = step.run_id ?? step.runId ?? step.job_id ?? step.jobId;
    if (parentId !== undefined && parentId !== expectedRunId) return [];
    const projected = {};
    const id = step.id ?? step.step_id ?? step.stepId ?? step.event_id ?? step.eventId;
    const stepId = safeCode(id);
    if (stepId) projected.id = stepId;
    const status = typeof step.status === "string" ? step.status.toLowerCase() : null;
    if (status && SAFE_STATUS_VALUES.has(status)) projected.status = status;
    const operation = typeof step.operation === "string" ? step.operation.toLowerCase().replaceAll("-", "_") : null;
    if (operation && SAFE_OPERATION_CODES.has(operation)) projected.operation = operation;
    const type = safeCode(step.type ?? step.kind, 64);
    if (type) projected.type = type;
    for (const [output, candidates] of Object.entries({
      started_at: ["started_at", "startedAt"], completed_at: ["completed_at", "completedAt"],
      duration_ms: ["duration_ms", "durationMs"]
    })) {
      const key = candidates.find(candidate => step[candidate] !== undefined);
      if (!key) continue;
      const value = output.endsWith("_at") ? safeTimestamp(step[key]) : step[key];
      if ((output.endsWith("_at") && value !== null) || (output === "duration_ms" && Number.isFinite(value) && value >= 0)) projected[output] = value;
    }
    return [projected];
  });
}

function validateEndpointBindings(bindings) {
  if (!Array.isArray(bindings)) throw new Error("Cloud Agent diagnostic endpoint bindings must come from a validated application profile.");
  const result = new Map();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || !ENDPOINT_NAMES.has(binding.name) || result.has(binding.name)) continue;
    if (binding.method !== "GET" || binding.observedStatus !== 200 || binding.contentType !== "application/json") continue;
    if (!isSafeRunIdentifier(binding.sourceEvidenceId)) continue;
    if (typeof binding.pathTemplate !== "string" || !binding.pathTemplate.startsWith("/api/admin/agent/")
      || binding.pathTemplate.includes("?") || binding.pathTemplate.includes("#")) continue;
    const markerIndex = binding.pathTemplate.indexOf("{runId}");
    const hasRunMarker = markerIndex >= 0;
    if ((binding.name === "health" && hasRunMarker) || (binding.name !== "health" && !hasRunMarker)) continue;
    if (hasRunMarker && binding.pathTemplate.indexOf("{runId}", markerIndex + 1) >= 0) continue;
    result.set(binding.name, Object.freeze({
      name: binding.name,
      method: binding.method,
      pathTemplate: binding.pathTemplate,
      sourceEvidenceId: binding.sourceEvidenceId
    }));
  }
  return result;
}

export class CloudAgentDiagnosticAdapter {
  #adminToken;

  constructor({
    baseUrl, adminToken, timeoutMs = 10_000, maxBytes = 262_144,
    applicationId = "cloud-agent", environment = null,
    environmentBinding = null, diagnosticTransport = null, remoteTarget = null,
    endpointBindings = environmentBinding?.diagnosticEndpointBindings ?? [], remoteIdentityVerifier = null,
    maxRequests = 32, fetchImpl = fetch
  } = {}) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("CloudAgentDiagnosticAdapter requires a baseUrl.");
    if (typeof adminToken !== "string" || !adminToken) throw new Error("CloudAgentDiagnosticAdapter requires an adminToken.");
    let parsedBase;
    try { parsedBase = new URL(baseUrl); } catch { throw new Error(`CloudAgentDiagnosticAdapter baseUrl is not a valid URL: '${baseUrl}'.`); }
    if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
      throw new Error("CloudAgentDiagnosticAdapter baseUrl must be a credential-free HTTP(S) service URL without query or fragment data.");
    }
    if (!isLoopbackUrl(baseUrl) && parsedBase.protocol !== "https:") throw new Error("Remote Cloud Agent diagnostics require HTTPS.");
    const expectedBase = environmentBinding?.diagnosticEndpoint;
    if (!expectedBase || normalizeServiceUrl(expectedBase) !== normalizeServiceUrl(baseUrl)) {
      throw new Error("Cloud Agent diagnostic URL must exactly match the endpoint declared by the active environment profile.");
    }
    let normalizedBase = String(baseUrl);
    while (normalizedBase.endsWith("/")) normalizedBase = normalizedBase.slice(0, -1);
    this.baseUrl = normalizedBase;
    this.#adminToken = adminToken;
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs, 60_000));
    this.maxBytes = Math.max(1, Math.min(maxBytes, 8 * 1024 * 1024));
    this.applicationId = applicationId;
    this.environment = environment ?? environmentBinding?.environmentId ?? "freeinference-staging";
    this.environmentBinding = environmentBinding;
    this.diagnosticTransport = diagnosticTransport;
    this.remoteTarget = remoteTarget;
    this.endpointBindings = validateEndpointBindings(endpointBindings);
    this.remoteIdentityVerifier = remoteIdentityVerifier;
    this.fetch = fetchImpl;
    this.maxRequests = Math.max(1, Math.min(maxRequests, 256));
    this.requestCount = 0;

    // A loopback tunnel name is not proof of the remote service identity.
    // Until a trusted tunnel adapter supplies a verifier, no request may
    // send the configured admin credential over loopback.
    if (isLoopbackUrl(this.baseUrl) && (diagnosticTransport !== "ssh_tunnel" || !remoteTarget || typeof remoteIdentityVerifier !== "function")) {
      this.loopbackIdentityUnverified = true;
    }
  }

  #pathFor(name, runId = null) {
    const binding = this.endpointBindings.get(name);
    if (!binding) return null;
    if (name === "health") return binding.pathTemplate;
    if (!isSafeRunIdentifier(runId)) return null;
    return binding.pathTemplate.replace("{runId}", encodeURIComponent(runId));
  }

  #assertAllowedPath(path, method) {
    const identity = [...this.endpointBindings.values()].find(binding => {
      if (binding.method !== method) return false;
      if (binding.pathTemplate === path) return true;
      const marker = binding.pathTemplate.indexOf("{runId}");
      if (marker < 0) return false;
      const prefix = binding.pathTemplate.slice(0, marker);
      const suffix = binding.pathTemplate.slice(marker + "{runId}".length);
      if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
      const encoded = path.slice(prefix.length, path.length - suffix.length);
      let decoded;
      try { decoded = decodeURIComponent(encoded); } catch { return false; }
      return isSafeRunIdentifier(decoded) && encodeURIComponent(decoded) === encoded;
    })?.name ?? null;
    if (!identity) throw new Error(`Diagnostic ${method} path '${path}' is not a registered endpoint identity.`);
    if (this.requestCount >= this.maxRequests) {
      throw new Error(`Diagnostic request limit (${this.maxRequests}) reached for this run.`);
    }
    this.requestCount++;
    return identity;
  }

  async #fetch(path, { method = "GET", body = null, query = {} } = {}) {
    const endpoint = this.#assertAllowedPath(path, method);
    if (isLoopbackUrl(this.baseUrl)) {
      if (this.loopbackIdentityUnverified) return { status: "unavailable", httpStatus: null, data: null, reason: "Loopback diagnostics require a trusted tunnel adapter that verifies the remote service identity." };
      let verified = false;
      try {
        const identity = await this.remoteIdentityVerifier({ baseUrl: this.baseUrl, remoteTarget: this.remoteTarget, environment: this.environment });
        verified = identity?.verified === true && identity.environmentId === this.environment;
      } catch {}
      if (!verified) return { status: "unavailable", httpStatus: null, data: null, reason: "The configured tunnel did not verify the remote staging service identity." };
    }
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
        response = await this.fetch(current, {
          method,
          redirect: "manual",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.#adminToken}`
          },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (error?.name === "AbortError") return { status: "error", httpStatus: null, data: null, reason: `Request timed out after ${this.timeoutMs}ms.` };
        return { status: "error", httpStatus: null, data: null, reason: String(error.message ?? error).slice(0, 300) };
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        // Never replay a privileged request through a redirect, even when the
        // destination appears same-origin. A caller can issue a fresh request
        // only after the redirected endpoint identity has been reviewed.
        clearTimeout(timer);
        return { status: "error", httpStatus: response.status, data: null, reason: `Redirect refused for registered diagnostic endpoint '${endpoint}'.` };
      }
      // Bound the response body by actual bytes while streaming; never buffer
      // the full body before checking the limit.
      const reader = response.body?.getReader?.();
      let totalBytes = 0;
      let truncated = false;
      if (reader) {
        const decoder = new TextDecoder();
        let text = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > this.maxBytes) {
              truncated = true;
              try { await reader.cancel(); } catch {}
              break;
            }
            text += decoder.decode(value, { stream: true });
          }
          if (truncated) {
            return { status: "truncated", httpStatus: response.status, data: null, reason: `Response exceeded ${this.maxBytes} bytes.` };
          }
          text += decoder.decode();
          const bodyText = text;
          let parsed;
          try { parsed = JSON.parse(bodyText); }
          catch { parsed = bodyText; }
          return { status: response.ok ? "ok" : "error", httpStatus: response.status, data: parsed };
        } catch (error) {
          return { status: "error", httpStatus: response.status, data: null, reason: String(error.message ?? error).slice(0, 300) };
        } finally {
          clearTimeout(timer);
        }
      }
      clearTimeout(timer);
      return { status: "error", httpStatus: response.status, data: null, reason: "Bounded response streaming is unavailable in this runtime." };
    }
    return { status: "error", httpStatus: null, data: null, reason: "Too many redirects." };
  }

  /**
   * Register metadata for one exact caller-observed Cloud Agent run. Broad
   * tenant lists, conversations, settings, audit exports, and sandboxes are
   * deliberately not exposed through the run collector.
   */
  registerRunScopedSources(collector, { activeTabRunId, cloudAgentRunId, sourceIds = [] } = {}) {
    if (!collector || typeof collector.register !== "function") throw new Error("A diagnostic collector is required.");
    if (!isSafeRunIdentifier(activeTabRunId) || !isSafeRunIdentifier(cloudAgentRunId)) {
      throw new Error("Run-scoped diagnostics require exact bounded ActiveTab and Cloud Agent run identifiers.");
    }
    const allowed = new Set(["cloud-agent-runs", "cloud-agent-steps", "cloud-agent-usage"]);
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.some(id => !allowed.has(id))) {
      throw new Error("Run-scoped diagnostics require one or more approved run, step, or usage source IDs.");
    }
    let detailPromise;
    const loadDetail = () => detailPromise ??= this.getRunDetail(cloudAgentRunId);
    const sources = new Map([
      ["cloud-agent-runs", {
        description: "Metadata for one exact caller-observed Cloud Agent run.",
        fetch: async () => {
          const result = await loadDetail();
          if (result.status !== "ok") return { status: "unavailable", sourceId: "cloud-agent-runs", httpStatus: result.httpStatus, reason: result.reason ?? "Exact run record unavailable.", records: [] };
          return { status: "available", sourceId: "cloud-agent-runs", httpStatus: result.httpStatus, recordCount: 1, records: [result.data.run] };
        }
      }],
      ["cloud-agent-steps", {
        description: "Bounded structural step metadata from the exact run activity endpoint.",
        fetch: async () => {
          const result = await this.getRunActivity(cloudAgentRunId);
          if (result.status !== "ok") return { status: "unavailable", sourceId: "cloud-agent-steps", httpStatus: result.httpStatus, reason: result.reason ?? "Exact run activity unavailable.", records: [] };
          return { status: result.data.steps.length ? "available" : "empty", sourceId: "cloud-agent-steps", httpStatus: result.httpStatus, recordCount: result.data.steps.length, records: result.data.steps };
        }
      }],
      ["cloud-agent-usage", {
        description: "Allowlisted numeric usage metadata from one exact Cloud Agent run.",
        fetch: async () => {
          const result = await loadDetail();
          if (result.status !== "ok") return { status: "unavailable", sourceId: "cloud-agent-usage", httpStatus: result.httpStatus, reason: result.reason ?? "Exact run usage unavailable.", records: [] };
          const usage = result.data.usage;
          const present = Object.keys(usage).length > 0;
          return { status: present ? "available" : "empty", sourceId: "cloud-agent-usage", httpStatus: result.httpStatus, recordCount: present ? 1 : 0, records: present ? [usage] : [] };
        }
      }]
    ]);

    for (const sourceId of [...new Set(sourceIds)]) {
      if (collector.hasSource?.(sourceId)) throw new Error(`Diagnostic source '${sourceId}' is already registered for this ActiveTab run.`);
      const source = sources.get(sourceId);
      collector.register(
        createDiagnosticContract({
          id: sourceId,
          authority: AUTHORITY.ADMIN_SESSION,
          operations: [OPERATION.READ_SCOPED],
          scope: `${this.applicationId}:${this.environment}:active-tab-run:${activeTabRunId}:cloud-agent-run:${cloudAgentRunId}`,
          sensitivity: SENSITIVITY.METADATA_ONLY,
          rateLimit: { maxCalls: 1 },
          description: source.description
        }),
        async operation => {
          if (operation !== OPERATION.READ_SCOPED) throw new Error("Cloud Agent run evidence accepts only scoped reads.");
          return await source.fetch();
        }
      );
    }
    return collector;
  }

  /** Run detail: attempts, usage, and terminal state for one execution. */
  async getRunDetail(jobId) {
    if (!isSafeRunIdentifier(jobId)) throw new Error("getRunDetail requires a bounded run identifier.");
    const path = this.#pathFor("runDetail", jobId);
    if (!path) return { status: "unavailable", httpStatus: null, data: null, reason: "No profile-validated exact Cloud Agent run-detail route is configured." };
    const result = await this.#fetch(path);
    if (result.status !== "ok") return result;
    const run = result.data?.run ?? result.data?.job ?? result.data?.execution ?? result.data;
    const projected = projectRun(run, jobId);
    if (!projected) return { status: "mismatch", httpStatus: result.httpStatus, data: null, reason: "The exact-run endpoint did not return the requested run identifier." };
    return { ...result, data: { run: projected, usage: projectUsage(run.usage ?? result.data?.usage) } };
  }

  /** Activity (steps/events) for a specific run. */
  async getRunActivity(jobId, { cursor = null, limit = 50 } = {}) {
    if (!isSafeRunIdentifier(jobId)) throw new Error("getRunActivity requires a bounded run identifier.");
    const path = this.#pathFor("runActivity", jobId);
    if (!path) return { status: "unavailable", httpStatus: null, data: null, reason: "No profile-validated exact Cloud Agent run-activity route is configured." };
    const query = {};
    if (cursor !== null) {
      const safeCursor = safeCode(cursor, 128);
      if (!safeCursor) throw new Error("getRunActivity cursor must be a bounded opaque code.");
      query.cursor = safeCursor;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("getRunActivity limit must be between 1 and 200.");
    query.limit = limit;
    const result = await this.#fetch(path, { query });
    if (result.status !== "ok") return result;
    const steps = projectSteps(result.data, jobId);
    return { ...result, data: { steps, nextCursor: safeCode(result.data?.next_cursor ?? result.data?.nextCursor, 128) } };
  }

  /**
   * Test the configured health endpoint and environment binding. This does
   * not claim admin authority; only an exact scoped run read exercises that
   * credential.
   */
  async healthCheck() {
    const path = this.#pathFor("health");
    if (!path) return { healthy: false, adminAuthority: "not_probed", reason: "No profile-validated diagnostic health endpoint is configured." };
    const result = await this.#fetch(path);
    if (result.status !== "ok") {
      return { healthy: false, reason: result.reason ?? `HTTP ${result.httpStatus}.` };
    }
    if (result.data?.status !== "ok") return { healthy: false, reason: "Health endpoint returned an unexpected status." };
    // A health check does not perform a broad authenticated list request.
    // Admin authority is tested only by the caller's exact run-scoped read.
    if (this.environmentBinding && this.environmentBinding.environmentId !== this.environment) {
      return { healthy: false, reason: `Adapter environment '${this.environment}' does not match the verified environment binding '${this.environmentBinding.environmentId}'.` };
    }
    return {
      healthy: true,
      adminAuthority: "not_probed",
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
 * a trusted in-process tunnel adapter that verifies the connected remote
 * service identity before sending the admin credential.
 */
export function cloudAgentAdapterFromEnv(env = process.env, { environmentBinding = null } = {}) {
  const baseUrl = env.ACTIVETAB_CLOUD_AGENT_URL;
  const adminToken = env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;
  if (!baseUrl || !adminToken) return null;
  if (!environmentBinding?.diagnosticEndpoint) return null;
  if (normalizeServiceUrl(baseUrl) !== normalizeServiceUrl(environmentBinding.diagnosticEndpoint)) return null;
  const requestedTransport = env.ACTIVETAB_CLOUD_AGENT_TRANSPORT ?? environmentBinding.diagnosticTransport ?? null;
  const requestedTarget = env.ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET ?? environmentBinding.remoteTarget ?? null;
  if (requestedTransport !== environmentBinding.diagnosticTransport
    || requestedTarget !== environmentBinding.remoteTarget) return null;
  return new CloudAgentDiagnosticAdapter({
    baseUrl,
    adminToken,
    environmentBinding,
    diagnosticTransport: environmentBinding.diagnosticTransport,
    remoteTarget: environmentBinding.remoteTarget,
    endpointBindings: environmentBinding.diagnosticEndpointBindings
  });
}

function normalizeServiceUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  let pathname = parsed.pathname;
  while (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}
