import { describe, expect, it } from "vitest";
import { LANDMARK, type LandmarkName, type NormalizedLandmark } from "../src/shared/fighter-model";
import { estimateBodyScale, flipLandmarksHorizontally } from "../src/shared/pose-geometry";
import { swapSides } from "../src/shared/side-flips";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { LIVE_STRIDE_MARGIN, STRIDE_LIMITS, compareStep, stepAdvice } from "../src/shared/walk-step";

const WIDTH = 512;
const photo = (landmarks: NormalizedLandmark[], width = WIDTH) => ({ landmarks, width });
const stance = buildStickFigureLandmarks("idle");
const step = buildStickFigureLandmarks("walk");

/** The same photo with the legs' labels swapped (the other foot forward), arms and torso as they were. */
function otherFootForward(l: NormalizedLandmark[]): NormalizedLandmark[] {
  const out = l.map((p) => ({ ...p }));
  for (const part of ["Hip", "Knee", "Ankle", "Heel", "FootIndex"]) {
    const left = LANDMARK[`left${part}` as LandmarkName], right = LANDMARK[`right${part}` as LandmarkName];
    [out[left], out[right]] = [l[right], l[left]];
  }
  return out;
}

/** Moved and scaled in the frame, like the same person a step closer to the camera. */
const elsewhere = (l: NormalizedLandmark[]) => l.map((p) => ({ ...p, x: p.x * 1.3 + 80, y: p.y * 1.3 - 40 }));

describe("the stance and the step make a walk", () => {
  it("passes the built-in stance and step", () => {
    expect(compareStep(photo(stance), photo(step))).toBeNull();
  });

  it("doesn't care where in the frame, how big, or which way they face", () => {
    expect(compareStep(photo(stance), photo(elsewhere(step), 900))).toBeNull();
    expect(compareStep(photo(flipLandmarksHorizontally(stance, WIDTH)), photo(step))).toBeNull();
  });

  it("isn't fooled by MediaPipe swapping a whole side-on body's labels", () => {
    expect(compareStep(photo(stance), photo(swapSides(step)))).toBeNull();
  });

  it("isn't fooled by a fighter looking at the camera from a side-on stance", () => {
    // The nose a hair behind the ears: the head alone says they face the other way.
    const lookingAtCamera = (l: NormalizedLandmark[]) => {
      const out = l.map((p) => ({ ...p }));
      out[LANDMARK.nose].x = (out[LANDMARK.leftEar].x + out[LANDMARK.rightEar].x) / 2 - 3;
      return out;
    };
    expect(compareStep(photo(lookingAtCamera(stance)), photo(step))).toBeNull();
    expect(compareStep(photo(stance), photo(lookingAtCamera(step)))).toBeNull();
  });

  it("catches a step through with the back foot (the other foot in front)", () => {
    expect(compareStep(photo(stance), photo(otherFootForward(step)))).toBe("switchedFeet");
  });

  it("catches a step no wider than the stance", () => {
    expect(compareStep(photo(stance), photo(stance))).toBe("tooNarrow");
    // A wide stance with that same step: not enough gained.
    expect(compareStep(photo(step), photo(step))).toBe("tooNarrow");
  });

  it("live asks for a bit more stride than the photo, so a step that goes green passes as a photo", () => {
    // The front foot slid out just far enough for the photo.
    const ankleGap = (l: NormalizedLandmark[]) => Math.abs(l[LANDMARK.leftAnkle].x - l[LANDMARK.rightAnkle].x) / estimateBodyScale(l);
    const front = stance[LANDMARK.leftAnkle].x > stance[LANDMARK.rightAnkle].x ? "left" : "right";
    const slid = (gain: number) => stance.map((p, i) => {
      const foot: number[] = [`${front}Ankle`, `${front}Heel`, `${front}FootIndex`].map((n) => LANDMARK[n as LandmarkName]);
      return foot.includes(i) ? { ...p, x: p.x + gain * estimateBodyScale(stance) } : p;
    });
    const justEnough = slid(STRIDE_LIMITS.min + 0.05);
    expect(ankleGap(justEnough) - ankleGap(stance)).toBeCloseTo(STRIDE_LIMITS.min + 0.05);
    expect(compareStep(photo(stance), photo(justEnough))).toBeNull();
    expect(compareStep(photo(stance), photo(justEnough), STRIDE_LIMITS.min + LIVE_STRIDE_MARGIN)).toBe("tooNarrow");
    expect(compareStep(photo(stance), photo(slid(STRIDE_LIMITS.min + LIVE_STRIDE_MARGIN + 0.05)), STRIDE_LIMITS.min + LIVE_STRIDE_MARGIN)).toBeNull();
  });

  it("says what to change for whichever photo is being taken", () => {
    expect(stepAdvice("switchedFeet", "step").spoken).toMatch(/front foot/);
    expect(stepAdvice("tooNarrow", "step").spoken).toMatch(/Bigger step/);
    expect(stepAdvice("tooNarrow", "stance").shown).toMatch(/closer together/);
    expect(stepAdvice("switchedFeet", "stance").shown).toMatch(/Same front foot/);
  });
});
