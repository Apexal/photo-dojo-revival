import { describe, expect, it } from "vitest";
import { LANDMARK, LANDMARK_COUNT, POSE_IDS, type LandmarkName, type NormalizedLandmark } from "../src/shared/fighter-model";
import { POSE_DEFINITIONS } from "../src/shared/pose-definitions";
import {
  angleAt,
  computeJointAngles,
  detectFacing,
  evaluatePose,
  flipLandmarksHorizontally,
  mirrorJointName,
  scorePoseMatch,
  type JointAngles,
} from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

function landmarks(points: Partial<Record<LandmarkName, [number, number]>>, visibility = 0.9): NormalizedLandmark[] {
  const out: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [name, [x, y]] of Object.entries(points)) out[LANDMARK[name as LandmarkName]] = { x, y, visibility };
  return out;
}

/** Upright torso, shoulders at y=100, hips at y=200 (y grows downward). */
const torso = {
  leftShoulder: [100, 100], rightShoulder: [100, 100],
  leftHip: [100, 200], rightHip: [100, 200],
} as const satisfies Partial<Record<LandmarkName, [number, number]>>;

describe("joint angles", () => {
  it("measures interior angles", () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(180);
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(90);
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("straight arm held forward at shoulder height: elbow 180, elevation 90", () => {
    const a = computeJointAngles(landmarks({ ...torso, rightElbow: [150, 100], rightWrist: [200, 100] }));
    expect(a.rightElbow).toBeCloseTo(180);
    expect(a.rightShoulderElevation).toBeCloseTo(90);
    expect(a.torsoLean).toBeCloseTo(0);
  });

  it("arm hanging down: elevation 0; arm straight up: 180", () => {
    expect(computeJointAngles(landmarks({ ...torso, leftElbow: [100, 150], leftWrist: [100, 200] })).leftShoulderElevation).toBeCloseTo(0);
    expect(computeJointAngles(landmarks({ ...torso, leftElbow: [100, 50], leftWrist: [100, 0] })).leftShoulderElevation).toBeCloseTo(180);
  });

  it("bent elbow and knee", () => {
    const a = computeJointAngles(landmarks({
      ...torso,
      rightElbow: [150, 100], rightWrist: [150, 50],
      leftKnee: [100, 280], leftAnkle: [180, 280],
    }));
    expect(a.rightElbow).toBeCloseTo(90);
    expect(a.leftKnee).toBeCloseTo(90);
    expect(a.leftHipFlexion).toBeCloseTo(0);
  });

  it("hip flexion, leg spread and torso lean", () => {
    const a = computeJointAngles(landmarks({
      leftShoulder: [150, 113.4], rightShoulder: [150, 113.4], leftHip: [100, 200], rightHip: [100, 200],
      rightKnee: [180, 200], leftKnee: [100, 280],
    }));
    expect(a.torsoLean).toBeCloseTo(30, 0);
    expect(a.legSpread).toBeCloseTo(90);
    // Thigh horizontal forward, torso leaning 30° forward: 90 + 30 from the torso axis.
    expect(a.rightHipFlexion).toBeCloseTo(120, 0);
  });

  it("returns null for joints whose landmarks are not visible", () => {
    const lm = landmarks({ ...torso, rightElbow: [150, 100], rightWrist: [200, 100] });
    lm[LANDMARK.rightWrist].visibility = 0.1;
    const a = computeJointAngles(lm);
    expect(a.rightElbow).toBeNull();
    expect(a.rightShoulderElevation).not.toBeNull();
  });
});

describe("pose scoring", () => {
  const target = { angleTargets: [{ joint: "rightElbow" as const, degrees: 175, tolerance: 25 }, { joint: "leftKnee" as const, degrees: 90, tolerance: 30 }] };
  const angles = (rightElbow: number | null, leftKnee: number | null) => ({ rightElbow, leftKnee }) as JointAngles;

  it("returns 0 for an exact match", () => {
    expect(scorePoseMatch(angles(175, 90), target)).toBe(0);
  });

  it("returns 1 at the tolerance edge, >1 outside", () => {
    expect(scorePoseMatch(angles(150, 90), target)).toBeCloseTo(1);
    expect(scorePoseMatch(angles(175, 120), target)).toBeCloseTo(1);
    expect(scorePoseMatch(angles(175, 130), target)).toBeGreaterThan(1);
  });

  it("is the worst normalized error", () => {
    expect(scorePoseMatch(angles(162.5, 75), target)).toBeCloseTo(0.5);
    expect(scorePoseMatch(angles(170, 60), target)).toBeCloseTo(1);
  });

  it("widened tolerances shrink the score", () => {
    expect(scorePoseMatch(angles(175, 135), target, 1.5)).toBeCloseTo(1);
  });

  it("missing angles never match", () => {
    expect(scorePoseMatch(angles(null, 90), target)).toBe(Infinity);
  });
});

/** Every main pose, the signature one once per archetype: its name, canonical skeleton and definition. */
const MAIN_POSES = POSE_IDS.flatMap((poseId) =>
  poseId === "signature"
    ? ARCHETYPE_IDS.map((a) => ({ name: `signature (${a})`, landmarks: buildStickFigureLandmarks(poseId, STICK_SIGNATURE_POSES[a]), def: poseDefinition(poseId, a) }))
    : [{ name: poseId, landmarks: buildStickFigureLandmarks(poseId), def: poseDefinition(poseId, "brawler") }]);

describe("pose definitions", () => {
  it("each canonical stick pose matches its own definition and no other", () => {
    for (const pose of MAIN_POSES) {
      for (const other of MAIN_POSES) {
        const { score } = evaluatePose(pose.landmarks, other.def);
        if (other === pose) expect(score, `${pose.name} vs itself`).toBeLessThan(0.9);
        else expect(score, `${pose.name} vs ${other.name}`).toBeGreaterThan(1);
      }
    }
  });

  it("attack poses accept either limb and record which", () => {
    const right = buildStickFigureLandmarks("punch");
    // Swap limb landmarks so the left arm is the extended one.
    const left = right.map((l) => ({ ...l }));
    for (const name of Object.keys(LANDMARK) as LandmarkName[]) {
      if (!name.startsWith("left")) continue;
      const mirror = ("right" + name.slice(4)) as LandmarkName;
      left[LANDMARK[name]] = right[LANDMARK[mirror]];
      left[LANDMARK[mirror]] = right[LANDMARK[name]];
    }
    expect(evaluatePose(right, POSE_DEFINITIONS.punch).side).toBe("right");
    const leftEval = evaluatePose(left, POSE_DEFINITIONS.punch);
    expect(leftEval.side).toBe("left");
    expect(leftEval.score).toBeLessThan(1);
    // Non-attack poses don't get mirrored.
    expect(POSE_DEFINITIONS.idle.attackLimb).toBeUndefined();
  });

  it("requires the listed landmarks to be visible", () => {
    const lm = buildStickFigureLandmarks("idle");
    lm[LANDMARK.leftAnkle].visibility = 0.2;
    expect(evaluatePose(lm, POSE_DEFINITIONS.idle).score).toBe(Infinity);
  });

  it("has a ghost path and prompt for every pose", () => {
    for (const { def } of MAIN_POSES) {
      expect(def.ghostSvgPath).toMatch(/^M[\d.]+ [\d.]+L/);
      expect(def.voicePrompt.length).toBeGreaterThan(3);
      expect(def.angleTargets.length).toBeGreaterThanOrEqual(3);
      expect(def.angleTargets.length).toBeLessThanOrEqual(5);
    }
  });

  it("each archetype's signature pose has its own skeleton and definition", () => {
    const paths = ARCHETYPE_IDS.map((a) => SIGNATURE_DEFINITIONS[a].ghostSvgPath);
    expect(new Set(paths).size).toBe(ARCHETYPE_IDS.length);
    for (const a of ARCHETYPE_IDS) expect(SIGNATURE_DEFINITIONS[a].poseId).toBe("signature");
  });

  it("mirrors joint names", () => {
    expect(mirrorJointName("rightElbow")).toBe("leftElbow");
    expect(mirrorJointName("leftHipFlexion")).toBe("rightHipFlexion");
    expect(mirrorJointName("legSpread")).toBe("legSpread");
  });
});

describe("facing", () => {
  it("detects facing from nose vs ears, and flipping reverses it", () => {
    const lm = buildStickFigureLandmarks("idle");
    expect(detectFacing(lm)).toBe("right");
    const flipped = flipLandmarksHorizontally(lm, 512);
    expect(detectFacing(flipped)).toBe("left");
    // Angles are mirror-invariant, so a left-facing person still matches live.
    expect(evaluatePose(flipped, POSE_DEFINITIONS.idle).score).toBeCloseTo(evaluatePose(lm, POSE_DEFINITIONS.idle).score);
  });

  it("falls back to shoulders when ears aren't visible", () => {
    const lm = buildStickFigureLandmarks("idle");
    lm[LANDMARK.leftEar].visibility = 0;
    lm[LANDMARK.rightEar].visibility = 0;
    expect(detectFacing(lm)).toBe("right");
  });
});

import { ALTERNATE_DEFINITIONS, REQUIRED_VARIANT_POSES, SIGNATURE_DEFINITIONS, captureTargetsFor, poseDefinition } from "../src/shared/pose-definitions";
import { STICK_BONUS_POSES, STICK_SIGNATURE_POSES } from "../src/shared/stick-figure";
import { ARCHETYPE_IDS } from "../src/shared/archetypes";

describe("second-version poses", () => {
  it("each second-version skeleton matches its own target, and no main pose triggers one", () => {
    for (const [key, def] of Object.entries(ALTERNATE_DEFINITIONS)) {
      const lm = buildStickFigureLandmarks(def.poseId, STICK_BONUS_POSES[key]);
      expect(evaluatePose(lm, def).score, key).toBeLessThan(0.9);
      for (const pose of MAIN_POSES) {
        // The second stance is meant to look like the first; the matcher's "relax, then strike
        // the pose" rule between similar poses is what stops it being captured by accident.
        if (key === "idle-2" && pose.name === "idle") continue;
        expect(evaluatePose(pose.landmarks, def).score, `${pose.name} vs ${key}`).toBeGreaterThan(1);
      }
    }
  });

  it("capture targets: all sixteen, each second version right after its main pose, the signature, the handshake last", () => {
    for (const archetype of ARCHETYPE_IDS) {
      const targets = captureTargetsFor(archetype);
      expect(targets.map((t) => [t.key, t.poseId, t.variant])).toEqual([
        ["idle", "idle", 0], ["idle-2", "idle", 1], ["walk", "walk", 0], ["block", "block", 0], ["crouch", "crouch", 0],
        ["punch", "punch", 0], ["punch-2", "punch", 1], ["kick", "kick", 0], ["kick-2", "kick", 1],
        ["jump", "jump", 0], ["hurt", "hurt", 0], ["hurt-2", "hurt", 1], ["win", "win", 0], ["win-2", "win", 1],
        ["signature", "signature", 0], ["handshake", "handshake", 0],
      ]);
      expect(targets.find((t) => t.key === "signature")!.definition).toBe(SIGNATURE_DEFINITIONS[archetype]);
    }
    expect(REQUIRED_VARIANT_POSES).toEqual(["idle", "punch", "kick", "hurt", "win"]);
    expect(ALTERNATE_DEFINITIONS["punch-2"].attackLimb).toBe("arm");
    expect(ALTERNATE_DEFINITIONS["kick-2"].attackLimb).toBe("leg");
  });
});
