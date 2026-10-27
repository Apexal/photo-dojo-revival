import { ARCHETYPE_IDS, type ArchetypeId } from "./archetypes";
import { POSE_IDS, type LandmarkName, type PoseId } from "./fighter-model";
import type { PoseTarget } from "./pose-geometry";
import { STICK_BONUS_POSES, STICK_SIGNATURE_POSES, buildStickFigureLandmarks, stickFigureSvgPath } from "./stick-figure";

export interface PoseDefinition extends PoseTarget {
  poseId: PoseId;
  /** SVG path data in sprite-canvas coordinates (512×512, anchor at the ground line). */
  ghostSvgPath: string;
  voicePrompt: string;
  /** Short on-screen instruction. */
  label: string;
}

const FULL_BODY: LandmarkName[] = ["nose", "leftShoulder", "rightShoulder", "leftHip", "rightHip", "leftAnkle", "rightAnkle"];

type DefinitionSpec = Omit<PoseDefinition, "ghostSvgPath" | "poseId">;

type MainPoseId = Exclude<PoseId, "signature">;

const SPECS: Record<MainPoseId, DefinitionSpec> = {
  idle: {
    label: "Fighting stance",
    voicePrompt: "Fighting stance. Fists up by your chin, feet apart.",
    angleTargets: [
      { joint: "rightElbow", degrees: 45, tolerance: 35 },
      { joint: "leftElbow", degrees: 45, tolerance: 35 },
      { joint: "rightShoulderElevation", degrees: 30, tolerance: 25 },
      { joint: "legSpread", degrees: 22, tolerance: 12 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  // The walk is drawn from the stance and this step (walk-gait.ts): the stance with the front foot slid
  // further forward. Guard up, same height, same lead foot, or every stride flaps the arms, bobs and crosses the legs.
  walk: {
    label: "Step forward",
    voicePrompt: "Step. Keep your guard up and slide your front foot forward. A big step, same height.",
    angleTargets: [
      { joint: "legSpread", degrees: 52, tolerance: 15 },
      { joint: "torsoLean", degrees: 5, tolerance: 12 }, // the stance's lean: not straightening up, not lunging
      { joint: "rightElbow", degrees: 45, tolerance: 35 }, // the stance's guard
      { joint: "leftElbow", degrees: 45, tolerance: 35 },
      { joint: "rightShoulderElevation", degrees: 30, tolerance: 25 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  block: {
    label: "Block",
    voicePrompt: "Block. Arms up in front of your face, knees bent.",
    angleTargets: [
      { joint: "rightElbow", degrees: 45, tolerance: 30 },
      { joint: "leftElbow", degrees: 45, tolerance: 30 },
      { joint: "rightShoulderElevation", degrees: 75, tolerance: 30 },
      { joint: "rightKnee", degrees: 140, tolerance: 25 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  crouch: {
    label: "Crouch block",
    voicePrompt: "Crouch block. Squat down low, arms up around your head.",
    angleTargets: [
      { joint: "rightKnee", degrees: 70, tolerance: 30 },
      { joint: "rightHipFlexion", degrees: 90, tolerance: 30 },
      { joint: "rightElbow", degrees: 45, tolerance: 35 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  punch: {
    label: "Punch",
    voicePrompt: "Punch. Arm straight out.",
    angleTargets: [
      { joint: "rightElbow", degrees: 175, tolerance: 25 },             // arm extended
      { joint: "rightShoulderElevation", degrees: 90, tolerance: 25 },  // arm forward at shoulder height
      { joint: "leftElbow", degrees: 60, tolerance: 40 },               // guard hand bent
    ],
    requiredVisibleLandmarks: ["rightWrist", "rightShoulder", "leftHip", "rightAnkle"],
    attackLimb: "arm",
  },
  kick: {
    label: "Kick",
    voicePrompt: "Kick. Leg straight out in front.",
    angleTargets: [
      { joint: "rightHipFlexion", degrees: 85, tolerance: 30 },
      { joint: "rightKnee", degrees: 165, tolerance: 25 },
      { joint: "leftKnee", degrees: 170, tolerance: 25 },
    ],
    requiredVisibleLandmarks: ["rightHip", "rightKnee", "rightAnkle", "leftAnkle", "rightShoulder"],
    attackLimb: "leg",
  },
  jump: {
    label: "Jump",
    voicePrompt: "Jump pose. Arms up, knees bent. Stay on the ground.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 155, tolerance: 30 },
      { joint: "leftShoulderElevation", degrees: 155, tolerance: 30 },
      { joint: "rightKnee", degrees: 115, tolerance: 35 },
      { joint: "leftKnee", degrees: 120, tolerance: 35 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  hurt: {
    label: "Get hit",
    voicePrompt: "Ouch. Lean back, off balance.",
    angleTargets: [
      { joint: "torsoLean", degrees: 28, tolerance: 15 },
      { joint: "rightElbow", degrees: 120, tolerance: 45 },
      { joint: "rightShoulderElevation", degrees: 50, tolerance: 35 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  win: {
    label: "Victory",
    voicePrompt: "You win! Hands up.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 160, tolerance: 35 },
      { joint: "leftShoulderElevation", degrees: 160, tolerance: 35 },
      { joint: "rightKnee", degrees: 172, tolerance: 25 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  handshake: {
    label: "Handshake",
    voicePrompt: "Last one: a handshake. Reach out to shake your opponent's hand, elbow a little bent.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 50, tolerance: 20 }, // hand out at waist height, not a punch
      { joint: "rightElbow", degrees: 150, tolerance: 25 },
      { joint: "leftShoulderElevation", degrees: 10, tolerance: 20 },   // other arm down
      { joint: "rightKnee", degrees: 172, tolerance: 20 },              // standing tall
    ],
    requiredVisibleLandmarks: FULL_BODY,
    // Either hand: the game shakes with whichever one was held out.
    attackLimb: "arm",
  },
};

/** The main poses but the signature, whose definition depends on the archetype (SIGNATURE_DEFINITIONS). */
export const POSE_DEFINITIONS: Record<MainPoseId, PoseDefinition> = Object.fromEntries(
  POSE_IDS.filter((poseId) => poseId !== "signature").map((poseId) => [
    poseId,
    { poseId, ...SPECS[poseId as MainPoseId], ghostSvgPath: stickFigureSvgPath(buildStickFigureLandmarks(poseId)) },
  ]),
) as Record<MainPoseId, PoseDefinition>;

/** Each archetype's signature pose (see archetypes.ts and STICK_SIGNATURE_POSES). */
const SIGNATURE_SPECS: Record<ArchetypeId, DefinitionSpec> = {
  brawler: {
    label: "Shoulder charge",
    voicePrompt: "Shoulder charge! Lean hard into your front shoulder, arm tucked, and lunge forward.",
    angleTargets: [
      { joint: "torsoLean", degrees: 28, tolerance: 14 },
      { joint: "legSpread", degrees: 68, tolerance: 22 },
      { joint: "rightElbow", degrees: 60, tolerance: 35 }, // tucked, not punching
    ],
    requiredVisibleLandmarks: FULL_BODY,
    attackLimb: "arm",
  },
  grappler: {
    label: "Bear hug",
    voicePrompt: "Bear hug! Both arms out wide at chest height, ready to squeeze.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 80, tolerance: 25 },
      { joint: "leftShoulderElevation", degrees: 78, tolerance: 25 },
      { joint: "rightElbow", degrees: 128, tolerance: 30 },
      { joint: "leftElbow", degrees: 125, tolerance: 30 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  guardian: {
    label: "Parry",
    voicePrompt: "Parry! Front palm up and out like a stop sign, other fist by your chin.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 105, tolerance: 25 },
      { joint: "rightElbow", degrees: 115, tolerance: 30 },
      { joint: "leftElbow", degrees: 45, tolerance: 35 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
    attackLimb: "arm",
  },
  acrobat: {
    label: "Flying knee",
    voicePrompt: "Flying knee! Drive your front knee up high, on one foot.",
    angleTargets: [
      { joint: "rightHipFlexion", degrees: 108, tolerance: 25 },
      { joint: "rightKnee", degrees: 62, tolerance: 30 },
      { joint: "leftKnee", degrees: 168, tolerance: 22 },
    ],
    requiredVisibleLandmarks: ["rightHip", "rightKnee", "rightAnkle", "leftAnkle", "rightShoulder"],
    attackLimb: "leg",
  },
};

export const SIGNATURE_DEFINITIONS: Record<ArchetypeId, PoseDefinition> = Object.fromEntries(
  ARCHETYPE_IDS.map((id) => [
    id,
    { poseId: "signature", ...SIGNATURE_SPECS[id], ghostSvgPath: stickFigureSvgPath(buildStickFigureLandmarks("signature", STICK_SIGNATURE_POSES[id])) },
  ]),
) as Record<ArchetypeId, PoseDefinition>;

/** A main pose's definition; the signature pose's is the archetype's. */
export function poseDefinition(poseId: PoseId, archetype: ArchetypeId): PoseDefinition {
  return poseId === "signature" ? SIGNATURE_DEFINITIONS[archetype] : POSE_DEFINITIONS[poseId];
}

/**
 * Second versions of five poses, keyed like "punch-2": a second stance the idle
 * sways into, the uppercut and low kick moves, plus alternate hit and win reactions.
 */
const ALTERNATE_SPECS: Record<string, DefinitionSpec & { poseId: PoseId }> = {
  "idle-2": {
    poseId: "idle",
    label: "Stance, breathing in",
    // Close to the main stance on purpose: standing still, the fighter sways between the two.
    voicePrompt: "Fighting stance again. Bend your knees a little more and breathe in.",
    angleTargets: [
      { joint: "rightElbow", degrees: 50, tolerance: 35 },
      { joint: "leftElbow", degrees: 50, tolerance: 35 },
      { joint: "rightShoulderElevation", degrees: 28, tolerance: 25 },
      { joint: "legSpread", degrees: 24, tolerance: 14 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  "punch-2": {
    poseId: "punch",
    label: "Uppercut",
    voicePrompt: "Uppercut. Drive your fist up high.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 140, tolerance: 25 },
      { joint: "rightElbow", degrees: 150, tolerance: 30 },
      { joint: "leftElbow", degrees: 60, tolerance: 40 },
    ],
    requiredVisibleLandmarks: ["rightWrist", "rightShoulder", "leftHip", "rightAnkle"],
    attackLimb: "arm",
  },
  "kick-2": {
    poseId: "kick",
    label: "Low kick",
    voicePrompt: "Low kick. Sweep a straight leg forward, low.",
    angleTargets: [
      { joint: "rightHipFlexion", degrees: 45, tolerance: 15 },
      { joint: "rightKnee", degrees: 170, tolerance: 20 },
      { joint: "legSpread", degrees: 55, tolerance: 20 },
    ],
    requiredVisibleLandmarks: ["rightHip", "rightKnee", "rightAnkle", "leftAnkle", "rightShoulder"],
    attackLimb: "leg",
  },
  "hurt-2": {
    poseId: "hurt",
    label: "Hit in the face",
    // Same lean as the main hurt pose (whose hurtboxes count for both); only the hands differ.
    voicePrompt: "Ow, my face! Lean back again, both hands on your face.",
    angleTargets: [
      { joint: "torsoLean", degrees: 28, tolerance: 15 },
      { joint: "rightShoulderElevation", degrees: 100, tolerance: 30 },
      { joint: "rightElbow", degrees: 40, tolerance: 30 },
      { joint: "rightKnee", degrees: 150, tolerance: 25 }, // standing, as in the main hurt pose: not a crouch
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
  "win-2": {
    poseId: "win",
    label: "Flex",
    voicePrompt: "Flex! Both arms up like a bodybuilder.",
    angleTargets: [
      { joint: "rightShoulderElevation", degrees: 95, tolerance: 25 },
      { joint: "leftShoulderElevation", degrees: 90, tolerance: 25 },
      { joint: "rightElbow", degrees: 60, tolerance: 30 },
      { joint: "rightKnee", degrees: 172, tolerance: 20 },
    ],
    requiredVisibleLandmarks: FULL_BODY,
  },
};

export const ALTERNATE_DEFINITIONS: Record<string, PoseDefinition> = Object.fromEntries(
  Object.entries(ALTERNATE_SPECS).map(([key, spec]) => [
    key,
    { ...spec, ghostSvgPath: stickFigureSvgPath(buildStickFigureLandmarks(spec.poseId, STICK_BONUS_POSES[key])) },
  ]),
);

/** One thing to capture: a main pose (variant 0) or its second version (variant 1). */
export interface CaptureTarget {
  key: string;
  poseId: PoseId;
  variant: number;
  definition: PoseDefinition;
}

/**
 * Every fighter captures all sixteen: the shared moveset's poses, then the
 * signature (once the archetype is picked, after the win poses), and the
 * handshake (the round intro) closes the session. Alternates come right after their main pose.
 */
export const CAPTURE_KEYS = ["idle", "idle-2", "walk", "block", "crouch", "punch", "punch-2", "kick", "kick-2", "jump", "hurt", "hurt-2", "win", "win-2", "signature", "handshake"] as const;

export const CAPTURE_TARGET_COUNT = CAPTURE_KEYS.length;
/** Where the signature pose sits in the capture order: the archetype is picked just before it. */
export const SIGNATURE_TARGET_INDEX = CAPTURE_KEYS.indexOf("signature");

/** What to capture, in order, for a fighter of this archetype. */
export function captureTargetsFor(archetype: ArchetypeId): readonly CaptureTarget[] {
  return CAPTURE_TARGETS[archetype];
}

const CAPTURE_TARGETS = Object.fromEntries(ARCHETYPE_IDS.map((archetype) => [
  archetype,
  CAPTURE_KEYS.map((key): CaptureTarget => {
    const alternate = ALTERNATE_DEFINITIONS[key];
    return alternate
      ? { key, poseId: alternate.poseId, variant: Number(key.split("-")[1]) - 1, definition: alternate }
      : { key, poseId: key as PoseId, variant: 0, definition: poseDefinition(key as PoseId, archetype) };
  }),
])) as unknown as Record<ArchetypeId, readonly CaptureTarget[]>;

/** Alternates every fighter has: variant 1 of each of these poses. */
export const REQUIRED_VARIANT_POSES: readonly PoseId[] = CAPTURE_TARGETS.brawler.filter((t) => t.variant > 0).map((t) => t.poseId);
