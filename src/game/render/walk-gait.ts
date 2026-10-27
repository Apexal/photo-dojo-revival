import { LANDMARK, type LimbSide, type NormalizedLandmark } from "../../shared/fighter-model";
import type { FrameTween } from "../../simulation/fight-simulation";
// The studio holds every stance/step pair to the same minimum stride (compareStep), so it rarely slips.
import { STRIDE_LIMITS } from "../../shared/walk-step";

/**
 * Walking as a planted shuffle, from the two captures every fighter has: the
 * stance (`idle`) and a step (`walk`). Rendering only, like the other tweens.
 *
 * The simulation slides a walking fighter along at a steady speed. Here the
 * morph between stance and step is driven by distance walked, not time: at each
 * moment it's exactly as far along as keeps the planted foot still on the floor
 * while the body moves past it. Forward, the front foot reaches out (the back
 * one planted), then the back foot catches up (the front one planted); walking
 * back, the planted feet swap. So a stride is as long as the fighter's own step
 * (clamped), and nothing is drawn away from where the simulation has them.
 * Mid-step the body rises a touch and the stepping foot lifts (`stepPose`).
 */

export const STANCE = { poseId: "idle", variant: 0 } as const;
export const STEP = { poseId: "walk", variant: 0 } as const;

/**
 * Mid-step: how much the body rises and the stepping foot lifts, in torso
 * lengths. Both very small: a hint of weight, and a foot that skims the floor
 * rather than leaving it (a fighting-game shuffle keeps both feet down).
 */
export const STEP_RISE = 0.01;
export const STEP_LIFT = 0.04;
/** Frames to ease back into the stance when the walk stops. */
export const SETTLE_FRAMES = 6;

const SAMPLES = 32;

/** Opening: stance → step (w 0 → 1). Closing: step → stance (w 1 → 0). */
type Half = "opening" | "closing";

/** The skeleton (relative to the feet anchor, facing right) part of the way from stance (0) to step (1). */
export type SkeletonAt = (w: number) => NormalizedLandmark[] | null;

/**
 * How far the body travels as each foot stays planted through each half, as a
 * table over w. Built once per fighter from the tweener's own in-between
 * skeletons, so it matches what's drawn.
 */
export class GaitShape {
  /** Ankle x (relative to the anchor) of each foot at w = i / SAMPLES. */
  private readonly ankleX: Record<LimbSide, Float64Array>;
  /** The foot ahead in the step capture. */
  readonly front: LimbSide;
  readonly back: LimbSide;
  readonly torso: number;
  private readonly tables = new Map<string, Float64Array>();

  private constructor(ankleX: Record<LimbSide, Float64Array>, torso: number) {
    this.ankleX = ankleX;
    this.front = ankleX.left[SAMPLES] > ankleX.right[SAMPLES] ? "left" : "right";
    this.back = this.front === "left" ? "right" : "left";
    this.torso = torso;
  }

  /** Null when the captures can't be morphed, or the step is no wider than the stance (nothing to plant). */
  static measure(skeletonAt: SkeletonAt, torso: number): GaitShape | null {
    const ankleX = { left: new Float64Array(SAMPLES + 1), right: new Float64Array(SAMPLES + 1) };
    for (let i = 0; i <= SAMPLES; i++) {
      const skeleton = skeletonAt(i / SAMPLES);
      if (!skeleton) return null;
      ankleX.left[i] = skeleton[LANDMARK.leftAnkle].x;
      ankleX.right[i] = skeleton[LANDMARK.rightAnkle].x;
    }
    const shape = new GaitShape(ankleX, torso);
    return shape.naturalStride() > 0.05 * torso ? shape : null;
  }

  /** Which foot stays down: forward, the back one while opening and the front one while closing; backward, the other way. */
  planted(half: Half, forward: boolean): LimbSide {
    return (half === "opening") === forward ? this.back : this.front;
  }

  /**
   * Distance the body has travelled, i / SAMPLES of the way through `half` with
   * `foot` planted: how far that foot has moved against the anchor. Never
   * decreasing, so it can be inverted.
   */
  private advanceTable(half: Half, foot: LimbSide): Float64Array {
    const key = `${half}:${foot}`;
    const cached = this.tables.get(key);
    if (cached) return cached;
    const x = this.ankleX[foot];
    const start = half === "opening" ? x[0] : x[SAMPLES];
    const table = new Float64Array(SAMPLES + 1);
    let best = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const w = half === "opening" ? i : SAMPLES - i; // i counts along the half
      best = Math.max(best, Math.abs(x[w] - start));
      table[i] = best;
    }
    this.tables.set(key, table);
    return table;
  }

  /** Distance through `half` at blend w. */
  advanceAt(half: Half, foot: LimbSide, w: number): number {
    const table = this.advanceTable(half, foot);
    const along = (half === "opening" ? w : 1 - w) * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(along));
    return table[i] + (table[i + 1] - table[i]) * (along - i);
  }

  /** The half's full length (the distance at its end). */
  length(half: Half, foot: LimbSide): number {
    return this.advanceTable(half, foot)[SAMPLES];
  }

  /** Blend w at distance `d` through `half`. */
  blendAt(half: Half, foot: LimbSide, d: number): number {
    const table = this.advanceTable(half, foot);
    let along = SAMPLES;
    for (let i = 0; i < SAMPLES; i++) {
      if (d <= table[i + 1]) {
        const span = table[i + 1] - table[i];
        along = i + (span > 1e-9 ? (d - table[i]) / span : 0);
        break;
      }
    }
    const fraction = along / SAMPLES;
    return half === "opening" ? fraction : 1 - fraction;
  }

  /** A full stride (both halves) walking forward, before clamping. */
  naturalStride(): number {
    return this.length("opening", this.planted("opening", true)) + this.length("closing", this.planted("closing", true));
  }

  /** How much faster than the feet the body may go (>1: a short stride stretched to the minimum, so the feet slip a little). */
  slip(): number {
    const natural = this.naturalStride();
    const clamped = Math.min(STRIDE_LIMITS.max * this.torso, Math.max(STRIDE_LIMITS.min * this.torso, natural));
    return clamped / natural;
  }
}

/** What to draw for a walking fighter: the stance ↔ step morph, and the mid-step lift. */
export interface GaitFrame {
  tween: FrameTween;
  /** The stepping (unplanted) foot, lifted mid-step; null while settling. */
  swing: LimbSide | null;
}

export interface GaitInput {
  walking: boolean;
  /** World x (the simulation's). */
  x: number;
  facing: 1 | -1;
}

/**
 * Follows one fighter's walk frame by frame (state: which half, how far).
 * Pure: frame numbers and positions come in. The same frame twice gives the
 * same answer; a frame earlier than the last (a replay) starts over.
 */
export class WalkGait {
  private half: Half = "opening";
  private w = 0;
  private forward = true;
  private lastX: number | null = null;
  private lastFrame = -Infinity;
  private last: GaitFrame | null = null;

  constructor(private readonly shape: GaitShape) {}

  update(frame: number, input: GaitInput, settleIntoStance: boolean): GaitFrame | null {
    if (frame === this.lastFrame) return this.last;
    if (frame < this.lastFrame) this.reset();
    this.lastFrame = frame;
    this.last = this.step(input, settleIntoStance);
    return this.last;
  }

  private step({ walking, x, facing }: GaitInput, settleIntoStance: boolean): GaitFrame | null {
    if (!walking) {
      this.lastX = null;
      this.half = "opening";
      // Stopping into the stance eases back to it; into anything else, the next action takes over now.
      if (!settleIntoStance || this.w <= 0) {
        this.w = 0;
        return null;
      }
      this.w = Math.max(0, this.w - 1 / SETTLE_FRAMES);
      return this.w > 0 ? { tween: { from: STANCE, to: STEP, t: this.w }, swing: null } : null;
    }
    const dx = this.lastX === null ? 0 : x - this.lastX;
    this.lastX = x;
    if (dx !== 0) this.forward = dx * facing > 0;
    this.advance(Math.abs(dx) / this.shape.slip());
    const swing = this.shape.planted(this.half, this.forward) === "left" ? "right" : "left";
    return { tween: { from: STANCE, to: STEP, t: this.w }, swing };
  }

  /** Move the blend on by `distance` of foot travel, across halves as needed. */
  private advance(distance: number): void {
    let remaining = distance;
    for (let guard = 0; guard < 8 && remaining > 0; guard++) {
      const foot = this.shape.planted(this.half, this.forward);
      const length = this.shape.length(this.half, foot);
      const d = this.shape.advanceAt(this.half, foot, this.w) + remaining;
      if (d < length) {
        this.w = this.shape.blendAt(this.half, foot, d);
        return;
      }
      remaining = d - length;
      this.w = this.half === "opening" ? 1 : 0;
      this.half = this.half === "opening" ? "closing" : "opening";
    }
  }

  reset(): void {
    this.half = "opening";
    this.w = 0;
    this.lastX = null;
    this.lastFrame = -Infinity;
    this.last = null;
  }
}

const LEG = (side: LimbSide): number[] => [LANDMARK[`${side}Knee`], LANDMARK[`${side}Ankle`], LANDMARK[`${side}Heel`], LANDMARK[`${side}FootIndex`]];

/**
 * The in-between skeleton with the step in it: mid-step (w = 0.5) the body is
 * at its highest and the stepping foot off the floor, both easing to nothing
 * at the stance and the step themselves, so the two photos stay as taken. The
 * planted foot doesn't move. Feet anchor-relative, y down.
 */
export function stepPose(skeleton: NormalizedLandmark[], w: number, swing: LimbSide, torso: number): NormalizedLandmark[] {
  const s = Math.sin(Math.PI * Math.min(1, Math.max(0, w)));
  if (s < 1e-3) return skeleton;
  const rise = STEP_RISE * torso * s;
  const lift = STEP_LIFT * torso * s;
  const planted = swing === "left" ? "right" : "left";
  const [swingKnee, ...swingFoot] = LEG(swing);
  const [plantedKnee, ...plantedFoot] = LEG(planted);
  return skeleton.map((l, i) => {
    let dy: number;
    if (plantedFoot.includes(i)) dy = 0;
    else if (i === plantedKnee) dy = -rise / 2;
    else if (swingFoot.includes(i)) dy = -lift;
    else if (i === swingKnee) dy = -(rise + lift) / 2;
    else dy = -rise; // hips, torso, arms, head
    return dy ? { ...l, y: l.y + dy } : l;
  });
}
