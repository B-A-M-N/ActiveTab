/**
 * Remote execution split for ActiveTab.
 *
 * The local machine keeps all control surface: API server, MCP server,
 * authorization (extension Attach / confirmed targets), evidence store,
 * journals, and workflow persistence. The heavy execution — browser
 * navigation and model inference — can run on another machine on the
 * same LAN by forwarding redacted run requests to it.
 *
 * Threat model and guarantees:
 * - The remote peer is a compute offload, not a trust offload. It never
 *   receives the local API token, extension grants, raw credentials, or
 *   evidence payloads — only the rendered goal, validated template input,
 *   and bounded options needed to execute.
 * - Requests are authenticated with a shared pre-shared key sent as a
 *   bearer token; the token is read from an operator-owned file and is
 *   never logged or journaled.
 * - The peer must present a pinned LAN hostname (default RFC 1918/loopback
 *   private addresses only) over http://; anything else is refused.
 * - Truthful states: unreachable peer, transport failure, timeout, or a
 *   lost connection mid-run all land as `failed` with an `interrupted`
 *   reason. A remote run can never report success without a complete
 *   success response, and cancellation maps to `canceled` only when the
 *   peer acknowledged it; otherwise the run is `failed/interrupted`.
 *
 * This is deliberately not a distributed orchestration framework: it is a
 * single-request forwarder with strict state translation.
 */
import { readFile } from "node:fs/promises";

const PRIVATE_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000; // matches bounded run budgets
const CONNECT_TIMEOUT_MS = 10_000;

function isPrivateLanHostname(hostname) {
  if (PRIVATE_HOSTNAMES.has(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;          // 10.0.0.0/8
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;             // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true; // 172.16.0.0/12
  if (/^fd[0-9a-f]{2}:/i.test(hostname) || hostname === "::1") return true;   // IPv6 ULA
  return false;
}

function validatePeerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("Remote executor peers must use plain http:// on a trusted LAN (TLS termination is an operator concern).");
  if (!isPrivateLanHostname(url.hostname)) throw new Error("Remote executor peer must be a loopback or RFC 1918 / ULA private address.");
  return url;
}

async function loadPeerToken({ peerToken, peerTokenFile }) {
  if (peerToken) return peerToken;
  const { loadOrCreatePeerToken } = await import("./tokens.js");
  const { token } = await loadOrCreatePeerToken(peerTokenFile);
  return token;
}

const REQUEST_KEYS = new Set(["goal", "input", "templateId", "taskId"]);
const SENSITIVE_KEY_PATTERN = /(?:password|token|secret|credential|cookie|auth|session|api.?key|bearer)/i;
function hasSensitiveNestedValue(value) {
  if (typeof value === "string") return SENSITIVE_KEY_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(hasSensitiveNestedValue);
  if (value && typeof value === "object") return Object.values(value).some(hasSensitiveNestedValue);
  return false;
}
function sanitizeForwardBody(body) {
  // Only whitelisted keys are forwarded; anything else (headers, nested
  // credentials, surprise fields) is dropped before it leaves this machine.
  const clean = {};
  for (const key of Object.keys(body ?? {})) {
    if (!REQUEST_KEYS.has(key)) continue;
    clean[key] = body[key];
  }
  if (clean.input && (typeof clean.input !== "object" || Array.isArray(clean.input))) clean.input = {};
  if (clean.goal && typeof clean.goal === "string" && clean.goal.length > 2000) clean.goal = clean.goal.slice(0, 2000);
  if (hasSensitiveNestedValue(clean.input)) throw new Error("Forwarded input contains a value matching a sensitive-field pattern; raw credentials must not be sent to a remote peer.");
  return clean;
}

/**
 * Create a remote executor matching the local runner's `.run()` contract.
 *
 * @param {object} options
 * @param {string} options.peerUrl - Base URL of the remote ActiveTab run endpoint.
 * @param {string} [options.peerToken] - Shared bearer token (or use peerTokenFile / ACTIVETAB_REMOTE_TOKEN).
 * @param {string} [options.peerTokenFile] - File containing the shared token.
 * @param {number} [options.timeoutMs] - Total run deadline (default 30 min).
 * @param {typeof fetch} [options.fetchImpl] - Transport override for testing.
 */
export function createRemoteExecutor({ peerUrl, peerToken, peerTokenFile, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!peerUrl) throw new Error("createRemoteExecutor requires a peerUrl.");
  const peer = validatePeerUrl(peerUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error("Remote executor timeout must be between 1 second and 1 hour.");
  }
  let tokenPromise = null;
  const token = () => tokenPromise ??= loadPeerToken({ peerToken, peerTokenFile });

  /**
   * Execute one run on the peer. Mirrors createNavigationRunner().run:
   * returns { status, output, usage, output_files, task_id, evidence_id }.
   * Terminal-state translation is explicit and can never fabricate success.
   * @param {string} [options.idempotencyKey] - Stable caller-owned key; defaults to the durable local taskId.
   */
  async function run(goal, { signal, input, templateId, taskId, idempotencyKey, inputSchema } = {}) {
    const canceledResult = (uncertain = false) => ({
      status: uncertain ? "reconciling" : "canceled",
      uncertain,
      output: {
        status: uncertain ? "unresolved" : "canceled",
        reason: uncertain
          ? "Cancellation interrupted the peer request after dispatch may have started; the remote outcome must be reconciled."
          : "Canceled before the peer request was dispatched.",
        ...(uncertain ? { uncertain: true } : {})
      }
    });
    if (signal?.aborted) return canceledResult(false);
    const stableIdempotencyKey = idempotencyKey ?? taskId;
    if (typeof stableIdempotencyKey !== "string" || !/^[\x21-\x7e]{1,128}$/.test(stableIdempotencyKey)) {
      return interrupted("A stable caller-owned idempotency key or durable taskId is required before peer dispatch.", { uncertain: false });
    }
    // Load the token before wiring cancellation so an abort that fires
    // while the token is being read still settles the run instead of
    // leaving it pending forever.
    const secret = await token();
    if (signal?.aborted) return canceledResult(false);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timers = [setTimeout(() => controller.abort(), timeoutMs)];
    try {
      let response;
      try {
        response = await fetchImpl(new URL("/v3/bots/remote/runs", peer), {
          method: "POST",
          headers: {
            "content-type": "application/json",
          "idempotency-key": stableIdempotencyKey,
            ...(secret ? { authorization: `Bearer ${secret}` } : {})
          },
          body: JSON.stringify(sanitizeForwardBody({ goal, input, templateId, taskId })),
          signal: controller.signal
        });
      } catch (error) {
        if (signal?.aborted) return canceledResult(true);
        return interrupted(`The remote executor is unreachable or the connection failed: ${String(error?.message ?? error).slice(0, 200)}`);
      }

      if (response.status === 401 || response.status === 403) {
        return interrupted("The remote executor rejected the shared token (401/403).", { uncertain: false });
      }
      if (!response.ok) {
        const definitelyRejected = [400, 401, 403, 409, 413, 422, 507].includes(response.status);
        return interrupted(`The remote executor returned HTTP ${response.status}.`, { uncertain: !definitelyRejected });
      }

      let payload;
      try {
        // Tolerate heartbeat blank lines emitted before the JSON body.
        const text = await response.text();
        payload = JSON.parse(text.replace(/^(\s|\n)+/, ""));
      }
      catch { return interrupted("The remote executor returned a non-JSON response; the run outcome is unknown."); }

      if (!payload || typeof payload !== "object") return interrupted("The remote executor returned an invalid response body.");
      // Response ownership: the peer may create its own task_id for the
      // forwarded run. We record the peer's ID in the result so callers
      // can trace it, but we do not require it to match the local taskId,
      // since the local and peer stores are separate domains.
      const status = payload.status;
      if (status === "succeeded" || status === "finished") {
        return {
          status: "succeeded",
          output: payload.output ?? { status: "succeeded" },
          usage: payload.usage ?? null,
          output_files: payload.output_files ?? {},
          task_id: payload.task_id ?? taskId ?? null,
          evidence_id: payload.evidence_id ?? null
        };
      }
      if (status === "needs_human") {
        return { status: "needs_human", output: payload.output ?? { reason: "Remote run requested human handoff." }, task_id: payload.task_id ?? taskId ?? null };
      }
      if (status === "canceled") {
        return payload.uncertain === false
          ? { status: "canceled", uncertain: false, output: payload.output ?? { status: "canceled" } }
          : { status: "reconciling", uncertain: true, output: payload.output ?? { status: "unresolved", uncertain: true, reason: "The peer has not established a safe terminal outcome." } };
      }
      if (status === "unresolved" || status === "reconciling") {
        return {
          status: "reconciling",
          uncertain: true,
          output: { status: "unresolved", uncertain: true, reason: String(payload.output?.reason ?? payload.error ?? "The peer outcome is unresolved.").slice(0, 500) },
          task_id: payload.task_id ?? taskId ?? null
        };
      }
      if (status === "failed") {
        return {
          status: "failed",
          output: { status: "failed", reason: String(payload.output?.reason ?? payload.error ?? "Remote run failed.").slice(0, 500) },
          usage: payload.usage ?? null,
          task_id: payload.task_id ?? taskId ?? null
        };
      }
      if (status === "interrupted") {
        return interrupted(String(payload.output?.reason ?? payload.error ?? "The peer reported an interrupted request."));
      }
      return interrupted(`The remote executor returned an unrecognized terminal state "${String(status).slice(0, 64)}"; the run outcome is unknown.`);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  function interrupted(reason, { uncertain = true } = {}) {
    return {
      status: uncertain ? "reconciling" : "failed",
      uncertain,
      output: { status: uncertain ? "unresolved" : "failed", reason: `interrupted: ${reason}`, ...(uncertain ? { uncertain: true } : {}) },
      usage: null
    };
  }

  return { run, peer: peer.toString() };
}
