import { LANDMARK, type NormalizedLandmark } from "../shared/fighter-model";
import { torsoLength } from "../shared/pose-geometry";
import { STICK_SEGMENTS } from "../shared/stick-figure";
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
  /** With "holes": the part most of them are in (a leg lost against a wall of the same colour), for the advice. */
  holesIn: BodyPart | null;
}

export type PhotoEdge = "left" | "right" | "top" | "bottom";
/** No left or right: the preview may be mirrored. */
export type BodyPart = "leg" | "arm" | "body";

const LEG_JOINTS: readonly number[] = [LANDMARK.leftKnee, LANDMARK.rightKnee, LANDMARK.leftAnkle, LANDMARK.rightAnkle, LANDMARK.leftFootIndex, LANDMARK.rightFootIndex];
const ARM_JOINTS: readonly number[] = [LANDMARK.leftElbow, LANDMARK.rightElbow, LANDMARK.leftWrist, LANDMARK.rightWrist];
const partOf = ([, b]: readonly [number, number]): BodyPart => (LEG_JOINTS.includes(b) ? "leg" : ARM_JOINTS.includes(b) ? "arm" : "body");

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
  return { issues, coreMissing, marginFilled, cutOff, edges, holesIn: issues.includes("holes") ? mostMissing(alpha, width, height, seen) : null };
}

/** The part whose clearly seen bones are most transparent along their length (crop landmarks; null without any). */
function mostMissing(alpha: ArrayLike<number>, width: number, height: number, seen: NormalizedLandmark[]): BodyPart | null {
  const total: Record<BodyPart, number> = { leg: 0, arm: 0, body: 0 };
  const missing: Record<BodyPart, number> = { leg: 0, arm: 0, body: 0 };
  for (const bone of STICK_SEGMENTS) {
    const p = seen[bone[0]], q = seen[bone[1]];
    if (p.visibility < CLEARLY_SEEN || q.visibility < CLEARLY_SEEN) continue;
    const part = partOf(bone);
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 3));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(p.x + ((q.x - p.x) * s) / steps), y = Math.round(p.y + ((q.y - p.y) * s) / steps);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      total[part]++;
      if (alpha[y * width + x] < OPAQUE) missing[part]++;
    }
  }
  let worst: BodyPart | null = null, worstShare = 0;
  for (const part of ["leg", "arm", "body"] as const) {
    const share = total[part] ? missing[part] / total[part] : 0;
    if (share > worstShare) [worst, worstShare] = [part, share];
  }
  return worst;
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
 * What to change for the next try, for the first issue: shown (a few words, read
 * from across the room) and spoken. Running into the photo's border says which
 * way to go: no left or right, since the preview may be mirrored.
 */
export function cutoutAdvice({ issues, cutOff, edges, holesIn }: Pick<CutoutQuality, "issues" | "cutOff" | "edges" | "holesIn">): { shown: string; spoken: string } {
  if (issues[0] === "cutOff" && cutOff.includes("edge")) {
    if (edges[0] === "bottom") return { shown: "Step back: feet cut off", spoken: "Step back a little: your feet touch the bottom of the picture." };
    if (edges[0] === "top") return { shown: "Step back: head cut off", spoken: "Step back a little: your head touches the top of the picture." };
    if (edges[0]) return { shown: "Move to the middle", spoken: "Move toward the middle of the picture: you're running off its side." };
  }
  // A limb lost against the background: its colour, not the light (a pale leg held out across a white door).
  if (issues[0] === "holes" && (holesIn === "leg" || holesIn === "arm")) {
    return {
      shown: `${holesIn === "leg" ? "Leg" : "Arm"} blends into the background`,
      spoken: `Your ${holesIn} blended into the background. Strike the pose in front of something that stands out from your clothes.`,
    };
  }
  const advice: Record<CutoutIssue, { shown: string; spoken: string }> = {
    cutOff: { shown: "Get fully in view", spoken: "Keep all of you in the frame, hands and feet too." },
    background: { shown: "Stand by a plain wall", spoken: "Step away from furniture, in front of a plain wall." },
    holes: { shown: "More light on you", spoken: "Get more light on you, in clothes that stand out from the wall." },
  };
  return issues.length ? advice[issues[0]] : { shown: "", spoken: "" };
}
