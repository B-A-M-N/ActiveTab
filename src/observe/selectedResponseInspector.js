import { sanitizeUrl } from "../browser/urlPrivacy.js";
import { createUtf8OffsetIndex, indexMarkdownDocument, inspectResponseBody, selectMarkdownRange, sliceUtf8View, redactCredentialUrl } from "./responseBodyInspector.js";
import { MAX_RESPONSE_BODY_BYTES, MAX_RESPONSE_MARKDOWN_BYTES } from "./responseBodyShared.js";
import {
  readSelectedResponseBody,
  responseBodyAcquisitionPolicy,
  responseBodyAcquisitionResult
} from "./networkResponseAcquisition.js";

const DEFAULT_NETWORK_RESPONSE_BYTES = 32 * 1024;
export const MAX_NETWORK_RESPONSE_CHUNK_BYTES = 256 * 1024;
const DEFAULT_NETWORK_RESPONSE_TIMEOUT_MS = 8_000;
const MAX_NETWORK_RESPONSE_TIMEOUT_MS = 15_000;
const MAX_NETWORK_RESPONSE_INSPECTION_MS = 3_000;
const MAX_NETWORK_RESPONSE_PAGE_CURSORS = 64;

function inlineMarkdown(value) {
  const text = String(value ?? "unavailable").replace(/\r?\n/g, " ");
  let maxTicks = 0;
  for (const match of text.matchAll(/`+/g)) maxTicks = Math.max(maxTicks, match[0].length);
  const fence = "`".repeat(maxTicks + 1);
  return `${fence}${text}${fence}`;
}

function renderNetworkResponseMarkdown(request, requestEvidence, inspection) {
  const cache = request.fromServiceWorker ? "service worker"
    : request.fromDiskCache ? "disk cache"
      : request.fromPrefetchCache ? "prefetch cache"
        : request.connectionReused ? "reused connection" : "network";
  const lines = [
    "# Network response",
    "",
    `- Request: ${inlineMarkdown(`${request.method ?? "unavailable"} ${requestEvidence.url ?? "unavailable"}`)}`,
    `- Status: ${inlineMarkdown(request.status)}`,
    `- Resource type: ${inlineMarkdown(request.resourceType)}`,
    `- Content type: ${inlineMarkdown(request.mimeType)}`,
    `- Protocol: ${inlineMarkdown(request.protocol)}`,
    `- Source: ${cache}`,
    `- Duration: ${inlineMarkdown(requestEvidence.durationMs)} ms`,
    `- Time to response: ${inlineMarkdown(requestEvidence.timeToResponseMs)} ms`,
    `- Encoded bytes: ${inlineMarkdown(request.encodedDataLength)}`,
    `- Decoded bytes observed: ${inlineMarkdown(request.decodedDataLength)}`,
    `- Decoded data chunks: ${inlineMarkdown(request.dataChunkCount)}`,
    `- Body interpretation: ${inlineMarkdown(`${inspection.format}${inspection.parseMode ? ` (${inspection.parseMode})` : ""}`)}`,
    `- Recognized credential redactions: ${inlineMarkdown(inspection.credentialRedactions)}`,
    `- Credential values: ${inspection.credentialValuesIncluded ? "included by explicit local request" : "redacted"}`,
    "",
    "## Response timing phases",
    "",
    "```json",
    JSON.stringify(request.responseTiming ?? {}, null, 2),
    "```",
    "",
    inspection.markdown
  ];
  return lines.join("\n");
}

function estimateBase64DecodedBytes(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}


export async function inspectNetworkResponse(observer, id, {
    requestId,
    includeSensitive = false,
    includeCredentialValues = false,
    includeSensitiveUrlData = false,
    maxBytes = DEFAULT_NETWORK_RESPONSE_BYTES,
    timeoutMs = DEFAULT_NETWORK_RESPONSE_TIMEOUT_MS,
    signal,
    offset = 0,
    view = "markdown",
    sectionId,
    blockId
  } = {}, responseCache) {
    const stored = observer.evidence.get(id)?.evidence;
    if (!stored) return { status: "expired", evidenceId: id };
    if (stored.targetId && stored.targetId !== observer.session.target.id) return {
      status: "stale",
      evidenceId: id,
      reasonCode: "evidence_target_changed",
      evidenceTargetId: stored.targetId,
      currentTargetId: observer.session.target.id
    };
    if (typeof requestId !== "string" || !requestId) return { status: "not_found", evidenceId: id, requestId: requestId ?? null };
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_NETWORK_RESPONSE_CHUNK_BYTES) {
      throw new Error(`maxBytes must be an integer from 1 to ${MAX_NETWORK_RESPONSE_CHUNK_BYTES}.`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_NETWORK_RESPONSE_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer from 1 to ${MAX_NETWORK_RESPONSE_TIMEOUT_MS}.`);
    }
    if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      throw new Error("signal must be an AbortSignal.");
    }
    if (includeCredentialValues === true && includeSensitive !== true) {
      throw new Error("includeCredentialValues:true requires includeSensitive:true.");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer.");
    if (view !== "markdown" && view !== "source" && view !== "normalized") throw new Error("view must be markdown, source, or normalized.");
    if (sectionId !== undefined && (typeof sectionId !== "string" || !sectionId)) throw new Error("sectionId must be a non-empty string.");
    if (blockId !== undefined && (typeof blockId !== "string" || !blockId)) throw new Error("blockId must be a non-empty string.");
    if ((sectionId !== undefined || blockId !== undefined) && view !== "markdown") throw new Error("sectionId and blockId require view:'markdown'.");
    if (sectionId !== undefined && blockId !== undefined) throw new Error("Select either sectionId or blockId, not both.");
    const request = stored.activity.networkRequests.filter(item => item.requestId === requestId).at(-1);
    if (!request) return { status: "not_found", evidenceId: id, requestId };
    const { protocolRequestId: _protocolRequestId, ...publicRequest } = request;
    const requestEvidence = {
      ...structuredClone(publicRequest),
      durationMs: Number.isFinite(request.timestamp) && Number.isFinite(request.finishedAt)
        ? Math.max(0, Math.round((request.finishedAt - request.timestamp) * 1000)) : null,
      timeToResponseMs: Number.isFinite(request.timestamp) && Number.isFinite(request.responseReceivedAt)
        ? Math.max(0, Math.round((request.responseReceivedAt - request.timestamp) * 1000)) : null,
      url: request.url ? redactCredentialUrl(sanitizeUrl(request.url, { includeSensitiveUrlData }), { includeUserInfo: includeSensitiveUrlData }) : request.url,
      redirectedTo: request.redirectedTo ? redactCredentialUrl(sanitizeUrl(request.redirectedTo, { includeSensitiveUrlData }), { includeUserInfo: includeSensitiveUrlData }) : request.redirectedTo
    };
    if (includeSensitive !== true) {
      return {
        status: "available",
        evidenceId: id,
        request: requestEvidence,
        responseBody: {
          status: "not_returned",
          available: request.finishedAt !== null && !request.failure && !request.redirectedTo,
          reason: "Response bodies may contain credentials or personal data. Set includeSensitive:true only when the caller explicitly wants this response body."
        }
      };
    }
    if (request.failure) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "failed_request" } };
    if (request.redirectedTo) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "redirect_body_unavailable" } };
    if (request.finishedAt === null) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "request_not_finished" } };
    if (!request.protocolRequestId) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "request_identity_unavailable" } };
    const projectionCacheKey = JSON.stringify([id, stored.targetId ?? observer.session.target.id, request.frameTargetId ?? null, requestId, view]);
    const canReuseProjection = includeCredentialValues !== true && includeSensitiveUrlData !== true;
    if (signal?.aborted) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "before_acquisition" }
    };
    const cachedProjection = canReuseProjection ? responseCache.getProjection(projectionCacheKey) : null;
    if (cachedProjection) return responseCache.pageProjection({
      evidenceId: id,
      requestEvidence,
      projection: cachedProjection.projection,
      projectionCacheKey,
      cacheHit: true,
      offset,
      maxBytes,
      sectionId,
      blockId
    });
    const client = observer.session.networkClientForTarget?.(request.frameTargetId ?? null);
    if (!client) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "network_session_unavailable" } };
    const acquisitionPolicy = responseBodyAcquisitionPolicy(request, {
      explicitBodyOptIn: includeSensitive === true
    });
    if (acquisitionPolicy.status === "over_limit") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: acquisitionPolicy.reasonCode,
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy),
        reportedDecodedBytes: acquisitionPolicy.reportedDecodedBytes,
        reportedEncodedBytes: acquisitionPolicy.reportedEncodedBytes,
        maxDecodedBytes: MAX_RESPONSE_BODY_BYTES,
        bodyRetrieved: false
      }
    };
    if (acquisitionPolicy.status === "refused") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "unsupported",
        reasonCode: acquisitionPolicy.reasonCode,
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy),
        bodyRetrieved: false
      }
    };
    const acquisitionStartedAt = Date.now();
    const acquisition = await readSelectedResponseBody(observer.session, client, request.protocolRequestId, { signal, timeoutMs });
    const acquisitionMs = Date.now() - acquisitionStartedAt;
    if (acquisition.status === "busy") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "busy",
        reasonCode: "session_response_body_acquisition_in_progress",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy),
        acquisitionMs
      }
    };
    if (acquisition.status === "cancelled") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "acquisition", acquisition: responseBodyAcquisitionResult(acquisitionPolicy), acquisitionMs }
    };
    if (acquisition.status === "timed_out") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "timed_out", phase: "acquisition", acquisition: responseBodyAcquisitionResult(acquisitionPolicy), timeoutMs, acquisitionMs }
    };
    if (acquisition.status !== "available") {
      return {
        status: "unavailable", evidenceId: id, request: requestEvidence,
        responseBody: {
          status: "body_evicted_or_unavailable",
          acquisition: responseBodyAcquisitionResult(acquisitionPolicy),
          acquisitionMs
        }
      };
    }
    const response = acquisition.response;
    if (typeof response?.body !== "string") return {
      status: "unavailable", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "empty_or_unavailable",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true }),
        acquisitionMs
      }
    };
    const base64Encoded = response.base64Encoded === true;
    const encodedBodyBytes = Buffer.byteLength(response.body, "utf8");
    const decodedBodyEstimate = base64Encoded ? estimateBase64DecodedBytes(response.body) : encodedBodyBytes;
    const maximumEncodedBase64Bytes = Math.ceil(MAX_RESPONSE_BODY_BYTES * 4 / 3) + 4;
    if (decodedBodyEstimate > MAX_RESPONSE_BODY_BYTES
      || (base64Encoded && encodedBodyBytes > maximumEncodedBase64Bytes)) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: "decoded_body_bytes_limit",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: decodedBodyEstimate }),
        encodedBodyBytes,
        decodedBodyEstimate,
        maxDecodedBytes: MAX_RESPONSE_BODY_BYTES,
        bodyRetrieved: true,
        bodyDecoded: false
      }
    };
    if (signal?.aborted) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "after_acquisition", acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: decodedBodyEstimate }), acquisitionMs }
    };
    const bytes = base64Encoded ? Buffer.from(response.body, "base64") : Buffer.from(response.body, "utf8");
    if (bytes.length > MAX_RESPONSE_BODY_BYTES) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: "decoded_body_bytes_limit",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
        encodedBodyBytes,
        decodedBytes: bytes.length,
        maxDecodedBytes: MAX_RESPONSE_BODY_BYTES,
        bodyRetrieved: true,
        bodyDecoded: true
      }
    };
    const processingStartedAt = Date.now();
    const analysisStartedAt = Date.now();
    const inspection = inspectResponseBody(bytes, request.mimeType, {
      base64Encoded,
      includeCredentialValues,
      includeMarkdown: view === "markdown"
    });
    const analysisMs = Date.now() - analysisStartedAt;
    if (inspection.status === "over_limit") return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: inspection.reasonCode,
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
        analysis: inspection.analysis,
        credentialValuesIncluded: false,
        limits: inspection.analysis?.budgetExceeded ?? null
      }
    };
    if (signal?.aborted) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "analysis", acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }), acquisitionMs, analysisMs }
    };
    if (analysisMs > MAX_NETWORK_RESPONSE_INSPECTION_MS) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: "analysis_time_budget_exceeded",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
        analysisMs,
        maxAnalysisMs: MAX_NETWORK_RESPONSE_INSPECTION_MS,
        sourceBytes: bytes.length
      }
    };
    const renderStartedAt = Date.now();
    const markdownReport = view === "markdown" ? renderNetworkResponseMarkdown(request, requestEvidence, inspection) : null;
    const renderMs = Date.now() - renderStartedAt;
    const markdownBytes = markdownReport === null ? 0 : Buffer.byteLength(markdownReport);
    if (markdownBytes > MAX_RESPONSE_MARKDOWN_BYTES) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: "markdown_output_limit",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
        markdownBytes,
        maxMarkdownBytes: MAX_RESPONSE_MARKDOWN_BYTES,
        sourceBytes: bytes.length
      }
    };
    if (signal?.aborted) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "render", acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }), acquisitionMs, analysisMs, renderMs }
    };
    if (view === "normalized" && inspection.normalizedText === null) {
      return {
        status: "unavailable",
        evidenceId: id,
        request: requestEvidence,
        responseBody: {
          status: "normalization_unavailable",
          acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
          format: inspection.format,
          parseMode: inspection.parseMode,
          credentialValuesIncluded: inspection.credentialValuesIncluded,
          analysis: inspection.analysis,
          reason: `No structured JSON value could be established. Request view:'source' to inspect the complete ${includeCredentialValues ? "source" : "redacted source"}.`
        }
      };
    }
    const selectedView = view === "source" ? inspection.sourceText
      : view === "normalized" ? inspection.normalizedText : markdownReport;
    const indexingStartedAt = Date.now();
    const markdownIndex = view === "markdown" ? indexMarkdownDocument(markdownReport) : undefined;
    const byteOffsets = markdownIndex?.byteOffsets ?? createUtf8OffsetIndex(selectedView);
    const indexingMs = Date.now() - indexingStartedAt;
    if (signal?.aborted) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: { status: "cancelled", phase: "indexing", acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }), acquisitionMs, analysisMs, renderMs, indexingMs }
    };
    const processingMs = Date.now() - processingStartedAt;
    if (processingMs > MAX_NETWORK_RESPONSE_INSPECTION_MS) return {
      status: "available", evidenceId: id, request: requestEvidence,
      responseBody: {
        status: "over_limit",
        reasonCode: "total_inspection_time_budget_exceeded",
        acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
        acquisitionMs,
        analysisMs,
        renderMs,
        indexingMs,
        processingMs,
        maxProcessingMs: MAX_NETWORK_RESPONSE_INSPECTION_MS,
        sourceBytes: bytes.length
      }
    };
    const projection = {
      evidenceId: id,
      view,
      selectedView,
      format: inspection.format,
      parseMode: inspection.parseMode,
      encoding: inspection.encoding,
      credentialRedactions: inspection.credentialRedactions,
      credentialValuesIncluded: inspection.credentialValuesIncluded,
      credentialDetails: inspection.credentialDetails,
      analysis: inspection.analysis,
      acquisition: responseBodyAcquisitionResult(acquisitionPolicy, { bodyRetrieved: true, actualDecodedBytes: bytes.length }),
      markdownIndex,
      byteOffsets,
      sourceBytes: bytes.length,
      markdownBytes,
      phaseMetrics: { acquisitionMs, analysisMs, renderMs, indexingMs, processingMs },
      pageCursors: new Map(),
      pagingCounters: { pageCount: 0, utf8IndexedLookups: 0, utf8CursorHits: 0, utf8ScannedBytes: 0 }
    };
    if (canReuseProjection) responseCache.storeProjection(projectionCacheKey, projection);
    return responseCache.pageProjection({
      evidenceId: id,
      requestEvidence,
      projection,
      projectionCacheKey: canReuseProjection ? projectionCacheKey : null,
      cacheHit: false,
      offset,
      maxBytes,
      sectionId,
      blockId
    });
  }


export function pageResponseProjection({ evidenceId, requestEvidence, projection, projectionCacheKey, cacheHit, offset, maxBytes, sectionId, blockId }) {
    const pageStartedAt = Date.now();
    const { selectedView, markdownIndex, byteOffsets } = projection;
    const selectionResult = markdownIndex
      ? selectMarkdownRange(selectedView, markdownIndex, { sectionId, blockId, includeText: false })
      : null;
    if ((sectionId !== undefined || blockId !== undefined) && !selectionResult) return {
      status: "not_found",
      evidenceId,
      request: requestEvidence,
      reasonCode: "markdown_selection_not_found",
      selection: { kind: sectionId !== undefined ? "section" : "block", id: sectionId ?? blockId },
      availableSelections: { sections: markdownIndex?.sections ?? [], blocks: markdownIndex?.blocks ?? [] }
    };
    const selection = selectionResult?.selection
      ?? (markdownIndex ? { kind: "document", id: null, documentOffset: 0, totalBytes: byteOffsets.totalBytes } : undefined);
    const rangeStart = selection?.documentOffset ?? 0;
    const rangeEnd = rangeStart + (selection?.totalBytes ?? byteOffsets.totalBytes);
    const cursorKey = JSON.stringify([selection?.kind ?? "view", selection?.id ?? null, rangeStart, rangeEnd]);
    const cursor = projection.pageCursors.get(cursorKey);
    const page = sliceUtf8View(selectedView, offset, maxBytes, {
      index: byteOffsets,
      cursor,
      rangeStart,
      endOffset: rangeEnd
    });
    if (projectionCacheKey) {
      if (!projection.pageCursors.has(cursorKey) && projection.pageCursors.size >= MAX_NETWORK_RESPONSE_PAGE_CURSORS) {
        projection.pageCursors.delete(projection.pageCursors.keys().next().value);
      }
      projection.pageCursors.set(cursorKey, {
        byteOffset: rangeStart + page.nextOffset,
        characterOffset: page.nextCharacterOffset
      });
    }
    const counters = projection.pagingCounters;
    counters.pageCount++;
    if (page.startLookupMode === "cursor") counters.utf8CursorHits++;
    counters.utf8IndexedLookups += [page.startLookupMode, page.endLookupMode].filter(mode => mode === "sparse_index").length;
    counters.utf8ScannedBytes += page.scannedBytes;
    return {
      status: "available",
      evidenceId,
      request: requestEvidence,
      responseBody: {
        status: "included",
        contentType: requestEvidence.mimeType,
        format: projection.format,
        parseMode: projection.parseMode,
        view: projection.view,
        encoding: projection.view === "markdown" || projection.view === "normalized" ? "utf-8" : projection.encoding,
        data: page.data,
        totalBytes: projection.sourceBytes,
        viewBytes: page.totalBytes,
        returnedBytes: Buffer.byteLength(page.data),
        offset: page.offset,
        nextOffset: page.nextOffset,
        documentOffset: selection ? selection.documentOffset + page.offset : undefined,
        hasMore: page.hasMore,
        truncated: false,
        ...(selection ? { selection } : {}),
        ...(markdownIndex ? { sections: markdownIndex.sections, blocks: markdownIndex.blocks } : {}),
        credentialRedactions: projection.credentialRedactions,
        credentialValuesIncluded: projection.credentialValuesIncluded,
        credentialDetails: projection.credentialDetails,
        acquisition: projection.acquisition,
        analysis: projection.analysis,
        inspectionMetrics: {
          acquisitionMs: cacheHit ? 0 : projection.phaseMetrics.acquisitionMs,
          analysisMs: cacheHit ? 0 : projection.phaseMetrics.analysisMs,
          renderMs: cacheHit ? 0 : projection.phaseMetrics.renderMs,
          indexingMs: cacheHit ? 0 : projection.phaseMetrics.indexingMs,
          processingMs: cacheHit ? Date.now() - pageStartedAt : projection.phaseMetrics.processingMs,
          sourceBytes: projection.sourceBytes,
          markdownBytes: projection.markdownBytes,
          returnedPageBytes: Buffer.byteLength(page.data),
          projectionCacheHit: cacheHit,
          paging: { ...counters }
        }
      }
    };
  }
