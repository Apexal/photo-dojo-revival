import type Phaser from "phaser";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";
import { GamepadInputSource } from "./gamepad-input-source";
import type { InputSource } from "./input-source";
import { KEY } from "./key-bindings";
import { KeyboardInputSource } from "./keyboard-input-source";

export type MenuAction = "up" | "down" | "left" | "right" | "confirm" | "back" | "pause";

const PADS = 4;

/**
 * Menu navigation from every device at once: both keyboard halves, the first
 * four gamepads, plus Enter / Space to confirm. Punch confirms, kick goes back,
 * Esc / Start is "pause". Buttons already held when the menu opens (or after
 * `reset`) don't count until released.
 */
export class MenuInput {
  private readonly sources: InputSource[];
  private previous: InputFrame[] = [];
  private enterLatched = false;

  constructor(scene: Phaser.Scene) {
    this.sources = [
      new KeyboardInputSource(scene, "p1"),
      new KeyboardInputSource(scene, "p2"),
      ...Array.from({ length: PADS }, (_, i) => new GamepadInputSource(scene.input.gamepad!, i)),
    ];
    const kb = scene.input.keyboard!;
    const confirm = (ev: KeyboardEvent) => { if (!ev.repeat) this.enterLatched = true; };
    kb.on("keydown-ENTER", confirm);
    kb.on("keydown-SPACE", confirm);
    kb.addCapture([KEY.ENTER, KEY.SPACE]);
    scene.events.once("shutdown", () => {
      kb.off("keydown-ENTER", confirm);
      kb.off("keydown-SPACE", confirm);
    });
    this.reset();
  }

  /** Forget anything pressed so far (e.g. when the menu comes back after a sub-screen). */
  reset(): void {
    this.previous = this.sources.map((s) => s.read());
    this.sources.forEach((s) => s.pausePressed());
    this.enterLatched = false;
  }

  poll(): Set<MenuAction> {
    const out = new Set<MenuAction>();
    const now = this.sources.map((s) => s.read());
    now.forEach((f, i) => {
      const was = this.previous[i] ?? EMPTY_INPUT;
      for (const k of ["up", "down", "left", "right"] as const) if (f[k] && !was[k]) out.add(k);
      if (f.punch && !was.punch) out.add("confirm");
      if (f.kick && !was.kick) out.add("back");
    });
    this.previous = now;
    // Poll every source (no short-circuit) so each one's latch is consumed.
    if (this.sources.map((s) => s.pausePressed()).includes(true)) out.add("pause");
    if (this.enterLatched) out.add("confirm");
    this.enterLatched = false;
    return out;
  }
}
