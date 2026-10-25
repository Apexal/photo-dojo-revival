/**
 * Keyboard bindings for the two keyboard halves, remappable from Settings.
 * Plain DOM key codes (the same numbers as Phaser's KeyCodes) so this module
 * stays importable in Node tests.
 */

export type KeyboardLayout = "p1" | "p2";
export type BindableAction = "left" | "right" | "up" | "down" | "punch" | "kick";
export type KeyBindings = Record<KeyboardLayout, Record<BindableAction, number[]>>;

export const BINDABLE_ACTIONS: readonly BindableAction[] = ["left", "right", "up", "down", "punch", "kick"];
export const KEYBOARD_LAYOUTS: readonly KeyboardLayout[] = ["p1", "p2"];

export const KEY = {
  TAB: 9, ENTER: 13, ESC: 27, SPACE: 32, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
  A: 65, D: 68, F: 70, J: 74, K: 75, N: 78, S: 83, T: 84, W: 87, NUMPAD_ONE: 97, NUMPAD_TWO: 98, F1: 112, COMMA: 188, PERIOD: 190,
} as const;

/** P1: WASD + J/K. P2: arrows + , (punch) and . (kick); numpad 1/2 also work if present. */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  p1: { left: [KEY.A], right: [KEY.D], up: [KEY.W], down: [KEY.S], punch: [KEY.J], kick: [KEY.K] },
  p2: { left: [KEY.LEFT], right: [KEY.RIGHT], up: [KEY.UP], down: [KEY.DOWN], punch: [KEY.COMMA, KEY.NUMPAD_ONE], kick: [KEY.PERIOD, KEY.NUMPAD_TWO] },
};

/** Pause, the hitbox overlay, and practice's dummy picker (Tab, 1–9) can't be bound to moves. */
export const RESERVED_KEYS: ReadonlySet<number> = new Set([KEY.ESC, KEY.F1, KEY.TAB, 49, 50, 51, 52, 53, 54, 55, 56, 57]);

let current: KeyBindings = cloneBindings(DEFAULT_KEY_BINDINGS);
let version = 0;

function cloneBindings(b: KeyBindings): KeyBindings {
  return {
    p1: Object.fromEntries(BINDABLE_ACTIONS.map((a) => [a, [...b.p1[a]]])) as KeyBindings["p1"],
    p2: Object.fromEntries(BINDABLE_ACTIONS.map((a) => [a, [...b.p2[a]]])) as KeyBindings["p2"],
  };
}

export const keyBindings = (): KeyBindings => current;

/** Bumped on every change, so live keyboard sources know to rebind. */
export const keyBindingsVersion = () => version;

export function setKeyBindings(b: KeyBindings): void {
  current = cloneBindings(b);
  version++;
}

/** Stored bindings, if they're well-formed (anything else falls back to the defaults). */
export function isKeyBindings(value: unknown): value is KeyBindings {
  if (!value || typeof value !== "object") return false;
  return KEYBOARD_LAYOUTS.every((layout) => {
    const map = (value as Record<string, unknown>)[layout];
    return Boolean(map) && BINDABLE_ACTIONS.every((a) => {
      const codes = (map as Record<string, unknown>)[a];
      return Array.isArray(codes) && codes.length > 0 && codes.every((c) => Number.isInteger(c) && c > 0);
    });
  });
}

export const isDefaultBindings = (b: KeyBindings) => JSON.stringify(b) === JSON.stringify(DEFAULT_KEY_BINDINGS);

/** Which keyboard half a key belongs to, for "press any button" joining. */
export function layoutForKey(keyCode: number, b: KeyBindings = current): KeyboardLayout | null {
  return KEYBOARD_LAYOUTS.find((layout) => BINDABLE_ACTIONS.some((a) => b[layout][a].includes(keyCode))) ?? null;
}

const ACTION_NAMES: Record<BindableAction, string> = { left: "left", right: "right", up: "up / jump", down: "down / crouch", punch: "punch", kick: "kick" };
export const actionName = (a: BindableAction) => ACTION_NAMES[a];

/**
 * Remapping one keyboard half, one action at a time. Each action gets exactly
 * one key; a key already used by the other half, by an action assigned earlier
 * in this pass, or reserved, is refused with the reason.
 */
export class RemapSession {
  private readonly assigned: Partial<Record<BindableAction, number>> = {};
  private index = 0;

  constructor(readonly layout: KeyboardLayout, private readonly base: KeyBindings = current) {}

  get action(): BindableAction | null {
    return BINDABLE_ACTIONS[this.index] ?? null;
  }

  get done(): boolean {
    return this.action === null;
  }

  /** Assign `keyCode` to the current action; returns why it was refused, or null. */
  press(keyCode: number): string | null {
    const action = this.action;
    if (!action) return null;
    if (RESERVED_KEYS.has(keyCode)) return `${keyLabel(keyCode)} is reserved`;
    const other: KeyboardLayout = this.layout === "p1" ? "p2" : "p1";
    const taken = BINDABLE_ACTIONS.find((a) => this.base[other][a].includes(keyCode));
    if (taken) return `${keyLabel(keyCode)} is ${other.toUpperCase()}'s ${actionName(taken)}`;
    const mine = BINDABLE_ACTIONS.find((a) => this.assigned[a] === keyCode);
    if (mine) return `${keyLabel(keyCode)} is already ${actionName(mine)}`;
    this.assigned[action] = keyCode;
    this.index++;
    return null;
  }

  /** The full bindings with this half replaced (call once `done`). */
  result(): KeyBindings {
    const b = cloneBindings(this.base);
    for (const a of BINDABLE_ACTIONS) b[this.layout][a] = [this.assigned[a] ?? this.base[this.layout][a][0]];
    return b;
  }
}

const NAMED_KEYS: Record<number, string> = {
  8: "Backspace", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt", 20: "Caps", 32: "Space", 33: "PgUp", 34: "PgDn", 35: "End", 36: "Home",
  37: "←", 38: "↑", 39: "→", 40: "↓", 45: "Ins", 46: "Del", 106: "Num*", 107: "Num+", 109: "Num-", 110: "Num.", 111: "Num/",
  186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'",
};

/** Short on-screen name for a key code. */
export function keyLabel(code: number): string {
  if (NAMED_KEYS[code]) return NAMED_KEYS[code];
  if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return String.fromCharCode(code);
  if (code >= 96 && code <= 105) return `Num${code - 96}`;
  if (code >= 112 && code <= 123) return `F${code - 111}`;
  return `Key ${code}`;
}

/** The first (main) key of an action, as a label. */
export const actionKeyLabel = (layout: KeyboardLayout, action: BindableAction, b: KeyBindings = current) => keyLabel(b[layout][action][0]);
