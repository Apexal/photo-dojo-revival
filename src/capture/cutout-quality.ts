import { LANDMARK, type NormalizedLandmark } from "../shared/fighter-model";
import { torsoLength } from "../shared/pose-geometry";
import { CORE_SCALE, skeletonPrior, type Rect } from "./matting";

/**
 * A quick check of a fresh cut-out, so a rough one can be retaken on the spot
 * instead of being discovered in the review strip. Pure, on the matte's crop.
 */

export type CutoutIssue = "holes" | "background" | "cutOff";

export interface CutoutQualityInput {
  /** Crop alpha (0..255). */
  alpha: ArrayLike<number>;
  rect: Rect;
  frameWidth: number;
  frameHeight: number;
  /** Landmarks in frame pixels. */
  landmarks: NormalizedLandmark[];
}

export interface CutoutQuality {
  issues: CutoutIssue[];
  /** Fraction of the body's core that's transparent. */
  coreMissing: number;
  /** Fraction of the margin around the body (where only background should be) that's opaque. */
  marginFilled: number;
  /** Extremities outside the frame or missing from the cut-out. */
  cutOff: string[];
}

export const QUALITY_THRESHOLDS = { coreMissing: 0.08, marginFilled: 0.4, edgePixels: 0.15 } as const;

const OPAQUE = 128;

const EXTREMITIES: [string, number][] = [
  ["head", LANDMARK.nose],
  ["left hand", LANDMARK.leftWrist],
  ["right hand", LANDMARK.rightWrist],
  ["left foot", LANDMARK.leftAnkle],
  ["right foot", LANDMARK.rightAnkle],
];

export function assessCutout(input: CutoutQualityInput): CutoutQuality {
  const { alpha, rect, frameWidth, frameHeight } = input;
  const { width, height } = rect;
  const crop = input.landmarks.map((l) => ({ ...l, x: l.x - rect.x, y: l.y - rect.y }));
  const torso = torsoLength(crop) || height / 4;

  // Holes: the thin core around the bones is always body.
  const core = skeletonPrior(crop, width, height, { scale: CORE_SCALE, falloffScale: 0, extremities: false });
  let coreTotal = 0, coreHoles = 0;
  // Background: the outer margin of the skeleton prior is wider than any real limb; a cut-out that fills it dragged the wall along.
  const prior = skeletonPrior(crop, width, height);
  let marginTotal = 0, marginOpaque = 0;
  for (let i = 0; i < width * height; i++) {
    const opaque = alpha[i] >= OPAQUE;
    if (core[i] >= 1) {
      coreTotal++;
      if (!opaque) coreHoles++;
    } else if (prior[i] >= 0.5 && prior[i] < 0.95) {
      marginTotal++;
      if (opaque) marginOpaque++;
    }
  }
  const coreMissing = coreTotal ? coreHoles / coreTotal : 0;
  const marginFilled = marginTotal ? marginOpaque / marginTotal : 0;

  // Cut off: an extremity outside the frame, or clearly seen but not in the cut-out.
  const cutOff: string[] = [];
  const radius = Math.max(2, Math.round(torso * 0.12));
  for (const [name, index] of EXTREMITIES) {
    const l = input.landmarks[index];
    const isHand = name.endsWith("hand");
    if (!isHand || l.visibility >= 0.3) {
      if (l.x < 0 || l.y < 0 || l.x >= frameWidth || l.y >= frameHeight) {
        cutOff.push(name);
        continue;
      }
    }
    if (l.visibility < 0.7) continue;
    const cx = Math.round(l.x - rect.x), cy = Math.round(l.y - rect.y);
    let found = false;
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius) && !found; y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
        if (alpha[y * width + x] >= OPAQUE) { found = true; break; }
      }
    }
    if (!found) cutOff.push(name);
  }
  // The person runs off the edge of the photo.
  const edge = edgeOpaqueCount(alpha, rect, frameWidth, frameHeight);
  if (edge > torso * QUALITY_THRESHOLDS.edgePixels && !cutOff.length) cutOff.push("edge");

  const issues: CutoutIssue[] = [];
  if (coreMissing > QUALITY_THRESHOLDS.coreMissing) issues.push("holes");
  if (marginFilled > QUALITY_THRESHOLDS.marginFilled) issues.push("background");
  if (cutOff.length) issues.push("cutOff");
  return { issues, coreMissing, marginFilled, cutOff };
}

/** Opaque crop pixels lying on the frame's border. */
function edgeOpaqueCount(alpha: ArrayLike<number>, rect: Rect, frameWidth: number, frameHeight: number): number {
  const { x: rx, y: ry, width, height } = rect;
  let count = 0;
  const check = (x: number, y: number) => { if (alpha[y * width + x] >= OPAQUE) count++; };
  if (rx === 0) for (let y = 0; y < height; y++) check(0, y);
  if (rx + width >= frameWidth) for (let y = 0; y < height; y++) check(width - 1, y);
  if (ry === 0) for (let x = 0; x < width; x++) check(x, 0);
  if (ry + height >= frameHeight) for (let x = 0; x < width; x++) check(x, height - 1);
  return count;
}

/** Short reason for the "came out rough" prompt. */
export function describeCutoutIssues(issues: CutoutIssue[]): string {
  const parts: Record<CutoutIssue, string> = {
    holes: "bits of you are missing",
    background: "some background came along",
    cutOff: "part of you is cut off",
  };
  return issues.map((i) => parts[i]).join(", ");
}
