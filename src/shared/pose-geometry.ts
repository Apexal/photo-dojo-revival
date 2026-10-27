import {
  CANONICAL_TORSO_LENGTH_PX,
  GROUND_LINE_Y,
  JUMP_ANCHOR_Y,
  LANDMARK,
  SPRITE_CANVAS_SIZE,
  type LandmarkName,
  type LimbSide,
  type NormalizedLandmark,
  type PoseId,
} from "./fighter-model";

export type JointName =
  | "leftElbow" | "rightElbow"
  | "leftKnee" | "rightKnee"
  | "leftShoulderElevation" | "rightShoulderElevation"
  | "leftHipFlexion" | "rightHipFlexion"
  | "legSpread"
  | "torsoLean"
  | "headTilt";

/** Unsigned angles in degrees, or null when the joint's landmarks aren't visible enough. */
export type JointAngles = Record<JointName, number | null>;

export interface AngleTarget { joint: JointName; degrees: number; tolerance: number }

export interface PoseTarget {
  angleTargets: AngleTarget[];
  requiredVisibleLandmarks: LandmarkName[];
  /** Attack poses: the limb that attacks, recorded from the side that matched (every pose accepts either side). */
  attackLimb?: "arm" | "leg";
}

/** How far one targeted joint is from its target. */
export interface JointError {
  joint: JointName;
  /** Actual minus target, in degrees (negative: not enough); null when the joint isn't visible. */
  delta: number | null;
  /** |delta| / tolerance: 0 = on target, 1 = at the tolerance edge, >1 = out; Infinity when not visible. */
  error: number;
}

export interface PoseEvaluation {
  /** The worst joint's error (see `jointErrors`); Infinity when a required landmark isn't clearly seen. */
  score: number;
  side: LimbSide;
  /** Each target angle for the chosen side (joint names already mirrored), for coaching. */
  joints: JointError[];
  /** The side's required landmarks that aren't clearly seen (why the score is Infinity). */
  unseen: LandmarkName[];
}

export const ANGLE_VISIBILITY_THRESHOLD = 0.3;
export const REQUIRED_VISIBILITY_THRESHOLD = 0.5;

interface Point { x: number; y: number }

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Angle in degrees between two vectors, 0..180. */
export function angleBetween(u: Point, v: Point): number | null {
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu < 1e-9 || lv < 1e-9) return null;
  const cos = Math.min(1, Math.max(-1, (u.x * v.x + u.y * v.y) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Interior angle at vertex b of the path a-b-c. */
export function angleAt(a: Point, b: Point, c: Point): number | null {
  return angleBetween(sub(a, b), sub(c, b));
}

export function midShoulder(landmarks: NormalizedLandmark[]): Point {
  return midpoint(landmarks[LANDMARK.leftShoulder], landmarks[LANDMARK.rightShoulder]);
}

export function midHip(landmarks: NormalizedLandmark[]): Point {
  return midpoint(landmarks[LANDMARK.leftHip], landmarks[LANDMARK.rightHip]);
}

export function torsoLength(landmarks: NormalizedLandmark[]): number {
  return distance(midShoulder(landmarks), midHip(landmarks));
}

export function computeJointAngles(landmarks: NormalizedLandmark[]): JointAngles {
  const visible = (...names: LandmarkName[]) =>
    names.every((n) => (landmarks[LANDMARK[n]]?.visibility ?? 0) >= ANGLE_VISIBILITY_THRESHOLD);
  const p = (n: LandmarkName) => landmarks[LANDMARK[n]];
  const torsoOk = visible("leftShoulder", "rightShoulder", "leftHip", "rightHip");
  const shoulders = torsoOk ? midShoulder(landmarks) : null;
  const hips = torsoOk ? midHip(landmarks) : null;
  const torsoDown = shoulders && hips ? sub(hips, shoulders) : null;
  const torsoUp = shoulders && hips ? sub(shoulders, hips) : null;

  const elbow = (side: LimbSide) =>
    visible(`${side}Shoulder`, `${side}Elbow`, `${side}Wrist`)
      ? angleAt(p(`${side}Shoulder`), p(`${side}Elbow`), p(`${side}Wrist`))
      : null;
  const knee = (side: LimbSide) =>
    visible(`${side}Hip`, `${side}Knee`, `${side}Ankle`)
      ? angleAt(p(`${side}Hip`), p(`${side}Knee`), p(`${side}Ankle`))
      : null;
  const shoulderElevation = (side: LimbSide) =>
    torsoDown && visible(`${side}Shoulder`, `${side}Elbow`)
      ? angleBetween(torsoDown, sub(p(`${side}Elbow`), p(`${side}Shoulder`)))
      : null;
  const hipFlexion = (side: LimbSide) =>
    torsoDown && visible(`${side}Hip`, `${side}Knee`)
      ? angleBetween(torsoDown, sub(p(`${side}Knee`), p(`${side}Hip`)))
      : null;

  return {
    leftElbow: elbow("left"),
    rightElbow: elbow("right"),
    leftKnee: knee("left"),
    rightKnee: knee("right"),
    leftShoulderElevation: shoulderElevation("left"),
    rightShoulderElevation: shoulderElevation("right"),
    leftHipFlexion: hipFlexion("left"),
    rightHipFlexion: hipFlexion("right"),
    legSpread: hips && visible("leftKnee", "rightKnee") ? angleAt(p("leftKnee"), hips, p("rightKnee")) : null,
    torsoLean: torsoUp ? angleBetween(torsoUp, { x: 0, y: -1 }) : null,
    headTilt: torsoUp && shoulders && visible("nose") ? angleBetween(torsoUp, sub(p("nose"), shoulders)) : null,
  };
}

/**
 * Each target angle's signed and normalized error: 0 = perfect, 1 = at the
 * tolerance edge, >1 = out; Infinity when the joint isn't visible.
 */
export function jointErrors(angles: JointAngles, target: Pick<PoseTarget, "angleTargets">, toleranceScale = 1): JointError[] {
  return target.angleTargets.map(({ joint, degrees, tolerance }) => {
    const actual = angles[joint];
    if (actual === null || actual === undefined) return { joint, delta: null, error: Infinity };
    const delta = actual - degrees;
    return { joint, delta, error: Math.abs(delta) / (tolerance * toleranceScale) };
  });
}

export function mirrorJointName(joint: JointName): JointName {
  if (joint.startsWith("left")) return ("right" + joint.slice(4)) as JointName;
  if (joint.startsWith("right")) return ("left" + joint.slice(5)) as JointName;
  return joint;
}

export function mirrorLandmarkName(name: LandmarkName): LandmarkName {
  if (name.startsWith("left")) return ("right" + name.slice(4)) as LandmarkName;
  if (name.startsWith("right")) return ("left" + name.slice(5)) as LandmarkName;
  return name;
}

/**
 * Scores landmarks against a pose target. Poses are written for the right side;
 * every one is also tried mirrored and the better side wins, so either foot
 * can lead: a fighter turned toward the camera bends the back knee toward the
 * lens, where it looks straight, and a right-side-only target would make them
 * lead with the right foot. `requiredVisibility`:
 * how sure MediaPipe has to be of each required landmark.
 */
export function evaluatePose(
  landmarks: NormalizedLandmark[],
  target: PoseTarget,
  toleranceScale = 1,
  requiredVisibility = REQUIRED_VISIBILITY_THRESHOLD,
): PoseEvaluation {
  const angles = computeJointAngles(landmarks);
  const evaluateSide = (side: LimbSide): PoseEvaluation => {
    const mirror = side === "left";
    const required = mirror ? target.requiredVisibleLandmarks.map(mirrorLandmarkName) : target.requiredVisibleLandmarks;
    const angleTargets = mirror
      ? target.angleTargets.map((t) => ({ ...t, joint: mirrorJointName(t.joint) }))
      : target.angleTargets;
    const joints = jointErrors(angles, { angleTargets }, toleranceScale);
    const unseen = required.filter((n) => (landmarks[LANDMARK[n]]?.visibility ?? 0) < requiredVisibility);
    const score = unseen.length ? Infinity : Math.max(0, ...joints.map((j) => j.error));
    return { score, side, joints, unseen };
  };
  const right = evaluateSide("right");
  const left = evaluateSide("left");
  if (left.score === Infinity && right.score === Infinity) return left.unseen.length < right.unseen.length ? left : right;
  return left.score < right.score ? left : right;
}

/**
 * Which way the body faces in a side view: the toes point that way (heel →
 * foot index) and the nose is ahead of the ears. Both count, by how far they
 * reach: a fighter looking at the camera from a side-on stance has the nose
 * almost between the ears, and the head alone would flip with every few pixels.
 */
export function detectFacing(landmarks: NormalizedLandmark[]): "left" | "right" {
  const seen = (l: NormalizedLandmark) => l.visibility >= ANGLE_VISIBILITY_THRESHOLD;
  const nose = landmarks[LANDMARK.nose];
  const le = landmarks[LANDMARK.leftEar];
  const re = landmarks[LANDMARK.rightEar];
  const ears = [le, re].filter(seen);
  const reference =
    ears.length === 2 ? midpoint(le, re) : ears.length === 1 ? ears[0] : midShoulder(landmarks);
  let ahead = nose.x - reference.x;
  for (const [heel, toe] of [[LANDMARK.leftHeel, LANDMARK.leftFootIndex], [LANDMARK.rightHeel, LANDMARK.rightFootIndex]]) {
    if (seen(landmarks[heel]) && seen(landmarks[toe])) ahead += landmarks[toe].x - landmarks[heel].x;
  }
  return ahead >= 0 ? "right" : "left";
}

/** Mirror x around the frame width. Anatomical sides stay the same: the person's right arm is still their right arm. */
export function flipLandmarksHorizontally(landmarks: NormalizedLandmark[], width: number): NormalizedLandmark[] {
  return landmarks.map((l) => ({ ...l, x: width - l.x }));
}

/** Feet on the ground: the lower ankle sets y; x is the ankle midpoint unless one foot is raised (kick), then the standing foot. Pelvis for jump. */
export function computeAnchor(landmarks: NormalizedLandmark[], poseId: PoseId): Point {
  if (poseId === "jump") return midHip(landmarks);
  const la = landmarks[LANDMARK.leftAnkle];
  const ra = landmarks[LANDMARK.rightAnkle];
  const raisedThreshold = 0.25 * torsoLength(landmarks);
  const leftLower = la.y >= ra.y;
  const lower = leftLower ? la : ra;
  const x = Math.abs(la.y - ra.y) > raisedThreshold ? lower.x : (la.x + ra.x) / 2;
  // The ground is under the heel and toes, not the ankle: anchoring the ankle sinks the feet
  // below the ground line, and the canvas-fit then shrinks the whole fighter to make room for them.
  const foot = leftLower
    ? [la, landmarks[LANDMARK.leftHeel], landmarks[LANDMARK.leftFootIndex]]
    : [ra, landmarks[LANDMARK.rightHeel], landmarks[LANDMARK.rightFootIndex]];
  const y = Math.max(lower.y, ...foot.filter((l) => l.visibility >= ANGLE_VISIBILITY_THRESHOLD).map((l) => l.y));
  return { x, y };
}

export interface NormalizationTransform {
  flipped: boolean;
  sourceWidth: number;
  scale: number;
  translateX: number;
  translateY: number;
  /** <1 when the figure was scaled down beyond canonical size to fit the canvas. */
  fitScale: number;
}

export function applyTransform(t: NormalizationTransform, p: Point): Point {
  const x = t.flipped ? t.sourceWidth - p.x : p.x;
  return { x: x * t.scale + t.translateX, y: p.y * t.scale + t.translateY };
}

export function transformLandmarks(t: NormalizationTransform, landmarks: NormalizedLandmark[]): NormalizedLandmark[] {
  return landmarks.map((l) => ({ ...applyTransform(t, l), visibility: l.visibility }));
}

export function anchorTargetFor(poseId: PoseId): Point {
  return { x: SPRITE_CANVAS_SIZE / 2, y: poseId === "jump" ? JUMP_ANCHOR_Y : GROUND_LINE_Y };
}

/**
 * Bone lengths as a fraction of torso length (mid-shoulder to mid-hip),
 * roughly average adult proportions. Every bone gives an independent
 * estimate of body size, so the estimate doesn't change with the pose.
 */
export const BONE_RATIOS: readonly [LandmarkName, LandmarkName, number][] = [
  ["leftShoulder", "leftElbow", 0.6], ["rightShoulder", "rightElbow", 0.6],
  ["leftElbow", "leftWrist", 0.55], ["rightElbow", "rightWrist", 0.55],
  ["leftHip", "leftKnee", 0.78], ["rightHip", "rightKnee", 0.78],
  ["leftKnee", "leftAnkle", 0.78], ["rightKnee", "rightAnkle", 0.78],
];

/** Foreshortening only ever shortens a bone in 2D, so take a high percentile of the estimates. */
const BODY_SCALE_PERCENTILE = 0.7;

/**
 * Body size in "torso lengths" (pixels per canonical torso), estimated from the
 * torso and every visible limb bone. Unlike the raw torso length, this barely
 * changes when the person leans, crouches or raises their arms, so it measures
 * camera distance rather than pose.
 */
export function estimateBodyScale(landmarks: NormalizedLandmark[]): number {
  const estimates: number[] = [];
  const torsoVisible = ["leftShoulder", "rightShoulder", "leftHip", "rightHip"].every(
    (n) => landmarks[LANDMARK[n as LandmarkName]].visibility >= REQUIRED_VISIBILITY_THRESHOLD,
  );
  if (torsoVisible) estimates.push(torsoLength(landmarks));
  for (const [a, b, ratio] of BONE_RATIOS) {
    const pa = landmarks[LANDMARK[a]];
    const pb = landmarks[LANDMARK[b]];
    if (pa.visibility < REQUIRED_VISIBILITY_THRESHOLD || pb.visibility < REQUIRED_VISIBILITY_THRESHOLD) continue;
    estimates.push(distance(pa, pb) / ratio);
  }
  if (!estimates.length) estimates.push(torsoLength(landmarks));
  estimates.sort((x, y) => x - y);
  return estimates[Math.min(estimates.length - 1, Math.floor(BODY_SCALE_PERCENTILE * estimates.length))];
}

/** Margins (as a fraction of torso length) for the body outline beyond the landmarks: hair, hands, shoes. */
// Toe and fingertip landmarks are already the extremities sideways; hair needs more room on top.
const FIT_MARGIN = { side: 0.15, top: 0.4, bottom: 0.1 };

/**
 * How much a pose must shrink below `scale` to fit the sprite canvas (1 = fits).
 * `landmarks` are source pixels, already flipped to face right.
 */
export function requiredFitScale(landmarks: NormalizedLandmark[], poseId: PoseId, scale: number): number {
  const anchor = computeAnchor(landmarks, poseId);
  const target = anchorTargetFor(poseId);
  const visible = landmarks.filter((l) => l.visibility >= ANGLE_VISIBILITY_THRESHOLD);
  const xs = visible.map((l) => l.x);
  const ys = visible.map((l) => l.y);
  const extent = {
    left: anchor.x - Math.min(...xs),
    right: Math.max(...xs) - anchor.x,
    top: anchor.y - Math.min(...ys),
    bottom: Math.max(...ys) - anchor.y,
  };
  const available = {
    left: target.x - FIT_MARGIN.side * CANONICAL_TORSO_LENGTH_PX,
    right: SPRITE_CANVAS_SIZE - target.x - FIT_MARGIN.side * CANONICAL_TORSO_LENGTH_PX,
    top: target.y - FIT_MARGIN.top * CANONICAL_TORSO_LENGTH_PX,
    bottom: SPRITE_CANVAS_SIZE - target.y - FIT_MARGIN.bottom * CANONICAL_TORSO_LENGTH_PX,
  };
  let fit = 1;
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const needed = extent[side] * scale;
    if (needed > available[side]) fit = Math.min(fit, Math.max(0, available[side]) / needed);
  }
  return fit;
}

/**
 * Transform from source-frame pixels to sprite-canvas pixels: flip if requested,
 * scale so the body is canonical size, and put the anchor on its target.
 *
 * `fitScale` is the extra shrink applied so the figure fits the canvas. Pass the
 * fighter-wide value so every pose is drawn at the same scale; when omitted,
 * this pose's own fit is used.
 */
export function computeNormalizationTransform(
  sourceLandmarks: NormalizedLandmark[],
  poseId: PoseId,
  sourceWidth: number,
  options: { flip?: boolean; fitScale?: number } = {},
): NormalizationTransform {
  const flipped = options.flip ?? false;
  const landmarks = flipped ? flipLandmarksHorizontally(sourceLandmarks, sourceWidth) : sourceLandmarks;
  if (!(torsoLength(landmarks) > 1)) throw new Error("Torso too small to normalize");
  const baseScale = CANONICAL_TORSO_LENGTH_PX / estimateBodyScale(landmarks);
  const anchor = computeAnchor(landmarks, poseId);
  const target = anchorTargetFor(poseId);
  const fitScale = options.fitScale ?? requiredFitScale(landmarks, poseId, baseScale);
  const scale = baseScale * fitScale;
  return {
    flipped,
    sourceWidth,
    scale,
    translateX: target.x - anchor.x * scale,
    translateY: target.y - anchor.y * scale,
    fitScale,
  };
}
