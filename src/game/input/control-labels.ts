import { ARCHETYPES, type ArchetypeId } from "../../shared/archetypes";
import type { FighterAction } from "../../shared/frame-data";
import type { PlayerInputDescriptor } from "./input-descriptor";
import { livePadId } from "./gamepad-input-source";
import { actionKeyLabel, keyBindings } from "./key-bindings";

export type ButtonLabels = {
  forward: string; back: string; up: string; down: string; punch: string; kick: string;
  /** Throw (and with down, the signature move). */ throw: string;
  /** A second throw button (a pad's right bumper). */ throwAlt?: string;
  /** A dedicated block button (a pad's triggers). */ block?: string;
  /** A dedicated uppercut button (a pad's X). */ uppercut?: string;
};

export type PadFamily = "xbox" | "playstation" | "nintendo";

/**
 * Which make of pad a `Gamepad.id` is, from the vendor id (054c Sony, 057e Nintendo)
 * or the name browsers give it; anything else gets Xbox names, as the standard mapping does.
 */
export function padFamily(id: string | undefined): PadFamily {
  if (!id) return "xbox";
  if (/054c|playstation|dualshock|dualsense|^wireless controller/i.test(id)) return "playstation";
  if (/057e|nintendo|pro controller|joy-con/i.test(id)) return "nintendo";
  return "xbox";
}

/**
 * Each make's names for the standard mapping's buttons. The mapping is by position,
 * so on a Nintendo pad the bottom button (punch) is B and the right one (kick) is A.
 */
const PAD_NAMES: Record<PadFamily, Required<Pick<ButtonLabels, "punch" | "kick" | "uppercut" | "throw" | "throwAlt" | "block">>> = {
  xbox: { punch: "Ⓐ", kick: "Ⓑ", uppercut: "Ⓧ", throw: "Ⓨ", throwAlt: "RB", block: "LT / RT" },
  playstation: { punch: "✕", kick: "○", uppercut: "□", throw: "△", throwAlt: "R1", block: "L2 / R2" },
  nintendo: { punch: "Ⓑ", kick: "Ⓐ", uppercut: "Ⓨ", throw: "Ⓧ", throwAlt: "R", block: "ZL / ZR" },
};

/**
 * What to press, for one player's device and side of the screen.
 * Forward/back depend on the side: the player on the left walks forward with "right".
 */
export function controlLabels(input: PlayerInputDescriptor, side: "left" | "right"): ButtonLabels {
  const key = input.kind === "keyboard" ? (a: Parameters<typeof actionKeyLabel>[1]) => actionKeyLabel(input.layout, a) : null;
  const dirs = key
    ? { left: key("left"), right: key("right"), up: key("up"), down: key("down") }
    : { left: "◀", right: "▶", up: "▲", down: "▼" };
  const sides = {
    forward: side === "left" ? dirs.right : dirs.left,
    back: side === "left" ? dirs.left : dirs.right,
    up: dirs.up,
    down: dirs.down,
  };
  if (key) {
    const both = `${key("punch")} + ${key("kick")}`;
    const unbound = input.kind === "keyboard" && keyBindings()[input.layout].throw.length === 0;
    return { ...sides, punch: key("punch"), kick: key("kick"), ...(unbound ? { throw: both } : { throw: key("throw"), throwAlt: both }) };
  }
  const pad = PAD_NAMES[padFamily(input.kind === "pad" ? (input.id ?? livePadId(input.index)) : undefined)];
  return { ...sides, ...pad };
}

export interface MoveGuide {
  name: string;
  /** Action previewed on the card. */
  action: FighterAction;
  how: (b: ButtonLabels) => string;
}

/** What beats what, for the footers of the pre-match screen and the pause menu's controls. */
export const GUARD_TIPS = "Crouch: punches whiff over you.  Block standing: jump kick, flying knee.  Block crouching: low kick.";
export const GRAB_TIPS = "Grabbed? Throw (punch + kick) breaks free (not out of a bear hug).  Taunt: punch + kick from far away, or a pad's left bumper (or a right stick click).";

/** The shared moves, in the order the pre-match screen shows them. */
export const MOVE_GUIDE: readonly MoveGuide[] = [
  { name: "Walk · dash", action: "walk", how: (b) => `${b.back} / ${b.forward}, tap twice to dash` },
  { name: "Jump", action: "jump", how: (b) => b.up },
  { name: "Block", action: "block", how: (b) => (b.block ? `${b.block} (+ ${b.down} low), or hold ${b.back} / ${b.down}` : `hold ${b.back} or ${b.down}`) },
  { name: "Punch", action: "punch", how: (b) => b.punch },
  { name: "Kick", action: "kick", how: (b) => b.kick },
  { name: "Uppercut", action: "uppercut", how: (b) => (b.uppercut ? `${b.uppercut}, or ${b.down} + ${b.punch}` : `${b.down} + ${b.punch}`) },
  { name: "Low kick", action: "lowKick", how: (b) => `${b.down} + ${b.kick}` },
  { name: "Throw", action: "throw", how: (b) => (b.throwAlt ? `${b.throw} or ${b.throwAlt}` : b.throw) },
];

/** A fighter's moves: the shared ones, then their archetype's signature. */
export function moveGuide(archetype: ArchetypeId): MoveGuide[] {
  const { move, moveName } = ARCHETYPES[archetype];
  return [...MOVE_GUIDE, { name: moveName, action: move, how: (b) => `${b.down} + ${b.throw}` }];
}

export const deviceName = (input: PlayerInputDescriptor) =>
  input.kind === "pad" ? `Gamepad ${input.index + 1}` : input.layout === "p1" ? "Keyboard (left side)" : "Keyboard (right side)";
