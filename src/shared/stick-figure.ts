import {
  CANONICAL_TORSO_LENGTH_PX,
  LANDMARK,
  LANDMARK_COUNT,
  type LimbSide,
  type NormalizedLandmark,
  POSE_IDS,
  type PoseId,
} from "./fighter-model";
import type { FighterGeometry, PoseGeometry } from "./frame-data";
import { anchorTargetFor, computeAnchor } from "./pose-geometry";

/**
 * A canonical side-view skeleton for each pose, facing right, in sprite-canvas pixels.
 * Used for placeholder fighters, ghost overlays, and synthetic test landmarks.
 *
 * Angles are degrees. Limb angles are measured from the torso's "down" direction,
 * positive rotating forward (toward the facing direction).
 */
export interface StickLimb { swing: number; bend: number }
export interface StickPoseParams {
  torsoLean: number;   // positive = lean forward
  headTilt: number;    // positive = chin forward/down, negative = head back
  arms: Record<LimbSide, StickLimb>;
  legs: Record<LimbSide, StickLimb>;
}

const T = CANONICAL_TORSO_LENGTH_PX;
// Same proportions as BONE_RATIOS in pose-geometry, so canonical figures measure exactly one torso.
const BONE = { upperArm: 0.6 * T, forearm: 0.55 * T, thigh: 0.78 * T, shin: 0.78 * T, neck: 0.36 * T };
const DEPTH = 5; // far-side (left) joints sit slightly behind in a side view

export const STICK_POSES: Record<PoseId, StickPoseParams> = {
  idle: {
    torsoLean: 5, headTilt: 5,
    // Fists by the chin: a guard held out front would make every fighter hittable from far away.
    arms: { right: { swing: 30, bend: 45 }, left: { swing: 20, bend: 40 } },
    legs: { right: { swing: 14, bend: 165 }, left: { swing: -12, bend: 165 } },
  },
  walk: {
    torsoLean: 2, headTilt: 0, // upright mid-stride: a forward lean reads as lunging, not walking
    arms: { right: { swing: 35, bend: 90 }, left: { swing: -10, bend: 120 } },
    legs: { right: { swing: 28, bend: 165 }, left: { swing: -24, bend: 160 } },
  },
  block: {
    torsoLean: 8, headTilt: 15,
    arms: { right: { swing: 70, bend: 45 }, left: { swing: 65, bend: 40 } },
    legs: { right: { swing: 25, bend: 140 }, left: { swing: -5, bend: 145 } },
  },
  // Crouching guard: deep squat, arms up around the head (punches pass over it).
  crouch: {
    torsoLean: 20, headTilt: 10,
    arms: { right: { swing: 75, bend: 40 }, left: { swing: 70, bend: 40 } },
    legs: { right: { swing: 95, bend: 65 }, left: { swing: 70, bend: 55 } },
  },
  punch: {
    torsoLean: 8, headTilt: 5,
    arms: { right: { swing: 90, bend: 178 }, left: { swing: 30, bend: 55 } },
    legs: { right: { swing: 18, bend: 160 }, left: { swing: -18, bend: 170 } },
  },
  kick: {
    torsoLean: -10, headTilt: 0,
    arms: { right: { swing: 30, bend: 80 }, left: { swing: -20, bend: 100 } },
    legs: { right: { swing: 88, bend: 170 }, left: { swing: -5, bend: 172 } },
  },
  jump: {
    torsoLean: 0, headTilt: 0,
    arms: { right: { swing: 160, bend: 165 }, left: { swing: 150, bend: 160 } },
    legs: { right: { swing: 45, bend: 115 }, left: { swing: 20, bend: 120 } },
  },
  hurt: {
    torsoLean: -25, headTilt: -30,
    arms: { right: { swing: 50, bend: 120 }, left: { swing: 20, bend: 140 } },
    legs: { right: { swing: 20, bend: 150 }, left: { swing: -10, bend: 165 } },
  },
  win: {
    torsoLean: 0, headTilt: -5,
    arms: { right: { swing: 165, bend: 165 }, left: { swing: 155, bend: 160 } },
    legs: { right: { swing: 8, bend: 175 }, left: { swing: -8, bend: 175 } },
  },
};

interface Vec { x: number; y: number }
const add = (a: Vec, b: Vec, k = 1): Vec => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Rotate "forward" (toward +x, from down toward up) in y-down coordinates. */
const rot = (v: Vec, deg: number): Vec => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c };
};

/** Canonical skeletons for the second versions of punch, kick, hurt and win, keyed by capture target. */
export const STICK_BONUS_POSES: Record<string, StickPoseParams> = {
  // Uppercut: punching arm driven up and forward, slightly bent.
  "punch-2": {
    torsoLean: 5, headTilt: -5,
    arms: { right: { swing: 140, bend: 150 }, left: { swing: 30, bend: 55 } },
    legs: { right: { swing: 22, bend: 150 }, left: { swing: -15, bend: 165 } },
  },
  // Low kick: straight leg swept forward at shin height.
  "kick-2": {
    torsoLean: 0, headTilt: 5,
    arms: { right: { swing: 40, bend: 70 }, left: { swing: 20, bend: 70 } },
    legs: { right: { swing: 45, bend: 172 }, left: { swing: -8, bend: 160 } },
  },
  // Hit in the face: the main hurt pose's lean and legs (its hurtboxes are used for both),
  // with both hands clutching the face.
  "hurt-2": {
    torsoLean: -25, headTilt: -30,
    arms: { right: { swing: 105, bend: 35 }, left: { swing: 95, bend: 40 } },
    legs: { right: { swing: 20, bend: 150 }, left: { swing: -10, bend: 165 } },
  },
  // Double-biceps flex.
  "win-2": {
    torsoLean: 0, headTilt: 0,
    arms: { right: { swing: 95, bend: 60 }, left: { swing: 90, bend: 55 } },
    legs: { right: { swing: 10, bend: 175 }, left: { swing: -10, bend: 175 } },
  },
};

/** Landmarks for a pose, with the anchor placed exactly where sprite normalization would put it. */
export function buildStickFigureLandmarks(poseId: PoseId, params: StickPoseParams = STICK_POSES[poseId]): NormalizedLandmark[] {
  const lm: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, visibility: 0.95 }));
  const set = (i: number, p: Vec) => { lm[i] = { x: p.x, y: p.y, visibility: 0.95 }; };

  // Leaning forward tips the head forward, so the torso's "down" direction swings back.
  const down = rot({ x: 0, y: 1 }, -params.torsoLean);
  const up = { x: -down.x, y: -down.y };
  const hip: Vec = { x: 0, y: 0 };
  const shoulder = add(hip, up, T);
  const side = (s: LimbSide): Vec => ({ x: s === "left" ? -DEPTH : DEPTH, y: 0 });

  for (const s of ["left", "right"] as const) {
    const sh = add(shoulder, side(s));
    const arm = params.arms[s];
    const upperDir = rot(down, arm.swing);
    const elbow = add(sh, upperDir, BONE.upperArm);
    const foreDir = rot(upperDir, 180 - arm.bend);
    const wrist = add(elbow, foreDir, BONE.forearm);
    const handSide = rot(foreDir, 90);
    set(LANDMARK[`${s}Shoulder`], sh);
    set(LANDMARK[`${s}Elbow`], elbow);
    set(LANDMARK[`${s}Wrist`], wrist);
    set(LANDMARK[`${s}Index`], add(wrist, foreDir, 14));
    set(LANDMARK[`${s}Pinky`], add(add(wrist, foreDir, 11), handSide, -4));
    set(LANDMARK[`${s}Thumb`], add(add(wrist, foreDir, 7), handSide, 5));

    const hp = add(hip, side(s));
    const leg = params.legs[s];
    const thighDir = rot(down, leg.swing);
    const knee = add(hp, thighDir, BONE.thigh);
    const shinDir = rot(thighDir, -(180 - leg.bend));
    const ankle = add(knee, shinDir, BONE.shin);
    const footDir = rot(shinDir, 90);
    set(LANDMARK[`${s}Hip`], hp);
    set(LANDMARK[`${s}Knee`], knee);
    set(LANDMARK[`${s}Ankle`], ankle);
    set(LANDMARK[`${s}Heel`], add(add(ankle, footDir, -8), shinDir, 6));
    set(LANDMARK[`${s}FootIndex`], add(add(ankle, footDir, 22), shinDir, 8));
  }

  const neckDir = rot(up, -params.headTilt);
  const faceFwd = rot(neckDir, -90);
  const head = add(shoulder, neckDir, BONE.neck);
  set(LANDMARK.nose, add(head, faceFwd, 16));
  for (const s of ["left", "right"] as const) {
    const d = s === "left" ? -2 : 2;
    set(LANDMARK[`${s}EyeInner`], add(add(head, faceFwd, 12), neckDir, 5 + d));
    set(LANDMARK[`${s}Eye`], add(add(head, faceFwd, 10), neckDir, 6 + d));
    set(LANDMARK[`${s}EyeOuter`], add(add(head, faceFwd, 8), neckDir, 6 + d));
    set(LANDMARK[`${s}Ear`], add(head, faceFwd, -4 + d));
    set(LANDMARK[`mouth${s === "left" ? "Left" : "Right"}`], add(add(head, faceFwd, 12), neckDir, -8 + d));
  }

  // Place the anchor where normalization would.
  const anchor = computeAnchor(lm, poseId);
  const target = anchorTargetFor(poseId);
  return lm.map((l) => ({ ...l, x: l.x - anchor.x + target.x, y: l.y - anchor.y + target.y }));
}

export const HEAD_RADIUS_PX = 0.22 * T;

export const STICK_SEGMENTS: readonly [number, number][] = [
  [LANDMARK.leftShoulder, LANDMARK.rightShoulder],
  [LANDMARK.leftHip, LANDMARK.rightHip],
  [LANDMARK.leftShoulder, LANDMARK.leftHip],
  [LANDMARK.rightShoulder, LANDMARK.rightHip],
  [LANDMARK.leftShoulder, LANDMARK.leftElbow],
  [LANDMARK.leftElbow, LANDMARK.leftWrist],
  [LANDMARK.rightShoulder, LANDMARK.rightElbow],
  [LANDMARK.rightElbow, LANDMARK.rightWrist],
  [LANDMARK.leftHip, LANDMARK.leftKnee],
  [LANDMARK.leftKnee, LANDMARK.leftAnkle],
  [LANDMARK.leftAnkle, LANDMARK.leftFootIndex],
  [LANDMARK.rightHip, LANDMARK.rightKnee],
  [LANDMARK.rightKnee, LANDMARK.rightAnkle],
  [LANDMARK.rightAnkle, LANDMARK.rightFootIndex],
];

export function headCenter(landmarks: NormalizedLandmark[]): Vec {
  const le = landmarks[LANDMARK.leftEar];
  const re = landmarks[LANDMARK.rightEar];
  const nose = landmarks[LANDMARK.nose];
  return { x: ((le.x + re.x) / 2 + nose.x) / 2, y: ((le.y + re.y) / 2 + nose.y) / 2 };
}

/** SVG path data (in sprite-canvas coordinates) for a ghost silhouette: limbs plus a head circle. */
export function stickFigureSvgPath(landmarks: NormalizedLandmark[]): string {
  const f = (n: number) => n.toFixed(1);
  const parts = STICK_SEGMENTS.map(([a, b]) =>
    `M${f(landmarks[a].x)} ${f(landmarks[a].y)}L${f(landmarks[b].x)} ${f(landmarks[b].y)}`);
  const c = headCenter(landmarks);
  const r = HEAD_RADIUS_PX;
  parts.push(`M${f(c.x - r)} ${f(c.y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`);
  return parts.join("");
}

/** Geometry for a stick-figure fighter, as the simulation sees it (main poses and their second versions). */
export function stickFigureGeometry(): FighterGeometry {
  const poses = Object.fromEntries(
    POSE_IDS.map((poseId) => [poseId, { landmarks: buildStickFigureLandmarks(poseId), anchorPoint: anchorTargetFor(poseId) }]),
  ) as Record<PoseId, PoseGeometry>;
  const variants: Partial<Record<PoseId, PoseGeometry[]>> = {};
  for (const [key, params] of Object.entries(STICK_BONUS_POSES)) {
    const poseId = key.split("-")[0] as PoseId;
    (variants[poseId] ??= []).push({ landmarks: buildStickFigureLandmarks(poseId, params), anchorPoint: anchorTargetFor(poseId) });
  }
  return { ...poses, variants };
}
