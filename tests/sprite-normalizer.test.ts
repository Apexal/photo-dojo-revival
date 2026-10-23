import { describe, expect, it } from "vitest";
import { planSpriteNormalization } from "../src/capture/sprite-normalizer";
import {
  CANONICAL_TORSO_LENGTH_PX,
  GROUND_LINE_Y,
  JUMP_ANCHOR_Y,
  LANDMARK,
  SPRITE_CANVAS_SIZE,
  type NormalizedLandmark,
  type PoseId,
} from "../src/shared/fighter-model";
import { applyTransform, computeAnchor, detectFacing, midHip, torsoLength } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

const W = 1280;
const H = 720;

/** A person in a 1280×720 frame as MediaPipe would report it (0..1), at an arbitrary size and spot. */
function inFrame(poseId: PoseId, opts: { scale?: number; cx?: number; cy?: number; faceLeft?: boolean } = {}): NormalizedLandmark[] {
  const { scale = 1.7, cx = 700, cy = 380, faceLeft = false } = opts;
  return buildStickFigureLandmarks(poseId).map((l) => {
    const dx = (l.x - 256) * scale;
    return { x: (cx + (faceLeft ? -dx : dx)) / W, y: (cy + (l.y - 300) * scale) / H, visibility: l.visibility };
  });
}

describe("sprite normalization", () => {
  it("achieves the canonical torso length", () => {
    for (const scale of [0.8, 1.7, 2.4]) {
      const plan = planSpriteNormalization(inFrame("idle", { scale }), "idle", W, H);
      expect(torsoLength(plan.landmarks)).toBeCloseTo(CANONICAL_TORSO_LENGTH_PX, 5);
      expect(plan.transform.fitScale).toBe(1);
    }
  });

  it("puts the feet anchor on the ground line at the canvas center", () => {
    for (const poseId of ["idle", "walk", "punch", "kick", "block", "hurt"] as const) {
      const plan = planSpriteNormalization(inFrame(poseId), poseId, W, H);
      expect(plan.anchorPoint).toEqual({ x: SPRITE_CANVAS_SIZE / 2, y: GROUND_LINE_Y });
      const anchor = computeAnchor(plan.landmarks, poseId);
      expect(anchor.x).toBeCloseTo(256, 5);
      expect(anchor.y).toBeCloseTo(GROUND_LINE_Y, 5);
    }
  });

  it("the standing foot's sole touches the ground line for a kick", () => {
    const plan = planSpriteNormalization(inFrame("kick"), "kick", W, H);
    const l = plan.landmarks;
    const sole = Math.max(l[LANDMARK.leftAnkle].y, l[LANDMARK.leftHeel].y, l[LANDMARK.leftFootIndex].y);
    expect(sole).toBeCloseTo(GROUND_LINE_Y, 5);
    expect(l[LANDMARK.leftAnkle].y).toBeLessThan(GROUND_LINE_Y); // the ankle is above the floor, not on it
    expect(l[LANDMARK.leftAnkle].x).toBeCloseTo(256, 5); // standing foot, not the kicking one
  });

  it("heels and toes below the ankle don't shrink the fighter to fit", () => {
    // Real captures: the heel and toes sit well below the ankle (here 0.3 torso lengths).
    const lm = inFrame("idle").map((l) => ({ ...l }));
    for (const i of [LANDMARK.leftHeel, LANDMARK.rightHeel, LANDMARK.leftFootIndex, LANDMARK.rightFootIndex]) lm[i].y += (0.3 * 110 * 1.7) / H; // fixture scale is 1.7 frame px per sprite px
    expect(planSpriteNormalization(lm, "idle", W, H).transform.fitScale).toBe(1);
  });

  it("anchors jump at the pelvis", () => {
    const plan = planSpriteNormalization(inFrame("jump"), "jump", W, H);
    expect(plan.anchorPoint).toEqual({ x: 256, y: JUMP_ANCHOR_Y });
    const pelvis = midHip(plan.landmarks);
    expect(pelvis.x).toBeCloseTo(256, 5);
    expect(pelvis.y).toBeCloseTo(JUMP_ANCHOR_Y, 5);
  });

  it("flips left-facing input so every sprite faces right", () => {
    const left = inFrame("punch", { faceLeft: true });
    expect(detectFacing(left.map((l) => ({ ...l, x: l.x * W, y: l.y * H })))).toBe("left");
    const plan = planSpriteNormalization(left, "punch", W, H);
    expect(plan.flipped).toBe(true);
    expect(detectFacing(plan.landmarks)).toBe("right");
    // The punching wrist ends up in front (to the right) of the shoulder.
    expect(plan.landmarks[LANDMARK.rightWrist].x).toBeGreaterThan(plan.landmarks[LANDMARK.rightShoulder].x + 100);
    // Same result as a right-facing capture.
    const right = planSpriteNormalization(inFrame("punch"), "punch", W, H);
    plan.landmarks.forEach((l, i) => {
      expect(l.x).toBeCloseTo(right.landmarks[i].x, 5);
      expect(l.y).toBeCloseTo(right.landmarks[i].y, 5);
    });
    expect(right.flipped).toBe(false);
  });

  it("the transform maps the source frame consistently with the landmarks", () => {
    const lms = inFrame("walk", { faceLeft: true });
    const plan = planSpriteNormalization(lms, "walk", W, H);
    const p = applyTransform(plan.transform, { x: lms[LANDMARK.nose].x * W, y: lms[LANDMARK.nose].y * H });
    expect(p.x).toBeCloseTo(plan.landmarks[LANDMARK.nose].x, 5);
    expect(p.y).toBeCloseTo(plan.landmarks[LANDMARK.nose].y, 5);
  });

  it("scales down uniformly and records it when the figure doesn't fit", () => {
    // Arms stretched way overhead: longer than the canvas allows at canonical size.
    const lms = inFrame("win");
    const stretched = lms.map((l, i) =>
      [LANDMARK.leftWrist, LANDMARK.rightWrist, LANDMARK.leftIndex, LANDMARK.rightIndex].includes(i as never)
        ? { ...l, y: l.y - 0.25 }
        : l,
    );
    const plan = planSpriteNormalization(stretched, "win", W, H);
    expect(plan.transform.fitScale).toBeLessThan(1);
    expect(torsoLength(plan.landmarks)).toBeCloseTo(CANONICAL_TORSO_LENGTH_PX * plan.transform.fitScale, 5);
    for (const l of plan.landmarks) {
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThanOrEqual(SPRITE_CANVAS_SIZE);
    }
    // The anchor still lands on the ground line.
    expect(computeAnchor(plan.landmarks, "win").y).toBeCloseTo(GROUND_LINE_Y, 5);
  });

  it("throws on a degenerate torso", () => {
    const flat = inFrame("idle").map((l) => ({ ...l, y: 0.5 }));
    const lms = flat.map((l, i) => (i === LANDMARK.leftHip || i === LANDMARK.rightHip ? { ...l, x: flat[LANDMARK.leftShoulder].x } : l));
    lms[LANDMARK.leftShoulder] = { ...lms[LANDMARK.leftShoulder], x: lms[LANDMARK.leftHip].x };
    lms[LANDMARK.rightShoulder] = { ...lms[LANDMARK.rightShoulder], x: lms[LANDMARK.leftHip].x };
    expect(() => planSpriteNormalization(lms, "idle", W, H)).toThrow(/Torso/);
  });
});

import { planFighterSprites } from "../src/capture/sprite-normalizer";
import { POSE_IDS } from "../src/shared/fighter-model";
import { estimateBodyScale } from "../src/shared/pose-geometry";

describe("fighter-wide scale", () => {
  const px = (lms: NormalizedLandmark[]) => lms.map((l) => ({ ...l, x: l.x * W, y: l.y * H }));

  it("body scale doesn't change when the torso is foreshortened (lean, crouch)", () => {
    const upright = inFrame("idle");
    // Squash the torso 25%: shoulders, head and arms move toward the hips.
    const squash = upright.map((l, i) => {
      const hipY = (upright[LANDMARK.leftHip].y + upright[LANDMARK.rightHip].y) / 2;
      // Indices below the hips are the face, shoulders, arms and hands.
      return i < LANDMARK.leftHip ? { ...l, y: hipY + (l.y - hipY) * 0.75 } : l;
    });
    expect(torsoLength(px(squash)) / torsoLength(px(upright))).toBeCloseTo(0.75, 2);
    const ratio = estimateBodyScale(px(squash)) / estimateBodyScale(px(upright));
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  it("every pose of the same person comes out the same size", () => {
    const plans = planFighterSprites(Object.fromEntries(POSE_IDS.map((id) => [id, { poseId: id, landmarks: inFrame(id), frameWidth: W, frameHeight: H }])));
    const scales = POSE_IDS.map((id) => plans[id]!.transform.scale);
    for (const s of scales) expect(s).toBeCloseTo(scales[0], 6);
    for (const id of POSE_IDS) expect(estimateBodyScale(plans[id]!.landmarks)).toBeCloseTo(CANONICAL_TORSO_LENGTH_PX * plans[id]!.transform.fitScale, 4);
  });

  it("compensates for the camera moving closer or farther between poses", () => {
    const plans = planFighterSprites({
      idle: { poseId: "idle", landmarks: inFrame("idle", { scale: 1.2 }), frameWidth: W, frameHeight: H },
      punch: { poseId: "punch", landmarks: inFrame("punch", { scale: 2.2, cx: 500 }), frameWidth: W, frameHeight: H },
    });
    expect(estimateBodyScale(plans.idle!.landmarks)).toBeCloseTo(estimateBodyScale(plans.punch!.landmarks), 4);
  });

  it("when one pose needs to shrink to fit, every pose shrinks by the same amount", () => {
    const stretched = inFrame("win").map((l, i) =>
      [LANDMARK.leftWrist, LANDMARK.rightWrist, LANDMARK.leftIndex, LANDMARK.rightIndex].includes(i as never) ? { ...l, y: l.y - 0.25 } : l,
    );
    const plans = planFighterSprites({
      idle: { poseId: "idle", landmarks: inFrame("idle"), frameWidth: W, frameHeight: H },
      "win-2": { poseId: "win", landmarks: stretched, frameWidth: W, frameHeight: H },
    });
    // A bonus alternate needing to shrink shrinks the main poses too.
    const fit = plans["win-2"].transform.fitScale;
    expect(fit).toBeLessThan(1);
    expect(plans.idle.transform.fitScale).toBe(fit);
    expect(torsoLength(plans.idle.landmarks)).toBeCloseTo(torsoLength(plans["win-2"].landmarks), 4);
    for (const l of plans["win-2"].landmarks) expect(l.y).toBeGreaterThanOrEqual(0);
    expect(computeAnchor(plans.idle!.landmarks, "idle").y).toBeCloseTo(GROUND_LINE_Y, 5);
  });
});
