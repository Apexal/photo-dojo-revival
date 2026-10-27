import { describe, expect, it } from "vitest";
import { LANDMARK, type NormalizedLandmark } from "../src/shared/fighter-model";
import { computeAnchor, midHip, midShoulder, torsoLength } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { KNOCKDOWN } from "../src/shared/frame-data";
import { Ragdoll, torsoCover, type RagdollStart } from "../src/game/render/ragdoll";

/** Like the tweener: a capture relative to its own feet anchor. */
const relative = (poseId: "hurt" | "punch") => {
  const lm = buildStickFigureLandmarks(poseId);
  const a = computeAnchor(lm, poseId);
  return lm.map((l) => ({ ...l, x: l.x - a.x, y: l.y - a.y }));
};

const start = (poseId: "hurt" | "punch" = "hurt", overrides: Partial<RagdollStart> = {}): RagdollStart => ({
  landmarks: relative(poseId),
  velocity: { x: -KNOCKDOWN.launch.x, y: KNOCKDOWN.launch.y },
  floor: 0,
  walls: [-2000, 2000],
  ...overrides,
});

const bone = (l: NormalizedLandmark[], a: number, b: number) => Math.hypot(l[a].x - l[b].x, l[a].y - l[b].y);

describe("the K.O. ragdoll", () => {
  it("flies back, lands and ends up lying on the floor", () => {
    const ragdoll = new Ragdoll(start());
    const before = ragdoll.skeleton();
    ragdoll.advanceTo(240);
    const after = ragdoll.skeleton();
    const torso = torsoLength(before);
    const spine = { x: midShoulder(after).x - midHip(after).x, y: midShoulder(after).y - midHip(after).y };
    // Lying: the spine is closer to flat than upright, head behind the hips (knocked backwards).
    expect(Math.abs(spine.y)).toBeLessThan(Math.abs(spine.x));
    expect(midShoulder(after).x).toBeLessThan(midHip(after).x);
    expect(midHip(after).x).toBeLessThan(midHip(before).x);
    // Resting on the floor, nothing through it.
    expect(Math.max(...after.map((l) => l.y))).toBeLessThanOrEqual(0);
    expect(midHip(after).y).toBeGreaterThan(-0.4 * torso);
    expect(ragdoll.settled).toBe(true);
  });

  it("keeps its bones their length", () => {
    const ragdoll = new Ragdoll(start("punch"));
    const before = ragdoll.skeleton();
    for (let f = 1; f <= 120; f += 7) {
      ragdoll.advanceTo(f);
      const now = ragdoll.skeleton();
      for (const [a, b] of [[LANDMARK.leftShoulder, LANDMARK.leftElbow], [LANDMARK.rightHip, LANDMARK.rightKnee], [LANDMARK.leftShoulder, LANDMARK.rightHip]]) {
        expect(bone(now, a, b)).toBeCloseTo(bone(before, a, b), -0.5);
      }
    }
  });

  it("flops the same way every time (the replay)", () => {
    const a = new Ragdoll(start("punch")), b = new Ragdoll(start("punch"));
    a.advanceTo(90);
    for (let f = 1; f <= 90; f++) b.advanceTo(f);
    expect(b.skeleton()).toEqual(a.skeleton());
  });

  it("stays inside the stage walls", () => {
    const ragdoll = new Ragdoll(start("hurt", { walls: [-60, 400], velocity: { x: -12, y: -4 } }));
    for (let f = 1; f <= 120; f++) {
      ragdoll.advanceTo(f);
      for (const l of ragdoll.skeleton()) expect(l.x).toBeGreaterThanOrEqual(-60);
    }
  });
});

describe("torsoCover", () => {
  const stance = relative("hurt");
  const torso = torsoLength(stance);
  const neck = midShoulder(stance), pelvis = midHip(stance);
  /** The stance with both arms laid along a direction from the shoulders (unit vector). */
  const armsAlong = (dx: number, dy: number) => {
    const l = stance.map((p) => ({ ...p }));
    for (const side of ["left", "right"] as const) {
      const shoulder = l[LANDMARK[`${side}Shoulder`]];
      const at = (k: number) => ({ x: shoulder.x + dx * k * torso, y: shoulder.y + dy * k * torso, visibility: 1 });
      l[LANDMARK[`${side}Elbow`]] = at(0.45);
      l[LANDMARK[`${side}Wrist`]] = at(0.85);
      l[LANDMARK[`${side}Index`]] = at(1);
    }
    return l;
  };
  const down = { x: (pelvis.x - neck.x) / torso, y: (pelvis.y - neck.y) / torso };

  it("is high with the arms hanging down the body, none with them raised overhead", () => {
    expect(torsoCover(armsAlong(down.x, down.y))).toBeGreaterThan(0.8);
    expect(torsoCover(armsAlong(-down.x, -down.y))).toBe(0);
  });

  it("is lower with the arms held out in front than hanging over the chest", () => {
    expect(torsoCover(armsAlong(1, 0))).toBeLessThan(torsoCover(armsAlong(down.x, down.y)));
  });
});
