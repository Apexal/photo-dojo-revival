import { describe, expect, it } from "vitest";
import { LANDMARK, type LandmarkName, type NormalizedLandmark } from "../src/shared/fighter-model";
import { flipLandmarksHorizontally } from "../src/shared/pose-geometry";
import { swapSides } from "../src/shared/side-flips";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { compareStep, stepAdvice } from "../src/shared/walk-step";

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

  it("catches a step through with the back foot (the other foot in front)", () => {
    expect(compareStep(photo(stance), photo(otherFootForward(step)))).toBe("switchedFeet");
  });

  it("catches a step no wider than the stance", () => {
    expect(compareStep(photo(stance), photo(stance))).toBe("tooNarrow");
    // A wide stance with that same step: not enough gained.
    expect(compareStep(photo(step), photo(step))).toBe("tooNarrow");
  });

  it("says what to change for whichever photo is being taken", () => {
    expect(stepAdvice("switchedFeet", "step").spoken).toMatch(/front foot/);
    expect(stepAdvice("tooNarrow", "step").spoken).toMatch(/Bigger step/);
    expect(stepAdvice("tooNarrow", "stance").shown).toMatch(/closer together/);
    expect(stepAdvice("switchedFeet", "stance").shown).toMatch(/Same front foot/);
  });
});
