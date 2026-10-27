import { LANDMARK, type LandmarkName, type LimbSide, type NormalizedLandmark } from "../shared/fighter-model";
import { computeJointAngles, estimateBodyScale, evaluatePose, midHip, type JointError, type JointName, type PoseTarget } from "../shared/pose-geometry";
import { STICK_SEGMENTS } from "../shared/stick-figure";

/** How a targeted joint is doing: in tolerance, nearly there, or well off. */
export type JointBand = "good" | "close" | "off";

/** Normalized error (1 = tolerance edge) up to which a joint counts as "close". */
export const CLOSE_ERROR = 1.75;

export function jointBand(error: number): JointBand {
  return error <= 1 ? "good" : error <= CLOSE_ERROR ? "close" : "off";
}

/**
 * What to say to fix one joint. `delta` is actual minus target: negative means
 * the angle is too small. No "left"/"right": the preview is mirrored, so those
 * words mislead; the coloured skeleton shows which limb.
 */
export function correctionFor(joint: JointName, delta: number): string {
  const tooSmall = delta < 0;
  switch (joint) {
    case "leftElbow": case "rightElbow":
      return tooSmall ? "Straighten your arm more" : "Bend your elbow more";
    case "leftKnee": case "rightKnee":
      return tooSmall ? "Straighten your leg" : "Bend your knee more";
    case "leftShoulderElevation": case "rightShoulderElevation":
      return tooSmall ? "Raise your arm higher" : "Lower your arm a bit";
    case "leftHipFlexion": case "rightHipFlexion":
      return tooSmall ? "Lift your leg higher" : "Lower your leg a bit";
    case "legSpread":
      return tooSmall ? "Feet further apart" : "Feet closer together";
    case "torsoLean":
      return tooSmall ? "Lean further" : "Stand up straighter";
    case "headTilt":
      return tooSmall ? "Tilt your head more" : "Hold your head straighter";
  }
}

/** The body part each landmark belongs to, as said to the player (no left or right, for the same reason). */
function bodyPart(name: LandmarkName): string {
  const part = name.replace(/^(left|right)/, "");
  switch (part) {
    case "Ankle": case "Heel": case "FootIndex": return "feet";
    case "Knee": return "knees";
    case "Hip": return "hips";
    case "Wrist": case "Pinky": case "Index": case "Thumb": return "hands";
    case "Elbow": return "arms";
    case "Shoulder": return "shoulders";
    default: return "head";
  }
}

/**
 * Why a pose can't be scored when its required landmarks aren't clearly seen
 * (the skeleton may still be drawn: it shows less certain points too). Null when all are seen.
 */
export function unseenText(unseen: LandmarkName[]): string | null {
  if (!unseen.length) return null;
  const parts = [...new Set(unseen.map(bodyPart))];
  return parts.length > 2 ? "Can't see you clearly" : `Can't see your ${parts.join(" or ")}`;
}

type Bone = readonly [number, number];

/** The bones each joint's angle is measured on (the ones to colour). */
function bonesOf(joint: JointName): Bone[] {
  const L = LANDMARK;
  switch (joint) {
    case "leftElbow": return [[L.leftShoulder, L.leftElbow], [L.leftElbow, L.leftWrist]];
    case "rightElbow": return [[L.rightShoulder, L.rightElbow], [L.rightElbow, L.rightWrist]];
    case "leftKnee": return [[L.leftHip, L.leftKnee], [L.leftKnee, L.leftAnkle]];
    case "rightKnee": return [[L.rightHip, L.rightKnee], [L.rightKnee, L.rightAnkle]];
    case "leftShoulderElevation": return [[L.leftShoulder, L.leftElbow]];
    case "rightShoulderElevation": return [[L.rightShoulder, L.rightElbow]];
    case "leftHipFlexion": return [[L.leftHip, L.leftKnee]];
    case "rightHipFlexion": return [[L.rightHip, L.rightKnee]];
    case "legSpread": return [[L.leftHip, L.leftKnee], [L.rightHip, L.rightKnee]];
    case "torsoLean": return [[L.leftShoulder, L.leftHip], [L.rightShoulder, L.rightHip]];
    case "headTilt": return [];
  }
}

const BAND_RANK: Record<JointBand, number> = { good: 0, close: 1, off: 2 };

/**
 * A band for each of `STICK_SEGMENTS` (same order): the worst of the targeted
 * joints measured on that bone, or null for bones the pose doesn't check.
 */
export function segmentBands(joints: readonly JointError[]): (JointBand | null)[] {
  const bands: (JointBand | null)[] = STICK_SEGMENTS.map(() => null);
  for (const { joint, error } of joints) {
    if (!Number.isFinite(error)) continue;
    const band = jointBand(error);
    for (const [a, b] of bonesOf(joint)) {
      const i = STICK_SEGMENTS.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
      const current = bands[i];
      if (i >= 0 && (current === null || BAND_RANK[band] > BAND_RANK[current])) bands[i] = band;
    }
  }
  return bands;
}

interface Point { x: number; y: number }

/** "Move this way": from where a limb's tip is to where it should go. Frame pixels. */
export interface CorrectionArrow { from: Point; to: Point }

/** How far the limb is turned to find the way to move it. */
const ARROW_DEGREES = 40;
/** Arrows are at least this long, in torso lengths: a tucked forearm turning 40° is a stub nobody sees from across the room. */
const ARROW_MIN_LENGTH = 0.8;

const HAND = { left: [LANDMARK.leftWrist, LANDMARK.leftPinky, LANDMARK.leftIndex, LANDMARK.leftThumb], right: [LANDMARK.rightWrist, LANDMARK.rightPinky, LANDMARK.rightIndex, LANDMARK.rightThumb] };
const FOOT = { left: [LANDMARK.leftAnkle, LANDMARK.leftHeel, LANDMARK.leftFootIndex], right: [LANDMARK.rightAnkle, LANDMARK.rightHeel, LANDMARK.rightFootIndex] };

/** A body part that turns about a pivot to fix a joint: the landmarks that move with it and the one to draw the arrow from. */
interface Lever { pivot: (px: NormalizedLandmark[]) => Point; moved: number[]; tip: number }

const at = (i: number) => (px: NormalizedLandmark[]) => px[i];

function leversOf(joint: JointName): Lever[] {
  const L = LANDMARK;
  const side = joint.startsWith("left") ? "left" : "right";
  const S = side === "left"
    ? { shoulder: L.leftShoulder, elbow: L.leftElbow, hip: L.leftHip, knee: L.leftKnee }
    : { shoulder: L.rightShoulder, elbow: L.rightElbow, hip: L.rightHip, knee: L.rightKnee };
  switch (joint) {
    case "leftElbow": case "rightElbow":
      return [{ pivot: at(S.elbow), moved: HAND[side], tip: HAND[side][0] }];
    case "leftShoulderElevation": case "rightShoulderElevation":
      return [{ pivot: at(S.shoulder), moved: [S.elbow, ...HAND[side]], tip: HAND[side][0] }];
    case "leftKnee": case "rightKnee":
      return [{ pivot: at(S.knee), moved: FOOT[side], tip: FOOT[side][0] }];
    case "leftHipFlexion": case "rightHipFlexion":
      return [{ pivot: at(S.hip), moved: [S.knee, ...FOOT[side]], tip: FOOT[side][0] }];
    case "legSpread":
      return (["left", "right"] as const).map((leg) => {
        const hip = leg === "left" ? L.leftHip : L.rightHip;
        const knee = leg === "left" ? L.leftKnee : L.rightKnee;
        return { pivot: at(hip), moved: [knee, ...FOOT[leg]], tip: FOOT[leg][0] };
      });
    case "torsoLean": // the whole upper body (landmarks 0–22) about the hips
      return [{ pivot: midHip, moved: Array.from({ length: L.rightThumb + 1 }, (_, i) => i), tip: L.nose }];
    case "headTilt":
      return [];
  }
}

function rotateAbout(p: Point, pivot: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * Math.cos(r) - dy * Math.sin(r), y: pivot.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * Arrows showing which way to turn the limb behind `joint` (`delta`: actual
 * minus target, as in `JointError`). Each lever is turned both ways and the way
 * that brings the angle closer to its target wins, so the arrow is right for
 * either limb, any facing and a mirrored preview. `px` is in frame pixels.
 */
export function correctionArrows(px: NormalizedLandmark[], joint: JointName, delta: number): CorrectionArrow[] {
  const actual = computeJointAngles(px)[joint];
  if (actual === null) return [];
  const target = actual - delta;
  const arrows: CorrectionArrow[] = [];
  for (const lever of leversOf(joint)) {
    const pivot = lever.pivot(px);
    let best: { miss: number; degrees: number } | null = null;
    for (const degrees of [ARROW_DEGREES, -ARROW_DEGREES]) {
      const turned = px.map((l, i) => (lever.moved.includes(i) ? { ...l, ...rotateAbout(l, pivot, degrees) } : l));
      const angle = computeJointAngles(turned)[joint];
      if (angle === null) continue;
      const miss = Math.abs(angle - target);
      if (miss < Math.abs(delta) && (!best || miss < best.miss)) best = { miss, degrees };
    }
    if (!best) continue;
    const from = px[lever.tip];
    const turned = rotateAbout(from, pivot, best.degrees);
    const chord = Math.hypot(turned.x - from.x, turned.y - from.y);
    if (!(chord > 0)) continue;
    const length = Math.max(chord, ARROW_MIN_LENGTH * estimateBodyScale(px));
    arrows.push({ from, to: { x: from.x + ((turned.x - from.x) / chord) * length, y: from.y + ((turned.y - from.y) / chord) * length } });
  }
  return arrows;
}

export interface CoachOptions {
  /** A different joint must be the worst this long before the hint switches to it (no flicker between two). */
  switchAfterMs: number;
  /**
   * A correction stays until it's been gone this long: tracking jitter (a joint
   * dipping into tolerance, an ankle flickering out of view) mustn't reset it.
   */
  dropAfterMs: number;
  /** A correction is spoken once it's been the hint this long... */
  speakAfterMs: number;
  /** ...not again within this long... */
  repeatMs: number;
  /** ...and not this soon after the pose starts, while its prompt is still playing. */
  quietAfterStartMs: number;
  /** A joint has to stay in (or out of) tolerance this long to count for the progress chime. */
  settleMs: number;
}

export const DEFAULT_COACH_OPTIONS: CoachOptions = {
  switchAfterMs: 1000,
  dropAfterMs: 600,
  speakAfterMs: 1200,
  repeatMs: 5000,
  quietAfterStartMs: 3000,
  settleMs: 400,
};

export interface Correction { joint: JointName; text: string }

export interface CoachUpdate {
  /** The one thing to fix now, or null when every joint is in tolerance (or nothing to coach). */
  correction: Correction | null;
  /** Say `correction.text` now. */
  speak: boolean;
  /**
   * One more checked joint has settled into tolerance (not the last one: the
   * hold tone takes over then): play the progress chime. 0..1 of the joints.
   */
  progress: number | null;
}

/**
 * Picks the one thing to correct from the matcher's per-joint errors: the worst
 * joint out of tolerance, kept until it's fixed or another has been worse for a
 * while, and through short gaps in the tracking. Keyed by the correction's text, not the joint, so an attack pose
 * switching sides (rightElbow ↔ leftElbow) doesn't count as a new correction.
 * Pure: time comes in as an argument.
 */
export class PoseCoach {
  private readonly options: CoachOptions;
  private startedAt = 0;
  private current: { joint: JointName; text: string; since: number; seenAt: number } | null = null;
  private challenger: { text: string; since: number } | null = null;
  private spokenAt = -Infinity;
  /** Per target angle (by index, so an attack pose switching sides keeps it): settled in tolerance or not. */
  private settled: { good: boolean; since: number; counted: boolean }[] = [];
  private settledCount = 0;

  constructor(options: Partial<CoachOptions> = {}) {
    this.options = { ...DEFAULT_COACH_OPTIONS, ...options };
  }

  start(nowMs: number): void {
    this.startedAt = nowMs;
    this.current = null;
    this.challenger = null;
    this.spokenAt = -Infinity;
    this.settled = [];
    this.settledCount = 0;
  }

  /** Pass [] when there's nothing to coach (no one in frame, matching, framing advice showing). */
  update(joints: readonly JointError[], nowMs: number): CoachUpdate {
    const o = this.options;
    // Worst first, so the first joint with a given text is the one to point at.
    const out = joints
      .filter((j) => j.delta !== null && j.error > 1)
      .sort((x, y) => y.error - x.error)
      .map((j) => ({ joint: j.joint, text: correctionFor(j.joint, j.delta!) }));
    const worst = out[0];
    const present = this.current && out.find((c) => c.text === this.current!.text);

    if (present) {
      this.current!.seenAt = nowMs;
      this.current!.joint = present.joint;
    } else if (this.current && nowMs - this.current.seenAt >= o.dropAfterMs) {
      this.current = null;
    }

    if (!this.current) {
      this.challenger = null;
      if (worst) this.current = { ...worst, since: nowMs, seenAt: nowMs };
    } else if (worst && worst.text !== this.current.text) {
      if (this.challenger?.text !== worst.text) this.challenger = { text: worst.text, since: nowMs };
      if (nowMs - this.challenger.since >= o.switchAfterMs) {
        this.current = { ...worst, since: nowMs, seenAt: nowMs };
        this.challenger = null;
      }
    } else if (worst) {
      this.challenger = null; // the current one is the worst again
    }

    const progress = this.trackProgress(joints, nowMs);
    const current = this.current;
    if (!current) return { correction: null, speak: false, progress };
    // Spoken only while it's actually wrong this frame, not while riding out a gap.
    const speak = out.some((c) => c.text === current.text)
      && nowMs - this.startedAt >= o.quietAfterStartMs
      && nowMs - current.since >= o.speakAfterMs
      && nowMs - this.spokenAt >= o.repeatMs;
    if (speak) this.spokenAt = nowMs;
    return { correction: { joint: current.joint, text: current.text }, speak, progress };
  }

  /** Counts joints that have settled into tolerance; a rise (short of all of them) is progress. Frozen while there's nothing to coach. */
  private trackProgress(joints: readonly JointError[], nowMs: number): number | null {
    if (!joints.length) return null;
    joints.forEach((j, i) => {
      const good = j.error <= 1;
      const entry = (this.settled[i] ??= { good, since: nowMs, counted: false });
      if (entry.good !== good) Object.assign(entry, { good, since: nowMs });
      if (nowMs - entry.since >= this.options.settleMs) entry.counted = good;
    });
    const count = this.settled.filter((e) => e.counted).length;
    const rose = count > this.settledCount && count < joints.length;
    this.settledCount = count;
    return rose ? count / joints.length : null;
  }
}

/**
 * Extra room for the photo on top of the live check's tolerance: landmarks
 * re-detected on a full-resolution still never land exactly where the live
 * ones did, and a pose that just passed live shouldn't fail on that alone.
 */
export const STILL_TOLERANCE_SLACK = 1.25;

export type StillPoseCheck = { ok: true; score: number; side: LimbSide } | { ok: false; score: number; correction: string | null };

/**
 * Is the photo itself in the pose? The live check passed, but the photo is the
 * sharpest frame of a burst, or a phone's later moment, and hitboxes come from
 * its landmarks (and the attack limb from its best side). `px` is in frame pixels.
 */
export function checkStillPose(px: NormalizedLandmark[], target: PoseTarget): StillPoseCheck {
  const { score, side, joints, unseen } = evaluatePose(px, target, STILL_TOLERANCE_SLACK);
  if (score <= 1) return { ok: true, score, side };
  if (unseen.length) return { ok: false, score, correction: unseenText(unseen) };
  const worst = joints.filter((j) => j.delta !== null).sort((a, b) => b.error - a.error)[0];
  return { ok: false, score, correction: worst && worst.error > 1 ? correctionFor(worst.joint, worst.delta!) : null };
}
