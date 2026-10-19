export const JEV_IMAGE_PREPARATION_VERSION = "jev_image_preparation_v1";
export const JEV_IMAGE_LIMITS = Object.freeze({
  minSide: 280,
  maxSide: 1_568,
  minPixels: 78_400,
  maxPixels: 2_458_624
});

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function jpegDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if ([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

/** Compute a full-viewport CDP screenshot scale. Small source viewports are never upscaled. */
export function planJevImagePreparation({ width, height } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image preparation requires positive integer viewport dimensions.");
  }
  if (width < JEV_IMAGE_LIMITS.minSide || height < JEV_IMAGE_LIMITS.minSide) {
    return Object.freeze({ status: "unavailable", reasonCode: "below_minimum_dimension", scale: 1, width, height });
  }
  const scale = Math.min(
    1,
    JEV_IMAGE_LIMITS.maxSide / width,
    JEV_IMAGE_LIMITS.maxSide / height,
    Math.sqrt(JEV_IMAGE_LIMITS.maxPixels / (width * height))
  );
  const outputWidth = Math.max(1, Math.floor(width * scale));
  const outputHeight = Math.max(1, Math.floor(height * scale));
  if (outputWidth < JEV_IMAGE_LIMITS.minSide || outputHeight < JEV_IMAGE_LIMITS.minSide
    || outputWidth * outputHeight < JEV_IMAGE_LIMITS.minPixels) {
    return Object.freeze({ status: "unavailable", reasonCode: "below_minimum_dimension_after_scaling", scale, width, height, outputWidth, outputHeight });
  }
  return Object.freeze({ status: "ready", scale, width, height, outputWidth, outputHeight });
}

/** Describe the pixel-to-viewport mapping from the actual encoded JPEG dimensions. */
export function describeJevImageTransform({ viewport, image, deviceScaleFactor = 1 } = {}) {
  if (!validDimensions(viewport) || !validDimensions(image)) return null;
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 8) return null;
  return Object.freeze({
    version: JEV_IMAGE_PREPARATION_VERSION,
    sourceWidth: viewport.width,
    sourceHeight: viewport.height,
    sourceDeviceScaleFactor: deviceScaleFactor,
    sourcePixelWidth: Math.round(viewport.width * deviceScaleFactor),
    sourcePixelHeight: Math.round(viewport.height * deviceScaleFactor),
    imageWidth: image.width,
    imageHeight: image.height,
    scaleX: image.width / viewport.width,
    scaleY: image.height / viewport.height,
    crop: Object.freeze({ x: 0, y: 0, width: viewport.width, height: viewport.height })
  });
}

export function isJevImageSizeSupported(image) {
  return validDimensions(image)
    && image.width >= JEV_IMAGE_LIMITS.minSide
    && image.height >= JEV_IMAGE_LIMITS.minSide
    && image.width <= JEV_IMAGE_LIMITS.maxSide
    && image.height <= JEV_IMAGE_LIMITS.maxSide
    && image.width * image.height >= JEV_IMAGE_LIMITS.minPixels
    && image.width * image.height <= JEV_IMAGE_LIMITS.maxPixels;
}

function validDimensions(value) {
  return Boolean(value && Number.isInteger(value.width) && value.width > 0 && value.width <= 16_384
    && Number.isInteger(value.height) && value.height > 0 && value.height <= 16_384);
}
