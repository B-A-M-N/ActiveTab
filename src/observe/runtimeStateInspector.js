import { randomUUID } from "node:crypto";

const MAX_RUNTIME_PATH_SEGMENTS = 8;
const MAX_RUNTIME_PATH_SEGMENT_LENGTH = 128;
const DEFAULT_RUNTIME_VALUE_CHUNK_LENGTH = 4_096;
const MAX_RUNTIME_VALUE_CHUNK_LENGTH = 16_384;
const MAX_RUNTIME_VALUE_LENGTH = MAX_RUNTIME_VALUE_CHUNK_LENGTH;

const RUNTIME_PATH_INSPECTOR = `function(path, failureMarker, includeSensitiveValues, valueOffset, valueChunkLength) {
  let current = this;
  for (let index = 0; index < path.length; index++) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      return failureMarker + ":parent_not_object:" + index + ":" + (current === null ? "null" : typeof current);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, path[index]);
    if (!descriptor) return failureMarker + ":not_found:" + index;
    if (!("value" in descriptor)) {
      return failureMarker + ":accessor_not_read:" + index + ":" + (typeof descriptor.get === "function") + ":" + (typeof descriptor.set === "function");
    }
    current = descriptor.value;
  }
  const type = current === null ? "null" : typeof current;
  if (type !== "object" && type !== "function") {
    if (!includeSensitiveValues) return failureMarker + ":primitive_redacted:" + type;
    if (type === "string") {
      let start = Math.min(Math.max(0, valueOffset), current.length);
      if (start > 0 && start < current.length) {
        const currentUnit = current.charCodeAt(start);
        const previousUnit = current.charCodeAt(start - 1);
        if (currentUnit >= 0xdc00 && currentUnit <= 0xdfff && previousUnit >= 0xd800 && previousUnit <= 0xdbff) start--;
      }
      let end = Math.min(current.length, start + valueChunkLength);
      if (end > start && end < current.length) {
        const previousUnit = current.charCodeAt(end - 1);
        const currentUnit = current.charCodeAt(end);
        if (previousUnit >= 0xd800 && previousUnit <= 0xdbff && currentUnit >= 0xdc00 && currentUnit <= 0xdfff) end--;
      }
      return failureMarker + ":primitive_string_chunk:" + JSON.stringify({
        value: current.slice(start, end),
        valueOffset: start,
        valueLength: current.length,
        valueComplete: end >= current.length,
        nextOffset: end
      });
    }
    if (type === "number" || type === "boolean" || type === "undefined" || type === "null") return current;
    return failureMarker + ":primitive_unavailable:" + type;
  }
  return current;
}`;

export async function inspectRuntimeState(observer, id, {
  path = [], frameTargetId = null, includeSensitiveValues = false,
  offset = 0, maxChars = DEFAULT_RUNTIME_VALUE_CHUNK_LENGTH
} = {}) {
  const stored = observer.evidenceStore.get(id);
  if (!stored) return { status: "expired", evidenceId: id };
  if (!Array.isArray(path) || path.length > MAX_RUNTIME_PATH_SEGMENTS || path.some(segment => typeof segment !== "string" || segment.length > MAX_RUNTIME_PATH_SEGMENT_LENGTH)) {
    throw new Error(`path must contain at most ${MAX_RUNTIME_PATH_SEGMENTS} strings of at most ${MAX_RUNTIME_PATH_SEGMENT_LENGTH} characters.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer.");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_RUNTIME_VALUE_CHUNK_LENGTH) {
    throw new Error(`maxChars must be an integer from 1 to ${MAX_RUNTIME_VALUE_CHUNK_LENGTH}.`);
  }
  if (stored.evidence.documentGeneration !== observer.session.documentGeneration) {
    return { status: "stale", evidenceId: id, documentGeneration: stored.evidence.documentGeneration, currentDocumentGeneration: observer.session.documentGeneration };
  }
  const frame = frameTargetId ? observer.session.frameSessions?.get(frameTargetId) : null;
  if (frameTargetId && (!frame || frame.status !== "ready")) {
    return { status: "unavailable", evidenceId: id, reason: "frame_session_unavailable", frameTargetId };
  }
  const client = frameTargetId ? frame.client : observer.session.client;
  const objectGroup = `activetab-runtime-${randomUUID()}`;
  const remotePrimitive = remote => {
    if (remote?.subtype === "null") return null;
    if (Object.hasOwn(remote ?? {}, "value")) return remote.value;
    if (typeof remote?.unserializableValue === "string") return remote.unserializableValue;
    return undefined;
  };
  let result;
  try {
    const failureMarker = `__ACTIVETAB_RUNTIME_${randomUUID()}__`;
    const root = await client.send("Runtime.evaluate", { expression: "globalThis", objectGroup, returnByValue: false, awaitPromise: false, userGesture: false });
    if (root.exceptionDetails || typeof root.result?.objectId !== "string") {
      result = { status: "unavailable", reason: "global_object_unavailable" };
    } else {
      const selectedResponse = await client.send("Runtime.callFunctionOn", {
        objectId: root.result.objectId,
        functionDeclaration: RUNTIME_PATH_INSPECTOR,
        arguments: [
          { value: path },
          { value: failureMarker },
          { value: includeSensitiveValues === true },
          { value: offset },
          { value: maxChars }
        ],
        objectGroup,
        returnByValue: false,
        generatePreview: false,
        awaitPromise: false,
        throwOnSideEffect: true,
        userGesture: false
      });
      const selectedRemote = selectedResponse.result;
      if (selectedResponse.exceptionDetails || !selectedRemote) {
        result = { status: "unavailable", reason: "inspection_rejected_or_unsupported" };
      } else if (selectedRemote.type === "string" && typeof selectedRemote.value === "string" && selectedRemote.value.startsWith(`${failureMarker}:`)) {
        const markerPayload = selectedRemote.value.slice(failureMarker.length + 1);
        const markerSeparator = markerPayload.indexOf(":");
        const status = markerSeparator < 0 ? markerPayload : markerPayload.slice(0, markerSeparator);
        const details = markerSeparator < 0 ? "" : markerPayload.slice(markerSeparator + 1);
        const [detailOne, detailTwo, detailThree] = details.split(":");
        if (status.startsWith("primitive_")) {
          const type = status === "primitive_oversize" || status === "primitive_string_chunk" ? "string" : detailOne;
          const selected = { kind: "primitive", type };
          if (status === "primitive_string_chunk") {
            let chunk;
            try { chunk = JSON.parse(details); }
            catch { chunk = null; }
            if (chunk && typeof chunk.value === "string" && Number.isSafeInteger(chunk.valueLength)
              && Number.isSafeInteger(chunk.valueOffset) && Number.isSafeInteger(chunk.nextOffset)
              && typeof chunk.valueComplete === "boolean") {
              selected.value = chunk.value;
              selected.valueLength = chunk.valueLength;
              selected.valueOffset = chunk.valueOffset;
              selected.valueComplete = chunk.valueComplete;
              selected.nextOffset = chunk.nextOffset;
              selected.valueChunked = !chunk.valueComplete || chunk.valueOffset > 0;
              result = { status: "available", selected };
            } else {
              result = { status: "unavailable", reason: "runtime_string_chunk_invalid" };
            }
          } else if (status === "primitive_oversize") {
            selected.valueRedacted = true;
            selected.valueLength = Number(detailOne);
            result = { status: "available", selected };
          } else {
            if (status === "primitive_redacted" && type !== "undefined") selected.valueRedacted = true;
            if (status === "primitive_unavailable") selected.valueUnavailable = true;
            result = { status: "available", selected };
          }
        } else {
          result = { status };
          if (detailOne !== undefined && Number.isInteger(Number(detailOne))) result.pathIndex = Number(detailOne);
          if (status === "parent_not_object" && detailTwo) result.type = detailTwo;
          if (status === "accessor_not_read") {
            if (detailTwo !== undefined) result.hasGetter = detailTwo === "true";
            if (detailThree !== undefined) result.hasSetter = detailThree === "true";
          }
        }
      } else if (typeof selectedRemote.objectId === "string") {
        const type = selectedRemote.type === "function" ? "function" : "object";
        result = { status: "available", selected: { kind: "object", type }, propertyEnumeration: "not_requested" };
      } else {
        const type = selectedRemote.subtype === "null" ? "null" : selectedRemote.type;
        const selected = { kind: "primitive", type };
        const rawValue = remotePrimitive(selectedRemote);
        const rawLength = typeof rawValue === "string" ? rawValue.length : undefined;
        const redacted = includeSensitiveValues !== true && type !== "undefined";
        const overLimit = typeof rawValue === "string" && rawLength > MAX_RUNTIME_VALUE_LENGTH;
        if (redacted || overLimit) selected.valueRedacted = true;
        if (overLimit) selected.valueLength = rawLength;
        if (!redacted && !overLimit && rawValue !== undefined && type !== "symbol") selected.value = rawValue;
        result = { status: "available", selected };
      }
    }
  } catch {
    // CDP versions and V8 values differ; page exceptions stay local and are not returned as tool text.
    result = { status: "unavailable", reason: "runtime_inspection_failed" };
  } finally {
    await client.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
  if (stored.evidence.documentGeneration !== observer.session.documentGeneration) {
    return { status: "stale", evidenceId: id, documentGeneration: stored.evidence.documentGeneration, currentDocumentGeneration: observer.session.documentGeneration };
  }
  const record = {
    id: randomUUID(),
    evidenceId: id,
    inspectedAt: new Date().toISOString(),
    documentGeneration: stored.evidence.documentGeneration,
    frameTargetId,
    path: [...path],
    sensitiveValuesIncluded: includeSensitiveValues === true,
    status: result.status,
    result
  };
  const retained = observer.evidenceStore.appendRuntimeRecord(id, record);
  return { ...structuredClone(record), retained };
}
