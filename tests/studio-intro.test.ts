import { describe, expect, it } from "vitest";
import { INTRO_SCENES, INTRO_TOTAL_MS, introSceneAt } from "../src/studio/ui/intro";

describe("How it works", () => {
  it("plays the scenes in order and stops on the last", () => {
    expect(introSceneAt(0)).toEqual({ index: 0, t: 0, done: false });
    const first = INTRO_SCENES[0].ms;
    expect(introSceneAt(first / 2)).toEqual({ index: 0, t: 0.5, done: false });
    expect(introSceneAt(first)).toMatchObject({ index: 1, t: 0 });
    expect(introSceneAt(INTRO_TOTAL_MS - 1)).toMatchObject({ index: INTRO_SCENES.length - 1, done: false });
    expect(introSceneAt(INTRO_TOTAL_MS + 5000)).toEqual({ index: INTRO_SCENES.length - 1, t: 1, done: true });
  });

  it("walks through the whole studio, short enough to sit through", () => {
    expect(INTRO_SCENES.map((s) => s.id)).toEqual(["become", "style", "pose", "cutout", "sounds", "fight"]);
    expect(INTRO_TOTAL_MS).toBeLessThanOrEqual(40_000);
  });
});
