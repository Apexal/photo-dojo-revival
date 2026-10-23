import { describe, expect, it } from "vitest";
import { assessCutout, describeCutoutIssues } from "../src/capture/cutout-quality";
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
  });

  it("describes the issues in plain words", () => {
    expect(describeCutoutIssues(["background", "cutOff"])).toBe("some background came along, part of you is cut off");
  });
});
