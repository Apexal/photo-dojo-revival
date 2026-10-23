import type { InputFrame } from "../../simulation/input-frame";
import type { Rumble } from "./rumble";

/** Anything that can drive a fighter: keyboard half or a gamepad. */
export interface InputSource {
  readonly id: string;
  readonly label: string;
  read(): InputFrame;
  /** Start / Escape. */
  pausePressed(): boolean;
  /** Still usable (a gamepad may have disconnected). */
  readonly connected: boolean;
  /** Controller rumble, where the device supports it. */
  rumble?(r: Rumble): void;
}
