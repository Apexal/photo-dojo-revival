import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { InputSource } from "./input-source";
import { BINDABLE_ACTIONS, KEY, actionKeyLabel, keyBindings, keyBindingsVersion, layoutForKey, type BindableAction, type KeyboardLayout } from "./key-bindings";
import { TapLatch } from "./tap-latch";

export type { KeyboardLayout } from "./key-bindings";

type Action = BindableAction | "pause";

/** The current bindings (see key-bindings.ts); Esc pauses on both halves. */
export class KeyboardInputSource implements InputSource {
  readonly id: string;
  readonly connected = true;
  private keys = {} as Record<Action, Phaser.Input.Keyboard.Key[]>;
  private unbind: () => void = () => {};
  private boundVersion = -1;
  /** Keeps taps shorter than a frame, and back-to-back taps, visible as separate presses. */
  private readonly taps = new TapLatch<Action>();
  private pauseLatched = false;

  constructor(private readonly scene: Phaser.Scene, readonly layout: KeyboardLayout) {
    this.id = `keyboard-${layout}`;
    this.bind();
  }

  get label(): string {
    const k = (a: BindableAction) => actionKeyLabel(this.layout, a);
    return `Keyboard (${k("up")}${k("left")}${k("down")}${k("right")} + ${k("punch")}/${k("kick")})`;
  }

  /** (Re)attach to the keys of the current bindings; called again after a remap. */
  private bind(): void {
    this.unbind();
    const kb = this.scene.input.keyboard!;
    const map: Record<Action, readonly number[]> = { ...keyBindings()[this.layout], pause: [KEY.ESC] };
    const handlers: [Phaser.Input.Keyboard.Key, string, () => void][] = [];
    this.keys = Object.fromEntries(
      (Object.keys(map) as Action[]).map((a) => [a, map[a].map((code) => kb.addKey(code, true, false))]),
    ) as Record<Action, Phaser.Input.Keyboard.Key[]>;
    for (const [action, keys] of Object.entries(this.keys) as [Action, Phaser.Input.Keyboard.Key[]][]) {
      for (const key of keys) {
        const down = () => (action === "pause" ? (this.pauseLatched = true) : this.taps.press(action));
        const up = () => this.taps.release(action);
        key.on("down", down);
        key.on("up", up);
        handlers.push([key, "down", down], [key, "up", up]);
      }
    }
    this.unbind = () => handlers.forEach(([key, ev, fn]) => key.off(ev, fn));
    this.boundVersion = keyBindingsVersion();
  }

  read(): InputFrame {
    if (this.boundVersion !== keyBindingsVersion()) this.bind();
    return this.taps.read(BINDABLE_ACTIONS, (a) => this.keys[a].some((k) => k.isDown));
  }

  pausePressed(): boolean {
    const pressed = this.pauseLatched;
    this.pauseLatched = false;
    return pressed;
  }

  /** Which layout a key belongs to, for "press any button" joining. */
  static layoutForKey(keyCode: number): KeyboardLayout | null {
    return layoutForKey(keyCode);
  }
}
