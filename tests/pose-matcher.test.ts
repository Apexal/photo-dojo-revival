import { describe, expect, it } from "vitest";
import { PoseMatcher } from "../src/capture/pose-matcher";
import { POSE_DEFINITIONS } from "../src/shared/pose-definitions";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

const target = POSE_DEFINITIONS.punch;
const hit = { score: 0.5, side: "right" as const, joints: [] };
const miss = { score: 1.5, side: "right" as const, joints: [] };

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
    const early = m.updateWithEvaluation(hit, 1000);
    expect(early).toMatchObject({ matching: false, armed: false, holdProgress: 0 });
    expect(early.events).toEqual([]);
    expect(m.updateWithEvaluation(hit, 1500).events).toEqual(["armed", "holdStarted"]);
    expect(m.updateWithEvaluation(hit, 2000).captured).toBe(true);
  });

  it("still holding the previous pose doesn't capture: they must leave the pose first", () => {
    const m = new PoseMatcher(target);
    m.start(0);
    // The last pose happens to satisfy this one too, and they never move.
    for (let t = 0; t <= 4000; t += 100) {
      const u = m.updateWithEvaluation(hit, t);
      expect(u).toMatchObject({ matching: false, captured: false, awaitingBreak: t >= 1500 });
      // Asked once, when the buffer runs out.
      expect(u.events).toEqual(t === 1500 ? ["breakNeeded"] : []);
    }
    // They move (or step out of view for a moment), then pose deliberately.
    expect(m.updateWithEvaluation(miss, 4100).events).toEqual(["armed"]);
    expect(m.updateWithEvaluation(hit, 4200).events).toEqual(["holdStarted"]);
    expect(m.updateWithEvaluation(hit, 4700).captured).toBe(true);
  });

  it("a break early in the buffer counts; capture waits for the buffer to end", () => {
    const m = new PoseMatcher(target);
    m.start(0);
    m.updateWithEvaluation(null, 200); // nobody in frame
    expect(m.updateWithEvaluation(hit, 1000).matching).toBe(false);
    expect(m.updateWithEvaluation(hit, 1500).matching).toBe(true);
  });

  it("each new pose re-arms", () => {
    const m = new PoseMatcher(target);
    m.start(0);
    m.updateWithEvaluation(miss, 100);
    m.updateWithEvaluation(hit, 2000);
    m.start(5000);
    expect(m.updateWithEvaluation(hit, 7000).armed).toBe(false);
  });

  it("manual capture isn't blocked by the buffer", () => {
    const m = new PoseMatcher(target);
    m.start(0);
    m.forceCapture();
    expect(m.captured).toBe(true);
  });
});

describe("PoseMatcher", () => {
  it("captures after 500 ms of continuous match", () => {
    const m = matcher();
    expect(m.updateWithEvaluation(hit, 100).events).toEqual(["holdStarted"]);
    expect(m.updateWithEvaluation(hit, 350).holdProgress).toBeCloseTo(0.5);
    expect(m.updateWithEvaluation(hit, 599).captured).toBe(false);
    const u = m.updateWithEvaluation(hit, 600);
    expect(u.captured).toBe(true);
    expect(u.events).toEqual(["captured"]);
    expect(m.updateWithEvaluation(hit, 700).events).toEqual([]);
  });

  it("score exactly 1.0 counts as a match", () => {
    const m = matcher();
    m.updateWithEvaluation({ score: 1, side: "right", joints: [] }, 0);
    expect(m.updateWithEvaluation({ score: 1, side: "right", joints: [] }, 500).captured).toBe(true);
  });

  it("resets the hold on a miss", () => {
    const m = matcher();
    m.updateWithEvaluation(hit, 0);
    m.updateWithEvaluation(hit, 400);
    expect(m.updateWithEvaluation(miss, 450).events).toEqual(["holdBroken"]);
    expect(m.updateWithEvaluation(hit, 500).events).toEqual(["holdStarted"]);
    expect(m.updateWithEvaluation(hit, 900).captured).toBe(false);
    expect(m.updateWithEvaluation(hit, 1000).captured).toBe(true);
  });

  it("losing the person resets the hold", () => {
    const m = matcher();
    m.updateWithEvaluation(hit, 0);
    expect(m.updateWithEvaluation(null, 300).events).toEqual(["holdBroken"]);
    m.updateWithEvaluation(hit, 400);
    expect(m.updateWithEvaluation(hit, 800).captured).toBe(false);
  });

  it("widens tolerances by 1.5x after 5 s", () => {
    const m = matcher();
    expect(m.updateWithEvaluation(miss, 4999).toleranceScale).toBe(1);
    const u = m.updateWithEvaluation(miss, 5000);
    expect(u.events).toContain("tolerancesWidened");
    expect(u.toleranceScale).toBe(1.5);
  });

  it("widened tolerances apply to real landmark scoring", () => {
    // Bend the punching arm until it's just outside the normal tolerance.
    const base = buildStickFigureLandmarks("punch");
    const m = new PoseMatcher(target);
    m.start(0);
    const offTarget = base.map((l) => ({ ...l }));
    // Bend the right elbow to 145° (the tolerance edge is 150°) by rotating the forearm off the upper-arm line.
    const shoulder = offTarget[12];
    const elbow = offTarget[14];
    const wrist = offTarget[16];
    const len = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y);
    const base0 = Math.atan2(elbow.y - shoulder.y, elbow.x - shoulder.x);
    const a = base0 - (35 * Math.PI) / 180;
    offTarget[16] = { ...wrist, x: elbow.x + len * Math.cos(a), y: elbow.y + len * Math.sin(a) };
    expect(m.update(offTarget, 100).matching).toBe(false);
    expect(m.update(offTarget, 5100).matching).toBe(true);
  });

  it("offers manual capture after 10 s", () => {
    const m = matcher();
    expect(m.updateWithEvaluation(miss, 9999).manualCaptureAvailable).toBe(false);
    const u = m.updateWithEvaluation(miss, 10000);
    expect(u.manualCaptureAvailable).toBe(true);
    expect(u.events).toEqual(["manualAvailable"]);
    m.forceCapture();
    expect(m.captured).toBe(true);
  });

  it("records the limb that matched", () => {
    const m = matcher();
    m.updateWithEvaluation({ score: 0.2, side: "left", joints: [] }, 0);
    m.updateWithEvaluation({ score: 0.2, side: "left", joints: [] }, 500);
    expect(m.side).toBe("left");
  });

  it("start() resets everything for a retake", () => {
    const m = matcher();
    m.updateWithEvaluation(hit, 0);
    m.updateWithEvaluation(hit, 600);
    m.updateWithEvaluation(miss, 6000);
    m.start(10000);
    expect(m.captured).toBe(false);
    expect(m.toleranceScale).toBe(1);
    expect(m.updateWithEvaluation(miss, 10001).manualCaptureAvailable).toBe(false);
  });
});
