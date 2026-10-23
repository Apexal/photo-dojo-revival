import { describe, expect, it } from "vitest";
import type { AlphaMask, Point } from "../src/game/render/arap";
import { PoseTweener, breathingStance, interpolateLandmarks, sidesFlipped, swapSides, type FrameRef, type TweenSource } from "../src/game/render/pose-tweener";
import { LANDMARK, SPRITE_CANVAS_SIZE, type NormalizedLandmark, type PoseId } from "../src/shared/fighter-model";
import { ATTACKS, poseForAction, tweenAtFrame } from "../src/shared/frame-data";
import { anchorTargetFor } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks, stickPoseParams } from "../src/shared/stick-figure";
import { ARCHETYPE_IDS, type ArchetypeId } from "../src/shared/archetypes";
import { allTweens, frameOf, tweenOf } from "../src/simulation/fight-simulation";
import { createFighterState, type FighterState } from "../src/simulation/fighter-state-machine";

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const L = LANDMARK;

/** Capsules along the stick figure's bones plus a head, like the placeholder fighters. */
function stickMask(landmarks: NormalizedLandmark[]): AlphaMask {
  const S = SPRITE_CANVAS_SIZE;
  const bones: [number, number, number][] = [
    [L.leftShoulder, L.leftHip, 22], [L.rightShoulder, L.rightHip, 22], [L.leftShoulder, L.rightShoulder, 22], [L.leftHip, L.rightHip, 22],
    ...(["left", "right"] as const).flatMap((s): [number, number, number][] => [
      [L[`${s}Shoulder`], L[`${s}Elbow`], 9], [L[`${s}Elbow`], L[`${s}Wrist`], 8],
      [L[`${s}Hip`], L[`${s}Knee`], 11], [L[`${s}Knee`], L[`${s}Ankle`], 10], [L[`${s}Ankle`], L[`${s}FootIndex`], 7],
    ]),
    [L.nose, L.nose, 26],
  ];
  const data = new Uint8ClampedArray(S * S * 4);
  for (const [a, b, r] of bones) {
    const p = landmarks[a], q = landmarks[b];
    const dx = q.x - p.x, dy = q.y - p.y, len2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(p.y, q.y) - r)); y <= Math.min(S - 1, Math.ceil(Math.max(p.y, q.y) + r)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(p.x, q.x) - r)); x <= Math.min(S - 1, Math.ceil(Math.max(p.x, q.x) + r)); x++) {
        const t = len2 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / len2)) : 0;
        if (Math.hypot(x - p.x - t * dx, y - p.y - t * dy) <= r) data[(y * S + x) * 4 + 3] = 255;
      }
    }
  }
  return { width: S, height: S, data };
}

function stickSource(frame: FrameRef, archetype: ArchetypeId = "brawler"): TweenSource {
  const landmarks = buildStickFigureLandmarks(frame.poseId, stickPoseParams(frame.poseId, archetype));
  return { mask: stickMask(landmarks), landmarks, anchor: anchorTargetFor(frame.poseId) };
}

const ref = (poseId: PoseId, variant = 0): FrameRef => ({ poseId, variant });
const state = (action: FighterState["action"], actionFrame: number): FighterState => ({ ...createFighterState(0, 1, 100), action, actionFrame });

describe("tween entries in the frame data", () => {
  it("step t evenly inside the entry and leave the frames around it hard cuts", () => {
    expect([0, 1, 2, 3].map((f) => tweenAtFrame(ATTACKS.punch.sequence, f)?.t)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(tweenAtFrame(ATTACKS.punch.sequence, 0)).toMatchObject({ from: "idle", to: "punch" });
    expect(tweenAtFrame(ATTACKS.punch.sequence, 4)).toBeNull();
    expect(tweenAtFrame(ATTACKS.punch.sequence, 7)).toMatchObject({ from: "punch", to: "idle" });
  });

  it("play as the pose they leave, so hit and hurt boxes are unchanged", () => {
    expect([0, 3, 4, 7, 10, 11].map((f) => poseForAction("punch", f))).toEqual(["idle", "idle", "punch", "punch", "punch", "idle"]);
    expect(frameOf(state("punch", 2))).toEqual(ref("idle"));
  });

  it("carry the captured version each end shows", () => {
    expect(tweenOf(state("uppercut", 12))).toMatchObject({ from: ref("punch", 1), to: ref("idle") });
    expect(tweenOf(state("lowKick", 0))).toMatchObject({ from: ref("idle"), to: ref("kick", 1) });
    expect(tweenOf(state("uppercut", 0))).toBeNull(); // crouch → uppercut stays a hard cut
    expect(tweenOf(state("idle", 0))).toBeNull();
  });

  it("lists every pair that can play, once", () => {
    const pairs = allTweens("brawler").map((t) => `${t.from.poseId}#${t.from.variant}>${t.to.poseId}#${t.to.variant}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toEqual(expect.arrayContaining(["idle#0>punch#0", "punch#0>idle#0", "idle#0>kick#0", "kick#0>idle#0", "punch#1>idle#0", "idle#0>kick#1", "kick#1>idle#0"]));
  });
});

describe("landmark interpolation", () => {
  const idle = buildStickFigureLandmarks("idle"), punch = buildStickFigureLandmarks("punch");

  it("starts and ends on the captures", () => {
    expect(interpolateLandmarks(idle, punch, 0)).toEqual(idle);
    expect(interpolateLandmarks(idle, punch, 1)).toEqual(punch);
    const almost = interpolateLandmarks(idle, punch, 1 - 1e-9);
    almost.forEach((p, i) => expect(dist(p, punch[i])).toBeLessThan(1e-4));
  });

  it("swings bones instead of shrinking them through the joint", () => {
    const bone = (l: NormalizedLandmark[], a: number, b: number) => dist(l[a], l[b]);
    for (const t of [0.25, 0.5, 0.75]) {
      const mid = interpolateLandmarks(idle, punch, t);
      for (const [a, b] of [[L.rightShoulder, L.rightElbow], [L.rightElbow, L.rightWrist], [L.rightHip, L.rightKnee]]) {
        const expected = bone(idle, a, b) + (bone(punch, a, b) - bone(idle, a, b)) * t;
        expect(bone(mid, a, b)).toBeCloseTo(expected, 6);
      }
    }
  });
});

describe("pose tweener", () => {
  const tweener = new PoseTweener(stickSource);
  const idle = buildStickFigureLandmarks("idle");
  const relative = (l: NormalizedLandmark[], poseId: PoseId) => l.map((p) => ({ ...p, x: p.x - anchorTargetFor(poseId).x, y: p.y - anchorTargetFor(poseId).y }));
  /** Where each vertex sits in the undeformed capture: uv × canvas size − anchor. */
  const restPositions = (uvs: Float32Array, poseId: PoseId) => Array.from({ length: uvs.length / 2 }, (_, i) =>
    ({ x: uvs[2 * i] * SPRITE_CANVAS_SIZE - anchorTargetFor(poseId).x, y: uvs[2 * i + 1] * SPRITE_CANVAS_SIZE - anchorTargetFor(poseId).y }));

  it("builds every tween the moves use", () => {
    for (const archetype of ARCHETYPE_IDS) {
      const own = new PoseTweener((frame) => stickSource(frame, archetype));
      for (const tween of allTweens(archetype)) expect(own.prepare(tween), `${archetype}: ${JSON.stringify(tween)}`).toBe(true);
    }
  });

  it("warps both captures onto the in-between skeleton and cross-fades them", () => {
    const t = 0.5;
    const kick = buildStickFigureLandmarks("kick");
    const [backing, ...layers] = tweener.layers({ from: ref("idle"), to: ref("kick"), t })!;
    expect(layers.map((l) => l.frame.poseId)).toEqual(["idle", "kick"]);
    expect(layers.map((l) => l.alpha)).toEqual([1, 1]);
    // From halfway the leaving capture's body backs the arriving one, solid.
    expect(backing).toMatchObject({ frame: ref("idle"), alpha: 1 });
    const between = interpolateLandmarks(relative(idle, "idle"), relative(kick, "kick"), t);
    // The vertex that started nearest a joint of the kicking leg keeps its distance to it.
    for (const layer of layers) {
      const start = relative(layer.frame.poseId === "idle" ? idle : kick, layer.frame.poseId);
      const rest = restPositions(layer.uvs, layer.frame.poseId);
      for (const joint of [L.rightKnee, L.rightAnkle, L.rightFootIndex]) {
        let nearest = 0;
        for (let i = 0; i < rest.length; i++) if (dist(rest[i], start[joint]) < dist(rest[nearest], start[joint])) nearest = i;
        const moved = { x: layer.positions[2 * nearest], y: layer.positions[2 * nearest + 1] };
        expect(dist(moved, between[joint])).toBeLessThan(dist(rest[nearest], start[joint]) + 3);
      }
    }
  });

  it("starts from the leaving capture as drawn", () => {
    const [backing, from, to] = tweener.layers({ from: ref("idle"), to: ref("punch"), t: 1e-6 })!;
    expect(backing).toMatchObject({ frame: ref("punch"), alpha: 1 });
    expect(from.alpha).toBe(1);
    expect(to.alpha).toBeCloseTo(0, 5);
    restPositions(from.uvs, "idle").forEach((p, i) => {
      expect(from.positions[2 * i]).toBeCloseTo(p.x, 0);
      expect(from.positions[2 * i + 1]).toBeCloseTo(p.y, 0);
    });
  });

  it("cuts a moving limb loose, so a fist by the chin doesn't drag the head", () => {
    const punch = buildStickFigureLandmarks("punch");
    const [backing, from] = tweener.layers({ from: ref("idle"), to: ref("punch"), t: 0.5 })!;
    const between = interpolateLandmarks(relative(idle, "idle"), relative(punch, "punch"), 0.5);
    const fist = relative(idle, "idle")[L.rightWrist];
    const rest = restPositions(from.uvs, "idle");
    // The cut duplicates vertices along it; the arm's own are the ones the body (here the backing) doesn't use.
    const body = new Set(backing.triangles);
    const arm = [...new Set(from.triangles)].filter((v) => !body.has(v));
    const nearest = arm.reduce((best, v) => (dist(rest[v], fist) < dist(rest[best], fist) ? v : best));
    const moved = { x: from.positions[2 * nearest], y: from.positions[2 * nearest + 1] };
    expect(dist(moved, between[L.rightWrist])).toBeLessThan(dist(rest[nearest], fist) + 3);
    // The punch's body, minus its arm, backs the idle capture: fewer triangles than the whole punch.
    const [, , punchLayer] = tweener.layers({ from: ref("idle"), to: ref("punch"), t: 0.2 })!;
    expect(tweener.layers({ from: ref("idle"), to: ref("punch"), t: 0.2 })![0].triangles.length).toBeLessThan(punchLayer.triangles.length);
    expect(backing.triangles.length).toBeLessThan(from.triangles.length);
  });

  it("falls back to a hard cut when a capture can't be meshed", () => {
    const empty = new PoseTweener((frame) => ({ ...stickSource(frame), mask: { width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4) } }));
    expect(empty.layers({ from: ref("idle"), to: ref("punch"), t: 0.5 })).toBeNull();
    expect(new PoseTweener(() => null).prepare({ from: ref("idle"), to: ref("kick") })).toBe(false);
  });
});

describe("left/right label flips", () => {
  // A three-quarter view: the far side sits 40 px behind, so shoulders and hips are told apart.
  const turned = buildStickFigureLandmarks("idle").map((p, i) => (i >= L.leftShoulder && i % 2 === 1 ? { ...p, x: p.x - 40 } : { ...p }));

  it("spots MediaPipe swapping the whole body's sides", () => {
    expect(sidesFlipped(turned, swapSides(turned))).toBe(true);
    expect(sidesFlipped(turned, turned)).toBe(false);
    expect(swapSides(swapSides(turned))).toEqual(turned);
  });

  it("doesn't mistake a cross (rear hand past the lead hand) for a flip", () => {
    const cross = turned.map((p) => ({ ...p }));
    cross[L.rightWrist] = { ...cross[L.leftWrist], x: cross[L.leftWrist].x + 60 };
    cross[L.rightElbow] = { ...cross[L.leftElbow], x: cross[L.leftElbow].x + 40 };
    expect(sidesFlipped(turned, cross)).toBe(false);
  });
});

describe("stand-in second stance", () => {
  const idle = buildStickFigureLandmarks("idle");
  // A fighter from before the second stance: the view hands over the idle photo with made-up landmarks.
  const tweener = new PoseTweener((frame) =>
    frame.poseId === "idle" && frame.variant === 1 ? { ...stickSource(ref("idle")), landmarks: breathingStance(idle), standIn: true } : stickSource(frame));

  it("sinks the body a little on fixed feet", () => {
    const breath = breathingStance(idle);
    for (const i of [L.leftAnkle, L.rightAnkle, L.leftFootIndex, L.rightHeel]) expect(breath[i]).toEqual(idle[i]);
    expect(breath[L.leftHip].y).toBeGreaterThan(idle[L.leftHip].y);
    expect(breath[L.nose].y - idle[L.nose].y).toBeLessThan(10);
  });

  it("sways by warping the one idle photo, no cross-fade", () => {
    const layers = tweener.layers({ from: ref("idle"), to: ref("idle", 1), t: 0.5 })!;
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ frame: ref("idle"), alpha: 1 });
    expect(tweener.prepare({ from: ref("idle"), to: ref("idle", 1) })).toBe(true);
  });

  it("leaves from the real stance", () => {
    const layers = tweener.layers({ from: ref("idle", 1), to: ref("block"), t: 0.3 })!;
    expect(layers.map((l) => l.frame)).toEqual([ref("block"), ref("idle"), ref("block")]);
  });
});
