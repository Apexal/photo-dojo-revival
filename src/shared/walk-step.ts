import { LANDMARK, type LimbSide, type NormalizedLandmark } from "./fighter-model";
import { detectFacing, estimateBodyScale, flipLandmarksHorizontally, midHip } from "./pose-geometry";
import { sidesFlipped, swapSides } from "./side-flips";

/**
 * The walk is drawn from two photos, the stance and the step
 * (src/game/render/walk-gait.ts): the stance with the front foot slid further
 * forward. Neither photo alone says whether they go together, so the studio
 * compares them when it takes either one: same front foot, and the step
 * clearly wider. Pure; landmarks are frame pixels.
 */

/**
 * A stride (stance → step → stance), in torso lengths: shorter patters, longer
 * drags; outside these the walk's feet slip a little. The stride is how much
 * further apart the feet are in the step than in the stance, so the minimum is
 * also what a step has to gain on its stance.
 */
export const STRIDE_LIMITS = { min: 0.5, max: 2.2 } as const;

/** Feet closer than this (torso lengths, front to back) have no clear front foot, so the lead isn't judged. */
const CLEAR_LEAD = 0.15;

export type StepIssue =
  /** The step leads with the other foot: stepped through instead of sliding the front foot out. */
  | "switchedFeet"
  /** The step isn't wide enough past the stance to make a stride. */
  | "tooNarrow";

interface Feet { lead: LimbSide | null; separation: number }

/** Facing right, hips at the origin, one torso long: two photos taken from different spots compare directly. */
function normalized(px: NormalizedLandmark[], width: number): NormalizedLandmark[] {
  const facingRight = detectFacing(px) === "right";
  const l = facingRight ? px : flipLandmarksHorizontally(px, width);
  const hips = midHip(l);
  const scale = estimateBodyScale(l);
  return l.map((p) => ({ ...p, x: (p.x - hips.x) / scale, y: (p.y - hips.y) / scale }));
}

function feet(l: NormalizedLandmark[]): Feet {
  const left = l[LANDMARK.leftAnkle].x, right = l[LANDMARK.rightAnkle].x;
  const separation = Math.abs(left - right);
  return { lead: separation < CLEAR_LEAD ? null : left > right ? "left" : "right", separation };
}

export interface StepPhoto {
  /** Landmarks in frame pixels. */
  landmarks: NormalizedLandmark[];
  /** The frame's width, to turn a left-facing photo around. */
  width: number;
}

/** Do the stance and the step make a walk? Null when they do. */
export function compareStep(stance: StepPhoto, step: StepPhoto): StepIssue | null {
  const a = normalized(stance.landmarks, stance.width);
  let b = normalized(step.landmarks, step.width);
  // MediaPipe sometimes swaps a side-on body's labels: that isn't a switched foot.
  if (sidesFlipped(a, b)) b = swapSides(b);
  const before = feet(a), after = feet(b);
  if (before.lead && after.lead && before.lead !== after.lead) return "switchedFeet";
  if (after.separation - before.separation < STRIDE_LIMITS.min) return "tooNarrow";
  return null;
}

/**
 * What to say when the pair doesn't make a walk, for whichever photo was just
 * taken (`retaking`): shown, and spoken (the player may be across the room).
 */
export function stepAdvice(issue: StepIssue, retaking: "stance" | "step"): { shown: string; spoken: string } {
  if (retaking === "step") {
    return issue === "switchedFeet"
      ? { shown: "Step with your front foot: slide it forward, don't step through.", spoken: "Other foot. Slide your front foot forward, don't step through." }
      : { shown: "A bigger step: slide your front foot further forward than in your stance.", spoken: "Bigger step. Slide your front foot further forward." };
  }
  return issue === "switchedFeet"
    ? { shown: "Same front foot as in your step, please.", spoken: "Other foot in front, the same one as in your step." }
    : { shown: "Feet a bit closer together than in your step.", spoken: "Feet a bit closer together than in your step." };
}
