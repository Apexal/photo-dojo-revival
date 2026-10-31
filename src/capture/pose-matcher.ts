import { LANDMARK, type LandmarkName, type NormalizedLandmark } from "../shared/fighter-model";
import { REQUIRED_VISIBILITY_THRESHOLD, estimateBodyScale, evaluatePose, type JointError, type PoseTarget } from "../shared/pose-geometry";

export interface MatcherOptions {
  /** Continuous, steady match time before auto-capture. */
  holdMs: number;
  /**
   * Buffer between poses: matches don't count until this long after the pose
   * starts (time to hear the prompt)...
   */
  armAfterMs: number;
  /**
   * ...and until the person has been seen out of the pose at least once, so
   * still holding the previous pose can't trigger the next one if they look alike.
   */
  requireBreak: boolean;
  /** How sure MediaPipe must be of each required landmark (see LIVE_VISIBILITY_MARGIN). */
  requiredVisibility: number;
  /** Scales every target's tolerance (the lab tries looser or stricter matching). */
  toleranceScale: number;
}

/**
 * Live, the required landmarks must be this much surer than the photo needs
 * (REQUIRED_VISIBILITY_THRESHOLD): the photo is detected afresh, without the
 * video's tracking, and a point only just clear live often isn't in it. Live
 * is stricter than the photo on every shared check (also STILL_TOLERANCE_SLACK,
 * LIVE_STRIDE_MARGIN, framing's EDGE_MARGIN), so what goes green passes as a photo.
 */
export const LIVE_VISIBILITY_MARGIN = 0.1;

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  holdMs: 500,
  armAfterMs: 1500,
  requireBreak: true,
  requiredVisibility: REQUIRED_VISIBILITY_THRESHOLD + LIVE_VISIBILITY_MARGIN,
  toleranceScale: 1,
};

/**
 * How far (torso lengths) any clearly seen body point may drift from where it
 * was when the hold began: further, and the hold starts over from there. The
 * photo is taken at the end of the hold, so a sway or a limb still settling
 * would blur it (and move the landmarks away from the matte).
 */
export const STEADY_RADIUS = 0.2;
const STEADY_POINTS = [
  LANDMARK.nose, LANDMARK.leftShoulder, LANDMARK.rightShoulder, LANDMARK.leftElbow, LANDMARK.rightElbow,
  LANDMARK.leftWrist, LANDMARK.rightWrist, LANDMARK.leftHip, LANDMARK.rightHip, LANDMARK.leftKnee, LANDMARK.rightKnee,
  LANDMARK.leftAnkle, LANDMARK.rightAnkle,
];

export type MatcherEvent = "holdStarted" | "holdBroken" | "captured" | "armed"
  /** In the pose but moving: the hold starts over. */
  | "moved"
  /** The buffer is over but they've been in the pose the whole time: ask them to reset and pose again. */
  | "breakNeeded";

export interface MatcherUpdate {
  score: number;
  /** Per-joint errors behind the score (empty when nobody's detected): drives the coaching. */
  joints: JointError[];
  /** Required landmarks MediaPipe doesn't clearly see (the score is Infinity then). */
  unseen: LandmarkName[];
  /** In the pose and armed (see `armed`); drives the green ghost, the hold tone and the capture. */
  matching: boolean;
  /** The between-poses buffer is over: holding the pose now captures it. */
  armed: boolean;
  /** Only waiting for them to leave the pose once (see `requireBreak`). */
  awaitingBreak: boolean;
  /** 0..1, fills the progress ring. */
  holdProgress: number;
  captured: boolean;
  events: MatcherEvent[];
}

/** Moved further than `STEADY_RADIUS` since `from` (both in frame pixels). */
function moved(from: NormalizedLandmark[], to: NormalizedLandmark[]): boolean {
  const limit = STEADY_RADIUS * estimateBodyScale(from);
  return STEADY_POINTS.some((i) => {
    const a = from[i], b = to[i];
    return a.visibility >= REQUIRED_VISIBILITY_THRESHOLD && b.visibility >= REQUIRED_VISIBILITY_THRESHOLD && Math.hypot(a.x - b.x, a.y - b.y) > limit;
  });
}

/**
 * Live scoring against one target pose with a hold timer: captures once the
 * pose has been held, steady, for `holdMs`.
 * Pure: time comes in as an argument so it's testable. Landmarks are frame pixels.
 */
export class PoseMatcher {
  private readonly options: MatcherOptions;
  private startedAt = 0;
  /** When the current hold began, and the landmarks then (the steadiness reference). */
  private hold: { since: number; at: NormalizedLandmark[] } | null = null;
  private armed = false;
  private sawBreak = false;
  private askedForBreak = false;
  private capturedFlag = false;

  constructor(private readonly target: PoseTarget, options: Partial<MatcherOptions> = {}) {
    this.options = { ...DEFAULT_MATCHER_OPTIONS, ...options };
  }

  start(nowMs: number): void {
    this.startedAt = nowMs;
    this.hold = null;
    this.sawBreak = !this.options.requireBreak;
    this.armed = this.sawBreak && this.options.armAfterMs <= 0;
    this.askedForBreak = false;
    this.capturedFlag = false;
  }

  get captured(): boolean {
    return this.capturedFlag;
  }

  /** `px`: the person's landmarks in frame pixels, or null when nobody (usable) is in view. */
  update(px: NormalizedLandmark[] | null, nowMs: number): MatcherUpdate {
    const evaluation = px ? evaluatePose(px, this.target, this.options.toleranceScale, this.options.requiredVisibility) : null;
    const score = evaluation?.score ?? Infinity;
    const joints = evaluation?.joints ?? [];
    const unseen = evaluation?.unseen ?? [];
    const events: MatcherEvent[] = [];
    const result = (matching: boolean, holdProgress: number, awaitingBreak = false): MatcherUpdate =>
      ({ score, joints, unseen, matching, armed: this.armed, awaitingBreak, holdProgress, captured: this.capturedFlag, events });
    if (this.capturedFlag) return result(false, 1);

    const inPose = score <= 1;
    if (!inPose) this.sawBreak = true;
    const bufferOver = nowMs - this.startedAt >= this.options.armAfterMs;
    if (!this.armed && this.sawBreak && bufferOver) {
      this.armed = true;
      events.push("armed");
    }
    const awaitingBreak = !this.sawBreak && bufferOver;
    if (awaitingBreak && !this.askedForBreak) {
      this.askedForBreak = true;
      events.push("breakNeeded");
    }
    if (!(inPose && this.armed)) {
      if (this.hold) events.push("holdBroken");
      this.hold = null;
      return result(false, 0, awaitingBreak);
    }
    if (!this.hold) {
      this.hold = { since: nowMs, at: px! };
      events.push("holdStarted");
    } else if (moved(this.hold.at, px!)) {
      this.hold = { since: nowMs, at: px! };
      events.push("moved");
    }
    const held = nowMs - this.hold.since;
    if (held >= this.options.holdMs) {
      this.capturedFlag = true;
      events.push("captured");
    }
    return result(true, Math.min(1, held / this.options.holdMs));
  }
}
