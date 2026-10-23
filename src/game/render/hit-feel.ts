import { KNOCKDOWN } from "../../shared/frame-data";
import { HITSTOP_FRAMES, airFrames, type FighterState } from "../../simulation/fighter-state-machine";
import { PLAYER_COLORS } from "./stage";

/*
 * What makes a hit land with weight, Street Fighter II style: the defender
 * stays in the pose they were struck in for most of the hit freeze, shaking,
 * and only then snaps into the hurt pose; a spark marks where the hit landed.
 * All rendering: the simulation applies the hit (and its hurtboxes) on the
 * frame it connects, as before.
 */

/** Hitstop frames the struck pose is held before the hurt pose shows (hitstop is HITSTOP_FRAMES long). */
export const REACTION_DELAY_FRAMES = 4;

/** Just hit (or KO'd), still frozen in hitstop, and the reaction hasn't come through yet: show the pose they were in. */
export function holdsStruckPose(s: FighterState): boolean {
  return (s.action === "hurt" || s.action === "ko" || s.action === "knockdown") && s.actionFrame === 0 && s.hitstopFrames > HITSTOP_FRAMES - REACTION_DELAY_FRAMES;
}

/** Sideways shake (px) of a fighter frozen in hitstop after being hit or blocking: flips every frame. */
export function hitShake(s: FighterState, frame: number): number {
  if (s.hitstopFrames <= 0) return 0;
  const amplitude = s.action === "hurt" || s.action === "ko" || s.action === "knockdown" ? 4 : s.action === "blockstun" ? 2 : 0;
  return frame % 2 === 0 ? amplitude : -amplitude;
}

/** The little bounce on hitting the floor: this many frames, this high (px). */
export const FLOOR_BOUNCE = { frames: 10, height: 14 } as const;

/**
 * How a knocked-down (or KO'd) fighter is drawn: the hurt photo tipped over
 * backwards around the feet, `tilt` of a quarter turn (1 = lying flat), raised
 * `bounce` px. Tips over through the flight, bounces on landing, lies still,
 * then rises back up while getting up. Null when standing.
 */
export function fallPose(s: FighterState): { tilt: number; bounce: number } | null {
  const flight = airFrames(KNOCKDOWN.launch.y);
  switch (s.action) {
    case "knockdown":
    case "ko":
      return { tilt: Math.min(1, s.actionFrame / flight), bounce: 0 };
    case "downed": {
      const f = s.actionFrame;
      return { tilt: 1, bounce: f < FLOOR_BOUNCE.frames ? FLOOR_BOUNCE.height * Math.sin((Math.PI * f) / FLOOR_BOUNCE.frames) : 0 };
    }
    case "wakeup": {
      const x = (s.actionFrame + 1) / KNOCKDOWN.wakeFrames;
      return { tilt: 1 - x * x * (3 - 2 * x), bounce: 0 }; // smoothstep up
    }
    default:
      return null;
  }
}

export type HitMarkerKind = "hit" | "ko" | "block" | "parry" | "throw" | "dust";

/** Each kind has its own symbol, so it reads at a glance whatever the colour. */
export type HitMarkerShape = "burst" | "bigBurst" | "shield" | "flash" | "chevrons" | "dust";

export interface HitMarkerStyle {
  shape: HitMarkerShape;
  /** Outer radius at full size, px. */
  radius: number;
}

/**
 * A clean hit is a spiky burst; a KO, a bigger burst inside a ring; a block, a
 * ring with four ticks (a struck shield); a throw, double chevrons pointing the
 * way the victim flies. The colour is the attacker's (markerColors).
 */
export const HIT_MARKER_STYLES: Record<HitMarkerKind, HitMarkerStyle> = {
  hit: { shape: "burst", radius: 34 },
  ko: { shape: "bigBurst", radius: 54 },
  block: { shape: "shield", radius: 32 },
  /** A parry: a double ring with rays, in the parrying fighter's colour. */
  parry: { shape: "flash", radius: 50 },
  throw: { shape: "chevrons", radius: 40 },
  /** Not a hit: where a knocked-down fighter lands. Grey, whoever's it is. */
  dust: { shape: "dust", radius: 46 },
};

/** The attacker's colour for the rim, and a pale version of it for the hot centre. */
export function markerColors(player: 0 | 1): { rim: number; core: number } {
  const rim = PLAYER_COLORS[player];
  const pale = (shift: number) => {
    const c = (rim >> shift) & 0xff;
    return Math.round(c + (255 - c) * 0.72) << shift;
  };
  return { rim, core: pale(16) | pale(8) | pale(0) };
}

/** How long a marker stays up, in simulation frames. */
export const HIT_MARKER_FRAMES = 16;

/** A marker's size (0..1 of its radius) and opacity, `age` frames after the hit: it pops out fast, holds through the freeze, then fades. */
export function hitMarkerShape(age: number): { scale: number; alpha: number } | null {
  if (age < 0 || age >= HIT_MARKER_FRAMES) return null;
  const scale = Math.min(1, 0.55 + 0.15 * age);
  const hold = HITSTOP_FRAMES + 1;
  const alpha = age < hold ? 1 : 1 - (age - hold) / (HIT_MARKER_FRAMES - hold);
  return { scale, alpha };
}
