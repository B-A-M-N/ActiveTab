import { MAX_RESPONSE_BODY_BYTES } from "./responseBodyShared.js";

const STREAMING_REQUEST_TYPES = new Set(["eventsource", "websocket"]);
const ACTIVE_SESSIONS = new WeakSet();

function contentTypeClass(mimeType) {
  const mime = String(mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!mime) return "unknown";
  if (mime.startsWith("text/")
    || /^(application\/(json|[^/]+\+json|xml|[^/]+\+xml|javascript|x-javascript|ecmascript|x-www-form-urlencoded|graphql-response\+json|ndjson|json-seq))$/u.test(mime)) {
    return "textual";
  }
  if (/^(image|audio|video|font)\//u.test(mime)
    || /^(application\/(octet-stream|pdf|zip|gzip|wasm))$/u.test(mime)) {
    return "binary";
  }
  return "other";
}

/** Describe acquisition eligibility without replacing the caller's authorization gate. */
export function responseBodyAcquisitionPolicy(request, { explicitBodyOptIn = false } = {}) {
  const requestType = typeof request?.resourceType === "string" ? request.resourceType.slice(0, 64) : null;
  const streaming = STREAMING_REQUEST_TYPES.has(String(requestType ?? "").toLowerCase());
  const encoded = Number.isFinite(request?.encodedDataLength) && request.encodedDataLength >= 0
    ? request.encodedDataLength : null;
  const decodedWasObserved = Number.isFinite(request?.dataChunkCount) && request.dataChunkCount > 0;
  const decoded = Number.isFinite(request?.decodedDataLength)
    && request.decodedDataLength >= 0
    && (decodedWasObserved || request.decodedDataLength > 0)
    ? request.decodedDataLength : null;
  const sizeStatus = encoded !== null || decoded !== null ? "reported_size" : "size_unknown";
  let status = sizeStatus;
  let reasonCode = null;
  if (explicitBodyOptIn !== true) {
    status = "authorization_required";
    reasonCode = "explicit_body_opt_in_required";
  } else if (streaming) {
    status = "refused";
    reasonCode = "streaming_request_type_unsupported";
  } else if (decoded !== null && decoded > MAX_RESPONSE_BODY_BYTES) {
    status = "over_limit";
    reasonCode = "reported_decoded_body_bytes_limit";
  } else if (encoded !== null && encoded > MAX_RESPONSE_BODY_BYTES) {
    status = "over_limit";
    reasonCode = "reported_encoded_body_bytes_limit";
  }
  return Object.freeze({
    status,
    reasonCode,
    explicitBodyOptIn: explicitBodyOptIn === true,
    requestType,
    requestKind: streaming ? "streaming" : requestType ? "finite_or_unknown" : "unknown",
    contentTypeClass: contentTypeClass(request?.mimeType),
    sizeStatus,
    reportedEncodedBytes: encoded,
    reportedDecodedBytes: decoded,
    maxEncodedBytes: MAX_RESPONSE_BODY_BYTES,
    maxDecodedBytes: MAX_RESPONSE_BODY_BYTES,
    hardMemoryBound: false,
    limitEnforcement: sizeStatus === "size_unknown"
      ? "post_acquisition_only"
      : "reported_size_preflight_and_post_acquisition_check",
    transportBehavior: "cdp_materializes_complete_body_result"
  });
}

/** Attach the measured body size while retaining the preflight uncertainty. */
export function responseBodyAcquisitionResult(policy, {
  bodyRetrieved = false,
  actualDecodedBytes = null
} = {}) {
  const mismatch = Number.isFinite(actualDecodedBytes)
    && Number.isFinite(policy?.reportedDecodedBytes)
    ? actualDecodedBytes !== policy.reportedDecodedBytes
    : null;
  return Object.freeze({
    ...policy,
    bodyRetrieved,
    actualDecodedBytes: Number.isFinite(actualDecodedBytes) ? actualDecodedBytes : null,
    reportedDecodedSizeMismatch: mismatch,
    hardMemoryBound: false
  });
}

/**
 * Allows one pending response-body command per BrowserSession. Caller timeout
 * or cancellation ends its wait, while the slot remains held until CDP settles.
 */
export function readSelectedResponseBody(session, client, requestId, { signal, timeoutMs }) {
  if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
  if (!session || (typeof session !== "object" && typeof session !== "function")
    || !client || typeof client.send !== "function") {
    return Promise.resolve({ status: "unavailable" });
  }
  if (ACTIVE_SESSIONS.has(session)) return Promise.resolve({ status: "busy" });
  ACTIVE_SESSIONS.add(session);

  return new Promise(resolve => {
    let settled = false;
    let commandStarted = false;
    const release = () => ACTIVE_SESSIONS.delete(session);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: "cancelled" });
    const timer = setTimeout(() => finish({ status: "timed_out" }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      release();
      onAbort();
      return;
    }

    Promise.resolve()
      .then(() => {
        if (settled) return null;
        commandStarted = true;
        return client.send("Network.getResponseBody", { requestId });
      })
      .then(response => {
        release();
        if (commandStarted) finish({ status: "available", response });
        else release();
      }, error => {
        release();
        finish({ status: error?.code === "CDP_TIMEOUT" ? "timed_out" : "unavailable" });
      });
  });
}
