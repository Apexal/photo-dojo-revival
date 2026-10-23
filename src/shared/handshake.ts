import { LANDMARK, type LimbSide, type NormalizedLandmark } from "./fighter-model";
import { groundAnchorFor, type FighterGeometry } from "./frame-data";

/*
 * The round intro's handshake: both fighters walk in, hold out a hand, shake
 * and walk back. Two photos never hold their hands at quite the same height,
 * so each fighter's arm is turned about its shoulder until both hands meet
 * halfway; the simulation stands them so the hands overlap, and the renderer
 * warps the photo onto the turned arm and pumps it up and down.
 */

interface Point { x: number; y: number }

/** Arm landmarks below the shoulder: what turns when the arm does. */
const ARM_JOINTS = ["Elbow", "Wrist", "Pinky", "Index", "Thumb"] as const;

/** The middle of a hand: between the wrist and the knuckles. */
export function handOf(landmarks: readonly NormalizedLandmark[], side: LimbSide): Point {
  const wrist = landmarks[LANDMARK[`${side}Wrist`]], index = landmarks[LANDMARK[`${side}Index`]];
  return { x: (wrist.x + index.x) / 2, y: (wrist.y + index.y) / 2 };
}

/** The landmarks with one arm turned about its shoulder; y points down, so positive turns an arm held forward downward. */
export function turnArm(landmarks: readonly NormalizedLandmark[], side: LimbSide, radians: number): NormalizedLandmark[] {
  const shoulder = landmarks[LANDMARK[`${side}Shoulder`]];
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const out = landmarks.map((l) => ({ ...l }));
  for (const joint of ARM_JOINTS) {
    const i = LANDMARK[`${side}${joint}`];
    const dx = landmarks[i].x - shoulder.x, dy = landmarks[i].y - shoulder.y;
    out[i] = { ...landmarks[i], x: shoulder.x + dx * cos - dy * sin, y: shoulder.y + dx * sin + dy * cos };
  }
  return out;
}

export interface HandshakeGrip {
  /** The handshake capture's landmarks (sprite space) with the arm aimed at the meeting height. */
  landmarks: NormalizedLandmark[];
  side: LimbSide;
  /** How far ahead of the feet the hand is, facing right (px). */
  reach: number;
  /** Frames after player 1's offer that this fighter holds out a hand: 0 for player 1. */
  offeredAt: number;
}

/** Both fighters' handshakes, each arm turned so the two hands meet at the average of their heights. */
export function handshakeGrips(geometry: readonly [FighterGeometry, FighterGeometry]): [HandshakeGrip, HandshakeGrip] {
  const poses = geometry.map((g) => {
    const pose = g.handshake;
    const side = pose.attackSide ?? "right";
    const anchor = groundAnchorFor(g, "handshake");
    return { landmarks: pose.landmarks, side, anchor, hand: handOf(pose.landmarks, side) };
  });
  const height = poses.reduce((sum, p) => sum + p.hand.y - p.anchor.y, 0) / poses.length;
  return poses.map(({ landmarks, side, anchor, hand }, player): HandshakeGrip => {
    const shoulder = landmarks[LANDMARK[`${side}Shoulder`]];
    const arm = { x: hand.x - shoulder.x, y: hand.y - shoulder.y };
    const length = Math.hypot(arm.x, arm.y);
    // Keep the hand the same distance from the shoulder, still on the side it was held out.
    const dy = Math.max(-length, Math.min(length, anchor.y + height - shoulder.y));
    const dx = Math.sqrt(length * length - dy * dy) * (Math.sign(arm.x) || 1);
    const aimed = turnArm(landmarks, side, Math.atan2(dy, dx) - Math.atan2(arm.y, arm.x));
    return { landmarks: aimed, side, reach: handOf(aimed, side).x - anchor.x, offeredAt: player === 0 ? 0 : SECOND_HAND_FRAMES };
  }) as [HandshakeGrip, HandshakeGrip];
}

/**
 * The handshake, in frames since player 1 held out a hand: player 2 holds out
 * theirs SECOND_HAND_FRAMES later; once it's out (REACH_FRAMES: the renderer
 * morphs into the pose meanwhile) the hands rest together for CLASP_FRAMES,
 * then both shake, SHAKES times, and hold a moment before letting go.
 */
export const SECOND_HAND_FRAMES = 20;
export const REACH_FRAMES = 6;
export const CLASP_FRAMES = 15;
export const SHAKE_START_FRAME = SECOND_HAND_FRAMES + REACH_FRAMES + CLASP_FRAMES;
export const SHAKES = 3;
/** How far the hand pumps each way from where it meets the other one (px, along its arc about the shoulder). */
export const SHAKE_PX = 9;
/** One pump, down and back up. */
export const SHAKE_PERIOD_FRAMES = 18;
export const HANDSHAKE_FRAMES = SHAKE_START_FRAME + SHAKES * SHAKE_PERIOD_FRAMES + 12;

/** The grip with the hand pumped up (-1) or down (1) by SHAKE_PX. Rendering only. */
export function shakenGrip(grip: HandshakeGrip, direction: 1 | -1): NormalizedLandmark[] {
  const shoulder = grip.landmarks[LANDMARK[`${grip.side}Shoulder`]];
  const hand = handOf(grip.landmarks, grip.side);
  const length = Math.hypot(hand.x - shoulder.x, hand.y - shoulder.y) || 1;
  // A hand held forward turns down for a positive angle; one held back (a bad capture) the other way.
  const forward = Math.sign(hand.x - shoulder.x) || 1;
  return turnArm(grip.landmarks, grip.side, (direction * forward * SHAKE_PX) / length);
}

/**
 * How far from the raised hand to the lowered one (0..1) the shake is, frame
 * `frame` of shaking: starting and ending where the hands meet (0.5), both
 * fighters in step, still before it starts and after SHAKES pumps.
 */
export function shakeAt(frame: number): number {
  if (frame < 0 || frame >= SHAKES * SHAKE_PERIOD_FRAMES) return 0.5;
  return 0.5 + 0.5 * Math.sin((2 * Math.PI * frame) / SHAKE_PERIOD_FRAMES);
}
