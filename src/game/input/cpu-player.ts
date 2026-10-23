import { ATTACKS, KNOCKDOWN, TAUNT, THROW, THROW_TOTAL_FRAMES, attackTotalFrames, type AttackId, type FighterGeometry } from "../../shared/frame-data";
import { worldBoxesOf } from "../../simulation/fight-simulation";
import { createFighterState, currentAttackPhase, isAttack, isDown, isGrounded, type FighterState } from "../../simulation/fighter-state-machine";
import { EMPTY_INPUT, type InputFrame } from "../../simulation/input-frame";

export type CpuLevel = "easy" | "normal" | "hard";

interface CpuTuning {
  /** Frames between something happening and the CPU seeing it. */
  reaction: number;
  /** Frames a neutral decision (walk, wait, guard) lasts before it picks again. */
  think: number;
  /** Chance of guarding: rolled per opponent attack it sees, and per decision when in the opponent's reach. */
  block: number;
  /** Chance of answering a jump-in with an uppercut. */
  antiAir: number;
  /** Chance per decision of attacking when something reaches. */
  aggression: number;
  /** Chance of hitting back while the opponent recovers from a move. */
  punish: number;
  /** Chance of breaking a throw. */
  tech: number;
}

export const CPU_LEVELS: Record<CpuLevel, CpuTuning> = {
  easy: { reaction: 24, think: 30, block: 0.15, antiAir: 0.05, aggression: 0.25, punish: 0.1, tech: 0.05 },
  normal: { reaction: 14, think: 16, block: 0.5, antiAir: 0.4, aggression: 0.45, punish: 0.45, tech: 0.35 },
  hard: { reaction: 8, think: 8, block: 0.85, antiAir: 0.8, aggression: 0.6, punish: 0.85, tech: 0.75 },
};

/** Gap left inside each range, so the CPU doesn't swing at the very tip and whiff. */
const RANGE_MARGIN = 8;
/** How close a jumping opponent has to be before the CPU treats it as a jump-in. */
const JUMP_IN_DISTANCE = 320;

type Stance = "idle" | "forward" | "back" | "crouch";

/** How far each move reaches, measured once from the two fighters' landmark-derived boxes. */
export interface Ranges {
  attack: Record<AttackId, number>;
  throw: number;
}

export function rangesFor(self: FighterGeometry, opponent: FighterGeometry): Ranges {
  const oppBoxes = worldBoxesOf(opponent, createFighterState(0, -1, 1));
  const reach = (attack: AttackId) => {
    const active = { ...createFighterState(0, 1, 1), action: attack, actionFrame: ATTACKS[attack].startup };
    const hit = worldBoxesOf(self, active).hitbox!;
    // How far the opponent's body sticks out towards us at the hitbox's height.
    const level = oppBoxes.hurtboxes.filter((b) => b.y < hit.y + hit.height && hit.y < b.y + b.height);
    const oppFront = level.length > 0 ? -Math.min(...level.map((b) => b.x)) : 0;
    return hit.x + hit.width + (ATTACKS[attack].advance ?? 0) + oppFront - RANGE_MARGIN;
  };
  const selfBody = worldBoxesOf(self, createFighterState(0, 1, 1)).bodyBox;
  return {
    attack: { punch: reach("punch"), kick: reach("kick"), uppercut: reach("uppercut"), lowKick: reach("lowKick"), jumpKick: reach("jumpKick") },
    throw: selfBody.x + selfBody.width - oppBoxes.bodyBox.x + THROW.range - RANGE_MARGIN,
  };
}

/**
 * A computer opponent. It reads the fight like a player would: it sees the
 * opponent `reaction` frames late, and guesses (guards, anti-airs, punishes)
 * succeed with per-level odds. Output is plain InputFrames, so it plays by
 * exactly the same rules as a person.
 */
/** Startup frames of the attack an input makes (punch, kick, or with down held, uppercut / low kick). */
function startupOf(move: Partial<InputFrame>): number {
  const attack: AttackId = move.punch ? (move.down ? "uppercut" : "punch") : move.down ? "lowKick" : "kick";
  return ATTACKS[attack].startup;
}

export class CpuPlayer {
  private readonly tuning: CpuTuning;
  private readonly ranges: Ranges;
  /** Recent opponent states; the CPU acts on the one `reaction` frames old. */
  private seen: FighterState[] = [];
  /** Scripted frames to play before deciding again (jump-ins). */
  private plan: Partial<InputFrame>[] = [];
  private stance: Stance = "idle";
  private thinkLeft = 0;
  /** Frames before another attack press, so it doesn't mash. */
  private cooldown = 0;
  private lastButtons = { punch: false, kick: false };
  /** Guard / punish / anti-air rolls for recent opponent moves. */
  private rolls = new Map<string, boolean>();
  private frame = 0;

  constructor(
    level: CpuLevel,
    geometry: { self: FighterGeometry; opponent: FighterGeometry },
    private readonly random: () => number = Math.random,
  ) {
    this.tuning = CPU_LEVELS[level];
    this.ranges = rangesFor(geometry.self, geometry.opponent);
  }

  read(self: FighterState, opponent: FighterState): InputFrame {
    this.frame++;
    this.seen.push(opponent);
    if (this.seen.length > this.tuning.reaction + 1) this.seen.shift();
    if (this.cooldown > 0) this.cooldown--;
    const frame = this.decide(self, this.seen[0]);
    // A button only counts on the frame it goes down: release before pressing again.
    if (frame.punch && this.lastButtons.punch) frame.punch = false;
    if (frame.kick && this.lastButtons.kick) frame.kick = false;
    this.lastButtons = { punch: frame.punch, kick: frame.kick };
    return frame;
  }

  private decide(self: FighterState, opp: FighterState): InputFrame {
    const forward = self.facing === 1 ? "right" : "left";
    const back = self.facing === 1 ? "left" : "right";
    const distance = Math.abs(opp.position.x - self.position.x);
    const free = isGrounded(self) && (self.action === "idle" || self.action === "walk" || self.action === "block");

    if (self.action === "grabbed") {
      // Its own state isn't delayed, but reacting to the grab is.
      const at = Math.min(this.tuning.reaction, THROW.techWindow - 1);
      return self.actionFrame === at && this.random() < this.tuning.tech
        ? { ...EMPTY_INPUT, punch: true, kick: true }
        : { ...EMPTY_INPUT };
    }

    if (this.plan.length > 0) return { ...EMPTY_INPUT, ...this.plan.shift() };

    // Jump-in: uppercut it, or block it standing (crouching loses to the jump kick).
    if (!isGrounded(opp) && distance < JUMP_IN_DISTANCE && this.approaching(self, opp)) {
      const key = `air:${this.moveId(opp)}`;
      if (free && distance <= this.ranges.attack.uppercut + 40 && this.cooldown === 0 && this.roll(key + ":aa", this.tuning.antiAir)) {
        return this.attack({ down: true, punch: true });
      }
      return this.roll(key + ":block", this.tuning.block) ? { ...EMPTY_INPUT, [back]: true } : { ...EMPTY_INPUT };
    }

    // An attack it can see coming: guard the right way for it (punches pass over a crouch).
    const phase = currentAttackPhase(opp);
    if (isAttack(opp.action) && (phase === "startup" || phase === "active") && this.roll(`attack:${this.moveId(opp)}`, this.tuning.block)) {
      const level = ATTACKS[opp.action].level;
      return level === "low" || level === "high" ? { ...EMPTY_INPUT, down: true } : { ...EMPTY_INPUT, [back]: true };
    }

    // Knocked down: nothing to hit yet. Walk in, and (more often the harder it is) time an
    // attack so it's already out when they get up.
    if (isDown(opp)) {
      if (!free) return this.stanceInput(forward, back);
      const move = this.bestAttack(distance);
      const wakeLeft = this.wakeLeft(opp);
      if (move && this.cooldown === 0 && wakeLeft >= 0 && wakeLeft <= startupOf(move) && this.roll(`meaty:${this.moveId(opp)}`, this.tuning.punish)) {
        return this.attack(move);
      }
      return distance > this.ranges.attack.punch ? { ...EMPTY_INPUT, [forward]: true } : { ...EMPTY_INPUT };
    }

    // Hit or blocked: maybe keep the guard up for what comes next.
    if (self.action === "hurt" || self.action === "blockstun") {
      return this.roll(`stun:${this.frame - self.actionFrame}`, this.tuning.block) ? { ...EMPTY_INPUT, down: true } : this.stanceInput(forward, back);
    }
    if (!free) return this.stanceInput(forward, back);

    // The opponent is stuck recovering (a whiff, a blocked move, a taunt) for long enough: hit back.
    if (this.cooldown === 0 && this.recoveryLeft(opp) > ATTACKS.punch.startup) {
      const move = this.bestAttack(distance);
      if (move && this.roll(`punish:${this.moveId(opp)}`, this.tuning.punish)) return this.attack(move);
    }

    if (this.thinkLeft-- <= 0) return this.think(opp, distance, forward, back);
    return this.stanceInput(forward, back);
  }

  /** A fresh neutral decision: attack, guard, walk, wait or jump in. */
  private think(opp: FighterState, distance: number, forward: "left" | "right", back: "left" | "right"): InputFrame {
    this.thinkLeft = this.tuning.think;
    const r = this.random();
    const t = this.tuning;
    const oppCanHitUs = distance <= this.ranges.attack.kick;
    const throwable = opp.action === "block" || opp.action === "idle" || opp.action === "walk";
    const jumpIn = () => {
      this.plan = Array.from({ length: 30 }, (_, i) => ({ [forward]: true, up: i < 3, kick: i === 17 }));
      this.cooldown = 40;
      return { ...EMPTY_INPUT, ...this.plan.shift() };
    };

    if (this.cooldown === 0 && r < t.aggression) {
      if (distance <= this.ranges.throw && throwable && this.random() < (opp.action === "block" ? 0.8 : 0.3)) return this.attack({ punch: true, kick: true });
      if (opp.action === "block") {
        // Against a guard: throw it up close, jump in on a crouch, low kick a standing one.
        if (opp.crouching && distance > this.ranges.throw && distance < JUMP_IN_DISTANCE && this.random() < 0.5) return jumpIn();
        if (!opp.crouching && distance <= this.ranges.attack.lowKick) return this.attack({ down: true, kick: true });
        this.stance = "forward";
        return this.stanceInput(forward, back);
      }
      const move = this.bestAttack(distance, true);
      if (move) return this.attack(move);
      // Out of range: close in, sometimes through the air.
      if (distance < JUMP_IN_DISTANCE && this.random() < 0.25) return jumpIn();
    }
    // Guard up when it's in the opponent's reach (crouching: it stops everything but jump-ins and throws).
    if (oppCanHitUs && this.random() < t.block) this.stance = "crouch";
    else if (oppCanHitUs && this.random() < 0.3) this.stance = "back";
    else if (distance > this.ranges.attack.punch || this.random() < t.aggression) this.stance = "forward";
    else this.stance = "idle";
    return this.stanceInput(forward, back);
  }

  /** The strongest attack that reaches from here (`varied`: mixes in low kicks and kicks). */
  private bestAttack(distance: number, varied = false): Partial<InputFrame> | null {
    const { attack } = this.ranges;
    if (distance <= attack.punch) {
      if (varied && this.random() < 0.3) return { down: true, kick: true };
      return { punch: true };
    }
    if (distance <= attack.lowKick && varied && this.random() < 0.4) return { down: true, kick: true };
    if (distance <= attack.kick) return { kick: true };
    return null;
  }

  /** Frames until a knocked-down opponent is free, judging from what the CPU saw `reaction` frames ago (-1: still flying, unknown). */
  private wakeLeft(opp: FighterState): number {
    const late = this.seen.length - 1;
    if (opp.action === "downed") return KNOCKDOWN.floorFrames - opp.actionFrame + KNOCKDOWN.wakeFrames - late;
    if (opp.action === "wakeup") return KNOCKDOWN.wakeFrames - opp.actionFrame - late;
    return -1;
  }

  /** Frames the opponent is still stuck for now, judging from what the CPU saw `reaction` frames ago. */
  private recoveryLeft(opp: FighterState): number {
    const late = this.seen.length - 1;
    if (isAttack(opp.action) && currentAttackPhase(opp) === "recovery" && opp.action !== "jumpKick") {
      return attackTotalFrames(ATTACKS[opp.action]) - opp.actionFrame - late;
    }
    if (opp.action === "throw" && opp.actionFrame > THROW.startup) return THROW_TOTAL_FRAMES - opp.actionFrame - late;
    if (opp.action === "taunt") return TAUNT.frames - opp.actionFrame - late;
    return 0;
  }

  private attack(move: Partial<InputFrame>): InputFrame {
    this.cooldown = this.tuning.think;
    this.stance = "idle";
    return { ...EMPTY_INPUT, ...move };
  }

  private stanceInput(forward: "left" | "right", back: "left" | "right"): InputFrame {
    switch (this.stance) {
      case "forward": return { ...EMPTY_INPUT, [forward]: true };
      case "back": return { ...EMPTY_INPUT, [back]: true };
      case "crouch": return { ...EMPTY_INPUT, down: true };
      default: return { ...EMPTY_INPUT };
    }
  }

  /** Is the opponent coming towards us (or already on top of us)? */
  private approaching(self: FighterState, opp: FighterState): boolean {
    const towards = Math.sign(self.position.x - opp.position.x);
    return opp.velocity.x === 0 || Math.sign(opp.velocity.x) === towards;
  }

  /** Identifies one opponent move (its action and the frame it started), so each gets one roll. */
  private moveId(opp: FighterState): string {
    return `${opp.action}@${this.frame - opp.actionFrame}`;
  }

  /** One random roll per key: the same opponent move gets the same answer every frame. */
  private roll(key: string, chance: number): boolean {
    let passed = this.rolls.get(key);
    if (passed === undefined) {
      passed = this.random() < chance;
      this.rolls.set(key, passed);
      if (this.rolls.size > 16) this.rolls.delete(this.rolls.keys().next().value!);
    }
    return passed;
  }
}
