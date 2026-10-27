import { describe, expect, it } from "vitest";
import { PoseMatcher, STEADY_RADIUS } from "../src/capture/pose-matcher";
import { estimateBodyScale } from "../src/shared/pose-geometry";
import { POSE_DEFINITIONS } from "../src/shared/pose-definitions";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

const target = POSE_DEFINITIONS.punch;
const hit = buildStickFigureLandmarks("punch");
const miss = buildStickFigureLandmarks("idle");
const shifted = (by: number) => hit.map((l) => ({ ...l, x: l.x + by }));

/** Hold-timing tests skip the between-poses buffer; it has its own tests below. */
function matcher() {
  const m = new PoseMatcher(target, { armAfterMs: 0, requireBreak: false });
  m.start(0);
  return m;
}

describe("PoseMatcher buffer between poses", () => {
  it("ignores matches until the prompt has had time to play", () => {
    const m = new PoseMatcher(target, { requireBreak: false });
    m.start(0);
    const early = m.update(hit, 1000);
    expect(early).toMatchObject({ matching: false, armed: false, holdProgress: 0 });
    expect(early.events).toEqual([]);
    expect(m.update(hit, 1500).events).toEqual(["armed", "holdStarted"]);
    expect(m.update(hit, 2000).captured).toBe(true);
  });

  it("still holding the previous pose doesn't capture: they must leave the pose first", () => {
    const m = new PoseMatcher(target);
    m.start(0);
    for (let t = 0; t <= 4000; t += 100) {
      const u = m.update(hit, t);
      expect(u).toMatchObject({ matching: false, captured: false, awaitingBreak: t >= 1500 });
      // Asked once, when the buffer runs out.
      expect(u.events).toEqual(t === 1500 ? ["breakNeeded"] : []);
    }
    // Out of the pose (or out of view for a moment), then the pose, deliberately.
    expect(m.update(null, 4100).events).toEqual(["armed"]);
    expect(m.update(hit, 4200).events).toEqual(["holdStarted"]);
    expect(m.update(hit, 4700).captured).toBe(true);
  });
});

describe("PoseMatcher hold", () => {
  it("captures after 500 ms of continuous, steady match", () => {
    const m = matcher();
    expect(m.update(hit, 100).events).toEqual(["holdStarted"]);
    expect(m.update(hit, 350).holdProgress).toBeCloseTo(0.5);
    expect(m.update(hit, 599).captured).toBe(false);
    const u = m.update(hit, 600);
    expect(u.captured).toBe(true);
    expect(u.events).toEqual(["captured"]);
    expect(m.update(hit, 700).events).toEqual([]);
  });

  it("a miss or losing the person resets the hold", () => {
    const m = matcher();
    m.update(hit, 0);
    expect(m.update(miss, 450).events).toEqual(["holdBroken"]);
    expect(m.update(hit, 500).events).toEqual(["holdStarted"]);
    expect(m.update(null, 800).events).toEqual(["holdBroken"]);
    m.update(hit, 900);
    expect(m.update(hit, 1300).captured).toBe(false);
    expect(m.update(hit, 1400).captured).toBe(true);
  });

  it("moving while in the pose starts the hold over; tracking jitter doesn't", () => {
    const m = matcher();
    const limit = STEADY_RADIUS * estimateBodyScale(hit);
    m.update(hit, 0);
    expect(m.update(shifted(limit * 0.5), 300).events).toEqual([]);
    const u = m.update(shifted(limit * 1.5), 400);
    expect(u).toMatchObject({ matching: true, holdProgress: 0, events: ["moved"] });
    expect(m.update(shifted(limit * 1.5), 800).captured).toBe(false);
    expect(m.update(shifted(limit * 1.5), 900).captured).toBe(true);
  });

  it("never captures without the pose, however long it takes", () => {
    const m = matcher();
    for (let t = 0; t <= 60_000; t += 100) expect(m.update(miss, t).captured).toBe(false);
  });

  it("start() resets everything for a retake", () => {
    const m = matcher();
    m.update(hit, 0);
    m.update(hit, 600);
    expect(m.captured).toBe(true);
    m.start(10000);
    expect(m.captured).toBe(false);
    expect(m.update(miss, 10001).captured).toBe(false);
  });
});
