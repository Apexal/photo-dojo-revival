import type Phaser from "phaser";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";
import type { InputSource } from "./input-source";
import { playRumble, type Rumble } from "./rumble";

/** Standard mapping button indices. */
export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
export const STICK_DEADZONE = 0.4;

/** Buttons and axes of one pad for this frame. */
interface PadState {
  button(i: number): boolean;
  axis(i: number): number;
}

/**
 * A/Cross = punch, B/Circle = kick, d-pad or left stick to move, Start = pause.
 * Reads the browser's live Gamepad by index each frame. Phaser's copy is per
 * scene and stops updating under an overlay scene that captures input (the
 * pause menu), so it's only the fallback where the Gamepad API is missing.
 */
export class GamepadInputSource implements InputSource {
  readonly id: string;
  readonly label: string;
  private startWasDown = true;

  constructor(private readonly plugin: Phaser.Input.Gamepad.GamepadPlugin, readonly padIndex: number) {
    this.id = `pad-${padIndex}`;
    this.label = `Gamepad ${padIndex + 1}`;
  }

  private get pad(): Phaser.Input.Gamepad.Gamepad | null {
    return this.plugin.getPad(this.padIndex) ?? null;
  }

  /** The browser's current Gamepad at our index (Phaser's copy can keep saying "connected" after an unplug). */
  private get live(): Gamepad | null | undefined {
    return typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads()[this.padIndex] : undefined;
  }

  get connected(): boolean {
    const live = this.live;
    if (live !== undefined) return Boolean(live?.connected);
    return this.pad?.connected ?? false;
  }

  private state(): PadState | null {
    const live = this.live;
    if (live !== undefined) {
      return live?.connected ? { button: (i) => live.buttons[i]?.pressed ?? false, axis: (i) => live.axes[i] ?? 0 } : null;
    }
    const pad = this.pad;
    return pad ? { button: (i) => pad.buttons[i]?.pressed ?? false, axis: (i) => pad.axes[i]?.getValue() ?? 0 } : null;
  }

  read(): InputFrame {
    const pad = this.state();
    if (!pad) return { ...EMPTY_INPUT };
    const x = pad.axis(0);
    const y = pad.axis(1);
    const b = (i: number) => pad.button(i);
    return {
      left: b(PAD_BUTTON.LEFT) || x < -STICK_DEADZONE,
      right: b(PAD_BUTTON.RIGHT) || x > STICK_DEADZONE,
      up: b(PAD_BUTTON.UP) || y < -STICK_DEADZONE * 1.5,
      down: b(PAD_BUTTON.DOWN) || y > STICK_DEADZONE * 1.5,
      punch: b(PAD_BUTTON.A) || b(PAD_BUTTON.X),
      kick: b(PAD_BUTTON.B) || b(PAD_BUTTON.Y),
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
