import { LANDMARK, type NormalizedLandmark } from "../shared/fighter-model";
import { torsoLength } from "../shared/pose-geometry";
import { STICK_SEGMENTS, headCenter } from "../shared/stick-figure";
import type { Rect } from "../shared/canvas";

/**
 * Person matting for full-body captures. The matting model (ISNet, see
 * background-remover.ts) does the real work; this file holds the pure parts
 * around it, testable without a DOM:
 *
 *   crop around the skeleton (so the person fills the model's input)
 *   → model input tensor → model output → alpha at crop size
 *   → keep only what's connected to the skeleton (drops furniture, other people).
 */

export type { Rect };

const VISIBLE = 0.3;

/** The crop's margins around the landmarks, in torso lengths. */
export interface CropMargins { side: number; top: number; bottom: number }

export const CROP_MARGINS: CropMargins = { side: 0.6, top: 0.8, bottom: 0.35 };

/** Region around the person: landmark bounds plus margins in torso lengths (more above for hair). */
export function personCropRect(landmarksPx: NormalizedLandmark[], frameWidth: number, frameHeight: number, margins: CropMargins = CROP_MARGINS): Rect {
  const visible = landmarksPx.filter((l) => l.visibility >= VISIBLE);
  const pts = visible.length ? visible : landmarksPx;
  const torso = torsoLength(landmarksPx) || Math.max(frameWidth, frameHeight) / 6;
  const minX = Math.min(...pts.map((p) => p.x)) - margins.side * torso;
  const maxX = Math.max(...pts.map((p) => p.x)) + margins.side * torso;
  const minY = Math.min(...pts.map((p) => p.y)) - margins.top * torso;
  const maxY = Math.max(...pts.map((p) => p.y)) + margins.bottom * torso;
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  return {
    x,
    y,
    width: Math.max(1, Math.min(frameWidth, Math.ceil(maxX)) - x),
    height: Math.max(1, Math.min(frameHeight, Math.ceil(maxY)) - y),
  };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 1 near the skeleton, falling to 0 a margin away. Limbs are capsules sized from
 * the torso length (generous: baggy clothes and hair must survive); the torso
 * and head get wider ones. Landmarks are in crop pixels.
 */
export function skeletonPrior(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  options: { scale?: number; falloffScale?: number; extremities?: boolean } = {},
): Float32Array {
  const { scale = 1, falloffScale = 1, extremities = true } = options;
  const torso = (torsoLength(landmarks) || Math.max(width, height) / 4) * scale;
  const shapes: { ax: number; ay: number; bx: number; by: number; r: number }[] = [];
  const l = (i: number) => landmarks[i];
  for (const [a, b] of STICK_SEGMENTS) {
    if (l(a).visibility < VISIBLE || l(b).visibility < VISIBLE) continue;
    shapes.push({ ax: l(a).x, ay: l(a).y, bx: l(b).x, by: l(b).y, r: 0.35 * torso });
  }
  const sh = { x: (l(LANDMARK.leftShoulder).x + l(LANDMARK.rightShoulder).x) / 2, y: (l(LANDMARK.leftShoulder).y + l(LANDMARK.rightShoulder).y) / 2 };
  const hp = { x: (l(LANDMARK.leftHip).x + l(LANDMARK.rightHip).x) / 2, y: (l(LANDMARK.leftHip).y + l(LANDMARK.rightHip).y) / 2 };
  shapes.push({ ax: sh.x, ay: sh.y, bx: hp.x, by: hp.y, r: 0.55 * torso });
  const head = headCenter(landmarks);
  shapes.push({ ax: head.x, ay: head.y, bx: sh.x, by: sh.y, r: 0.5 * torso });
  // Hands and feet extend past wrists/ankles.
  for (const [a, b] of !extremities ? [] :  [[LANDMARK.leftElbow, LANDMARK.leftWrist], [LANDMARK.rightElbow, LANDMARK.rightWrist], [LANDMARK.leftKnee, LANDMARK.leftAnkle], [LANDMARK.rightKnee, LANDMARK.rightAnkle]]) {
    if (l(a).visibility < VISIBLE || l(b).visibility < VISIBLE) continue;
    const ex = l(b).x + (l(b).x - l(a).x) * 0.45;
    const ey = l(b).y + (l(b).y - l(a).y) * 0.45;
    shapes.push({ ax: l(b).x, ay: l(b).y, bx: ex, by: ey, r: 0.3 * torso });
  }
  const falloff = 0.3 * torso * falloffScale;
  const out = new Float32Array(width * height);
  for (const s of shapes) {
    const reach = s.r + falloff;
    const x0 = Math.max(0, Math.floor(Math.min(s.ax, s.bx) - reach));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(s.ax, s.bx) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(s.ay, s.by) - reach));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(s.ay, s.by) + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = segmentDistance(x + 0.5, y + 0.5, s.ax, s.ay, s.bx, s.by);
        const v = d <= s.r ? 1 : Math.max(0, 1 - (d - s.r) / falloff);
        const i = y * width + x;
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

/**
 * Width of the always-person core around the bones, as a scale of the prior's
 * capsules: well inside any real limb (radius ~0.04 torso lengths; a forearm is
 * ~0.07 half-wide), so MediaPipe's few pixels of joint error and the cut-out's
 * soft edge don't read as holes. cutout-quality.ts checks it's opaque. At 0.25
 * it was wider than a forearm, and about half of perfect cut-outs with normal
 * joint error failed the holes check.
 */
export const CORE_SCALE = 0.12;

/** Flood fill from seed pixels over set pixels; everything not reached is cleared. */
export function keepConnected(mask: Uint8Array, width: number, _height: number, seeds: number[]): Uint8Array {
  const out = new Uint8Array(mask.length);
  const stack: number[] = seeds.filter((i) => i >= 0 && i < mask.length && mask[i]);
  for (const i of stack) out[i] = 1;
  // Millions of pixels per capture: no per-pixel allocations.
  const visit = (n: number) => {
    if (mask[n] && !out[n]) {
      out[n] = 1;
      stack.push(n);
    }
  };
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < mask.length) visit(i + width);
  }
  return out;
}

/**
 * Soft alpha at or above this joins a region when deciding what's attached to
 * the body: low, so hair and soft edges stay connected to the person.
 */
export const REGION_ALPHA = 0.1;

/** Pixel indices along the visible bones, where the person certainly is. */
export function skeletonSeeds(landmarks: NormalizedLandmark[], width: number, height: number): number[] {
  const seeds: number[] = [];
  for (const [a, b] of STICK_SEGMENTS) {
    const p = landmarks[a], q = landmarks[b];
    if (p.visibility < VISIBLE || q.visibility < VISIBLE) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(p.x + ((q.x - p.x) * s) / steps), y = Math.round(p.y + ((q.y - p.y) * s) / steps);
      if (x >= 0 && y >= 0 && x < width && y < height) seeds.push(y * width + x);
    }
  }
  return seeds;
}

/**
 * The model's alpha (0..1, crop-sized) as bytes, keeping only regions
 * connected to the skeleton. Landmarks are in crop pixels.
 */
export function keepPerson(alpha: Float32Array, width: number, height: number, landmarks: NormalizedLandmark[], regionAlpha = REGION_ALPHA): Uint8ClampedArray {
  const region = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) region[i] = alpha[i] >= regionAlpha ? 1 : 0;
  let kept = keepConnected(region, width, height, skeletonSeeds(landmarks, width, height));
  if (!kept.includes(1)) kept = region; // the landmarks missed the matte entirely: trust the model
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) if (kept[i]) out[i] = Math.round(alpha[i] * 255);
  return out;
}

/** Square input side of the matting model. */
export const MODEL_SIZE = 1024;

/** RGBA (already resized to size × size) → planar RGB in -0.5..0.5, ISNet's input tensor. */
export function toModelInput(rgba: ArrayLike<number>, size = MODEL_SIZE): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = rgba[i * 4 + c] / 255 - 0.5;
  }
  return out;
}

/**
 * ISNet's output stretched to the full 0..1 range, as its reference code does:
 * its raw maximum sits a little under 1, which would leave the body faintly see-through.
 */
export function stretchToUnit(values: ArrayLike<number>): Float32Array {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Float32Array(values.length);
  const range = max - min;
  if (range > 0) for (let i = 0; i < values.length; i++) out[i] = (values[i] - min) / range;
  return out;
}

/** Bilinear resample of a float mask. */
export function resampleFloat(src: Float32Array, width: number, height: number, toWidth: number, toHeight: number): Float32Array {
  if (width === toWidth && height === toHeight) return src;
  const out = new Float32Array(toWidth * toHeight);
  for (let y = 0; y < toHeight; y++) {
    const fy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / toHeight - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < toWidth; x++) {
      const fx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / toWidth - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0;
      const top = src[y0 * width + x0] * (1 - tx) + src[y0 * width + x1] * tx;
      const bottom = src[y1 * width + x0] * (1 - tx) + src[y1 * width + x1] * tx;
      out[y * toWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** The crop's colours with `alpha` as their alpha channel: the cut-out. */
export function applyAlpha(rgba: Uint8ClampedArray, alpha: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i];
  return out;
}
