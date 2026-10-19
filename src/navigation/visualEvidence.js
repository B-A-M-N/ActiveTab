import { createHash } from "node:crypto";
import { describeJevImageTransform, jpegDimensions } from "../decisions/imagePreparation.js";

const MAX_SCREENSHOT_BYTES = 1_500_000;

/** Bind a retained screenshot to the exact browser observation it depicts. */
export function bindVisualEvidence(observation, retainedEvidence) {
  if (!observation?.evidenceId || !observation?.targetId
    || !Number.isInteger(observation.documentGeneration)
    || !validViewport(observation.viewport)
    || retainedEvidence?.status !== "available"
    || retainedEvidence.evidenceId !== observation.evidenceId
    || retainedEvidence.targetId !== observation.targetId
    || retainedEvidence.documentGeneration !== observation.documentGeneration
    || !sameViewport(retainedEvidence.viewport, observation.viewport)
    || retainedEvidence.coverage?.screenshot !== true
    || typeof retainedEvidence.screenshotBase64 !== "string"
    || !retainedEvidence.screenshotBase64) return null;

  const bytes = Buffer.from(retainedEvidence.screenshotBase64, "base64");
  const dimensions = jpegDimensions(bytes);
  if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES
    || bytes.toString("base64") !== retainedEvidence.screenshotBase64) return null;
  if (!dimensions || !describeJevImageTransform({ viewport: observation.viewport, image: dimensions })) return null;

  return Object.freeze({
    evidenceId: observation.evidenceId,
    targetId: observation.targetId,
    documentGeneration: observation.documentGeneration,
    viewport: Object.freeze({ width: observation.viewport.width, height: observation.viewport.height }),
    deviceScaleFactor: retainedEvidence.deviceScaleFactor ?? 1,
    screenshotBase64: retainedEvidence.screenshotBase64
  });
}

export function isBoundVisualEvidence(observation, imageEvidence) {
  return Boolean(observation?.evidenceId && observation?.targetId
    && Number.isInteger(observation.documentGeneration)
    && validViewport(observation.viewport)
    && imageEvidence?.evidenceId === observation.evidenceId
    && imageEvidence?.targetId === observation.targetId
    && imageEvidence?.documentGeneration === observation.documentGeneration
    && sameViewport(imageEvidence?.viewport, observation.viewport)
    && typeof imageEvidence.screenshotBase64 === "string"
    && imageEvidence.screenshotBase64.length > 0
    && Buffer.byteLength(imageEvidence.screenshotBase64, "ascii") <= Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3)
    && Buffer.from(imageEvidence.screenshotBase64, "base64").toString("base64") === imageEvidence.screenshotBase64
    && describeJevImageTransform({ viewport: imageEvidence.viewport, image: jpegDimensions(Buffer.from(imageEvidence.screenshotBase64, "base64")), deviceScaleFactor: imageEvidence.deviceScaleFactor ?? 1 }) !== null);
}

export function visualEvidenceProjection(imageEvidence) {
  if (!imageEvidence) return null;
  const bytes = Buffer.from(imageEvidence.screenshotBase64, "base64");
  const transform = describeJevImageTransform({ viewport: imageEvidence.viewport, image: jpegDimensions(bytes), deviceScaleFactor: imageEvidence.deviceScaleFactor ?? 1 });
  if (!transform) return null;
  const digest = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    evidenceId: imageEvidence.evidenceId,
    targetId: imageEvidence.targetId,
    documentGeneration: imageEvidence.documentGeneration,
    viewport: { width: imageEvidence.viewport.width, height: imageEvidence.viewport.height },
    ...(transform ? { transform } : {}),
    imageSha256: digest
  });
}

function validViewport(viewport) {
  return Boolean(viewport && Number.isInteger(viewport.width) && viewport.width >= 1 && viewport.width <= 16_384
    && Number.isInteger(viewport.height) && viewport.height >= 1 && viewport.height <= 16_384);
}

function sameViewport(left, right) {
  return validViewport(left) && validViewport(right)
    && left.width === right.width && left.height === right.height;
}
