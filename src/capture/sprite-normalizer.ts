import {
  CANONICAL_TORSO_LENGTH_PX,
  SPRITE_CANVAS_SIZE,
  THUMBNAIL_SIZE,
  type NormalizedLandmark,
  type PoseId,
} from "../shared/fighter-model";
import {
  computeNormalizationTransform,
  detectFacing,
  estimateBodyScale,
  flipLandmarksHorizontally,
  requiredFitScale,
  transformLandmarks,
  anchorTargetFor,
  type NormalizationTransform,
} from "../shared/pose-geometry";
import { canvasToPng, createCanvas, context2d, type AnyCanvas } from "../shared/canvas";

export interface SpritePlan {
  transform: NormalizationTransform;
  /** Landmarks in sprite-canvas pixels. */
  landmarks: NormalizedLandmark[];
  anchorPoint: { x: number; y: number };
  /** The person faced left and the frame was mirrored. */
  flipped: boolean;
}

/** MediaPipe gives 0..1 coordinates; convert to frame pixels. */
export function toPixelLandmarks(landmarks: NormalizedLandmark[], width: number, height: number): NormalizedLandmark[] {
  return landmarks.map((l) => ({ x: l.x * width, y: l.y * height, visibility: l.visibility }));
}

/**
 * Pure math for normalization: flip left-facing captures, scale to the canonical
 * torso length, and anchor the feet (or pelvis for jump) on the ground line.
 * `landmarks` are MediaPipe-normalized (0..1).
 */
export function planSpriteNormalization(
  landmarks: NormalizedLandmark[],
  poseId: PoseId,
  frameWidth: number,
  frameHeight: number,
  options: { fitScale?: number } = {},
): SpritePlan {
  const px = toPixelLandmarks(landmarks, frameWidth, frameHeight);
  const flipped = detectFacing(px) === "left";
  const transform = computeNormalizationTransform(px, poseId, frameWidth, { flip: flipped, fitScale: options.fitScale });
  return {
    transform,
    landmarks: transformLandmarks(transform, px),
    anchorPoint: anchorTargetFor(poseId),
    flipped,
  };
}

export interface PoseCaptureGeometry {
  /** Which pose this is (second versions share their main pose's anchor rules). */
  poseId: PoseId;
  /** MediaPipe-normalized (0..1). */
  landmarks: NormalizedLandmark[];
  frameWidth: number;
  frameHeight: number;
}

/**
 * One scale for the whole fighter. Each capture is sized by its own body-scale
 * estimate (which tracks camera distance, not pose), and the shrink needed to
 * fit the canvas is the largest any capture needs, applied to all of them, so
 * the fighter is the same size in every frame. Keyed by capture target.
 */
export function planFighterSprites(captures: Record<string, PoseCaptureGeometry>): Record<string, SpritePlan> {
  const entries = Object.entries(captures);
  let fitScale = 1;
  for (const [, c] of entries) {
    const px = toPixelLandmarks(c.landmarks, c.frameWidth, c.frameHeight);
    const faced = detectFacing(px) === "left" ? flipLandmarksHorizontally(px, c.frameWidth) : px;
    fitScale = Math.min(fitScale, requiredFitScale(faced, c.poseId, CANONICAL_TORSO_LENGTH_PX / estimateBodyScale(faced)));
  }
  return Object.fromEntries(
    entries.map(([key, c]) => [key, planSpriteNormalization(c.landmarks, c.poseId, c.frameWidth, c.frameHeight, { fitScale })]),
  );
}

/**
 * The person cut out of a frame: the crop around them with the matte applied
 * as alpha. Kept for the whole session so sprites can be re-rendered when the
 * fighter-wide scale changes.
 */
export interface MaskedCapture {
  image: AnyCanvas;
  /** Where the crop sits in the frame. */
  offsetX: number;
  offsetY: number;
}

/** A cut-out from a matte's crop-sized RGBA (colours already cleaned of background, alpha set). */
export function cutoutFromCrop(rgba: Uint8ClampedArray<ArrayBuffer>, crop: { x: number; y: number; width: number; height: number }): MaskedCapture {
  const canvas = createCanvas(crop.width, crop.height);
  context2d(canvas).putImageData(new ImageData(rgba, crop.width, crop.height), 0, 0);
  return { image: canvas, offsetX: crop.x, offsetY: crop.y };
}

/** Draw a cut-out into a 512×512 PNG using a sprite plan's transform. */
export async function renderSprite(capture: MaskedCapture, plan: SpritePlan): Promise<Blob> {
  const out = createCanvas(SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
  const ctx = context2d(out);
  const t = plan.transform;
  // x' = (flipped ? W - x : x) * s + tx, with x in frame pixels.
  ctx.setTransform(t.flipped ? -t.scale : t.scale, 0, 0, t.scale, t.flipped ? t.sourceWidth * t.scale + t.translateX : t.translateX, t.translateY);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(capture.image as CanvasImageSource, capture.offsetX, capture.offsetY);
  return canvasToPng(out);
}

/** Idle pose downscaled for the character select grid. */
export async function makeThumbnail(sprite: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(sprite);
  const canvas = createCanvas(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  bitmap.close();
  return canvasToPng(canvas);
}
