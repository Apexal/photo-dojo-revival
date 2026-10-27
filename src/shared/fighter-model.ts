import type { ArchetypeId } from "./archetypes";

export type PoseId =
  | "idle" | "walk" | "punch" | "kick"
  | "jump" | "block" | "crouch" | "hurt" | "win"
  /** The archetype's signature move (archetypes.ts): a different pose for each archetype. */
  | "signature"
  /** Reaching out to shake hands: the round intro (fight-simulation.ts). */
  | "handshake";

export type SoundId = "attack" | "hurt" | "win" | "taunt";

/** Capture order: easy poses first so the user learns the mechanic. */
export const POSE_IDS: readonly PoseId[] = ["idle", "walk", "block", "crouch", "punch", "kick", "jump", "hurt", "win", "signature", "handshake"];
export const SOUND_IDS: readonly SoundId[] = ["attack", "hurt", "win", "taunt"];
/** Optional lines: without a take of their own, the game plays this one's instead (a taunt says the victory line). */
export const SOUND_FALLBACK: Partial<Record<SoundId, SoundId>> = { taunt: "win" };

/** Pixel coords in the sprite canvas (or in the source frame before normalization). */
export interface NormalizedLandmark { x: number; y: number; visibility: number }

/** Which limb performed an attack pose. Left-handed users punch with their left. */
export type LimbSide = "left" | "right";

export interface CapturedPose {
  poseId: PoseId;
  imageBlob: Blob;                       // PNG with alpha, SPRITE_CANVAS_SIZE x SPRITE_CANVAS_SIZE
  landmarks: NormalizedLandmark[];       // 33 MediaPipe landmarks, in sprite-canvas pixel space
  anchorPoint: { x: number; y: number }; // feet midpoint (or pelvis for jump), in sprite-canvas pixels
  capturedAt: number;
  attackSide?: LimbSide;                 // punch/kick/signature/handshake only; defaults to "right"
}

export interface Fighter {
  fighterId: string;                      // uuid
  name: string;
  schemaVersion: 2;
  /** Picks the signature move and what the `signature` pose shows. */
  archetype: ArchetypeId;
  createdAt: number;
  facingDirection: "right";               // all captures face right; renderer flips for P2
  poses: Record<PoseId, CapturedPose>;
  sounds: Record<SoundId, Blob | null>;   // webm/opus, ≤MAX_SOUND_SECONDS each
  thumbnailBlob: Blob;                    // idle pose downscaled, for character select
  /**
   * Second versions of idle (the stance it sways into), punch (uppercut), kick
   * (low kick), hurt and win (REQUIRED_VARIANT_POSES). Variant n is index n-1.
   */
  poseVariants: Partial<Record<PoseId, CapturedPose[]>>;
  /** Extra takes of each voice line; the game picks one at random. */
  soundVariants?: Partial<Record<SoundId, Blob[]>>;
}

export const MAX_SOUND_TAKES = 3;

/** Longest name a player can type: the studio's name field, and renaming on fighter select. */
export const MAX_TYPED_NAME_LENGTH = 24;

/** A typed name, tidied: trimmed, runs of spaces made one, cut to the limit. Empty if nothing's left. */
export const tidyFighterName = (name: string): string => name.replace(/\s+/g, " ").trim().slice(0, MAX_TYPED_NAME_LENGTH).trim();

/** Main clip plus any extra takes. */
export function soundTakes(fighter: Pick<Fighter, "sounds" | "soundVariants">, soundId: SoundId): Blob[] {
  const main = fighter.sounds[soundId];
  return [...(main ? [main] : []), ...(fighter.soundVariants?.[soundId] ?? [])];
}

export const SPRITE_CANVAS_SIZE = 512;
/** Mid-shoulder to mid-hip; every pose is scaled so this is constant. */
export const CANONICAL_TORSO_LENGTH_PX = 110;
/** Feet anchor is placed here for grounded poses. */
export const GROUND_LINE_Y = 480;
/** Pelvis anchor height for the jump pose. */
export const JUMP_ANCHOR_Y = 300;
export const THUMBNAIL_SIZE = 128;
export const LANDMARK_COUNT = 33;
/** Recording limit per voice line: the victory line has room for a short speech. */
export const MAX_SOUND_SECONDS: Record<SoundId, number> = { attack: 2, hurt: 2, win: 5, taunt: 3 };

/** MediaPipe Pose landmark indices. */
export const LANDMARK = {
  nose: 0,
  leftEyeInner: 1, leftEye: 2, leftEyeOuter: 3,
  rightEyeInner: 4, rightEye: 5, rightEyeOuter: 6,
  leftEar: 7, rightEar: 8,
  mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const;

export type LandmarkName = keyof typeof LANDMARK;

export function isPoseId(value: unknown): value is PoseId {
  return typeof value === "string" && (POSE_IDS as readonly string[]).includes(value);
}

export function isSoundId(value: unknown): value is SoundId {
  return typeof value === "string" && (SOUND_IDS as readonly string[]).includes(value);
}

export function createFighterId(): string {
  return crypto.randomUUID();
}
