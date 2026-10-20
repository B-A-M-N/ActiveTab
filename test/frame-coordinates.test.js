import test from "node:test";
import assert from "node:assert/strict";
import { mapFrameRectToParent, mapPointFromParentToFrame } from "../src/observe/frameCoordinates.js";

test("frame coordinate mapping round-trips points through a translated and scaled owner quad", () => {
  const frame = {
    viewport: { width: 300, height: 150 },
    ownerContentQuad: [100, 50, 400, 50, 400, 200, 100, 200]
  };
  const localPoint = { x: 125, y: 75 };
  const parentPoint = {
    x: frame.ownerContentQuad[0] + localPoint.x,
    y: frame.ownerContentQuad[1] + localPoint.y
  };

  assert.deepEqual(mapPointFromParentToFrame(parentPoint, frame), localPoint);
  assert.deepEqual(mapFrameRectToParent({ x: 20, y: 30, width: 40, height: 10 }, frame), {
    x: 120, y: 80, width: 40, height: 10
  });
});

test("frame coordinate mapping handles an affine rotation and rejects invalid owner geometry", () => {
  const frame = {
    viewport: { width: 100, height: 100 },
    ownerContentQuad: [10, 20, 10, 120, -90, 120, -90, 20]
  };
  const local = { x: 20, y: 40 };
  const parent = { x: 10 - 40, y: 20 + 20 };

  assert.deepEqual(mapPointFromParentToFrame(parent, frame), local);
  assert.equal(mapPointFromParentToFrame({ x: 900, y: 900 }, frame), null);
  assert.equal(mapFrameRectToParent({ x: 0, y: 0, width: 1, height: 1 }, {
    ...frame,
    ownerContentQuad: [0, 0, 1, 1, 5, 5, 0, 1]
  }), null);
});
