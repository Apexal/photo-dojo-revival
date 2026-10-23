import { describe, expect, it } from "vitest";
import { STAGES, randomStage, stageFor } from "../src/game/stages/stages";

describe("stages", () => {
  it("has at least one stage, each with a unique id and a name", () => {
    expect(STAGES.length).toBeGreaterThan(0);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(STAGES.length);
    for (const s of STAGES) expect(s.name.trim()).not.toBe("");
  });

  it("finds a stage by id, falling back to the first for unknown or missing ids", () => {
    for (const s of STAGES) expect(stageFor(s.id)).toBe(s);
    expect(stageFor("no-such-stage")).toBe(STAGES[0]);
    expect(stageFor(undefined)).toBe(STAGES[0]);
  });

  it("picks a random stage from the list", () => {
    expect(randomStage(() => 0)).toBe(STAGES[0]);
    expect(randomStage(() => 0.999)).toBe(STAGES[STAGES.length - 1]);
  });
});
