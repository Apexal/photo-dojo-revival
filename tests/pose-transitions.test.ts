import { describe, expect, it } from "vitest";
import { PoseTransitions } from "../src/game/render/pose-transitions";
import type { PoseId } from "../src/shared/fighter-model";
import { SOFT_CUTS } from "../src/shared/frame-data";
import { IDLE_SWAY_FRAMES } from "../src/shared/frame-data";
import { frameOf, idleSwayOf, tweenOf } from "../src/simulation/fight-simulation";
import { createFighterState, type FighterState } from "../src/simulation/fighter-state-machine";

const ref = (poseId: PoseId, variant = 0) => ({ poseId, variant });
const state = (action: FighterState["action"], actionFrame: number): FighterState => ({ ...createFighterState(0, 1, 100), action, actionFrame });

describe("soft cuts between actions", () => {
  it("morph idle into block over a few frames, easing out, then hold", () => {
    const tr = new PoseTransitions();
    expect(tr.update(0, ref("idle"), null)).toBeNull();
    const ts = [1, 2, 3, 4].map((f) => tr.update(f, ref("block"), null)?.t);
    expect(ts.every((t) => t! > 0 && t! < 1)).toBe(true);
    expect([...ts].sort()).toEqual(ts); // rising
    expect(ts[0]).toBeGreaterThan(1 / 5); // eased: the new pose shows up fast
    expect(tr.update(4, ref("block"), null)?.t).toBe(ts[3]); // a faster display renders a frame twice: same answer
    expect(tr.update(5, ref("block"), null)).toBeNull();
  });

  it("keep impacts hard: nothing morphs into hurt", () => {
    const tr = new PoseTransitions();
    tr.update(0, ref("idle"), null);
    expect(tr.update(1, ref("hurt", 1), null)).toBeNull();
    expect(SOFT_CUTS.some((c) => c.to === "hurt")).toBe(false);
    // ...but getting over it does.
    expect(tr.update(20, ref("idle"), null)).toMatchObject({ from: ref("hurt", 1), to: ref("idle") });
  });

  it("turn the walk cycle into a stride", () => {
    const tr = new PoseTransitions();
    const tweens = Array.from({ length: 40 }, (_, f) => tr.update(f, frameOf(state("walk", f)), tweenOf(state("walk", f))));
    expect(tweens[10]).toMatchObject({ from: ref("walk"), to: ref("idle") });
    expect(tweens[20]).toMatchObject({ from: ref("idle"), to: ref("walk") });
  });

  it("let a move's own tween run, without a second morph after it", () => {
    const tr = new PoseTransitions();
    const seen = Array.from({ length: 17 }, (_, f) => tr.update(f, frameOf(state("punch", f)), tweenOf(state("punch", f))));
    expect(seen[0]).toMatchObject({ from: ref("idle"), to: ref("punch") });
    expect(seen[4]).toBeNull(); // active frames: the strike, held
    expect(seen[7]).toMatchObject({ from: ref("punch"), to: ref("idle") });
    expect(seen[11]).toBeNull(); // the move's own retraction already ended on idle
  });

  it("start over when a replay rewinds", () => {
    const tr = new PoseTransitions();
    tr.update(100, ref("idle"), null);
    tr.update(101, ref("block"), null);
    expect(tr.update(50, ref("crouch"), null)).toBeNull();
  });
});

describe("idle sway", () => {
  const idle = (f: number) => state("idle", f);
  const run = (tr: PoseTransitions, frame: number, s: FighterState) => tr.update(frame, frameOf(s), tweenOf(s), idleSwayOf(s));

  it("breathes from the stance to the second stance and back, for display only", () => {
    expect(idleSwayOf(idle(0))?.t).toBe(0);
    expect(idleSwayOf(idle(IDLE_SWAY_FRAMES / 2))).toEqual({ from: ref("idle"), to: ref("idle", 1), t: 1 });
    expect(idleSwayOf(idle(IDLE_SWAY_FRAMES))?.t).toBeCloseTo(0, 9);
    expect(frameOf(idle(IDLE_SWAY_FRAMES / 2))).toEqual(ref("idle")); // hurtboxes: always the main stance
    expect(idleSwayOf({ ...state("block", 0), crouching: true })).toBeNull();
    expect(idleSwayOf(state("walk", 0))).toBeNull();
  });

  it("waits for a soft cut into idle to finish, and a cut out of it starts from the nearer stance", () => {
    const tr = new PoseTransitions();
    run(tr, 0, state("block", 0));
    expect(run(tr, 1, idle(0))).toMatchObject({ from: ref("block"), to: ref("idle") });
    expect(run(tr, 4, idle(3))).toMatchObject({ from: ref("block"), to: ref("idle") });
    expect(run(tr, 10, idle(9))).toMatchObject({ from: ref("idle"), to: ref("idle", 1) });
    run(tr, 51, idle(50)); // deep in the second stance
    expect(run(tr, 52, state("block", 0))).toMatchObject({ from: ref("idle", 1), to: ref("block") });
  });
});
