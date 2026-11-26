import type Phaser from "phaser";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";
import type { InputSource } from "./input-source";
import { padConnections } from "./pad-connections";
import { playRumble, type Rumble } from "./rumble";

/** Standard mapping button indices. */
export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
export const STICK_DEADZONE = 0.4;
/** Left or right counts once the stick is more than 22.5° off vertical: eight even-ish sectors. */
const STICK_SIDE = Math.sin((22.5 * Math.PI) / 180);
/** Up or down counts once it's more than 35° off horizontal, so walking with the stick a little high doesn't jump. */
const STICK_VERTICAL = Math.sin((35 * Math.PI) / 180);

/**
 * The left stick as directions, by angle once it's past a round deadzone, so how
 * far it's pushed doesn't matter: a half-pushed down-back is down-back, not just back.
 */
export function stickDirections(x: number, y: number): { left: boolean; right: boolean; up: boolean; down: boolean } {
  const r = Math.hypot(x, y);
  if (r < STICK_DEADZONE) return { left: false, right: false, up: false, down: false };
  const sx = x / r, sy = y / r;
  return { left: sx < -STICK_SIDE, right: sx > STICK_SIDE, up: sy < -STICK_VERTICAL, down: sy > STICK_VERTICAL };
}

/**
 * A player's controller: a slot and the connection in it when they picked it
 * up (pad-connections.ts), plus the pad's model (`Gamepad.id`) to tell two
 * different kinds of controller apart. Without `connection` it's just the slot,
 * whatever is in it (menus, where any pad may navigate). Mutable on purpose:
 * when the player takes their seat back with a woken controller, the binding
 * moves to it, and every scene holding it (a rematch, the next round) follows.
 */
export interface PadBinding {
  kind: "pad";
  index: number;
  connection?: number;
  id?: string;
}

const livePads = (): (Gamepad | null)[] | undefined =>
  typeof navigator !== "undefined" && navigator.getGamepads ? Array.from(navigator.getGamepads()) : undefined;

/** The model (`Gamepad.id`) of the pad in a slot now, if there is one. */
export const livePadId = (index: number): string | undefined => livePads()?.[index]?.id;

/** The player's binding to whatever pad is in a slot now (fighter select, a reconnect). */
export function padBinding(index: number): PadBinding {
  const pad = livePads()?.[index];
  if (pad === undefined) return { kind: "pad", index }; // no Gamepad API: slots are all there is
  const connection = padConnections.current(index, Boolean(pad?.connected));
  return connection === null ? { kind: "pad", index } : { kind: "pad", index, connection, id: pad!.id };
}

/** Bindings in use by players right now (sources of running scenes), so a reclaim doesn't take a pad someone holds. */
const seated = new Map<PadBinding, number>();

/** Takes a seat until the scene shuts down; returns a function leaving it early (idempotent). */
function seat(binding: PadBinding, plugin: Phaser.Input.Gamepad.GamepadPlugin): () => void {
  seated.set(binding, (seated.get(binding) ?? 0) + 1);
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    const n = (seated.get(binding) ?? 1) - 1;
    if (n > 0) seated.set(binding, n);
    else seated.delete(binding);
  };
  (plugin as { scene?: Phaser.Scene }).scene?.events?.once("shutdown", leave);
  return leave;
}

const isLive = (b: PadBinding, pads = livePads()) =>
  b.connection === undefined || padConnections.current(b.index, Boolean(pads?.[b.index]?.connected)) === b.connection;

/** Buttons and axes of one pad for this frame. */
interface PadState {
  button(i: number): boolean;
  axis(i: number): number;
}

/**
 * A/Cross = punch, B/Circle = kick, X/Square = uppercut, Y/Triangle or RB/R1 = throw
 * (down + it the signature move; never a taunt), either trigger = block (low with
 * down held), LB/L1 or a right stick click = taunt, the only ways to taunt on a pad
 * (not the left stick: it's pressed hard while moving), d-pad or left stick to move,
 * Start = pause. Labels for each make of pad: control-labels.ts.
 * A player's source (given a PadBinding) reads only the connection it was bound
 * to: once that pad sleeps or unplugs it's disconnected and reads nothing, even
 * when another pad lands in its slot, until a button on a pad nobody else holds
 * takes the seat back (preferring a pad of the same model). That press, held,
 * doesn't count.
 * Reads the browser's live Gamepad by index each frame. Phaser's copy is per
 * scene and stops updating under an overlay scene that captures input (the
 * pause menu), so it's only the fallback where the Gamepad API is missing.
 */
export class GamepadInputSource implements InputSource {
  private startWasDown = true;
  private readonly binding: PadBinding;
  /** Buttons held when the seat was taken back: ignored until let go. */
  private held = new Set<number>();
  private readonly leaveSeat: () => void;

  constructor(private readonly plugin: Phaser.Input.Gamepad.GamepadPlugin, pad: number | PadBinding) {
    this.binding = typeof pad === "number" ? { kind: "pad", index: pad } : pad;
    this.leaveSeat = typeof pad === "number" ? () => {} : seat(this.binding, plugin);
  }

  /** Replaced before its scene ends (a reconnect, a player leaving): its binding no longer holds a seat. */
  release(): void {
    this.leaveSeat();
  }

  get padIndex(): number { return this.binding.index; }
  get id(): string { return `pad-${this.padIndex}`; }
  get label(): string { return `Gamepad ${this.padIndex + 1}`; }

  private get pad(): Phaser.Input.Gamepad.Gamepad | null {
    return this.plugin.getPad(this.padIndex) ?? null;
  }

  /** The browser's current Gamepad at our index (Phaser's copy can keep saying "connected" after an unplug). */
  private liveIn(pads: (Gamepad | null)[] | undefined): Gamepad | null | undefined {
    return pads ? (pads[this.padIndex] ?? null) : undefined;
  }

  private get live(): Gamepad | null | undefined {
    return this.liveIn(livePads());
  }

  get connected(): boolean {
    return this.connectedIn(livePads());
  }

  /** `connected`, given one snapshot of the browser's pads. */
  private connectedIn(pads: (Gamepad | null)[] | undefined): boolean {
    if (!pads) return this.pad?.connected ?? false;
    // isLive first: it also tells padConnections when the slot is seen empty.
    return isLive(this.binding, pads) && Boolean(this.liveIn(pads)?.connected);
  }

  /**
   * Lost our pad: take one back now if a button is pressed on a pad nobody holds.
   * The one way a player's seat is taken back with a pad: reading a lost source
   * does it too, and the pause menu calls this in its own order (fight-scene.ts
   * pollReconnect). True when it took one.
   */
  reclaim(): boolean {
    const pads = livePads();
    return !this.connectedIn(pads) && this.claimFrom(pads);
  }

  /**
   * The reclaim rule: a fresh press (pad-connections.ts) on a pad no seated
   * player holds takes it. A pad of another model that a different lost player
   * had is theirs, not ours. Two lost players of one model: whoever asks first.
   */
  private claimFrom(snapshot: (Gamepad | null)[] | undefined): boolean {
    const b = this.binding;
    if (b.connection === undefined) return false;
    const pads = snapshot ?? [];
    const lost = [...seated.keys()].filter((o) => o !== b && o.connection !== undefined && !isLive(o, snapshot));
    for (const pad of pads) {
      if (!pad?.connected || !padConnections.freshPress(pad.index, pad.buttons.some((x) => x.pressed))) continue;
      const connection = padConnections.current(pad.index, true);
      if ([...seated.keys()].some((o) => o !== b && o.index === pad.index && o.connection === connection)) continue;
      if (b.id && pad.id !== b.id && lost.some((o) => o.id === pad.id)) continue;
      Object.assign(b, { index: pad.index, connection, id: pad.id });
      this.held = new Set(pad.buttons.flatMap((x, i) => (x.pressed ? [i] : [])));
      this.startWasDown = true;
      return true;
    }
    return false;
  }

  private state(): PadState | null {
    const pads = livePads();
    if (!this.connectedIn(pads) && !this.claimFrom(pads)) return null;
    const live = this.liveIn(pads);
    if (live !== undefined) {
      return live?.connected ? { button: (i) => live.buttons[i]?.pressed ?? false, axis: (i) => live.axes[i] ?? 0 } : null;
    }
    const pad = this.pad;
    return pad ? { button: (i) => pad.buttons[i]?.pressed ?? false, axis: (i) => pad.axes[i]?.getValue() ?? 0 } : null;
  }

  read(): InputFrame {
    const pad = this.state();
    if (!pad) return { ...EMPTY_INPUT };
    const stick = stickDirections(pad.axis(0), pad.axis(1));
    for (const i of this.held) if (!pad.button(i)) this.held.delete(i);
    const b = (i: number) => pad.button(i) && !this.held.has(i);
    return {
      left: b(PAD_BUTTON.LEFT) || stick.left,
      right: b(PAD_BUTTON.RIGHT) || stick.right,
      up: b(PAD_BUTTON.UP) || stick.up,
      down: b(PAD_BUTTON.DOWN) || stick.down,
      punch: b(PAD_BUTTON.A),
      kick: b(PAD_BUTTON.B),
      block: b(PAD_BUTTON.LT) || b(PAD_BUTTON.RT),
      throw: b(PAD_BUTTON.Y) || b(PAD_BUTTON.RB),
      uppercut: b(PAD_BUTTON.X),
      taunt: b(PAD_BUTTON.LB) || b(PAD_BUTTON.R3),
      hasTauntButton: true,
    };
  }

  rumble(r: Rumble): void {
    // Phaser keeps the browser Gamepad it saw when the pad first appeared, but browsers hand
    // out a fresh snapshot every frame and a stale snapshot's actuator stops working. Look it up live.
    playRumble((this.live ?? this.pad?.pad) as Parameters<typeof playRumble>[0], r);
  }

  pausePressed(): boolean {
    const down = this.state()?.button(PAD_BUTTON.START) ?? false;
    const pressed = down && !this.startWasDown;
    this.startWasDown = down;
    return pressed;
  }
}
