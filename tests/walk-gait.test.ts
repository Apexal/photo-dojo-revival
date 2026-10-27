import { describe, expect, it } from "vitest";
import { LANDMARK, type NormalizedLandmark } from "../src/shared/fighter-model";
import { computeAnchor, torsoLength } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { interpolateLandmarks } from "../src/game/render/pose-tweener";
import { GaitShape, STEP_LIFT, WalkGait, stepPose, type GaitFrame } from "../src/game/render/walk-gait";
import { STRIDE_LIMITS } from "../src/shared/walk-step";
import { WALK_SPEED } from "../src/simulation/fighter-state-machine";

/** Like the tweener: each capture relative to its own feet anchor. */
const relative = (poseId: "idle" | "walk") => {
  const lm = buildStickFigureLandmarks(poseId);
  const a = computeAnchor(lm, poseId);
  return lm.map((l) => ({ ...l, x: l.x - a.x, y: l.y - a.y }));
};
const stance = relative("idle");
const step = relative("walk");
const skeletonAt = (w: number) => interpolateLandmarks(stance, step, w);
const torso = torsoLength(stance);
const shape = GaitShape.measure(skeletonAt, torso)!;

/** Walk `frames` frames at `speed` px/frame (signed world x), returning each frame's gait and world ankle x's. */
function walk(gait: WalkGait, frames: number, speed: number, facing: 1 | -1 = 1, startX = 0, startFrame = 0) {
  const out: { frame: GaitFrame | null; left: number; right: number; x: number }[] = [];
  for (let f = 0; f < frames; f++) {
    const x = startX + speed * f;
    const frame = gait.update(startFrame + f, { walking: true, x, facing }, false);
    const sk = skeletonAt(frame!.tween.t);
    out.push({ frame, x, left: x + facing * sk[LANDMARK.leftAnkle].x, right: x + facing * sk[LANDMARK.rightAnkle].x });
  }
  return out;
}

/** Per frame, how far the stiller foot moved: zero when one foot is planted. */
const plantedSlip = (run: ReturnType<typeof walk>) =>
  run.slice(1).map((r, i) => Math.min(Math.abs(r.left - run[i].left), Math.abs(r.right - run[i].right)));

describe("the walk gait", () => {
  it("measures a stride from the stance and the step, within the limits", () => {
    expect(shape).not.toBeNull();
    const stride = shape.naturalStride();
    expect(stride).toBeGreaterThan(STRIDE_LIMITS.min * torso);
    expect(stride).toBeLessThan(STRIDE_LIMITS.max * torso);
    expect(shape.slip()).toBe(1);
  });

  it("keeps one foot planted while the body walks forward", () => {
    const run = walk(new WalkGait(shape), 120, WALK_SPEED);
    const slips = plantedSlip(run);
    // Every frame but the ones crossing from one half to the other (where the planted foot changes hands).
    expect(slips.filter((s) => s > 0.25).length).toBeLessThanOrEqual(Math.ceil(120 / 10));
    expect(Math.max(...slips)).toBeLessThan(WALK_SPEED);
    // And it actually walks: both feet end up well ahead.
    expect(Math.min(run.at(-1)!.left - run[0].left, run.at(-1)!.right - run[0].right)).toBeGreaterThan(WALK_SPEED * 100);
  });

  it("strides as far as the body travels in one cycle", () => {
    const run = walk(new WalkGait(shape), 400, WALK_SPEED);
    // Count returns to the stance (t back near 0 after being near 1).
    let cycles = 0, wasOut = false;
    for (const r of run) {
      const t = r.frame!.tween.t;
      if (t > 0.9) wasOut = true;
      if (wasOut && t < 0.1) { cycles++; wasOut = false; }
    }
    const expected = (WALK_SPEED * 400) / shape.naturalStride();
    expect(Math.abs(cycles - expected)).toBeLessThanOrEqual(1);
  });

  it("walks backward with the planted feet swapped, not a moonwalk", () => {
    const run = walk(new WalkGait(shape), 120, -WALK_SPEED, 1);
    const slips = plantedSlip(run);
    expect(slips.filter((s) => s > 0.25).length).toBeLessThanOrEqual(Math.ceil(120 / 10));
    // Facing left (player 2 walking toward the right is backward for them).
    const mirrored = plantedSlip(walk(new WalkGait(shape), 120, WALK_SPEED, -1));
    expect(mirrored.filter((s) => s > 0.25).length).toBeLessThanOrEqual(Math.ceil(120 / 10));
  });

  it("turns around mid-stride without a jump in the pose", () => {
    const gait = new WalkGait(shape);
    const out = walk(gait, 13, WALK_SPEED);
    const back = walk(gait, 10, -WALK_SPEED, 1, out.at(-1)!.x, 13);
    expect(Math.abs(back[0].frame!.tween.t - out.at(-1)!.frame!.tween.t)).toBeLessThan(0.2);
  });

  it("eases back into the stance when the walk stops, and gives way at once to anything else", () => {
    const gait = new WalkGait(shape);
    walk(gait, 8, WALK_SPEED);
    const ts: number[] = [];
    for (let f = 8; f < 20; f++) ts.push(gait.update(f, { walking: false, x: 0, facing: 1 }, true)?.tween.t ?? 0);
    expect(ts[0]).toBeGreaterThan(0);
    expect(ts.at(-1)).toBe(0);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    const other = new WalkGait(shape);
    walk(other, 8, WALK_SPEED);
    expect(other.update(8, { walking: false, x: 0, facing: 1 }, false)).toBeNull();
  });

  it("answers the same frame the same way, and starts over on a replay", () => {
    const gait = new WalkGait(shape);
    walk(gait, 20, WALK_SPEED);
    const again = gait.update(19, { walking: true, x: 999, facing: 1 }, false);
    expect(again).toEqual(walk(new WalkGait(shape), 20, WALK_SPEED).at(-1)!.frame);
    expect(gait.update(3, { walking: true, x: 0, facing: 1 }, false)!.tween.t).toBe(0);
  });

  it("stretches a too-short step to the minimum stride (the feet slip, it doesn't patter)", () => {
    const tiny = GaitShape.measure((w) => interpolateLandmarks(stance, interpolateLandmarks(stance, step, 0.3), w), torso)!;
    expect(tiny.naturalStride()).toBeLessThan(STRIDE_LIMITS.min * torso);
    expect(tiny.slip()).toBeCloseTo((STRIDE_LIMITS.min * torso) / tiny.naturalStride());
  });

  it("can't plant anything when the step is no wider than the stance", () => {
    expect(GaitShape.measure(() => stance, torso)).toBeNull();
    expect(GaitShape.measure(() => null, torso)).toBeNull();
  });
});

describe("the step itself", () => {
  const ankle = (l: NormalizedLandmark[], side: "left" | "right") => l[LANDMARK[`${side}Ankle`]];

  it("lifts the stepping foot and the body mid-step, leaving the planted foot where it is", () => {
    const mid = skeletonAt(0.5);
    const stepped = stepPose(mid, 0.5, "right", torso);
    expect(ankle(stepped, "left")).toEqual(ankle(mid, "left"));
    expect(ankle(stepped, "right").y).toBeCloseTo(ankle(mid, "right").y - STEP_LIFT * torso);
    expect(stepped[LANDMARK.nose].y).toBeLessThan(mid[LANDMARK.nose].y);
  });

  it("leaves both photos as taken at the stance and the step", () => {
    expect(stepPose(stance, 0, "right", torso)).toBe(stance);
    expect(stepPose(step, 1, "right", torso)).toBe(step);
  });
});
