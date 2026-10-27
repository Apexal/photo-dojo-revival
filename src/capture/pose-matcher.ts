import type { LimbSide, NormalizedLandmark } from "../shared/fighter-model";
import { evaluatePose, type JointError, type PoseEvaluation, type PoseTarget } from "../shared/pose-geometry";

export interface MatcherOptions {
  /** Continuous match time before auto-capture. */
  holdMs: number;
  /** Time without a capture before tolerances widen. */
  widenAfterMs: number;
  widenFactor: number;
  /** Time before "Tap to capture anyway" appears. */
  manualAfterMs: number;
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
}

export const DEFAULT_MATCHER_OPTIONS: MatcherOptions = {
  holdMs: 500,
  widenAfterMs: 5000,
  widenFactor: 1.5,
  manualAfterMs: 10000,
  armAfterMs: 1500,
  requireBreak: true,
};

export type MatcherEvent = "holdStarted" | "holdBroken" | "captured" | "tolerancesWidened" | "manualAvailable" | "armed"
  /** The buffer is over but they've been in the pose the whole time: ask them to reset and pose again. */
  | "breakNeeded";

export interface MatcherUpdate {
  score: number;
  side: LimbSide;
  /** Per-joint errors behind the score (empty when nobody's detected): drives the coaching. */
  joints: JointError[];
  /** In the pose and armed (see `armed`); drives the green ghost, the hold tone and the capture. */
  matching: boolean;
  /** The between-poses buffer is over: holding the pose now captures it. */
  armed: boolean;
  /** Only waiting for them to leave the pose once (see `requireBreak`). */
  awaitingBreak: boolean;
  /** 0..1, fills the progress ring. */
  holdProgress: number;
  toleranceScale: number;
  manualCaptureAvailable: boolean;
  captured: boolean;
  events: MatcherEvent[];
}

/**
 * Live scoring against one target pose with a hold timer.
 * Pure: time comes in as an argument so it's testable.
 */
export class PoseMatcher {
  private readonly options: MatcherOptions;
  private startedAt = 0;
  private holdStartedAt: number | null = null;
  private armed = false;
  private sawBreak = false;
  private askedForBreak = false;
  private awaitingBreak = false;
  private widened = false;
  private manualAvailable = false;
  private capturedSide: LimbSide | null = null;
  private lastSide: LimbSide = "right";

  constructor(private readonly target: PoseTarget, options: Partial<MatcherOptions> = {}) {
    this.options = { ...DEFAULT_MATCHER_OPTIONS, ...options };
  }

  start(nowMs: number): void {
    this.startedAt = nowMs;
    this.holdStartedAt = null;
    this.sawBreak = !this.options.requireBreak;
    this.armed = this.sawBreak && this.options.armAfterMs <= 0;
    this.askedForBreak = false;
    this.awaitingBreak = false;
    this.widened = false;
    this.manualAvailable = false;
    this.capturedSide = null;
  }

  get toleranceScale(): number {
    return this.widened ? this.options.widenFactor : 1;
  }

  get captured(): boolean {
    return this.capturedSide !== null;
  }

  /** The limb used for the captured attack pose. */
  get side(): LimbSide {
    return this.capturedSide ?? this.lastSide;
  }

  update(landmarks: NormalizedLandmark[] | null, nowMs: number): MatcherUpdate {
    // Advance the clock first so a widening that kicks in this frame applies to this frame's score.
    const events = this.captured ? [] : this.advanceClock(nowMs);
    const evaluation = landmarks ? evaluatePose(landmarks, this.target, this.toleranceScale) : null;
    const result = this.updateWithEvaluation(evaluation, nowMs);
    return { ...result, events: [...events, ...result.events] };
  }

  private advanceClock(nowMs: number): MatcherEvent[] {
    const events: MatcherEvent[] = [];
    const elapsed = nowMs - this.startedAt;
    if (!this.widened && elapsed >= this.options.widenAfterMs) {
      this.widened = true;
      events.push("tolerancesWidened");
    }
    if (!this.manualAvailable && elapsed >= this.options.manualAfterMs) {
      this.manualAvailable = true;
      events.push("manualAvailable");
    }
    return events;
  }

  /** Core timer logic, given an already-computed score (null = no person detected). */
  updateWithEvaluation(evaluation: PoseEvaluation | null, nowMs: number): MatcherUpdate {
    const events: MatcherEvent[] = [];
    const score = evaluation?.score ?? Infinity;
    const joints = evaluation?.joints ?? [];
    if (evaluation) this.lastSide = evaluation.side;

    if (this.captured) {
      return this.snapshot(score, joints, false, 1, events);
    }

    events.push(...this.advanceClock(nowMs));

    const inPose = score <= 1;
    if (!inPose) this.sawBreak = true;
    const bufferOver = nowMs - this.startedAt >= this.options.armAfterMs;
    if (!this.armed && this.sawBreak && bufferOver) {
      this.armed = true;
      events.push("armed");
    }
    this.awaitingBreak = !this.sawBreak && bufferOver;
    if (this.awaitingBreak && !this.askedForBreak) {
      this.askedForBreak = true;
      events.push("breakNeeded");
    }
    const matching = inPose && this.armed;
    let progress = 0;
    if (matching) {
      if (this.holdStartedAt === null) {
        this.holdStartedAt = nowMs;
        events.push("holdStarted");
      }
      const held = nowMs - this.holdStartedAt;
      progress = Math.min(1, held / this.options.holdMs);
      if (held >= this.options.holdMs) {
        this.capturedSide = this.lastSide;
        events.push("captured");
      }
    } else if (this.holdStartedAt !== null) {
      this.holdStartedAt = null;
      events.push("holdBroken");
    }
    return this.snapshot(score, joints, matching, progress, events);
  }

  /** "Tap to capture anyway". */
  forceCapture(): void {
    this.capturedSide = this.lastSide;
  }

  private snapshot(score: number, joints: JointError[], matching: boolean, holdProgress: number, events: MatcherEvent[]): MatcherUpdate {
    return {
      score,
      side: this.side,
      joints,
      matching,
      armed: this.armed,
      awaitingBreak: this.awaitingBreak,
      holdProgress,
      toleranceScale: this.toleranceScale,
      manualCaptureAvailable: this.manualAvailable,
      captured: this.captured,
      events,
    };
  }
}
