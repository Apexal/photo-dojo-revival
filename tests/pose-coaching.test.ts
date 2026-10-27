import { describe, expect, it } from "vitest";
import { PoseCoach, STILL_TOLERANCE_SLACK, checkStillPose, correctionArrows, correctionFor, segmentBands } from "../src/capture/pose-coaching";
import { LANDMARK } from "../src/shared/fighter-model";
import { POSE_DEFINITIONS } from "../src/shared/pose-definitions";
import { computeJointAngles, evaluatePose, type JointError, type JointName } from "../src/shared/pose-geometry";
import { STICK_SEGMENTS, buildStickFigureLandmarks } from "../src/shared/stick-figure";

const err = (joint: JointName, delta: number, error = Math.abs(delta) / 20): JointError => ({ joint, delta, error });

const segment = (a: number, b: number) => STICK_SEGMENTS.findIndex(([x, y]) => x === a && y === b);

describe("corrections", () => {
  it("points the way from the sign of the error", () => {
    expect(correctionFor("rightElbow", -40)).toBe("Straighten your arm more");
    expect(correctionFor("rightElbow", 40)).toBe("Bend your elbow more");
    expect(correctionFor("leftShoulderElevation", -30)).toBe("Raise your arm higher");
    expect(correctionFor("rightHipFlexion", -30)).toBe("Lift your leg higher");
    expect(correctionFor("legSpread", -10)).toBe("Feet further apart");
    expect(correctionFor("torsoLean", 12)).toBe("Stand up straighter");
  });

});

describe("segment bands", () => {
  it("colours the bones each joint is measured on, worst wins, others unchecked", () => {
    const bands = segmentBands([err("rightElbow", 10), err("rightShoulderElevation", 60)]);
    expect(bands[segment(LANDMARK.rightShoulder, LANDMARK.rightElbow)]).toBe("off"); // both joints use the upper arm
    expect(bands[segment(LANDMARK.rightElbow, LANDMARK.rightWrist)]).toBe("good");
    expect(bands[segment(LANDMARK.leftShoulder, LANDMARK.leftElbow)]).toBeNull();
  });

  it("ignores joints that aren't visible", () => {
    expect(segmentBands([{ joint: "leftKnee", delta: null, error: Infinity }]).every((b) => b === null)).toBe(true);
  });
});

describe("PoseCoach", () => {
  const quiet = { quietAfterStartMs: 0 };

  it("names the worst joint out of tolerance, and nothing once all are in", () => {
    const coach = new PoseCoach(quiet);
    coach.start(0);
    expect(coach.update([err("rightElbow", -30), err("rightShoulderElevation", -60)], 0).correction)
      .toEqual({ joint: "rightShoulderElevation", text: "Raise your arm higher" });
    const fixed = [err("rightElbow", -10), err("rightShoulderElevation", 5)];
    coach.update(fixed, 100);
    expect(coach.update(fixed, 700).correction).toBeNull();
  });

  it("rides out tracking gaps without resetting, but doesn't speak during them", () => {
    const coach = new PoseCoach({ quietAfterStartMs: 0, speakAfterMs: 1000, dropAfterMs: 600 });
    coach.start(0);
    const off = [err("rightKnee", -40)];
    coach.update(off, 0);
    expect(coach.update([], 300).correction?.text).toBe("Straighten your leg"); // a dropped frame
    expect(coach.update([err("rightKnee", -10)], 550)).toEqual({ correction: { joint: "rightKnee", text: "Straighten your leg" }, speak: false, progress: null });
    expect(coach.update(off, 1000).speak).toBe(true); // the timer kept running through the gap
    coach.update([], 1100);
    expect(coach.update([], 1700).correction).toBeNull(); // gone long enough: fixed
  });

  it("sticks with a correction until it's fixed or another has been worse for a while", () => {
    const coach = new PoseCoach({ ...quiet, switchAfterMs: 1000 });
    coach.start(0);
    coach.update([err("rightElbow", -60), err("legSpread", -30)], 0);
    const worseLegs = [err("rightElbow", -40), err("legSpread", -60)];
    expect(coach.update(worseLegs, 500).correction?.text).toBe("Straighten your arm more");
    expect(coach.update(worseLegs, 1500).correction?.text).toBe("Feet further apart");
    // Fixed (for long enough to not be jitter): on to the next one.
    const legsFixed = [err("rightElbow", -40), err("legSpread", 5)];
    coach.update(legsFixed, 1600);
    expect(coach.update(legsFixed, 2200).correction?.text).toBe("Straighten your arm more");
  });

  it("treats an attack pose switching sides as the same correction", () => {
    const coach = new PoseCoach(quiet);
    coach.start(0);
    coach.update([err("rightElbow", -60)], 0);
    const update = coach.update([err("leftElbow", -50), err("legSpread", -70)], 100);
    expect(update.correction).toEqual({ joint: "leftElbow", text: "Straighten your arm more" });
  });

  it("speaks once a correction has settled, not during the prompt, not too often", () => {
    const coach = new PoseCoach({ quietAfterStartMs: 3000, speakAfterMs: 1200, repeatMs: 5000 });
    coach.start(0);
    const off = [err("rightKnee", -40)];
    expect(coach.update(off, 0).speak).toBe(false);
    expect(coach.update(off, 2000).speak).toBe(false); // settled, but the prompt is still playing
    expect(coach.update(off, 3000).speak).toBe(true);
    expect(coach.update(off, 3100).speak).toBe(false);
    expect(coach.update(off, 8000).speak).toBe(true);
  });

  it("tells someone in their stance what to change for real poses", () => {
    const coach = new PoseCoach(quiet);
    const stance = buildStickFigureLandmarks("idle");
    const advice = (poseId: "punch" | "win" | "crouch") => {
      coach.start(0);
      return coach.update(evaluatePose(stance, POSE_DEFINITIONS[poseId]).joints, 0).correction?.text;
    };
    expect(advice("punch")).toBe("Straighten your arm more");
    expect(advice("win")).toBe("Raise your arm higher");
    expect(advice("crouch")).toMatch(/Bend your knee more|Lift your leg higher/);
  });

  it("start() forgets the last pose", () => {
    const coach = new PoseCoach({ quietAfterStartMs: 0, speakAfterMs: 0 });
    coach.start(0);
    expect(coach.update([err("rightKnee", -40)], 0).speak).toBe(true);
    coach.start(100);
    expect(coach.update([err("rightKnee", -40)], 100).speak).toBe(true);
  });
});

describe("correction arrows", () => {
  const stance = buildStickFigureLandmarks("idle");
  /** The arrows for one joint of `poseId`, coaching someone in fighting stance. */
  const arrowsFor = (poseId: "punch" | "win" | "kick", joint: JointName) => {
    const j = evaluatePose(stance, POSE_DEFINITIONS[poseId]).joints.find((x) => x.joint === joint)!;
    return correctionArrows(stance, joint, j.delta!);
  };

  it("raises the arm upward for the victory pose (y grows downward)", () => {
    const [arrow] = arrowsFor("win", "rightShoulderElevation");
    expect(arrow.from).toMatchObject({ x: stance[LANDMARK.rightWrist].x, y: stance[LANDMARK.rightWrist].y });
    expect(arrow.to.y).toBeLessThan(arrow.from.y);
  });

  it("lifts the foot for the kick", () => {
    const [arrow] = arrowsFor("kick", "rightHipFlexion");
    expect(arrow.to.y).toBeLessThan(arrow.from.y);
  });

  it("points the way that brings the angle toward its target, for either limb", () => {
    for (const joint of ["rightElbow", "leftElbow"] as const) {
      const [arrow] = arrowsFor("punch", joint === "rightElbow" ? "rightElbow" : "leftElbow");
      if (!arrow) continue; // the guard hand may already be in tolerance
      const moved = stance.map((l, i) => (i === LANDMARK[joint === "rightElbow" ? "rightWrist" : "leftWrist"] ? { ...l, ...arrow.to } : l));
      const target = POSE_DEFINITIONS.punch.angleTargets.find((t) => t.joint === joint)!.degrees;
      expect(Math.abs(computeJointAngles(moved)[joint]! - target)).toBeLessThan(Math.abs(computeJointAngles(stance)[joint]! - target));
    }
  });

  it("spreads both feet apart for a wider stance", () => {
    const arrows = correctionArrows(stance, "legSpread", -30);
    expect(arrows).toHaveLength(2);
    const gap = (a: number, b: number) => Math.abs(a - b);
    expect(gap(arrows[0].to.x, arrows[1].to.x)).toBeGreaterThan(gap(arrows[0].from.x, arrows[1].from.x));
  });

  it("has nothing to point at when the joint isn't visible", () => {
    const hidden = stance.map((l, i) => (i === LANDMARK.rightWrist ? { ...l, visibility: 0 } : l));
    expect(correctionArrows(hidden, "rightElbow", -40)).toEqual([]);
  });
});

describe("progress chime", () => {
  const coach = () => { const c = new PoseCoach({ settleMs: 400 }); c.start(0); return c; };
  const three = (...errors: number[]) => errors.map((e, i) => err((["rightElbow", "rightShoulderElevation", "leftElbow"] as const)[i], -e * 20, e));

  it("chimes when one more joint settles in, rising with how many", () => {
    const c = coach();
    expect(c.update(three(2, 2, 2), 0).progress).toBeNull();
    expect(c.update(three(0.5, 2, 2), 100).progress).toBeNull(); // not settled yet
    expect(c.update(three(0.5, 2, 2), 500).progress).toBeCloseTo(1 / 3);
    expect(c.update(three(0.5, 2, 2), 600).progress).toBeNull(); // once
    c.update(three(0.5, 0.5, 2), 700);
    expect(c.update(three(0.5, 0.5, 2), 1100).progress).toBeCloseTo(2 / 3);
  });

  it("ignores a joint flickering in and out, and leaves the last one to the hold tone", () => {
    const c = coach();
    for (let t = 0; t < 2000; t += 100) expect(c.update(three(t % 200 ? 0.9 : 1.1, 2, 2), t).progress).toBeNull();
    const all = three(0.5, 0.5, 0.5);
    c.update(all, 2000);
    expect(c.update(all, 2500).progress).toBeNull();
  });

  it("freezes while there's nothing to coach", () => {
    const c = coach();
    c.update(three(0.5, 2, 2), 0);
    expect(c.update(three(0.5, 2, 2), 400).progress).toBeCloseTo(1 / 3);
    c.update([], 1000); // matching, or out of frame
    expect(c.update(three(0.5, 2, 2), 1500).progress).toBeNull();
  });
});

describe("checking the photo itself", () => {
  it("passes a photo in the pose (with the limb it attacks with), and says what slipped in one that isn't", () => {
    expect(checkStillPose(buildStickFigureLandmarks("punch"), POSE_DEFINITIONS.punch)).toMatchObject({ ok: true, side: "right" });
    // The punch's photo caught them back in their stance.
    expect(checkStillPose(buildStickFigureLandmarks("idle"), POSE_DEFINITIONS.punch)).toEqual({ ok: false, score: expect.any(Number), correction: "Straighten your arm more" });
  });

  it("allows a bit more than the live check", () => {
    const target = { angleTargets: [{ joint: "torsoLean" as const, degrees: 0, tolerance: 10 }], requiredVisibleLandmarks: [] };
    // Lean the stick figure 11° off upright: just out live, inside the photo's slack.
    const lm = buildStickFigureLandmarks("win");
    const hips = { x: (lm[LANDMARK.leftHip].x + lm[LANDMARK.rightHip].x) / 2, y: (lm[LANDMARK.leftHip].y + lm[LANDMARK.rightHip].y) / 2 };
    const lean = (deg: number) => lm.map((l) => {
      const r = (deg * Math.PI) / 180, dx = l.x - hips.x, dy = l.y - hips.y;
      return { ...l, x: hips.x + dx * Math.cos(r) - dy * Math.sin(r), y: hips.y + dx * Math.sin(r) + dy * Math.cos(r) };
    });
    const base = computeJointAngles(lm).torsoLean!;
    expect(checkStillPose(lean(11 - base), target).ok).toBe(true);
    expect(checkStillPose(lean(10 * STILL_TOLERANCE_SLACK + 2 - base), target).ok).toBe(false);
  });
});
