import type { FightSimulation } from "../../simulation/fight-simulation";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";
import type { PlayerIndex } from "../../simulation/round-rules";
import { CpuPlayer, rangesFor, type CpuLevel } from "./cpu-player";
import type { InputSource } from "./input-source";

/** `pressure` (walk in and punch, for the tutorial's blocking drill) isn't on the practice picker. */
type ScriptedBehavior = "stand" | "block" | "crouch" | "jump" | "jumpIn" | "punch" | "pressure" | "throw" | "random";
export type DummyBehavior = ScriptedBehavior | "cpuEasy" | "cpuNormal" | "cpuHard";

export const DUMMY_BEHAVIORS: readonly { behavior: DummyBehavior; label: string }[] = [
  { behavior: "stand", label: "Stand still" },
  { behavior: "block", label: "Block (standing)" },
  { behavior: "crouch", label: "Crouch-block" },
  { behavior: "jump", label: "Jump" },
  { behavior: "jumpIn", label: "Jump in with a kick (practice anti-air)" },
  { behavior: "punch", label: "Punch" },
  { behavior: "throw", label: "Throw" },
  { behavior: "random", label: "Mix it up" },
  { behavior: "cpuEasy", label: "CPU: easy" },
  { behavior: "cpuNormal", label: "CPU: normal" },
  { behavior: "cpuHard", label: "CPU: hard" },
];

const CPU_BEHAVIORS: Partial<Record<DummyBehavior, CpuLevel>> = { cpuEasy: "easy", cpuNormal: "normal", cpuHard: "hard" };
export const isCpuBehavior = (b: DummyBehavior) => b in CPU_BEHAVIORS;

/** Number key 9 cycles the CPU levels; this is the one after `b` (easy when `b` isn't a CPU). */
export function nextCpuBehavior(b: DummyBehavior): DummyBehavior {
  return b === "cpuEasy" ? "cpuNormal" : b === "cpuNormal" ? "cpuHard" : "cpuEasy";
}

/** Same frames every loop so practice is repeatable. */
const LOOP = 60;

/**
 * Practice-mode opponent: a scripted input source, or a CPU that plays. The
 * fight is read each frame so "back" is always away from the player.
 */
export class DummyInputSource implements InputSource {
  readonly id = "dummy";
  readonly label = "Training dummy";
  readonly connected = true;
  behavior: DummyBehavior = "stand";
  private frame = 0;
  private randomBehavior: Exclude<ScriptedBehavior, "random"> = "stand";
  private cpu: CpuPlayer | null = null;
  /** `pressure`: how close it walks before punching. */
  private punchRange = 0;

  constructor(
    private readonly fight: Pick<FightSimulation, "current" | "getGeometry">,
    private readonly player: PlayerIndex = 1,
    private readonly random: () => number = Math.random,
  ) {}

  setBehavior(behavior: DummyBehavior): void {
    this.behavior = behavior;
    this.frame = 0;
    const level = CPU_BEHAVIORS[behavior];
    const other = this.player === 0 ? 1 : 0;
    this.cpu = level
      ? new CpuPlayer(level, { self: this.fight.getGeometry(this.player), opponent: this.fight.getGeometry(other) }, this.random)
      : null;
    if (behavior === "pressure") {
      this.punchRange = rangesFor(this.fight.getGeometry(this.player), this.fight.getGeometry(other)).attack.punch;
    }
  }

  read(): InputFrame {
    const fighters = this.fight.current.fighters;
    if (this.cpu) return this.cpu.read(fighters[this.player], fighters[this.player === 0 ? 1 : 0]);
    const t = this.frame++ % LOOP;
    let behavior = this.behavior;
    if (behavior === "random") {
      if (t === 0) {
        const options = DUMMY_BEHAVIORS.map((b) => b.behavior).filter((b): b is Exclude<ScriptedBehavior, "random"> => b !== "random" && !isCpuBehavior(b));
        this.randomBehavior = options[Math.floor(this.random() * options.length)];
      }
      behavior = this.randomBehavior;
    }
    const facing = fighters[this.player].facing;
    const back = facing === 1 ? { left: true } : { right: true };
    switch (behavior) {
      case "block": return { ...EMPTY_INPUT, ...back };
      case "crouch": return { ...EMPTY_INPUT, down: true };
      case "jump": return { ...EMPTY_INPUT, up: t < 3 };
      case "jumpIn": {
        const forward = facing === 1 ? { right: t < 30 } : { left: t < 30 };
        return { ...EMPTY_INPUT, ...forward, up: t < 3, kick: t === 18 };
      }
      case "punch": return { ...EMPTY_INPUT, punch: t % 30 < 2 };
      case "pressure": {
        const distance = Math.abs(fighters[this.player === 0 ? 1 : 0].position.x - fighters[this.player].position.x);
        if (distance > this.punchRange) return { ...EMPTY_INPUT, ...(facing === 1 ? { right: true } : { left: true }) };
        return { ...EMPTY_INPUT, punch: t < 2 };
      }
      case "throw": return { ...EMPTY_INPUT, punch: t < 2, kick: t < 2 };
      default: return { ...EMPTY_INPUT };
    }
  }

  pausePressed(): boolean {
    return false;
  }
}
