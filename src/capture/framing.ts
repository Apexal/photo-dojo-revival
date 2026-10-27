import { GROUND_LINE_Y, LANDMARK, SPRITE_CANVAS_SIZE, type NormalizedLandmark } from "../shared/fighter-model";
import { REQUIRED_VISIBILITY_THRESHOLD, computeAnchor, estimateBodyScale, midHip } from "../shared/pose-geometry";
import { HEAD_RADIUS_PX, buildStickFigureLandmarks, headCenter } from "../shared/stick-figure";

/**
 * Fitting the ghost to the person in front of the camera, and telling them
 * whether to come closer or step back. Pure: landmarks are frame pixels.
 */

/** Where the ghost goes in the frame: sprite pixel (SPRITE_CANVAS_SIZE / 2, GROUND_LINE_Y) lands on (groundX, groundY). */
export interface GhostFit {
  /** Frame pixels per sprite pixel. */
  scale: number;
  groundX: number;
  groundY: number;
}

/** "center": a part of the person is at a side of the picture (a lunge reaches further than standing). */
export type FramingAdvice = "ok" | "closer" | "further" | "center";

const STICK_IDLE = buildStickFigureLandmarks("idle");
/** Body scale (≈ torso length) of the canonical figure, in sprite pixels. */
const STICK_BODY_SCALE = estimateBodyScale(STICK_IDLE);
/** Head top to the ground (under the feet) of the canonical figure, in body-scale units. */
export const STANDING_HEIGHT_RATIO = (GROUND_LINE_Y - (headCenter(STICK_IDLE).y - HEAD_RADIUS_PX)) / STICK_BODY_SCALE;
/** Hip to the ground of the canonical figure, in body-scale units (to place the ground when feet are out of frame). */
const HIP_TO_GROUND_RATIO = (GROUND_LINE_Y - midHip(STICK_IDLE).y) / STICK_BODY_SCALE;

/** Ghost height as a fraction of the frame before anyone is detected; the person should roughly fill it. */
export const DEFAULT_HEIGHT_FRACTION = 0.78;
/** Standing height range (fraction of the frame) that's comfortable to capture in. */
export const FRAMING_RANGE = { min: 0.5, max: 0.9 } as const;

export function defaultGhostFit(width: number, height: number): GhostFit {
  return { scale: (height * DEFAULT_HEIGHT_FRACTION) / (STANDING_HEIGHT_RATIO * STICK_BODY_SCALE), groundX: width / 2, groundY: height * 0.95 };
}

const visible = (l: NormalizedLandmark) => l.visibility >= REQUIRED_VISIBILITY_THRESHOLD;

/** Measure the person: body scale, standing height and where their feet are. Null without a usable torso. */
export function measurePerson(px: NormalizedLandmark[]): { bodyScale: number; standingHeight: number; groundX: number; groundY: number } | null {
  const hipsOk = visible(px[LANDMARK.leftHip]) && visible(px[LANDMARK.rightHip]);
  const shouldersOk = visible(px[LANDMARK.leftShoulder]) || visible(px[LANDMARK.rightShoulder]);
  if (!hipsOk || !shouldersOk) return null;
  const bodyScale = estimateBodyScale(px);
  if (!(bodyScale > 0)) return null;
  const feetOk = visible(px[LANDMARK.leftAnkle]) && visible(px[LANDMARK.rightAnkle]);
  const hip = midHip(px);
  const ground = feetOk ? computeAnchor(px, "idle") : { x: hip.x, y: hip.y + HIP_TO_GROUND_RATIO * bodyScale };
  return { bodyScale, standingHeight: STANDING_HEIGHT_RATIO * bodyScale, groundX: ground.x, groundY: ground.y };
}

/** A ghost the person's size, standing where they stand (clamped to stay a sensible size). */
export function fitGhost(px: NormalizedLandmark[], height: number): GhostFit | null {
  const m = measurePerson(px);
  if (!m) return null;
  const minScale = (height * 0.3) / (STANDING_HEIGHT_RATIO * STICK_BODY_SCALE);
  const maxScale = (height * 1.1) / (STANDING_HEIGHT_RATIO * STICK_BODY_SCALE);
  return { scale: Math.min(maxScale, Math.max(minScale, m.bodyScale / STICK_BODY_SCALE)), groundX: m.groundX, groundY: m.groundY };
}

/**
 * Clearly seen body points nearer a side of the picture than this (torso
 * lengths) are at its edge: hands, feet and clothes reach past their
 * landmarks, and the photo's cut-out would run into the border.
 */
export const EDGE_MARGIN = 0.15;
/** Feet nearer the bottom of the picture than this (torso lengths) touch it. */
const BOTTOM_MARGIN = 0.05;
const EDGE_POINTS = [
  LANDMARK.nose, LANDMARK.leftShoulder, LANDMARK.rightShoulder, LANDMARK.leftElbow, LANDMARK.rightElbow,
  LANDMARK.leftWrist, LANDMARK.rightWrist, LANDMARK.leftIndex, LANDMARK.rightIndex, LANDMARK.leftPinky, LANDMARK.rightPinky, LANDMARK.leftHip, LANDMARK.rightHip, LANDMARK.leftKnee, LANDMARK.rightKnee,
  LANDMARK.leftAnkle, LANDMARK.rightAnkle, LANDMARK.leftHeel, LANDMARK.rightHeel, LANDMARK.leftFootIndex, LANDMARK.rightFootIndex,
];

/**
 * "A bit closer" / "a bit further" from how tall the person stands in the frame
 * and whether head and feet fit; "center" when some of them is at a side.
 * Anything but "ok" stops a capture: "further" and "center" would cut them
 * off, "closer" leaves too few pixels for a sharp sprite and a clean cut-out.
 */
export function framingAdvice(px: NormalizedLandmark[], width: number, height: number): FramingAdvice {
  const m = measurePerson(px);
  if (!m) return "further";
  const headTop = m.groundY - m.standingHeight;
  const outOfFrame = [LANDMARK.nose, LANDMARK.leftAnkle, LANDMARK.rightAnkle].some((i) => {
    const l = px[i];
    return l.x < 0 || l.x > width || l.y < 0 || l.y > height;
  });
  const feetAtBottom = m.groundY > height - BOTTOM_MARGIN * m.bodyScale;
  if (outOfFrame || headTop < 0 || feetAtBottom || m.standingHeight > FRAMING_RANGE.max * height) return "further";
  const side = EDGE_MARGIN * m.bodyScale;
  if (EDGE_POINTS.some((i) => visible(px[i]) && (px[i].x < side || px[i].x > width - side))) return "center";
  if (m.standingHeight < FRAMING_RANGE.min * height) return "closer";
  return "ok";
}

/** Sprite → frame transform for drawing the ghost path. */
export function ghostTransform(fit: GhostFit): { scale: number; translateX: number; translateY: number } {
  return { scale: fit.scale, translateX: fit.groundX - (SPRITE_CANVAS_SIZE / 2) * fit.scale, translateY: fit.groundY - GROUND_LINE_Y * fit.scale };
}

/**
 * Smooths the fit over time so the ghost doesn't jitter with every detection.
 * `holdVertical` keeps the ground where it was (the jump pose lifts the feet).
 */
export class GhostFitter {
  private current: GhostFit | null = null;
  private lastAt = 0;

  constructor(private readonly timeConstantMs = 300) {}

  update(px: NormalizedLandmark[] | null, width: number, height: number, nowMs: number, options: { holdVertical?: boolean } = {}): GhostFit {
    const target = px ? fitGhost(px, height) : null;
    const dt = this.current ? Math.max(0, nowMs - this.lastAt) : 0;
    this.lastAt = nowMs;
    if (!target) return (this.current ??= defaultGhostFit(width, height));
    if (!this.current) return (this.current = target);
    const k = 1 - Math.exp(-dt / this.timeConstantMs);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    this.current = {
      scale: lerp(this.current.scale, target.scale),
      groundX: lerp(this.current.groundX, target.groundX),
      groundY: options.holdVertical ? this.current.groundY : lerp(this.current.groundY, target.groundY),
    };
    return this.current;
  }

  /** Current fit without new data (or the default before anyone was seen). */
  peek(width: number, height: number): GhostFit {
    return this.current ?? defaultGhostFit(width, height);
  }

  reset(): void {
    this.current = null;
  }
}
