import { archetypeOfMove, type ArchetypeId } from "./archetypes";
import { CANONICAL_TORSO_LENGTH_PX, LANDMARK, type LimbSide, type NormalizedLandmark, type PoseId } from "./fighter-model";
import { midHip } from "./pose-geometry";
import { headCenter, stickFigureGeometry } from "./stick-figure";

/** Axis-aligned box; x/y is the top-left corner, y grows downward. */
export interface Box { x: number; y: number; width: number; height: number }

export type MovePhase = "startup" | "active" | "recovery";
/** Show one captured pose for some frames (a hard cut into it). */
export interface HoldFrame { poseId: PoseId; frames: number; phase?: MovePhase }
/**
 * Morph one capture into the next over some frames (ARAP mesh warp, see
 * src/game/render/pose-tweener.ts). Purely visual: hurtboxes, hitboxes and body
 * boxes stay those of `fromPoseId`, so a tween never changes how a move plays.
 * Keep them between side-view poses and short, which is where the warp holds up.
 */
export interface TweenFrame { fromPoseId: PoseId; toPoseId: PoseId; frames: number; phase?: MovePhase }
export type PoseFrame = HoldFrame | TweenFrame;

export const isTween = (entry: PoseFrame): entry is TweenFrame => "fromPoseId" in entry;
/** The pose whose geometry counts for an entry: a tween plays as the pose it leaves. */
export const gameplayPoseOf = (entry: PoseFrame): PoseId => (isTween(entry) ? entry.fromPoseId : entry.poseId);

/** The shared moves, then the strike signatures (the brawler's charge, the acrobat's knee). */
export type AttackId = "punch" | "kick" | "uppercut" | "lowKick" | "jumpKick" | "charge" | "flyingKnee";

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
  /** Which limb carries the hitbox (shoulder: the lead shoulder and upper arm). */
  limb: "arm" | "leg" | "shoulder";
  /**
   * A clean hit knocks down: "air" only someone in the air (the anti-air's reward;
   * other air hits are plain hits), "always" anyone.
   */
  knockdown?: "air" | "always";
  level: HitLevel;
  /**
   * The pose (and captured version) shown on active frames: uppercut / low kick use the second
   * punch / kick captures, signature strikes the signature capture.
   */
  pose: { poseId: PoseId; variant: number };
  sequence: PoseFrame[];
}

/*
 * Frame advantage (attacker's turn minus defender's, hitstop excluded) works out to
 * hitstun − (active − 1 + recovery) − 1 on hit, and the same with blockstun on block:
 *
 *              on hit   on block
 *   punch        +2        −3     safe: too little for a 4f punch to punish; high: whiffs over a crouching guard
 *   kick         +1        −6     the long one: lunges 60 px on its active frames, so it beats a punch at
 *                                 long range; punishable up close, safe blocked at the tip (pushback 20)
 *   uppercut     +1        −8     anti-air: airborne attacks can't hit it during startup/active; very punishable on block
 *   low kick      0        −4     quick poke along the ground (lunges 20 px); must be blocked crouching
 *   charge      knockdown −16     brawler: a slow wind-up, then 300 px across the stage; blocking it is a free punish
 *   flying knee   +1        −4     acrobat: an overhead from the ground (lunges 80 px), so a crouching guard can't sit still
 *
 * The jump kick is an overhead (must be blocked standing); landing ends it, so its
 * advantage depends on how high it hits.
 */
export const ATTACKS: Record<AttackId, AttackData> = {
  punch: {
    startup: 4, active: 3, recovery: 10, damage: 8, hitstun: 15, blockstun: 10, pushback: 6,
    limb: "arm", level: "high", pose: { poseId: "punch", variant: 0 },
    sequence: [
      { fromPoseId: "idle", toPoseId: "punch", frames: 4, phase: "startup" },
      { poseId: "punch", frames: 3, phase: "active" },
      { fromPoseId: "punch", toPoseId: "idle", frames: 4, phase: "recovery" },
      { poseId: "idle", frames: 6, phase: "recovery" },
    ],
  },
  kick: {
    startup: 7, active: 4, recovery: 16, damage: 12, hitstun: 21, blockstun: 14, pushback: 20, advance: 60,
    limb: "leg", level: "mid", pose: { poseId: "kick", variant: 0 },
    sequence: [
      { fromPoseId: "idle", toPoseId: "kick", frames: 7, phase: "startup" },
      { poseId: "kick", frames: 4, phase: "active" },
      { fromPoseId: "kick", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 10, phase: "recovery" },
    ],
  },
  uppercut: {
    startup: 6, active: 4, recovery: 18, damage: 11, hitstun: 23, blockstun: 14, pushback: 12,
    limb: "arm", level: "mid", pose: { poseId: "punch", variant: 1 }, knockdown: "air",
    sequence: [
      // Hard cut out of the crouch: the pop up is what reads as an anti-air.
      { poseId: "block", frames: 6, phase: "startup" },
      { poseId: "punch", frames: 4, phase: "active" },
      { fromPoseId: "punch", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 12, phase: "recovery" },
    ],
  },
  lowKick: {
    startup: 6, active: 3, recovery: 12, damage: 7, hitstun: 15, blockstun: 11, pushback: 8, advance: 20,
    limb: "leg", level: "low", pose: { poseId: "kick", variant: 1 },
    sequence: [
      { fromPoseId: "idle", toPoseId: "kick", frames: 6, phase: "startup" },
      { poseId: "kick", frames: 3, phase: "active" },
      { fromPoseId: "kick", toPoseId: "idle", frames: 5, phase: "recovery" },
      { poseId: "idle", frames: 7, phase: "recovery" },
    ],
  },
  /**
   * Kick in the air, once per jump. It stays out until landing (which cancels it),
   * so a late jump kick comes down onto a crouching guard: the overhead has to beat
   * a crouch, or crouching would be safe against everything but throws.
   */
  jumpKick: {
    startup: 5, active: 40, recovery: 4, damage: 10, hitstun: 17, blockstun: 12, pushback: 8,
    limb: "leg", level: "overhead", pose: { poseId: "kick", variant: 0 },
    sequence: [
      { fromPoseId: "jump", toPoseId: "kick", frames: 5, phase: "startup" },
      { poseId: "kick", frames: 40, phase: "active" },
      { poseId: "jump", frames: 4, phase: "recovery" },
    ],
  },
  /** Brawler: leans in slowly (the tell), then barrels forward over its active frames. */
  charge: {
    startup: 14, active: 10, recovery: 18, damage: 14, hitstun: 23, blockstun: 12, pushback: 30, advance: 300,
    limb: "shoulder", level: "mid", pose: { poseId: "signature", variant: 0 }, knockdown: "always",
    sequence: [
      { fromPoseId: "idle", toPoseId: "signature", frames: 14, phase: "startup" },
      { poseId: "signature", frames: 10, phase: "active" },
      { poseId: "signature", frames: 4, phase: "recovery" },
      { fromPoseId: "signature", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 8, phase: "recovery" },
    ],
  },
  /** Acrobat: a dip (the block capture, like the uppercut's), then the knee drives up and forward. */
  flyingKnee: {
    startup: 16, active: 4, recovery: 14, damage: 9, hitstun: 19, blockstun: 14, pushback: 10, advance: 80,
    limb: "leg", level: "overhead", pose: { poseId: "signature", variant: 0 },
    sequence: [
      { poseId: "block", frames: 6, phase: "startup" },
      { fromPoseId: "block", toPoseId: "signature", frames: 10, phase: "startup" },
      { poseId: "signature", frames: 4, phase: "active" },
      { fromPoseId: "signature", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 8, phase: "recovery" },
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

/** Punch + kick from at least this far away taunts instead of throwing: win pose, taunt line, wide open. */
export const TAUNT = { frames: 50, minDistance: 300 } as const;
/** Frames on the ground before a jump leaves it; the jump can still turn into a block during them. */
export const JUMP_SQUAT_FRAMES = 3;
/** A block counts if back (or down, for a crouch block) was held within this many frames. */
export const BLOCK_LENIENCY_FRAMES = 3;

/**
 * Grabs beat block, lose to attacks (a fighter in an attack's startup or active
 * frames can't be grabbed) and whiff into long recovery. On the active frame
 * they catch a throwable opponent within `range`, who is then held for
 * `holdFrames` and thrown: knocked down (KNOCKDOWN), landing throwDistance away.
 */
export interface GrabData {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  /** Frames the grabbed fighter is held before the throw lands. */
  holdFrames: number;
  /** The grabbed fighter can break free with punch + kick while held. */
  techable: boolean;
  /** How far the thrown fighter lands from where they were grabbed (px). */
  throwDistance: number;
  /** Max gap between the two push boxes for the grab to connect. */
  range: number;
  sequence: PoseFrame[];
}

export type GrabId = "throw" | "bearHug";

export const GRABS: Record<GrabId, GrabData> = {
  /** Punch + kick up close: the shared throw. */
  throw: {
    startup: 5, active: 1, recovery: 20, damage: 12, holdFrames: 8, techable: true, throwDistance: 90, range: 40,
    sequence: [
      { fromPoseId: "idle", toPoseId: "punch", frames: 5, phase: "startup" },
      { poseId: "punch", frames: 1, phase: "active" },
      { fromPoseId: "punch", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 14, phase: "recovery" },
    ],
  },
  /**
   * Grappler: reaches almost three times as far as a throw and can't be broken,
   * but it's slower and a whiff is a long time stuck with arms out.
   */
  bearHug: {
    startup: 8, active: 1, recovery: 32, damage: 20, holdFrames: 14, techable: false, throwDistance: 70, range: 110,
    sequence: [
      { fromPoseId: "idle", toPoseId: "signature", frames: 8, phase: "startup" },
      { poseId: "signature", frames: 1, phase: "active" },
      { poseId: "signature", frames: 14, phase: "recovery" },
      { fromPoseId: "signature", toPoseId: "idle", frames: 6, phase: "recovery" },
      { poseId: "idle", frames: 12, phase: "recovery" },
    ],
  },
};

export const THROW = GRABS.throw;

export const isGrab = (a: FighterAction): a is GrabId => a === "throw" || a === "bearHug";

export function grabTotalFrames(grab: GrabData): number {
  return grab.startup + grab.active + grab.recovery;
}

/**
 * Guardian's parry: during its active frames, any strike that would connect is
 * caught instead. No damage, and the attacker staggers (the "parried" action,
 * shown with the hurt capture) long enough for a free punish while the parrying
 * fighter is free at once. It doesn't stop grabs, and a whiffed parry is a long
 * time standing open.
 */
export const PARRY = {
  startup: 3,
  active: 10,
  recovery: 18,
  /** Frames the parried attacker is stuck. */
  stagger: 24,
  sequence: [
    { fromPoseId: "idle", toPoseId: "signature", frames: 3, phase: "startup" },
    { poseId: "signature", frames: 10, phase: "active" },
    { fromPoseId: "signature", toPoseId: "idle", frames: 6, phase: "recovery" },
    { poseId: "idle", frames: 12, phase: "recovery" },
  ] as PoseFrame[],
} as const;

export const PARRY_TOTAL_FRAMES = PARRY.startup + PARRY.active + PARRY.recovery;

/** Is a parry on this frame catching strikes? */
export function parryActiveAt(actionFrame: number): boolean {
  return actionFrame >= PARRY.startup && actionFrame < PARRY.startup + PARRY.active;
}

/**
 * Knockdown, Street Fighter style: a grab, a shoulder charge, or an anti-air
 * (uppercut) hit on someone in the air, sends them flying back to the floor (other
 * hits are plain hits: knockdowns should be an event, not every exchange); they lie there, then get up. All
 * the while they can't be hit or thrown and have no push box (walk over them):
 * no juggles, just a reset to neutral with the attacker free first. The fixed
 * wake-up timing is the guessing game: attack as they rise, or wait.
 */
export const KNOCKDOWN = {
  /** Launch velocity (px/frame): back, and up. */
  launch: { x: 3.5, y: -7 },
  /** Frames lying on the floor after landing. */
  floorFrames: 40,
  /** Frames getting up; free (and buffered presses come out) on the next. */
  wakeFrames: 12,
} as const;
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

/** The sequence entry on a given frame; the last entry holds if the frame runs past the end. */
export function poseAtFrame(sequence: PoseFrame[], actionFrame: number): PoseFrame {
  return entryAtFrame(sequence, actionFrame).entry;
}

function entryAtFrame(sequence: PoseFrame[], actionFrame: number): { entry: PoseFrame; frame: number } {
  let f = actionFrame;
  for (const entry of sequence) {
    if (f < entry.frames) return { entry, frame: f };
    f -= entry.frames;
  }
  const last = sequence[sequence.length - 1];
  return { entry: last, frame: last.frames - 1 };
}

/** A tween in progress: morph `from` toward `to`; t is in (0, 1), exclusive at both ends. */
export interface PoseTween { from: PoseId; to: PoseId; t: number }

/**
 * The tween shown on a given frame, or null on a hard-cut frame. t steps by
 * 1 / (frames + 1), so its first frame already moves off the pose before it and
 * its last stops short of the pose after it.
 */
export function tweenAtFrame(sequence: PoseFrame[], actionFrame: number): PoseTween | null {
  const { entry, frame } = entryAtFrame(sequence, actionFrame);
  return isTween(entry) ? { from: entry.fromPoseId, to: entry.toPoseId, t: (frame + 1) / (entry.frames + 1) } : null;
}

/** The sequence an action plays, if it has one (attacks, grabs and the parry). */
export function sequenceFor(action: FighterAction): PoseFrame[] | null {
  if (isAttackId(action)) return ATTACKS[action].sequence;
  if (isGrab(action)) return GRABS[action].sequence;
  return action === "parry" ? PARRY.sequence : null;
}

export const isAttackId = (a: FighterAction): a is AttackId => Object.hasOwn(ATTACKS, a);

/**
 * Rendering only, like tween entries: when the shown capture cuts from one pose
 * to another between actions (or along the walk cycle), these pairs morph over
 * a few frames instead, easing out so the new pose reads almost at once.
 * Deliberately missing: anything into "hurt" (an impact should snap) and
 * block → punch (the uppercut's pop). Attack sequences carry their own tweens.
 */
export const SOFT_CUTS: readonly { from: PoseId; to: PoseId; frames: number }[] = [
  // A stride: the walk cycle swaps captures every 10 frames.
  { from: "idle", to: "walk", frames: 8 }, { from: "walk", to: "idle", frames: 8 },
  // Guarding.
  { from: "idle", to: "block", frames: 4 }, { from: "block", to: "idle", frames: 5 },
  { from: "walk", to: "block", frames: 4 }, { from: "block", to: "walk", frames: 5 },
  { from: "idle", to: "crouch", frames: 4 }, { from: "crouch", to: "idle", frames: 5 },
  { from: "walk", to: "crouch", frames: 4 },
  { from: "block", to: "crouch", frames: 3 }, { from: "crouch", to: "block", frames: 3 },
  // Take-off (the squat shows the block capture), landing, and the jump kick folding back.
  { from: "block", to: "jump", frames: 3 }, { from: "jump", to: "idle", frames: 5 },
  { from: "jump", to: "block", frames: 4 }, { from: "jump", to: "walk", frames: 5 },
  { from: "kick", to: "jump", frames: 3 }, { from: "kick", to: "idle", frames: 5 },
  // A parry that caught something lets go at once.
  { from: "signature", to: "idle", frames: 5 },
  // Getting over a hit.
  { from: "hurt", to: "idle", frames: 6 }, { from: "hurt", to: "block", frames: 4 },
  // The round intro: reaching out to shake hands (from the walk cycle's either capture), letting go.
  { from: "walk", to: "handshake", frames: 5 }, { from: "idle", to: "handshake", frames: 5 }, { from: "handshake", to: "walk", frames: 6 },
  // Taunts and the win pose.
  { from: "idle", to: "win", frames: 8 }, { from: "walk", to: "win", frames: 8 }, { from: "win", to: "idle", frames: 6 },
];

export function softCut(from: PoseId, to: PoseId): { frames: number } | null {
  return SOFT_CUTS.find((c) => c.from === from && c.to === to) ?? null;
}

/** Standing still, the fighter sways from its stance to the second stance and back once every this many frames. Rendering only. */
export const IDLE_SWAY_FRAMES = 100;

/** How far into the second stance (0..1) the sway is on a given frame of standing still: a smooth breath that starts at 0. */
export function idleSwayAt(actionFrame: number): number {
  return (1 - Math.cos((2 * Math.PI * actionFrame) / IDLE_SWAY_FRAMES)) / 2;
}

export type FighterAction =
  | "idle" | "walk" | "jump" | "block" | "blockstun"
  | "jumpSquat"
  | AttackId | GrabId | "taunt"
  /** The guardian's parry, and an attacker it caught (staggered). */
  | "parry" | "parried"
  | "grabbed" | "hurt" | "ko" | "win"
  /** The round intro's handshake (fight-simulation.ts). */
  | "handshake"
  /** Knocked down: flying (knockdown), on the floor (downed), getting up (wakeup). */
  | "knockdown" | "downed" | "wakeup";

/**
 * Walk alternates between the walk and idle captures: what collides while
 * walking. On screen (WebGL) the stride is walk-gait.ts instead, timed by
 * distance so a foot stays planted; this cycle's soft cuts are its fallback.
 */
export const WALK_CYCLE: HoldFrame[] = [
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
    case "charge":
    case "flyingKnee":
    case "throw":
    case "bearHug":
    case "parry":
      return gameplayPoseOf(poseAtFrame(sequenceFor(action)!, actionFrame));
    case "jumpSquat":
      return "block"; // the crouch before the jump
    case "taunt":
      return "win";
    case "grabbed":
    case "parried":
      return "hurt";
    case "blockstun":
      return "block";
    case "walk":
      return gameplayPoseOf(poseAtFrame(WALK_CYCLE, actionFrame % (WALK_CYCLE[0].frames + WALK_CYCLE[1].frames)));
    case "ko":
    case "knockdown":
    case "downed":
    case "wakeup":
      return "hurt"; // drawn lying down / getting up by rotating it (fighter-sprite-view.ts)
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
  /** Whose signature the signature pose (and move) is. */
  archetype: ArchetypeId;
};

/** Geometry for one displayed frame. Versions that aren't captures (the handshake's pumping hand) use the main capture's. */
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
    case "ko":
    case "knockdown":
    case "downed":
    case "wakeup": return "hurt";
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

/** A displayed frame: which pose, which captured version, and (for the signature pose) whose. */
export interface FrameRef { poseId: PoseId; variant: number }

/**
 * Hurtboxes, each clipped to the reference fighter's same frame (its overall
 * extent from the feet anchor, ±15%): a sprawling capture doesn't make you a
 * bigger target. Pass the frame (and the archetype, for the signature pose) to
 * clip; omit it for the raw boxes.
 */
export function hurtboxesFor(pose: PoseGeometry, frame?: FrameRef, archetype: ArchetypeId = "brawler"): Box[] {
  const boxes = rawHurtboxesFor(pose);
  if (!frame) return boxes;
  const ref = canonicalHurtExtent(frame.poseId, frame.variant, archetype);
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
function canonicalHurtExtent(poseId: PoseId, variant: number, archetype: ArchetypeId) {
  const key = poseId === "signature" ? `${poseId}#${variant}#${archetype}` : `${poseId}#${variant}`;
  let edges = hurtExtentCache.get(key);
  if (!edges) {
    const pose = frameGeometry(referenceGeometry(archetype), poseId, variant);
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
  const limb = ATTACKS[attack].limb;
  const joints = limb === "arm"
    ? [LANDMARK[`${side}Wrist`], LANDMARK[`${side}Elbow`], LANDMARK[`${side}Shoulder`]]
    : limb === "leg"
      ? [LANDMARK[`${side}Ankle`], LANDMARK[`${side}Knee`]]
      : [LANDMARK[`${side}Shoulder`], LANDMARK[`${side}Elbow`]];
  const size = limb === "arm" ? PUNCH_HITBOX_SIZE : KICK_HITBOX_SIZE;
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

const referenceCache = new Map<ArchetypeId, FighterGeometry>();

/** The canonical stick fighter of an archetype: the fairness reference. */
function referenceGeometry(archetype: ArchetypeId): FighterGeometry {
  let geometry = referenceCache.get(archetype);
  if (!geometry) referenceCache.set(archetype, (geometry = stickFigureGeometry(archetype)));
  return geometry;
}

const reachCache = new Map<AttackId, number>();

/** Reach of each attack on the canonical stick fighter (the fairness reference). */
export function canonicalReach(attack: AttackId): number {
  let reach = reachCache.get(attack);
  if (reach === undefined) {
    const { poseId, variant } = ATTACKS[attack].pose;
    const pose = frameGeometry(referenceGeometry(archetypeOfMove(attack) ?? "brawler"), poseId, variant);
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
