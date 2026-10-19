import { describeJevImageTransform, jpegDimensions } from "../decisions/imagePreparation.js";
import { isBoundVisualEvidence } from "./visualEvidence.js";

const MIN_PRESENCE_PROBABILITY = 0.8;
const MIN_BOX_CONFIDENCE = 0.7;
const MIN_CANDIDATE_COVERAGE = 0.75;
const MIN_BOX_IOU = 0.2;
const MIN_RUNNER_UP_MARGIN = 0.18;

/**
 * Match an advisory Jev Noul + Box prediction to exactly one fresh DOM/AX
 * candidate. This function has no browser handle and never dispatches input.
 */
export function groundVisualTarget({ observation, imageEvidence, answers, allowedCandidateIds = null } = {}) {
  if (!observation?.evidenceId || !observation?.targetId || !Number.isSafeInteger(observation?.documentGeneration)
    || !isBoundVisualEvidence(observation, imageEvidence)) {
    return unavailable("stale_or_unbound_visual_evidence");
  }
  const presence = answers?.target_present;
  const boxAnswer = answers?.target_box;
  if (presence?.type !== "noul" || !Number.isFinite(presence.probabilityYes)
    || presence.probabilityYes < MIN_PRESENCE_PROBABILITY) {
    return unavailable("target_not_confirmed_present", { presenceProbability: presence?.probabilityYes ?? null });
  }
  if (boxAnswer?.type !== "box" || !Number.isFinite(boxAnswer.confidence)
    || boxAnswer.confidence < MIN_BOX_CONFIDENCE || !validNormalizedBox(boxAnswer.box)) {
    return unavailable("target_box_not_confident", { presenceProbability: presence.probabilityYes, boxConfidence: boxAnswer?.confidence ?? null });
  }

  const bytes = Buffer.from(imageEvidence.screenshotBase64, "base64");
  const dimensions = jpegDimensions(bytes);
  const transform = describeJevImageTransform({
    viewport: imageEvidence.viewport,
    image: dimensions,
    deviceScaleFactor: imageEvidence.deviceScaleFactor ?? 1
  });
  if (!transform) return unavailable("image_transform_unavailable");
  const sourceBox = normalizedBoxToSource(boxAnswer.box, transform);
  if (!validPixelBox(sourceBox, imageEvidence.viewport)) return unavailable("target_box_outside_viewport");

  const allowed = allowedCandidateIds === null ? null : new Set(allowedCandidateIds);
  const candidates = (observation.candidates ?? []).filter(candidate => {
    if (!candidate || candidate.visible !== true || candidate.disabled === true
      || candidate.targetId !== observation.targetId
      || candidate.documentGeneration !== observation.documentGeneration
      || typeof candidate.identity !== "string" || !candidate.identity
      || (allowed && !allowed.has(candidate.identity))) return false;
    return validRect(candidate.bounds);
  });
  const mappedCandidates = candidates.map(candidate => ({
    candidate,
    rootBounds: mapCandidateBoundsToRoot(candidate, observation)
  })).filter(item => item.rootBounds);
  if (mappedCandidates.length === 0) {
    const hasCrossFrame = (observation.candidates ?? []).some(candidate => candidate?.visible === true && candidate?.frameTargetId);
    return unavailable(hasCrossFrame ? "cross_frame_bounds_unmapped" : "no_fresh_visible_candidates", {
      presenceProbability: presence.probabilityYes,
      boxConfidence: boxAnswer.confidence,
      sourceBox
    });
  }

  const ranked = mappedCandidates.map(({ candidate, rootBounds }) => {
    const clipped = clipRect(rootBounds, imageEvidence.viewport);
    const overlap = overlapMetrics(sourceBox, clipped);
    return { candidate, rootBounds, ...overlap };
  }).filter(item => item.coverage >= MIN_CANDIDATE_COVERAGE && item.iou >= MIN_BOX_IOU)
    .sort((left, right) => right.coverage - left.coverage || right.iou - left.iou);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (!winner || (runnerUp && winner.coverage - runnerUp.coverage < MIN_RUNNER_UP_MARGIN)) {
    return unavailable(runnerUp ? "multiple_candidates_match_box" : "box_does_not_match_candidate", {
      presenceProbability: presence.probabilityYes,
      boxConfidence: boxAnswer.confidence,
      sourceBox,
      matchingCandidateCount: ranked.length
    });
  }

  return Object.freeze({
    status: "grounded",
    candidate: candidateIdentity(winner.candidate),
    evidence: Object.freeze({
      evidenceId: observation.evidenceId,
      targetId: observation.targetId,
      documentGeneration: observation.documentGeneration,
      frameTargetId: winner.candidate.frameTargetId ?? null,
      imageTransformVersion: transform.version,
      sourceBox: Object.freeze(sourceBox),
      candidateRootBounds: Object.freeze({ ...winner.rootBounds })
    }),
    scores: Object.freeze({
      presenceProbability: presence.probabilityYes,
      boxConfidence: boxAnswer.confidence,
      candidateCoverage: winner.coverage,
      boxIoU: winner.iou,
      runnerUpCoverage: runnerUp?.coverage ?? null
    }),
    advisoryOnly: true,
    requiresFreshResolutionBeforeDispatch: true,
    authorizesOperation: false
  });
}

/** Re-resolve the proposed identity after inference against a fresh observation. */
export function revalidateVisualGrounding(grounding, observation) {
  if (grounding?.status !== "grounded" || !observation?.evidenceId
    || observation.targetId !== grounding.evidence.targetId
    || observation.documentGeneration !== grounding.evidence.documentGeneration
    || !validViewport(observation.viewport)) return null;
  const candidate = (observation.candidates ?? []).find(item => item?.identity === grounding.candidate.identity);
  if (!candidate || candidate.targetId !== observation.targetId
    || candidate.documentGeneration !== observation.documentGeneration
    || (candidate.frameTargetId ?? null) !== (grounding.candidate.frameTargetId ?? null)
    || candidate.visible !== true || candidate.disabled === true
    || candidate.tag !== grounding.candidate.tag || candidate.role !== grounding.candidate.role
    || !validRect(candidate.bounds)) return null;
  const rootBounds = mapCandidateBoundsToRoot(candidate, observation);
  if (!rootBounds) return null;
  const clipped = clipRect(rootBounds, observation.viewport);
  const overlap = overlapMetrics(grounding.evidence.sourceBox, clipped);
  if (overlap.coverage < MIN_CANDIDATE_COVERAGE || overlap.iou < MIN_BOX_IOU) return null;
  return candidate;
}

/** Map a candidate's frame-local bounds through captured iframe owner geometry. */
export function mapCandidateBoundsToRoot(candidate, observation) {
  if (!candidate?.frameTargetId) return validRect(candidate?.bounds) ? { ...candidate.bounds } : null;
  const frames = new Map((observation?.outOfProcessFrameGeometry ?? [])
    .filter(frame => frame?.status === "available" && typeof frame.frameTargetId === "string")
    .map(frame => [frame.frameTargetId, frame]));
  let frame = frames.get(candidate.frameTargetId);
  if (!frame) return null;
  let bounds = { ...candidate.bounds };
  for (let depth = 0; depth < 8; depth++) {
    bounds = mapThroughFrameOwner(bounds, frame);
    if (!bounds) return null;
    if (frame.parentTargetId === null) return bounds;
    frame = frames.get(frame.parentTargetId);
    if (!frame) return null;
  }
  return null;
}

function mapThroughFrameOwner(bounds, frame) {
  const viewport = frame.viewport;
  const quad = frame.ownerContentQuad;
  if (!validRect(bounds) || !Number.isFinite(viewport?.width) || viewport.width <= 0
    || !Number.isFinite(viewport?.height) || viewport.height <= 0
    || !Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) return null;
  const p1 = { x: quad[0], y: quad[1] };
  const p2 = { x: quad[2], y: quad[3] };
  const p3 = { x: quad[4], y: quad[5] };
  const p4 = { x: quad[6], y: quad[7] };
  const expectedP3 = { x: p2.x + p4.x - p1.x, y: p2.y + p4.y - p1.y };
  if (Math.hypot(p3.x - expectedP3.x, p3.y - expectedP3.y) > 2) return null;
  const mapPoint = (x, y) => ({
    x: p1.x + (p2.x - p1.x) * x / viewport.width + (p4.x - p1.x) * y / viewport.height,
    y: p1.y + (p2.y - p1.y) * x / viewport.width + (p4.y - p1.y) * y / viewport.height
  });
  const points = [
    mapPoint(bounds.x, bounds.y),
    mapPoint(bounds.x + bounds.width, bounds.y),
    mapPoint(bounds.x + bounds.width, bounds.y + bounds.height),
    mapPoint(bounds.x, bounds.y + bounds.height)
  ];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const mapped = { x: left, y: top, width: right - left, height: bottom - top };
  return validRect(mapped) ? mapped : null;
}

function normalizedBoxToSource(box, transform) {
  const { crop, imageWidth, imageHeight, scaleX, scaleY } = transform;
  return {
    left: crop.x + box.left * imageWidth / scaleX,
    top: crop.y + box.top * imageHeight / scaleY,
    right: crop.x + box.right * imageWidth / scaleX,
    bottom: crop.y + box.bottom * imageHeight / scaleY
  };
}

function overlapMetrics(box, rect) {
  if (!validPixelBox(box) || !validRect(rect)) return { coverage: 0, iou: 0 };
  const left = Math.max(box.left, rect.x);
  const top = Math.max(box.top, rect.y);
  const right = Math.min(box.right, rect.x + rect.width);
  const bottom = Math.min(box.bottom, rect.y + rect.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const boxArea = (box.right - box.left) * (box.bottom - box.top);
  const candidateArea = rect.width * rect.height;
  const union = boxArea + candidateArea - intersection;
  return {
    coverage: candidateArea ? intersection / candidateArea : 0,
    iou: union ? intersection / union : 0
  };
}

function clipRect(rect, viewport = null) {
  const width = viewport?.width ?? Number.MAX_SAFE_INTEGER;
  const height = viewport?.height ?? Number.MAX_SAFE_INTEGER;
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function validRect(rect) {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0);
}

function validViewport(viewport) {
  return Boolean(viewport && Number.isInteger(viewport.width) && viewport.width > 0 && viewport.width <= 16_384
    && Number.isInteger(viewport.height) && viewport.height > 0 && viewport.height <= 16_384);
}

function validPixelBox(box, viewport = null) {
  if (!box || ![box.left, box.top, box.right, box.bottom].every(Number.isFinite)
    || box.left < 0 || box.top < 0 || !(box.left < box.right) || !(box.top < box.bottom)) return false;
  return !viewport || (box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1);
}

function validNormalizedBox(box) {
  return Boolean(box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite)
    && box.left >= 0 && box.top >= 0 && box.right <= 1 && box.bottom <= 1
    && box.left < box.right && box.top < box.bottom);
}

function candidateIdentity(candidate) {
  return Object.freeze({
    identity: candidate.identity,
    targetId: candidate.targetId,
    documentGeneration: candidate.documentGeneration,
    frameTargetId: candidate.frameTargetId ?? null,
    backendNodeId: candidate.backendNodeId ?? null,
    tag: candidate.tag,
    role: candidate.role,
    name: candidate.name ?? "",
    bounds: Object.freeze({ ...candidate.bounds })
  });
}

function unavailable(reasonCode, details = {}) {
  return Object.freeze({
    status: "unavailable",
    reasonCode,
    ...details,
    advisoryOnly: true,
    requiresFreshResolutionBeforeDispatch: true,
    authorizesOperation: false
  });
}
