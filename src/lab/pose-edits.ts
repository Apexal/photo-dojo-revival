import type { ArchetypeId } from "../shared/archetypes";
import { CANONICAL_TORSO_LENGTH_PX, LANDMARK, type LandmarkName, type LimbSide, type NormalizedLandmark, type PoseId } from "../shared/fighter-model";
import { captureTargetsFor, type PoseDefinition } from "../shared/pose-definitions";
import { detectFacing, evaluatePose, midHip, midShoulder, type AngleTarget, type PoseEvaluation } from "../shared/pose-geometry";
import {
  STICK_BONUS_POSES,
  STICK_POSES,
  STICK_SIGNATURE_POSES,
  buildStickFigureLandmarks,
  headCenter,
  stickFigureSvgPath,
  type StickPoseParams,
} from "../shared/stick-figure";

/**
 * The lab's editable copy of one capture target: its definition (pose-definitions.ts)
 * and its ghost skeleton (stick-figure.ts). Pure, so it's Node-tested.
 */
export interface PoseEdit {
  label: string;
  voicePrompt: string;
  angleTargets: AngleTarget[];
  requiredVisibleLandmarks: LandmarkName[];
  attackLimb?: "arm" | "leg";
  stick: StickPoseParams;
}

/** Edits are kept per capture key; the signature's per archetype ("signature:grappler"). */
export function editKey(key: string, archetype: ArchetypeId): string {
  return key === "signature" ? `signature:${archetype}` : key;
}

export function poseIdOf(key: string): PoseId {
  return key.split("-")[0] as PoseId;
}

function stickDefaults(key: string, archetype: ArchetypeId): StickPoseParams {
  if (key === "signature") return STICK_SIGNATURE_POSES[archetype];
  return STICK_BONUS_POSES[key] ?? STICK_POSES[key as Exclude<PoseId, "signature">];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The target as the source code has it now. */
export function defaultEdit(key: string, archetype: ArchetypeId): PoseEdit {
  const target = captureTargetsFor(archetype).find((t) => t.key === key);
  if (!target) throw new Error(`No capture target ${key}`);
  const { label, voicePrompt, angleTargets, requiredVisibleLandmarks, attackLimb } = target.definition;
  return clone({ label, voicePrompt, angleTargets, requiredVisibleLandmarks, ...(attackLimb ? { attackLimb } : {}), stick: stickDefaults(key, archetype) });
}

export function isModified(edit: PoseEdit, key: string, archetype: ArchetypeId): boolean {
  return JSON.stringify(edit) !== JSON.stringify(defaultEdit(key, archetype));
}

export function stickLandmarks(edit: PoseEdit, key: string) {
  return buildStickFigureLandmarks(poseIdOf(key), edit.stick);
}

/** What the matcher scores against, with the edited ghost. */
export function toDefinition(edit: PoseEdit, key: string): PoseDefinition {
  const { stick, ...spec } = edit;
  return { poseId: poseIdOf(key), ...spec, ghostSvgPath: stickFigureSvgPath(stickLandmarks(edit, key)) };
}

/** The ghost scored against its own definition: a ghost that doesn't pass shows people a pose that can't be captured. */
export function ghostSelfCheck(edit: PoseEdit, key: string): PoseEvaluation {
  return evaluatePose(stickLandmarks(edit, key), edit);
}

const FULL_BODY: readonly LandmarkName[] = ["nose", "leftShoulder", "rightShoulder", "leftHip", "rightHip", "leftAnkle", "rightAnkle"];

const propertyName = (key: string) => (/^[a-z]\w*$/i.test(key) ? key : JSON.stringify(key));
const round = (n: number) => Math.round(n * 10) / 10;

/** The key the spec has in its table: SPECS / ALTERNATE_SPECS by capture key, SIGNATURE_SPECS by archetype. */
function specName(key: string, archetype: ArchetypeId): string {
  return propertyName(key === "signature" ? archetype : key);
}

/** The edit as an entry of SPECS, ALTERNATE_SPECS or SIGNATURE_SPECS in pose-definitions.ts (comments aren't kept). */
export function specSnippet(edit: PoseEdit, key: string, archetype: ArchetypeId): string {
  const required = edit.requiredVisibleLandmarks;
  const fullBody = required.length === FULL_BODY.length && FULL_BODY.every((n) => required.includes(n));
  const lines = [
    `  ${specName(key, archetype)}: {`,
    ...(key.includes("-") ? [`    poseId: ${JSON.stringify(poseIdOf(key))},`] : []),
    `    label: ${JSON.stringify(edit.label)},`,
    `    voicePrompt: ${JSON.stringify(edit.voicePrompt)},`,
    `    angleTargets: [`,
    ...edit.angleTargets.map((t) => `      { joint: ${JSON.stringify(t.joint)}, degrees: ${round(t.degrees)}, tolerance: ${round(t.tolerance)} },`),
    `    ],`,
    `    requiredVisibleLandmarks: ${fullBody ? "FULL_BODY" : `[${required.map((n) => JSON.stringify(n)).join(", ")}]`},`,
    ...(edit.attackLimb ? [`    attackLimb: ${JSON.stringify(edit.attackLimb)},`] : []),
    `  },`,
  ];
  return lines.join("\n");
}

/** The ghost as an entry of STICK_POSES, STICK_BONUS_POSES or STICK_SIGNATURE_POSES in stick-figure.ts. */
export function stickSnippet(edit: PoseEdit, key: string, archetype: ArchetypeId): string {
  const { torsoLean, headTilt, arms, legs } = edit.stick;
  const limbs = (l: StickPoseParams["arms"]) =>
    `{ right: { swing: ${round(l.right.swing)}, bend: ${round(l.right.bend)} }, left: { swing: ${round(l.left.swing)}, bend: ${round(l.left.bend)} } }`;
  return [
    `  ${specName(key, archetype)}: {`,
    `    torsoLean: ${round(torsoLean)}, headTilt: ${round(headTilt)},`,
    `    arms: ${limbs(arms)},`,
    `    legs: ${limbs(legs)},`,
    `  },`,
  ].join("\n");
}

interface Vec { x: number; y: number }

/** The angle stick-figure.ts's `rot` turns `from` by to point along `to` ("forward" positive), -180..180. */
function turn(from: Vec, to: Vec): number {
  return -(Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y) * 180) / Math.PI;
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });

/** The stick figure's head centre sits this far (degrees, seen from the shoulders) ahead of its neck. */
const HEAD_AHEAD = (Math.atan2(6, 0.36 * CANONICAL_TORSO_LENGTH_PX) * 180) / Math.PI;

/**
 * The stick-figure parameters of a real pose (the inverse of buildStickFigureLandmarks),
 * to make a ghost from someone striking it. `side`: the side the definition matched on;
 * "left" swaps the limbs, since definitions and ghosts are written for the right.
 * Faces right whichever way the person faced. `px` in frame pixels.
 */
export function stickFromLandmarks(px: NormalizedLandmark[], side: LimbSide = "right"): StickPoseParams {
  const facing = detectFacing(px);
  const lm = facing === "left" ? px.map((l) => ({ ...l, x: -l.x })) : px;
  const hip = midHip(lm), shoulder = midShoulder(lm);
  const up = sub(shoulder, hip);
  const down = { x: -up.x, y: -up.y };
  const p = (i: number) => lm[i];
  const limb = (s: LimbSide, kind: "arm" | "leg") => {
    const [root, mid, tip] = kind === "arm"
      ? [LANDMARK[`${s}Shoulder`], LANDMARK[`${s}Elbow`], LANDMARK[`${s}Wrist`]]
      : [LANDMARK[`${s}Hip`], LANDMARK[`${s}Knee`], LANDMARK[`${s}Ankle`]];
    const upper = sub(p(mid), p(root)), lower = sub(p(tip), p(mid));
    const bend = turn(upper, lower);
    return { swing: Math.round(turn(down, upper)), bend: Math.round(kind === "arm" ? 180 - bend : 180 + bend) };
  };
  const other: LimbSide = side === "right" ? "left" : "right";
  return {
    torsoLean: Math.round(-turn({ x: 0, y: -1 }, up)),
    headTilt: Math.round(-turn(up, sub(headCenter(lm), shoulder)) - HEAD_AHEAD),
    arms: { right: limb(side, "arm"), left: limb(other, "arm") },
    legs: { right: limb(side, "leg"), left: limb(other, "leg") },
  };
}

/** Edits saved in localStorage: anything that doesn't look like one is dropped. */
export function parseEdits(json: string | null): Record<string, PoseEdit> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, PoseEdit>;
    return Object.fromEntries(Object.entries(parsed).filter(([, e]) => e && Array.isArray(e.angleTargets) && e.stick?.arms && e.stick?.legs));
  } catch {
    return {};
  }
}
