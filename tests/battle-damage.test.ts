import { describe, expect, it } from "vitest";
import { LANDMARK, type NormalizedLandmark } from "../src/shared/fighter-model";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { MAX_HEALTH } from "../src/simulation/round-rules";
import type { RoundSummary } from "../src/simulation/match-stats";
import { DAMAGE_PER_SCAR, SCAR_ORDER, damageInRounds, headOf, scarCount, scarsOn, type ScarKind } from "../src/game/render/battle-damage";

const round = (health: [number, number]) => ({ health }) as RoundSummary;

describe("battle damage", () => {
  it("adds a scar per stretch of health lost, up to all of them", () => {
    expect(scarCount(0)).toBe(0);
    expect(scarCount(DAMAGE_PER_SCAR - 1)).toBe(0);
    expect(scarCount(DAMAGE_PER_SCAR)).toBe(1);
    // Beaten in two rounds: every scar.
    expect(scarCount(2 * MAX_HEALTH)).toBe(SCAR_ORDER.length);
    expect(scarCount(10 * MAX_HEALTH)).toBe(SCAR_ORDER.length);
  });

  it("counts the health lost in rounds already over", () => {
    expect(damageInRounds([round([0, 60]), round([30, 0])], 0)).toBe(MAX_HEALTH + 70);
    expect(damageInRounds([round([0, 60]), round([30, 0])], 1)).toBe(40 + MAX_HEALTH);
    expect(damageInRounds([], 1)).toBe(0);
  });

  it("finds the head of a side-on fighter: forward toward the nose, up out of the top", () => {
    const head = headOf(buildStickFigureLandmarks("idle"))!;
    expect(head).not.toBeNull();
    expect(head.forward.x).toBeGreaterThan(0.5); // facing right
    expect(head.up.y).toBeLessThan(-0.5); // y down: up is negative
    expect(head.size).toBeGreaterThan(1);
  });

  it("has no head when the face can't be seen", () => {
    const l = buildStickFigureLandmarks("idle").map((p, i) => (i === LANDMARK.nose ? { ...p, visibility: 0.1 } : p));
    expect(headOf(l)).toBeNull();
  });

  const scar = (l: NormalizedLandmark[], kind: ScarKind) => scarsOn(l, SCAR_ORDER.length).find((s) => s.kind === kind)!;

  it("puts the black eye on the eye and the bump above the ear, following the head when it tips over", () => {
    const l = buildStickFigureLandmarks("idle");
    const head = headOf(l)!;
    expect(scar(l, "blackEye").at).toEqual({ x: head.eye.x, y: head.eye.y });
    expect(scar(l, "bump").at.y).toBeLessThan(head.ear.y - 0.5 * head.size);

    // The same fighter lying on their back (a quarter turn, head to the left): the bump is now left of the ear.
    const nose = l[LANDMARK.nose];
    const lying = l.map((p) => ({ ...p, x: nose.x + (p.y - nose.y), y: nose.y - (p.x - nose.x) }));
    const turned = headOf(lying)!;
    expect(scar(lying, "bump").at.x).toBeLessThan(turned.ear.x - 0.5 * turned.size);
  });

  it("spreads over the body: a bandaged forearm and a bruised shin on the surer limb", () => {
    const l = buildStickFigureLandmarks("idle").map((p, i) =>
      i === LANDMARK.leftElbow || i === LANDMARK.leftWrist || i === LANDMARK.leftKnee || i === LANDMARK.leftAnkle ? { ...p, visibility: 0.2 } : p);
    const between = (at: { x: number; y: number }, a: NormalizedLandmark, b: NormalizedLandmark) => {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return Math.hypot(at.x - mid.x, at.y - mid.y);
    };
    const bone = (a: number, b: number) => Math.hypot(l[a].x - l[b].x, l[a].y - l[b].y);
    expect(between(scar(l, "armWrap").at, l[LANDMARK.rightElbow], l[LANDMARK.rightWrist])).toBeLessThan(0.1 * bone(LANDMARK.rightElbow, LANDMARK.rightWrist));
    expect(between(scar(l, "shinBruise").at, l[LANDMARK.rightKnee], l[LANDMARK.rightAnkle])).toBeLessThan(0.1 * bone(LANDMARK.rightKnee, LANDMARK.rightAnkle));
    // The second scar is already on the body.
    expect(SCAR_ORDER.slice(0, 2)).toContain("armWrap");
  });

  it("leaves out scars it can't place, keeping the rest", () => {
    const faceless = buildStickFigureLandmarks("idle").map((p, i) => (i === LANDMARK.nose ? { ...p, visibility: 0.1 } : p));
    expect(scarsOn(faceless, SCAR_ORDER.length).map((s) => s.kind)).toEqual(["armWrap", "shinBruise", "kneePatch"]);
  });

  it("gives scars in order, as many as asked for", () => {
    const l = buildStickFigureLandmarks("idle");
    expect(scarsOn(l, 0)).toEqual([]);
    expect(scarsOn(l, SCAR_ORDER.length).map((s) => s.kind)).toEqual(SCAR_ORDER);
  });
});
