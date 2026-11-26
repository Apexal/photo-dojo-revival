import type { FightSimulation } from "../../simulation/fight-simulation";
import { STAGE_MARGIN, STAGE_WIDTH } from "../../simulation/fighter-state-machine";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";
import type { PlayerIndex } from "../../simulation/round-rules";
import { CpuPlayer, NoDoubleTaps, rangesFor, type CpuLevel } from "./cpu-player";
import type { InputSource } from "./input-source";

/**
 * The tutorial's drills (not on the practice picker) walk in until a move
 * reaches, then use it, over and over: `pressure` punches, `pressureLow` low
 * kicks, `pressureUppercut` uppercuts (to be blocked and punished), `grab`
 * throws (to be broken), `jumpInClose` jumps in with a kick from where it lands
 * in front (to be blocked standing, or uppercut).
 */
type DrillBehavior = "pressure" | "pressureLow" | "pressureUppercut" | "grab" | "jumpInClose";
type ScriptedBehavior = "stand" | "block" | "crouch" | "jump" | "jumpIn" | "punch" | "throw" | "random" | DrillBehavior;
export type DummyBehavior = ScriptedBehavior | "cpuEasy" | "cpuNormal" | "cpuHard";

export const DUMMY_BEHAVIORS: readonly { behavior: DummyBehavior; label: string }[] = [
  { behavior: "stand", label: "Stand still" },
  { behavior: "block", label: "Block (standing)" },
  { behavior: "crouch", label: "Crouch-block" },
  { behavior: "jump", label: "Jump" },
  { behavior: "jumpIn", label: "Jump-in kick (anti-air drill)" },
  { behavior: "punch", label: "Punch" },
  { behavior: "throw", label: "Throw" },
  { behavior: "random", label: "Mix it up" },
  { behavior: "cpuEasy", label: "CPU: easy" },
  { behavior: "cpuNormal", label: "CPU: normal" },
  { behavior: "cpuHard", label: "CPU: hard" },
];

const CPU_BEHAVIORS: Partial<Record<DummyBehavior, CpuLevel>> = { cpuEasy: "easy", cpuNormal: "normal", cpuHard: "hard" };
export const isCpuBehavior = (b: DummyBehavior) => b in CPU_BEHAVIORS;
export const cpuBehavior = (level: CpuLevel): DummyBehavior => (level === "easy" ? "cpuEasy" : level === "normal" ? "cpuNormal" : "cpuHard");

/** Number key 9 cycles the CPU levels; this is the one after `b` (easy when `b` isn't a CPU). */
export function nextCpuBehavior(b: DummyBehavior): DummyBehavior {
  return b === "cpuEasy" ? "cpuNormal" : b === "cpuNormal" ? "cpuHard" : "cpuEasy";
}

/** `jumpInClose` jumps from no closer than this share of its range: any closer and it lands behind them. */
const JUMP_IN_CLOSEST = 0.6;

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
  private readonly taps = new NoDoubleTaps();
  /** A drill: how close it walks before using its move. */
  private drillRange = 0;
  /** `jumpInClose`: frames into the current jump-in, or -1 while walking in. */
  private jumpAt = -1;

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
    const ranges = rangesFor(this.fight.getGeometry(this.player), this.fight.getGeometry(other));
    const drill: Partial<Record<DummyBehavior, number>> = {
      pressure: ranges.attack.punch, pressureLow: ranges.attack.lowKick, pressureUppercut: ranges.attack.uppercut,
      grab: ranges.throw, jumpInClose: ranges.attack.jumpKick,
    };
    this.drillRange = drill[behavior] ?? 0;
    this.jumpAt = -1;
  }

  read(): InputFrame {
    const fighters = this.fight.current.fighters;
    if (this.cpu) return this.cpu.read(fighters[this.player], fighters[this.player === 0 ? 1 : 0]);
    return this.taps.filter(this.scripted(), fighters[this.player].facing);
  }

  /** The scripted behaviour's input this frame (before NoDoubleTaps). */
  private scripted(): InputFrame {
    const fighters = this.fight.current.fighters;
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
      // Back, plus the block button: back alone would walk away when nothing's coming.
      case "block": return { ...EMPTY_INPUT, ...back, block: true };
      case "crouch": return { ...EMPTY_INPUT, down: true };
      case "jump": return { ...EMPTY_INPUT, up: t < 3 };
      case "jumpIn": {
        const forward = facing === 1 ? { right: t < 30 } : { left: t < 30 };
        return { ...EMPTY_INPUT, ...forward, up: t < 3, kick: t === 18 };
      }
      case "punch": return { ...EMPTY_INPUT, punch: t % 30 < 2 };
      case "pressure":
      case "pressureLow":
      case "pressureUppercut":
      case "grab":
      case "jumpInClose": {
        const forward = facing === 1 ? { right: true } : { left: true };
        if (this.jumpAt >= 0) {
          // The jump-in: up, forward through the jump, the kick on the way down onto them.
          const j = this.jumpAt++;
          if (j >= LOOP) this.jumpAt = -1;
          return { ...EMPTY_INPUT, ...(j < 30 ? forward : {}), up: j < 3, kick: j === 18 };
        }
        const distance = Math.abs(fighters[this.player === 0 ? 1 : 0].position.x - fighters[this.player].position.x);
        if (distance > this.drillRange) return { ...EMPTY_INPUT, ...forward };
        if (behavior === "jumpInClose") {
          // Too close to land in front of them (it would cross over): step back out first, unless cornered.
          const me = fighters[this.player].position.x;
          const cornered = facing === 1 ? me <= STAGE_MARGIN + 1 : me >= STAGE_WIDTH - STAGE_MARGIN - 1;
          if (distance < this.drillRange * JUMP_IN_CLOSEST && !cornered) return { ...EMPTY_INPUT, ...(facing === 1 ? { left: true } : { right: true }) };
          this.jumpAt = 1;
          return { ...EMPTY_INPUT, ...forward, up: true };
        }
        const go = t < 2;
        return behavior === "pressure" ? { ...EMPTY_INPUT, punch: go }
          : behavior === "pressureLow" ? { ...EMPTY_INPUT, down: go, kick: go }
          : behavior === "pressureUppercut" ? { ...EMPTY_INPUT, uppercut: go }
          : { ...EMPTY_INPUT, throw: go };
      }
      case "throw": return { ...EMPTY_INPUT, punch: t < 2, kick: t < 2 };
      default: return { ...EMPTY_INPUT };
    }
  }

  pausePressed(): boolean {
    return false;
  }
}
