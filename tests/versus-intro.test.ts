import { describe, expect, it } from "vitest";
import { ARCHETYPES, type ArchetypeId } from "../src/shared/archetypes";
import { LANDMARK } from "../src/shared/fighter-model";
import type { FighterGeometry, PoseGeometry } from "../src/shared/frame-data";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { POSE_IDS } from "../src/shared/fighter-model";
import { TAPE_STATS, TYPICAL_TAPE, formatTape, measureFighter, tapeEdges, tapeVerdict } from "../src/game/tale-of-the-tape";
import { POSE_HOLD_FRAME, VICTORY_HOLD_FRAMES, cycleLength, moveFrames, routineAt, routineLength, showOffRoutine, signatureStartFrame } from "../src/game/versus-intro";

const geo = stickFigureGeometry();

/** The same fighter with every forearm stretched (elbow → wrist, and the hand with it) by `factor`. */
function longArms(factor: number): FighterGeometry {
  const stretch = (pose: PoseGeometry): PoseGeometry => {
    const landmarks = pose.landmarks.map((l) => ({ ...l }));
    for (const side of ["left", "right"] as const) {
      const elbow = landmarks[LANDMARK[`${side}Elbow`]];
      const wrist = pose.landmarks[LANDMARK[`${side}Wrist`]];
      const dx = (wrist.x - elbow.x) * (factor - 1), dy = (wrist.y - elbow.y) * (factor - 1);
      for (const joint of ["Wrist", "Pinky", "Index", "Thumb"] as const) {
        const l = landmarks[LANDMARK[`${side}${joint}`]];
        landmarks[LANDMARK[`${side}${joint}`]] = { ...l, x: l.x + dx, y: l.y + dy };
      }
    }
    return { ...pose, landmarks };
  };
  const poses = Object.fromEntries(POSE_IDS.map((id) => [id, stretch(geo[id])]));
  const variants = Object.fromEntries(Object.entries(geo.variants ?? {}).map(([id, list]) => [id, list!.map(stretch)]));
  return { ...geo, ...poses, variants };
}

describe("tale of the tape", () => {
  it("measures an average build as regulation", () => {
    const tape = measureFighter(geo);
    for (const stat of TAPE_STATS) {
      expect(tape[stat] / TYPICAL_TAPE[stat]).toBeGreaterThan(0.96);
      expect(tape[stat] / TYPICAL_TAPE[stat]).toBeLessThan(1.04);
      expect(tapeVerdict(stat, tape[stat])).toBe("regulation");
    }
    expect(formatTape(tape.height)).toMatch(/^\d\.\d torsos$/);
  });

  it("calls long arms suspiciously long and gives them the edge on reach only", () => {
    const [a, b] = [measureFighter(geo), measureFighter(longArms(1.6))];
    expect(b.reach).toBeGreaterThan(a.reach * 1.2);
    expect(b.legs).toBeCloseTo(a.legs, 6);
    expect(tapeVerdict("reach", b.reach)).toBe("suspiciously long");
    expect(tapeEdges(a, b)).toEqual({ stats: { height: null, reach: 1, legs: null }, overall: 1 });
  });

  it("picks verdicts from well short to well past average", () => {
    expect(tapeVerdict("reach", TYPICAL_TAPE.reach * 0.8)).toBe("T. rex arms");
    expect(tapeVerdict("legs", TYPICAL_TAPE.legs * 0.93)).toBe("sturdy");
    expect(tapeVerdict("height", TYPICAL_TAPE.height * 1.07)).toBe("towering");
    expect(tapeVerdict("legs", TYPICAL_TAPE.legs * 1.3)).toBe("all legs");
  });

  it("calls it even when nobody has more edges", () => {
    const a = { height: 3.3, reach: 1.2, legs: 1.5 }, b = { height: 3.3, reach: 1.1, legs: 1.6 };
    expect(tapeEdges(a, b)).toEqual({ stats: { height: null, reach: 0, legs: 1 }, overall: null });
    expect(tapeEdges(a, a).overall).toBeNull();
  });
});

describe("show-off routine", () => {
  it("punches, kicks, uppercuts, does the signature move, then holds the victory pose", () => {
    for (const archetype of Object.keys(ARCHETYPES) as ArchetypeId[]) {
      const routine = showOffRoutine(archetype);
      const moves = routine.filter((s) => s.action !== "idle").map((s) => s.action);
      expect(moves).toEqual(["punch", "kick", "uppercut", ARCHETYPES[archetype].move, "taunt"]);
      for (const step of routine.slice(0, -1)) expect(step.frames).toBe(step.action === "idle" ? step.frames : moveFrames(step.action));
      expect(routineAt(routine, routineLength(routine) + 50)).toMatchObject({ action: "taunt", actionFrame: POSE_HOLD_FRAME });
      const start = signatureStartFrame(routine, archetype);
      expect(routineAt(routine, start)).toMatchObject({ action: ARCHETYPES[archetype].move, actionFrame: 0 });
      // Under five seconds of showing off.
      expect(routineLength(routine)).toBeLessThan(300);
    }
  });

  it("stands ready before it starts, and plays each move from its first frame", () => {
    const routine = showOffRoutine("brawler");
    expect(routineAt(routine, -5)).toEqual({ action: "idle", actionFrame: 0, step: -1 });
    const punchAt = routine[0].frames;
    expect(routineAt(routine, punchAt)).toMatchObject({ action: "punch", actionFrame: 0 });
    expect(routineAt(routine, punchAt + 3)).toMatchObject({ action: "punch", actionFrame: 3 });
    expect(routineAt(routine, punchAt + moveFrames("punch"))).toMatchObject({ action: "idle", actionFrame: 0 });
  });

  it("holds the victory pose a while, then goes round again", () => {
    const routine = showOffRoutine("acrobat");
    const cycle = cycleLength(routine);
    expect(cycle).toBe(routineLength(routine) + VICTORY_HOLD_FRAMES);
    expect(routineAt(routine, cycle - 1)).toMatchObject({ action: "taunt", actionFrame: POSE_HOLD_FRAME });
    for (const f of [0, 40, 100, 200]) expect(routineAt(routine, cycle + f)).toEqual(routineAt(routine, f));
    // 15 seconds is room for two goes and most of a third.
    expect(Math.floor((15 * 60) / cycle)).toBeGreaterThanOrEqual(2);
  });
});
