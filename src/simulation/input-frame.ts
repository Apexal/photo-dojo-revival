export interface InputFrame {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  punch: boolean;
  kick: boolean;
  /** Dedicated standing block (a controller's X or bumpers): guards without walking, whatever the opponent is doing. */
  block: boolean;
  /** Dedicated throw button (a controller's Y): the same as punch + kick together, so down + it is the signature move. */
  throw: boolean;
}

export const EMPTY_INPUT: Readonly<InputFrame> = Object.freeze({
  left: false, right: false, up: false, down: false, punch: false, kick: false, block: false, throw: false,
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
  };
}

/** Folds the throw button into punch + kick, which is how the simulation reads it. */
export function withThrowButton(f: InputFrame): InputFrame {
  return f.throw ? { ...f, punch: true, kick: true } : f;
}
