import type Phaser from "phaser";
import { CPU_LEVEL_NAMES, type CpuLevel } from "./cpu-player";
import { GamepadInputSource } from "./gamepad-input-source";
import type { InputSource } from "./input-source";
import { actionKeyLabel } from "./key-bindings";
import { KeyboardInputSource, type KeyboardLayout } from "./keyboard-input-source";

/** Serializable description of a player's controller, so each scene can bind its own input plugin. */
export type InputDescriptor =
  | { kind: "keyboard"; layout: KeyboardLayout }
  | { kind: "pad"; index: number }
  /** Practice-mode opponent; the fight scene creates it (it needs the simulation). */
  | { kind: "dummy" }
  /** A match's computer opponent; likewise made by the fight scene. */
  | { kind: "cpu"; level: CpuLevel };

export type PlayerInputDescriptor = Exclude<InputDescriptor, { kind: "dummy" } | { kind: "cpu" }>;
export const isPlayerInput = (d: InputDescriptor): d is PlayerInputDescriptor => d.kind !== "dummy" && d.kind !== "cpu";

export function createInputSource(scene: Phaser.Scene, d: PlayerInputDescriptor): InputSource {
  return d.kind === "keyboard" ? new KeyboardInputSource(scene, d.layout) : new GamepadInputSource(scene.input.gamepad!, d.index);
}

export const describeInput = (d: InputDescriptor) =>
  d.kind === "dummy" ? "Training dummy"
  : d.kind === "cpu" ? `CPU · ${CPU_LEVEL_NAMES[d.level]}`
  : d.kind === "keyboard" ? `Keyboard ${keyboardKeys(d.layout)}` : `Gamepad ${d.index + 1}`;

/** e.g. "WASD + J/K" for the current bindings. */
export function keyboardKeys(layout: KeyboardLayout): string {
  const k = (a: Parameters<typeof actionKeyLabel>[1]) => actionKeyLabel(layout, a);
  const dirs = [k("up"), k("left"), k("down"), k("right")];
  return `${dirs.every((d) => d.length === 1) ? dirs.join("") : dirs.join(" ")} + ${k("punch")}/${k("kick")}`;
}

export const sameInput = (a: InputDescriptor, b: InputDescriptor) =>
  a.kind === b.kind && (a.kind === "keyboard" ? a.layout === (b as typeof a).layout : a.kind === "pad" ? a.index === (b as typeof a).index : a.kind === "cpu" ? a.level === (b as typeof a).level : true);
