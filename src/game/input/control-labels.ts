import { ARCHETYPES, type ArchetypeId } from "../../shared/archetypes";
import type { FighterAction } from "../../shared/frame-data";
import type { PlayerInputDescriptor } from "./input-descriptor";
import { actionKeyLabel } from "./key-bindings";

export type ButtonLabels = { forward: string; back: string; up: string; down: string; punch: string; kick: string };

/**
 * What to press, for one player's device and side of the screen.
 * Forward/back depend on the side: the player on the left walks forward with "right".
 */
export function controlLabels(input: PlayerInputDescriptor, side: "left" | "right"): ButtonLabels {
  const key = input.kind === "keyboard" ? (a: Parameters<typeof actionKeyLabel>[1]) => actionKeyLabel(input.layout, a) : null;
  const dirs = key
    ? { left: key("left"), right: key("right"), up: key("up"), down: key("down") }
    : { left: "◀", right: "▶", up: "▲", down: "▼" };
  const buttons = key ? { punch: key("punch"), kick: key("kick") } : { punch: "Ⓐ", kick: "Ⓑ" };
  return {
    forward: side === "left" ? dirs.right : dirs.left,
    back: side === "left" ? dirs.left : dirs.right,
    up: dirs.up,
    down: dirs.down,
    ...buttons,
  };
}

export interface MoveGuide {
  name: string;
  /** Action previewed on the card. */
  action: FighterAction;
  how: (b: ButtonLabels) => string;
}

/** The shared moves, in the order the pre-match screen shows them. */
export const MOVE_GUIDE: readonly MoveGuide[] = [
  { name: "Walk", action: "walk", how: (b) => `${b.back} / ${b.forward}` },
  { name: "Jump", action: "jump", how: (b) => b.up },
  { name: "Block", action: "block", how: (b) => `hold ${b.back} or ${b.down}` },
  { name: "Punch", action: "punch", how: (b) => b.punch },
  { name: "Kick", action: "kick", how: (b) => b.kick },
  { name: "Uppercut", action: "uppercut", how: (b) => `${b.down} + ${b.punch}` },
  { name: "Low kick", action: "lowKick", how: (b) => `${b.down} + ${b.kick}` },
  { name: "Throw", action: "throw", how: (b) => `${b.punch} + ${b.kick}` },
];

/** A fighter's moves: the shared ones, then their archetype's signature. */
export function moveGuide(archetype: ArchetypeId): MoveGuide[] {
  const { move, moveName } = ARCHETYPES[archetype];
  return [...MOVE_GUIDE, { name: moveName, action: move, how: (b) => `${b.down} + ${b.punch} + ${b.kick}` }];
}

export const deviceName = (input: PlayerInputDescriptor) =>
  input.kind === "pad" ? `Gamepad ${input.index + 1}` : input.layout === "p1" ? "Keyboard (left side)" : "Keyboard (right side)";
