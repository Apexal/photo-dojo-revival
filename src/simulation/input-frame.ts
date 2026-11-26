export interface InputFrame {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  punch: boolean;
  kick: boolean;
  /** Dedicated block (a controller's triggers): guards without walking, whatever the opponent is doing; with down held, a crouching guard. */
  block: boolean;
  /** Dedicated throw button (a controller's Y or right bumper): the same as punch + kick together, so down + it is the signature move. */
  throw: boolean;
  /** Dedicated uppercut button (a controller's X): the same as down + punch, without crouching first. */
  uppercut: boolean;
  /** Dedicated taunt button (a controller's left bumper or right stick click). */
  taunt: boolean;
  /**
   * The device has a taunt button (a controller): it's the only way to taunt,
   * so punch + kick (or the throw button) throws even from far away.
   */
  hasTauntButton: boolean;
}

export const EMPTY_INPUT: Readonly<InputFrame> = Object.freeze({
  left: false, right: false, up: false, down: false, punch: false, kick: false, block: false, throw: false,
  uppercut: false, taunt: false, hasTauntButton: false,
});

export function input(partial: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, ...partial };
}

export function mergeInputs(a: InputFrame, b: InputFrame): InputFrame {
  return {
    left: a.left || b.left,
    right: a.right || b.right,
    up: a.up || b.up,
    down: a.down || b.down,
    punch: a.punch || b.punch,
    kick: a.kick || b.kick,
    block: a.block || b.block,
    throw: a.throw || b.throw,
    uppercut: a.uppercut || b.uppercut,
    taunt: a.taunt || b.taunt,
    hasTauntButton: a.hasTauntButton || b.hasTauntButton,
  };
}

/** Folds the throw button into punch + kick, which is how the simulation reads it. */
export function withThrowButton(f: InputFrame): InputFrame {
  return f.throw ? { ...f, punch: true, kick: true } : f;
}
