import { CANONICAL_TORSO_LENGTH_PX, LANDMARK, type LimbSide, type NormalizedLandmark, type PoseId } from "./fighter-model";
import { midHip } from "./pose-geometry";
import { headCenter, stickFigureGeometry } from "./stick-figure";

/** Axis-aligned box; x/y is the top-left corner, y grows downward. */
export interface Box { x: number; y: number; width: number; height: number }

export type MovePhase = "startup" | "active" | "recovery";
export interface PoseFrame { poseId: PoseId; frames: number; phase?: MovePhase }

export type AttackId = "punch" | "kick" | "uppercut" | "lowKick" | "jumpKick";

/** mid: block either way; low: must crouch-block; overhead: must block standing; high: block standing, whiffs over a crouch. */
export type HitLevel = "mid" | "low" | "overhead" | "high";

export interface AttackData {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  hitstun: number;
  /** Frames a blocking defender stays locked in block. */
  blockstun: number;
  pushback: number;
  /**
   * How far the fighter steps forward during startup (sprite px). Kicks step in, so
   * they win at a range a punch can't reach: the punch is fast, the kick is long.
   */
  advance?: number;
  /** Which limb carries the hitbox. */
  limb: "arm" | "leg";
  level: HitLevel;
  /** The pose (and captured version) shown on active frames: uppercut / low kick use the second punch / kick captures. */
  pose: { poseId: PoseId; variant: number };
  sequence: PoseFrame[];
}

/*
 * Frame advantage (attacker's turn minus defender's, hitstop excluded) works out to
 * hitstun − (active − 1 + recovery) − 1 on hit, and the same with blockstun on block:
 *
 *              on hit   on block
 *   punch        +3        −3     safe: too little for a 4f punch to punish; high: whiffs over a crouching guard
 *   kick         +2        −6     the long one: lunges 60 px on its active frames, so it beats a punch at
 *                                 long range; punishable up close, safe blocked at the tip (pushback 20)
 *   uppercut     +2        −8     anti-air: airborne attacks can't hit it during startup/active; very punishable on block
 *   low kick     +1        −4     quick poke along the ground (lunges 20 px); must be blocked crouching
 *
 * The jump kick is an overhead (must be blocked standing); landing ends it, so its
 * advantage depends on how high it hits.
 */
export const ATTACKS: Record<AttackId, AttackData> = {
  punch: {
    startup: 4, active: 3, recovery: 10, damage: 8, hitstun: 16, blockstun: 10, pushback: 6,
    limb: "arm", level: "high", pose: { poseId: "punch", variant: 0 },
    sequence: [
      { poseId: "idle", frames: 4, phase: "startup" },
      { poseId: "punch", frames: 3, phase: "active" },
      { poseId: "punch", frames: 4, phase: "recovery" },
      { poseId: "idle", frames: 6, phase: "recovery" },
    ],
  },
  kick: {
    startup: 7, active: 4, recovery: 16, damage: 12, hitstun: 22, blockstun: 14, pushback: 20, advance: 60,
    limb: "leg", level: "mid", pose: { poseId: "kick", variant: 0 },
    sequence: [
      { poseId: "idle", frames: 7, phase: "startup" },
      { poseId: "kick", frames: 4, phase: "active" },
      { poseId: "kick", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 10, phase: "recovery" },
    ],
  },
  uppercut: {
    startup: 6, active: 4, recovery: 18, damage: 11, hitstun: 24, blockstun: 14, pushback: 12,
    limb: "arm", level: "mid", pose: { poseId: "punch", variant: 1 },
    sequence: [
      { poseId: "block", frames: 6, phase: "startup" },
      { poseId: "punch", frames: 4, phase: "active" },
      { poseId: "punch", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 12, phase: "recovery" },
    ],
  },
  lowKick: {
    startup: 6, active: 3, recovery: 12, damage: 7, hitstun: 16, blockstun: 11, pushback: 8, advance: 20,
    limb: "leg", level: "low", pose: { poseId: "kick", variant: 1 },
    sequence: [
      { poseId: "idle", frames: 6, phase: "startup" },
      { poseId: "kick", frames: 3, phase: "active" },
      { poseId: "kick", frames: 5, phase: "recovery" },
      { poseId: "idle", frames: 7, phase: "recovery" },
    ],
  },
  /**
   * Kick in the air, once per jump. It stays out until landing (which cancels it),
   * so a late jump kick comes down onto a crouching guard: the overhead has to beat
   * a crouch, or crouching would be safe against everything but throws.
   */
  jumpKick: {
    startup: 5, active: 40, recovery: 4, damage: 10, hitstun: 18, blockstun: 12, pushback: 8,
    limb: "leg", level: "overhead", pose: { poseId: "kick", variant: 0 },
    sequence: [
      { poseId: "jump", frames: 5, phase: "startup" },
      { poseId: "kick", frames: 40, phase: "active" },
      { poseId: "jump", frames: 4, phase: "recovery" },
    ],
  },
};

/** Does this attack pass over a crouching guard (instead of hitting or being blocked)? */
export function whiffsOverCrouch(level: HitLevel): boolean {
  return level === "high";
}

/** Can this guard stop that attack? */
export function guardBlocks(level: HitLevel, crouching: boolean): boolean {
  return level === "mid" || (level === "low") === crouching;
}

/** Punch + kick from at least this far away taunts instead of throwing: win pose, voice line, wide open. */
export const TAUNT = { frames: 50, minDistance: 300 } as const;
/** Frames on the ground before a jump leaves it; the jump can still turn into a block during them. */
export const JUMP_SQUAT_FRAMES = 3;
/** A block counts if back (or down, for a crouch block) was held within this many frames. */
export const BLOCK_LENIENCY_FRAMES = 3;

/**
 * Throw: beats block, loses to attacks (a fighter in an attack's startup or
 * active frames can't be grabbed), whiffs into long recovery. The grabbed
 * fighter can break it by pressing punch + kick during the tech window.
 */
export const THROW = {
  startup: 5,
  active: 1,
  recovery: 20,
  damage: 12,
  /** Frames the grabbed fighter has to press punch + kick and break free. */
  techWindow: 8,
  /** Hurt frames after the throw lands; leaves the thrower well ahead. */
  releaseHitstun: 26,
  throwDistance: 90,
  /** Max gap between the two push boxes for the grab to connect. */
  range: 40,
  sequence: [
    { poseId: "idle", frames: 5, phase: "startup" },
    { poseId: "punch", frames: 1, phase: "active" },
    { poseId: "punch", frames: 6, phase: "recovery" },
    { poseId: "idle", frames: 14, phase: "recovery" },
  ] as PoseFrame[],
} as const;

export const THROW_TOTAL_FRAMES = THROW.startup + THROW.active + THROW.recovery;
/** Pressing the second button this many frames into a punch/kick turns it into a throw. */
export const THROW_LENIENCY_FRAMES = 2;
/** A punch/kick press is remembered this long, so pressing a little early still works. */
export const INPUT_BUFFER_FRAMES = 5;

export function attackTotalFrames(attack: AttackData): number {
  return attack.startup + attack.active + attack.recovery;
}

export function attackPhaseAt(attack: AttackData, actionFrame: number): MovePhase | null {
  if (actionFrame < 0) return null;
  if (actionFrame < attack.startup) return "startup";
  if (actionFrame < attack.startup + attack.active) return "active";
  if (actionFrame < attackTotalFrames(attack)) return "recovery";
  return null;
}

/** The pose shown on a given frame of a sequence; the last entry holds if the frame runs past the end. */
export function poseAtFrame(sequence: PoseFrame[], actionFrame: number): PoseFrame {
  let f = actionFrame;
  for (const entry of sequence) {
    if (f < entry.frames) return entry;
    f -= entry.frames;
  }
  return sequence[sequence.length - 1];
}

export type FighterAction =
  | "idle" | "walk" | "jump" | "block" | "blockstun"
  | "jumpSquat"
  | "punch" | "kick" | "uppercut" | "lowKick" | "jumpKick" | "throw" | "taunt"
  | "grabbed" | "hurt" | "ko" | "win";

/** Walk alternates between the walk and idle captures for a hard-cut stride. */
export const WALK_CYCLE: PoseFrame[] = [
  { poseId: "walk", frames: 10 },
  { poseId: "idle", frames: 10 },
];

export function poseForAction(action: FighterAction, actionFrame: number): PoseId {
  switch (action) {
    case "punch":
    case "kick":
    case "uppercut":
    case "lowKick":
    case "jumpKick":
      return poseAtFrame(ATTACKS[action].sequence, actionFrame).poseId;
    case "jumpSquat":
      return "block"; // the crouch before the jump
    case "taunt":
      return "win";
    case "throw":
      return poseAtFrame(THROW.sequence, actionFrame).poseId;
    case "grabbed":
      return "hurt";
    case "blockstun":
      return "block";
    case "walk":
      return poseAtFrame(WALK_CYCLE, actionFrame % (WALK_CYCLE[0].frames + WALK_CYCLE[1].frames)).poseId;
    case "ko":
      return "hurt";
    default:
      return action;
  }
}

// ---------------------------------------------------------------------------
// Boxes derived from each fighter's own landmarks (sprite-canvas space).

export const HURTBOX_VISIBILITY = 0.5;
export const PUNCH_HITBOX_SIZE = 48;
export const KICK_HITBOX_SIZE = 56;
export const BODY_BOX_WIDTH_FRACTION = 0.6;

export interface PoseGeometry {
  landmarks: NormalizedLandmark[];
  anchorPoint: { x: number; y: number };
  attackSide?: LimbSide;
}

export type FighterGeometry = Record<PoseId, PoseGeometry> & {
  /** Captured alternates; variant n uses variants[poseId][n - 1]. */
  variants?: Partial<Record<PoseId, PoseGeometry[]>>;
};

/** Geometry for one displayed frame; unknown variants fall back to the main capture. */
export function frameGeometry(geometry: FighterGeometry, poseId: PoseId, variant = 0): PoseGeometry {
  return (variant > 0 && geometry.variants?.[poseId]?.[variant - 1]) || geometry[poseId];
}

/** How many versions of a pose a fighter has (main capture + alternates). */
export function variantCount(geometry: FighterGeometry, poseId: PoseId): number {
  return 1 + (geometry.variants?.[poseId]?.length ?? 0);
}

/**
 * The pose whose captured alternates are picked at random for an action (null: none).
 * Attacks don't vary randomly: their alternates are separate moves (uppercut, low kick).
 */
export function variantPoseFor(action: FighterAction): PoseId | null {
  switch (action) {
    case "hurt":
    case "ko": return "hurt";
    case "win":
    case "taunt": return "win";
    // Grabbed always shows the main hurt pose, so the throw animation always reads the same.
    default: return null;
  }
}

export function boundingBox(points: { x: number; y: number }[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function expandBox(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

/**
 * Hurtbox part sizes, in sprite pixels (fighters are normalized to the same torso
 * length, CANONICAL_TORSO_LENGTH_PX). The same for every fighter: how thick
 * someone's limbs look in their photo doesn't change how easy they are to hit.
 */
export const HURT_PART_SIZE = {
  /** Half the head box's side, around the head centre (with room for hair). */
  head: 0.26 * CANONICAL_TORSO_LENGTH_PX,
  /** Padding around the shoulders-and-hips box. */
  torso: 0.25 * CANONICAL_TORSO_LENGTH_PX,
  /** Half an arm's / a leg's thickness. */
  arm: 0.1 * CANONICAL_TORSO_LENGTH_PX,
  leg: 0.14 * CANONICAL_TORSO_LENGTH_PX,
} as const;

/** Limb bones; each becomes two boxes (one per half), so a diagonal limb isn't one big rectangle. */
const HURT_BONES: [number, number, "arm" | "leg"][] = [
  [LANDMARK.leftShoulder, LANDMARK.leftElbow, "arm"], [LANDMARK.leftElbow, LANDMARK.leftWrist, "arm"],
  [LANDMARK.rightShoulder, LANDMARK.rightElbow, "arm"], [LANDMARK.rightElbow, LANDMARK.rightWrist, "arm"],
  [LANDMARK.leftHip, LANDMARK.leftKnee, "leg"], [LANDMARK.leftKnee, LANDMARK.leftAnkle, "leg"],
  [LANDMARK.rightHip, LANDMARK.rightKnee, "leg"], [LANDMARK.rightKnee, LANDMARK.rightAnkle, "leg"],
  [LANDMARK.leftAnkle, LANDMARK.leftFootIndex, "leg"], [LANDMARK.rightAnkle, LANDMARK.rightFootIndex, "leg"],
];

/**
 * The body as boxes: head, torso, and each visible limb bone in two halves.
 * Only where the body is can be hit: the empty space under an extended arm or
 * above a crouch isn't part of it. The extended attacking limb is, so whiffs can be punished.
 */
export function rawHurtboxesFor(pose: PoseGeometry): Box[] {
  const l = pose.landmarks;
  const head = headCenter(l);
  const boxes: Box[] = [
    expandBox({ x: head.x, y: head.y, width: 0, height: 0 }, HURT_PART_SIZE.head),
    expandBox(boundingBox([l[LANDMARK.leftShoulder], l[LANDMARK.rightShoulder], l[LANDMARK.leftHip], l[LANDMARK.rightHip]]), HURT_PART_SIZE.torso),
  ];
  for (const [a, b, kind] of HURT_BONES) {
    if (l[a].visibility <= HURTBOX_VISIBILITY || l[b].visibility <= HURTBOX_VISIBILITY) continue;
    const mid = { x: (l[a].x + l[b].x) / 2, y: (l[a].y + l[b].y) / 2 };
    boxes.push(expandBox(boundingBox([l[a], mid]), HURT_PART_SIZE[kind]), expandBox(boundingBox([mid, l[b]]), HURT_PART_SIZE[kind]));
  }
  return boxes;
}

/** How far each hurtbox edge may stray from the reference fighter's: 15%, but at least this many px. */
export const HURTBOX_MIN_TOLERANCE_PX = 16;

/**
 * Hurtboxes, each clipped to the reference fighter's same frame (its overall
 * extent from the feet anchor, ±15%): a sprawling capture doesn't make you a
 * bigger target. Pass the frame to clip; omit it for the raw boxes.
 */
export function hurtboxesFor(pose: PoseGeometry, frame?: { poseId: PoseId; variant: number }): Box[] {
  const boxes = rawHurtboxesFor(pose);
  if (!frame) return boxes;
  const ref = canonicalHurtExtent(frame.poseId, frame.variant);
  const a = pose.anchorPoint;
  const tol = (edge: number) => Math.max(HURTBOX_MIN_TOLERANCE_PX, Math.abs(edge) * REACH_TOLERANCE);
  const limit = { left: a.x + ref.left - tol(ref.left), right: a.x + ref.right + tol(ref.right), top: a.y + ref.top - tol(ref.top), bottom: a.y + ref.bottom + tol(ref.bottom) };
  const clipped: Box[] = [];
  for (const b of boxes) {
    if (b.x >= limit.left && b.x + b.width <= limit.right && b.y >= limit.top && b.y + b.height <= limit.bottom) {
      clipped.push(b);
      continue;
    }
    const left = Math.max(b.x, limit.left), right = Math.min(b.x + b.width, limit.right);
    const top = Math.max(b.y, limit.top), bottom = Math.min(b.y + b.height, limit.bottom);
    if (right > left && bottom > top) clipped.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return clipped;
}

const hurtExtentCache = new Map<string, { left: number; right: number; top: number; bottom: number }>();

/** The reference fighter's overall hurtbox extent for a frame, relative to its anchor. */
function canonicalHurtExtent(poseId: PoseId, variant: number) {
  const key = `${poseId}#${variant}`;
  let edges = hurtExtentCache.get(key);
  if (!edges) {
    referenceGeometry ??= stickFigureGeometry();
    const pose = frameGeometry(referenceGeometry, poseId, variant);
    const boxes = rawHurtboxesFor(pose);
    const b = boundingBox(boxes.flatMap((x) => [{ x: x.x, y: x.y }, { x: x.x + x.width, y: x.y + x.height }]));
    edges = { left: b.x - pose.anchorPoint.x, right: b.x + b.width - pose.anchorPoint.x, top: b.y - pose.anchorPoint.y, bottom: b.y + b.height - pose.anchorPoint.y };
    hurtExtentCache.set(key, edges);
  }
  return edges;
}

/**
 * The striking limb: a 48 (arm) / 56 (leg) px square on the wrist/ankle,
 * stretched back along the limb (to the shoulder for an arm, the knee for a
 * leg) so a point-blank hit still connects: hurtboxes follow the body, and a
 * fist-only box would land behind an opponent standing close.
 */
export function rawHitboxFor(attack: AttackId, pose: PoseGeometry): Box {
  const side = pose.attackSide ?? "right";
  const arm = ATTACKS[attack].limb === "arm";
  const joints = arm
    ? [LANDMARK[`${side}Wrist`], LANDMARK[`${side}Elbow`], LANDMARK[`${side}Shoulder`]]
    : [LANDMARK[`${side}Ankle`], LANDMARK[`${side}Knee`]];
  const size = arm ? PUNCH_HITBOX_SIZE : KICK_HITBOX_SIZE;
  const squares = joints.map((j) => expandBox({ x: pose.landmarks[j].x, y: pose.landmarks[j].y, width: 0, height: 0 }, size / 2));
  return boundingBox(squares.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }]));
}

/** How far a hitbox reaches in front of the fighter's feet (captures face right). */
export function hitboxReach(box: Box, pose: PoseGeometry): number {
  return box.x + box.width - pose.anchorPoint.x;
}

/** Reach may differ from the reference fighter's by at most this fraction. */
export const REACH_TOLERANCE = 0.15;

/**
 * Hitbox with its reach clamped to the reference fighter's ±15%, so long arms or
 * a stretched kick during capture don't decide fights. The box slides toward or
 * away from the fighter; its size and height are unchanged. `referenceReach`
 * comes from the canonical stick figure (see `canonicalReach`).
 */
export function hitboxFor(attack: AttackId, pose: PoseGeometry, referenceReach: number | null = canonicalReach(attack)): Box {
  const box = rawHitboxFor(attack, pose);
  if (referenceReach === null) return box;
  const reach = hitboxReach(box, pose);
  const clamped = Math.min(referenceReach * (1 + REACH_TOLERANCE), Math.max(referenceReach * (1 - REACH_TOLERANCE), reach));
  return { ...box, x: box.x + (clamped - reach) };
}

let referenceGeometry: FighterGeometry | null = null;
const reachCache = new Map<AttackId, number>();

/** Reach of each attack on the canonical stick fighter (the fairness reference). */
export function canonicalReach(attack: AttackId): number {
  referenceGeometry ??= stickFigureGeometry();
  let reach = reachCache.get(attack);
  if (reach === undefined) {
    const { poseId, variant } = ATTACKS[attack].pose;
    const pose = frameGeometry(referenceGeometry, poseId, variant);
    reach = hitboxReach(rawHitboxFor(attack, pose), pose);
    reachCache.set(attack, reach);
  }
  return reach;
}

/** Push boxes are at least this wide (in torso lengths), so fighters can't stand inside each other. */
export const MIN_BODY_BOX_WIDTH_TORSOS = 0.7;

/** Shoulders-to-ankles bounding box narrowed to 60% width (but at least 0.7 torso wide), for push-apart. */
export function bodyBoxFor(pose: PoseGeometry): Box {
  const l = pose.landmarks;
  const b = boundingBox([
    l[LANDMARK.leftShoulder], l[LANDMARK.rightShoulder],
    l[LANDMARK.leftHip], l[LANDMARK.rightHip],
    l[LANDMARK.leftAnkle], l[LANDMARK.rightAnkle],
  ]);
  const torso = Math.hypot(
    (l[LANDMARK.leftShoulder].x + l[LANDMARK.rightShoulder].x - l[LANDMARK.leftHip].x - l[LANDMARK.rightHip].x) / 2,
    (l[LANDMARK.leftShoulder].y + l[LANDMARK.rightShoulder].y - l[LANDMARK.leftHip].y - l[LANDMARK.rightHip].y) / 2,
  );
  const width = Math.max(b.width * BODY_BOX_WIDTH_FRACTION, torso * MIN_BODY_BOX_WIDTH_TORSOS);
  return { x: b.x + (b.width - width) / 2, y: b.y, width, height: b.height };
}

/**
 * Where the fighter's feet are in sprite space for a pose. Grounded poses are anchored
 * at the feet already; the jump pose is anchored at the pelvis, so its feet sit one
 * idle-pelvis-height below.
 */
export function groundAnchorFor(geometry: FighterGeometry, poseId: PoseId, variant = 0): { x: number; y: number } {
  const pose = frameGeometry(geometry, poseId, variant);
  if (poseId !== "jump") return pose.anchorPoint;
  const idle = geometry.idle;
  const pelvisHeight = idle.anchorPoint.y - midHip(idle.landmarks).y;
  return { x: pose.anchorPoint.x, y: pose.anchorPoint.y + pelvisHeight };
}
