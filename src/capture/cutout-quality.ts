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
  /** Extremities outside the frame or missing from the cut-out ("edge": the body runs into the photo's border). */
  cutOff: string[];
  /** Which borders of the photo the body runs into (for "edge"), as the camera sees it. */
  edges: PhotoEdge[];
}

export type PhotoEdge = "left" | "right" | "top" | "bottom";

export const QUALITY_THRESHOLDS = { coreMissing: 0.08, marginFilled: 0.4, edgePixels: 0.15 } as const;

const OPAQUE = 128;
/** A landmark this confident is clearly seen: its bones and extremities are held to the cut-out. */
const CLEARLY_SEEN = 0.7;

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

  // Holes: the thin core around the bones is always body. Only bones MediaPipe clearly sees: a limb hidden
  // behind the body (the rear arm in a shoulder charge) gets a low-confidence guess that can land just off the
  // silhouette, and a hidden limb can't be missing from the cut-out.
  const seen = crop.map((l) => (l.visibility >= CLEARLY_SEEN ? l : { ...l, visibility: 0 }));
  const core = skeletonPrior(seen, width, height, { scale: CORE_SCALE, falloffScale: 0, extremities: false });
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
    if (l.visibility < CLEARLY_SEEN) continue;
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
  const onEdges = edgeOpaqueCounts(alpha, rect, frameWidth, frameHeight);
  const edge = Object.values(onEdges).reduce((a, b) => a + b, 0);
  const edges: PhotoEdge[] = [];
  if (edge > torso * QUALITY_THRESHOLDS.edgePixels) {
    if (!cutOff.length) cutOff.push("edge");
    // The borders with a real share of it, most first.
    for (const [side, count] of Object.entries(onEdges).sort((a, b) => b[1] - a[1])) if (count >= 0.2 * edge) edges.push(side as PhotoEdge);
  }

  const issues: CutoutIssue[] = [];
  if (coreMissing > QUALITY_THRESHOLDS.coreMissing) issues.push("holes");
  if (marginFilled > QUALITY_THRESHOLDS.marginFilled) issues.push("background");
  if (cutOff.length) issues.push("cutOff");
  return { issues, coreMissing, marginFilled, cutOff, edges };
}

/** Opaque crop pixels lying on each of the frame's borders. */
function edgeOpaqueCounts(alpha: ArrayLike<number>, rect: Rect, frameWidth: number, frameHeight: number): Record<PhotoEdge, number> {
  const { x: rx, y: ry, width, height } = rect;
  const counts: Record<PhotoEdge, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  const check = (side: PhotoEdge, x: number, y: number) => { if (alpha[y * width + x] >= OPAQUE) counts[side]++; };
  if (rx === 0) for (let y = 0; y < height; y++) check("left", 0, y);
  if (rx + width >= frameWidth) for (let y = 0; y < height; y++) check("right", width - 1, y);
  if (ry === 0) for (let x = 0; x < width; x++) check("top", x, 0);
  if (ry + height >= frameHeight) for (let x = 0; x < width; x++) check("bottom", x, height - 1);
  return counts;
}

/**
 * What to change for the next try, for the first issue (spoken: the player may
 * be across the room). Running into the photo's border says which way to go:
 * no left or right, since the preview may be mirrored.
 */
export function cutoutAdvice({ issues, cutOff, edges }: Pick<CutoutQuality, "issues" | "cutOff" | "edges">): string {
  if (issues[0] === "cutOff" && cutOff.includes("edge")) {
    if (edges[0] === "bottom") return "Step back a little: your feet touch the bottom of the picture.";
    if (edges[0] === "top") return "Step back a little: your head touches the top of the picture.";
    if (edges[0]) return "Move toward the middle of the picture: you're running off its side.";
  }
  const advice: Record<CutoutIssue, string> = {
    cutOff: "Keep all of you in the frame, hands and feet too.",
    background: "Step away from furniture, in front of a plain wall.",
    holes: "Get more light on you, in clothes that stand out from the wall.",
  };
  return issues.length ? advice[issues[0]] : "";
}

/** Short reason for the "didn't cut out cleanly" prompt. */
export function describeCutoutIssues(issues: CutoutIssue[]): string {
  const parts: Record<CutoutIssue, string> = {
    holes: "bits of you are missing",
    background: "some background came along",
    cutOff: "part of you is cut off",
  };
  return issues.map((i) => parts[i]).join(", ");
}
