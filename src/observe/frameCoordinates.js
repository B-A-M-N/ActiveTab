const QUAD_TOLERANCE = 2;

function frameTransform(frame) {
  const viewport = frame?.viewport;
  const quad = frame?.ownerContentQuad;
  if (!Number.isFinite(viewport?.width) || viewport.width <= 0
    || !Number.isFinite(viewport?.height) || viewport.height <= 0
    || !Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) return null;
  const origin = { x: quad[0], y: quad[1] };
  const horizontal = { x: quad[2] - origin.x, y: quad[3] - origin.y };
  const vertical = { x: quad[6] - origin.x, y: quad[7] - origin.y };
  const expectedFourth = { x: quad[2] + quad[6] - origin.x, y: quad[3] + quad[7] - origin.y };
  if (Math.hypot(quad[4] - expectedFourth.x, quad[5] - expectedFourth.y) > QUAD_TOLERANCE) return null;
  const determinant = horizontal.x * vertical.y - horizontal.y * vertical.x;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.001) return null;
  return { viewport, origin, horizontal, vertical, determinant };
}

/** Map a frame-local rectangle into its parent's CSS coordinate space. */
export function mapFrameRectToParent(bounds, frame) {
  const transform = frameTransform(frame);
  if (!transform || ![bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)
    || bounds.width < 0 || bounds.height < 0) return null;
  const mapPoint = (x, y) => ({
    x: transform.origin.x + transform.horizontal.x * x / transform.viewport.width + transform.vertical.x * y / transform.viewport.height,
    y: transform.origin.y + transform.horizontal.y * x / transform.viewport.width + transform.vertical.y * y / transform.viewport.height
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
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Invert a captured iframe owner quad for one point in the parent's viewport. */
export function mapPointFromParentToFrame(point, frame) {
  const transform = frameTransform(frame);
  if (!transform || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const delta = { x: point.x - transform.origin.x, y: point.y - transform.origin.y };
  const horizontalFraction = (delta.x * transform.vertical.y - delta.y * transform.vertical.x) / transform.determinant;
  const verticalFraction = (transform.horizontal.x * delta.y - transform.horizontal.y * delta.x) / transform.determinant;
  const x = horizontalFraction * transform.viewport.width;
  const y = verticalFraction * transform.viewport.height;
  if (x < -QUAD_TOLERANCE || y < -QUAD_TOLERANCE
    || x > transform.viewport.width + QUAD_TOLERANCE
    || y > transform.viewport.height + QUAD_TOLERANCE) return null;
  return {
    x: Math.max(0, Math.min(transform.viewport.width, x)),
    y: Math.max(0, Math.min(transform.viewport.height, y))
  };
}
