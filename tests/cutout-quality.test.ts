import { describe, expect, it } from "vitest";
import { assessCutout, cutoutAdvice } from "../src/capture/cutout-quality";
import { keepPerson, skeletonPrior, type Rect } from "../src/capture/matting";
import { LANDMARK, type NormalizedLandmark } from "../src/shared/fighter-model";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

// A 512×512 crop sitting inside a bigger frame, so the person doesn't touch the frame's edges.
const S = 512;
const rect: Rect = { x: 200, y: 40, width: S, height: S };
const FRAME = { frameWidth: 1000, frameHeight: 640 };
const idle = buildStickFigureLandmarks("idle");
const inFrame = (lms: NormalizedLandmark[]) => lms.map((l) => ({ ...l, x: l.x + rect.x, y: l.y + rect.y }));
/** A person a bit slimmer than the prior's capsules, as real limbs are. */
const body = skeletonPrior(idle, S, S, { scale: 0.6, falloffScale: 0 }).map((v) => (v >= 1 ? 1 : 0));

const matte = (modelAlpha: Float32Array, landmarks = idle) => keepPerson(modelAlpha, S, S, landmarks);

const assess = (alpha: ArrayLike<number>, landmarks: NormalizedLandmark[] = inFrame(idle), frame = FRAME) =>
  assessCutout({ alpha, rect, landmarks, ...frame });

describe("cut-out quality check", () => {
  it("passes a clean cut-out", () => {
    const q = assess(matte(Float32Array.from(body)));
    expect(q.issues).toEqual([]);
    expect(q.coreMissing).toBeLessThan(0.02);
  });

  it("flags background stuck to the person", () => {
    const q = assess(matte(new Float32Array(S * S).fill(0.95))); // the model thinks the wall is person too
    expect(q.issues).toContain("background");
    expect(q.marginFilled).toBeGreaterThan(0.4);
  });

  it("flags holes in the body", () => {
    const alpha = matte(Float32Array.from(body));
    const hip = idle[LANDMARK.leftHip];
    const shoulder = idle[LANDMARK.leftShoulder];
    for (let y = Math.round(shoulder.y); y < hip.y; y++) for (let x = 0; x < S; x++) alpha[y * S + x] = 0; // dark shirt lost
    expect(assess(alpha).issues).toContain("holes");
  });

  it("flags a hand missing from the cut-out", () => {
    const alpha = matte(Float32Array.from(body));
    const wrist = idle[LANDMARK.rightWrist];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (Math.hypot(x - wrist.x, y - wrist.y) < 60) alpha[y * S + x] = 0;
    }
    const q = assess(alpha);
    expect(q.issues).toContain("cutOff");
    expect(q.cutOff).toContain("right hand");
  });

  it("flags feet below the frame", () => {
    const alpha = matte(Float32Array.from(body));
    const q = assess(alpha, inFrame(idle), { frameWidth: 1000, frameHeight: 480 });
    expect(q.issues).toContain("cutOff");
    expect(q.cutOff).toEqual(expect.arrayContaining(["left foot", "right foot"]));
  });

  it("flags a person running off the edge even when the landmarks are inside", () => {
    const alpha = matte(Float32Array.from(body));
    const tight = { x: 0, y: 0, width: S, height: S };
    const q = assessCutout({ alpha, rect: tight, landmarks: idle, frameWidth: S, frameHeight: 470 + 40 });
    expect(q.cutOff).toContain("edge");
    // The feet are what reach that border.
    expect(q.edges[0]).toBe("bottom");
  });

  it("doesn't hold a hidden limb to the cut-out (MediaPipe's guess for it can land off the body)", () => {
    // The near arm only: the far arm is behind the body, so the photo shows no far arm at all.
    const near = idle.map((l, i) => ([LANDMARK.leftElbow, LANDMARK.leftWrist].includes(i as 13 | 15) ? { ...l, visibility: 0 } : l));
    const alpha = matte(Float32Array.from(skeletonPrior(near, S, S, { scale: 0.6, falloffScale: 0 }).map((v) => (v >= 1 ? 1 : 0))));
    // MediaPipe guesses the hidden arm, with low confidence, a little behind the back.
    const T = Math.hypot(idle[LANDMARK.leftShoulder].x - idle[LANDMARK.leftHip].x, idle[LANDMARK.leftShoulder].y - idle[LANDMARK.leftHip].y);
    const guessed = idle.map((l, i) => ([LANDMARK.leftElbow, LANDMARK.leftWrist].includes(i as 13 | 15) ? { ...l, x: l.x - 1.2 * T, visibility: 0.5 } : l));
    expect(assess(alpha, inFrame(guessed)).issues).toEqual([]);
    // Seen clearly there, though, it is missing: that's a real hole.
    const seenThere = guessed.map((l, i) => ([LANDMARK.leftElbow, LANDMARK.leftWrist].includes(i as 13 | 15) ? { ...l, visibility: 0.95 } : l));
    expect(assess(alpha, inFrame(seenThere)).issues).not.toEqual([]);
  });

  it("passes clean cut-outs of every pose despite MediaPipe's usual joint error (a few pixels)", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const poseId of ["idle", "walk", "block", "crouch", "punch", "kick", "jump", "hurt", "win", "handshake"] as const) {
      const lms = buildStickFigureLandmarks(poseId);
      // Limbs at real widths: a side-on forearm is ~0.08 torso lengths half-wide (the old, wider core failed this).
      const person = Uint8Array.from(skeletonPrior(lms, S, S, { scale: 0.22, falloffScale: 0 }), (v) => (v >= 1 ? 255 : 0));
      const T = Math.hypot(lms[LANDMARK.leftShoulder].x - lms[LANDMARK.leftHip].x, lms[LANDMARK.leftShoulder].y - lms[LANDMARK.leftHip].y);
      for (let trial = 0; trial < 5; trial++) {
        const off = lms.map((l) => ({ ...l, x: l.x + (rnd() - 0.5) * 0.08 * T, y: l.y + (rnd() - 0.5) * 0.08 * T }));
        expect(assess(person, inFrame(off)).issues, `${poseId} #${trial}`).toEqual([]);
      }
    }
  });


  it("says what to change for the next try, for the first issue", () => {
    const advice = (issues: ("holes" | "background" | "cutOff")[], cutOff: string[] = [], edges: ("left" | "right" | "top" | "bottom")[] = []) =>
      cutoutAdvice({ issues, cutOff, edges });
    expect(advice(["background", "cutOff"])).toBe("Step away from furniture, in front of a plain wall.");
    expect(advice(["cutOff"], ["left foot"])).toMatch(/in the frame/);
    expect(advice(["holes"])).toMatch(/light/);
    expect(advice([])).toBe("");
    // Running into the photo's border: which way to go, never "left" or "right" (the preview may be mirrored).
    expect(advice(["cutOff"], ["edge"], ["bottom"])).toMatch(/Step back.*feet.*bottom/);
    expect(advice(["cutOff"], ["edge"], ["top"])).toMatch(/Step back.*head.*top/);
    expect(advice(["cutOff"], ["edge"], ["right"])).toMatch(/middle of the picture/);
    expect(advice(["cutOff"], ["edge"], ["left", "bottom"])).not.toMatch(/\b(left|right)\b/);
  });
});
