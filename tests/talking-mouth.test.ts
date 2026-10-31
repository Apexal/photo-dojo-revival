import { describe, expect, it } from "vitest";
import { LANDMARK } from "../src/shared/fighter-model";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import {
  DEFAULT_TALK,
  dropJaw,
  jawDropFor,
  loudnessEnvelope,
  maxJawDrop,
  mouthFrameOf,
  mouthHole,
  opennessAt,
  type MouthFrame,
} from "../src/game/render/talking-mouth";

const RATE = 8000;

/** Silence, a loud tone, silence: a quarter second each. */
function burst(): Float32Array {
  const quarter = RATE / 4;
  const out = new Float32Array(quarter * 3);
  for (let i = quarter; i < 2 * quarter; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

describe("loudness envelope", () => {
  it("opens while it's loud and shuts again after", () => {
    const env = loudnessEnvelope([burst()], RATE);
    expect(env.length).toBe(45); // 0.75 s at 60 fps
    expect(opennessAt(env, 60, 0.1)).toBe(0);
    expect(opennessAt(env, 60, 0.45)).toBeGreaterThan(0.9);
    expect(opennessAt(env, 60, 0.74)).toBeLessThan(0.05);
  });

  it("closes between syllables even when the speech stays loud", () => {
    // Loud, a little quieter (-8 dB), loud: a tenth of a second each.
    const tenth = RATE / 10;
    const speech = new Float32Array(tenth * 3).map((_, i) => (i >= tenth && i < 2 * tenth ? 0.4 : 1) * 0.8 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    const gap = (o: { syllableDb: number }) => opennessAt(loudnessEnvelope([speech], RATE, o), 60, 0.17);
    expect(gap({ syllableDb: 0 })).toBeGreaterThan(0.6);
    // Still closing (the release smoothing), but well on its way.
    expect(gap({ syllableDb: 6 })).toBeLessThan(gap({ syllableDb: 0 }) / 2);
  });

  it("keeps the mouth shut under the gate and outside the clip", () => {
    const quiet = burst().map((v, i) => (i < RATE / 4 ? 0.01 * Math.sin(i) : v));
    const env = loudnessEnvelope([quiet], RATE, { gateDb: -20 });
    expect(opennessAt(env, 60, 0.1)).toBe(0);
    expect(opennessAt(env, 60, -1)).toBe(0);
    expect(opennessAt(env, 60, 10)).toBe(0);
    expect(loudnessEnvelope([new Float32Array(RATE)], RATE).every((v) => v === 0)).toBe(true);
  });
});

describe("mouth frame", () => {
  it("finds a side-on mouth: along the face, up toward the eyes", () => {
    const l = buildStickFigureLandmarks("idle");
    const f = mouthFrameOf(l)!;
    expect(f.frontal).toBe(false);
    expect(f.along.x).toBeGreaterThan(0.8); // facing right
    expect(f.up.y).toBeLessThan(-0.5);
    const eye = l[LANDMARK.rightEye];
    expect((eye.x - f.center.x) * f.up.x + (eye.y - f.center.y) * f.up.y).toBeGreaterThan(0);
    expect(f.back).toBeLessThan(f.full);
    expect(f.full).toBeLessThan(f.front);
  });

  it("uses both corners when the face is turned to the camera", () => {
    const l = buildStickFigureLandmarks("idle").map((p) => ({ ...p }));
    const c = l[LANDMARK.mouthLeft];
    l[LANDMARK.mouthLeft] = { ...c, x: c.x - 10 };
    l[LANDMARK.mouthRight] = { ...c, x: c.x + 10 };
    const f = mouthFrameOf(l)!;
    expect(f.frontal).toBe(true);
    expect(f.width).toBeCloseTo(20);
    expect(Math.abs(f.along.x)).toBeCloseTo(1);
  });

  it("gives up on a face it can't see", () => {
    const l = buildStickFigureLandmarks("idle").map((p, i) => (i === LANDMARK.nose ? { ...p, visibility: 0.1 } : p));
    expect(mouthFrameOf(l)).toBeNull();
  });
});

describe("dropping the jaw", () => {
  // A face looking right, mouth at (100, 100), on a picture whose red is its row and green its column.
  const W = 256, H = 256;
  const src = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) src.set([y, x, 0, 255], (y * W + x) * 4);
  const f: MouthFrame = {
    center: { x: 100, y: 100 }, along: { x: 1, y: 0 }, up: { x: 0, y: -1 },
    width: 16, headSize: 40, chin: 20, back: -30, full: -10, front: 20, frontal: false,
  };
  const at = (img: Uint8ClampedArray, x: number, y: number) => [img[(y * W + x) * 4], img[(y * W + x) * 4 + 1]];

  it("doesn't move anything with the mouth shut", () => {
    expect(dropJaw(src, W, H, f, jawDropFor(f, 0))).toEqual(src);
  });

  it("drops the chin, leaves the face above the lips and the rest of the picture alone", () => {
    const out = dropJaw(src, W, H, f, 5);
    expect(at(out, 100, 110)[0]).toBeCloseTo(105, -0.5); // shows what was 5 px higher
    expect(at(out, 100, 90)).toEqual([90, 100]);
    expect(at(out, 200, 110)).toEqual([110, 200]);
    expect(at(out, 100, 220)).toEqual([220, 100]);
    // Behind the hinge the jaw doesn't move; partway there it moves less.
    expect(at(out, 65, 110)[0]).toBe(110);
    expect(at(out, 80, 110)[0]).toBeGreaterThan(105);
  });

  it("never folds, even at its widest", () => {
    const out = dropJaw(src, W, H, f, 1000);
    for (let y = 60; y < 200; y++) expect(at(out, 100, y + 1)[0]).toBeGreaterThanOrEqual(at(out, 100, y)[0]);
    // Capped at the largest drop the neck can take up: the jaw moved by exactly that.
    expect(Math.abs(at(out, 100, Math.round(110 + maxJawDrop(f)))[0] - 110)).toBeLessThanOrEqual(1);
  });

  it("drops further the louder, up to the set drop", () => {
    expect(jawDropFor(f, 0)).toBe(0);
    expect(jawDropFor(f, 0.5)).toBeLessThan(jawDropFor(f, 1));
    expect(jawDropFor(f, 1)).toBeCloseTo(DEFAULT_TALK.drop * f.headSize);
    expect(jawDropFor(f, 1, { drop: 5, curve: 1 })).toBe(maxJawDrop(f));
  });

  it("rewrites only the jaw's box in a reused buffer", () => {
    const out = new Uint8ClampedArray(src);
    dropJaw(src, W, H, f, 12, out);
    expect(dropJaw(src, W, H, f, 5, out)).toEqual(dropJaw(src, W, H, f, 5));
    expect(dropJaw(src, W, H, f, 0, out)).toEqual(src);
  });

  it("opens a gap that grows with the drop", () => {
    expect(mouthHole(f, 0)).toBeNull();
    expect(mouthHole(f, 10)!.ry).toBeGreaterThan(mouthHole(f, 4)!.ry);
  });
});
