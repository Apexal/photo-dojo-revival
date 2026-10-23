import { ARCHETYPES, type ArchetypeId } from "../shared/archetypes";
import type { AttackId, GrabId } from "../shared/frame-data";
import type { FightEvent, FightState } from "../simulation/fight-simulation";
import { isGrounded, isThrowable } from "../simulation/fighter-state-machine";
import type { ButtonLabels } from "./input/control-labels";
import type { DummyBehavior } from "./input/dummy-input-source";

/** One drill of the tutorial. The player is always P1 (index 0), the dummy P2. */
export interface TutorialStep {
  /** The instruction, shown big. */
  title: string;
  /** How to do it, with the player's own buttons. */
  how: (b: ButtonLabels) => string;
  /** What the dummy does meanwhile. */
  dummy: DummyBehavior;
  /** How many times to do it. */
  goal: number;
  /** How many times the player did it on this frame (`state` is after the step, `prev` before). */
  progress: (state: FightState, prev: FightState) => number;
  /** The move being drilled: an attempt at it that ends without progress was out of reach. */
  move?: AttackId | GrabId;
}

/** Landed (unblocked) hits by the player with this attack this frame. */
const landed = (attack: AttackId) => (state: FightState) =>
  state.events.filter((ev) => ev.type === "hit" && ev.attacker === 0 && ev.attack === attack && !ev.blocked).length;

const count = (state: FightState, match: (ev: FightEvent) => boolean) => state.events.filter(match).length;

/** Walking in from the start: done once the player is this close to the dummy. */
export const WALK_GOAL_DISTANCE = 450;

/** The shared drills, in the order of the controls screen, give or take: each uses what the last one taught. */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: "Walk up to the dummy",
    how: (b) => `Hold ${b.forward} to walk forward (${b.back} walks back)`,
    dummy: "stand",
    goal: 1,
    progress: (s, prev) => {
      const gap = (f: FightState) => Math.abs(f.fighters[1].position.x - f.fighters[0].position.x);
      return gap(s) <= WALK_GOAL_DISTANCE && gap(prev) > WALK_GOAL_DISTANCE ? 1 : 0;
    },
  },
  {
    title: "Jump",
    how: (b) => `Press ${b.up}`,
    dummy: "stand",
    goal: 2,
    progress: (s, prev) => (isGrounded(prev.fighters[0]) && !isGrounded(s.fighters[0]) ? 1 : 0),
  },
  { title: "Punch the dummy", how: (b) => `Press ${b.punch}: quick, short reach`, dummy: "stand", goal: 3, progress: landed("punch"), move: "punch" },
  { title: "Kick it", how: (b) => `Press ${b.kick}: slower, but reaches further`, dummy: "stand", goal: 2, progress: landed("kick"), move: "kick" },
  { title: "Uppercut", how: (b) => `Hold ${b.down} and press ${b.punch}: knocks jumpers down`, dummy: "stand", goal: 2, progress: landed("uppercut"), move: "uppercut" },
  { title: "Low kick", how: (b) => `Hold ${b.down} and press ${b.kick}: must be blocked crouching`, dummy: "stand", goal: 2, progress: landed("lowKick"), move: "lowKick" },
  {
    title: "Now block",
    how: (b) => `Hold ${b.back} when it punches`,
    dummy: "pressure",
    goal: 3,
    progress: (s) => count(s, (ev) => ev.type === "hit" && ev.defender === 0 && ev.blocked),
  },
  {
    title: "Now throw",
    how: (b) => `Walk right up to it, then press ${b.punch} + ${b.kick} together`,
    dummy: "stand",
    goal: 2,
    progress: (s) => count(s, (ev) => ev.type === "throw" && ev.attacker === 0 && ev.grab === "throw"),
    move: "throw",
  },
];

const signature = (b: ButtonLabels) => `hold ${b.down}, press ${b.punch} + ${b.kick}`;

/** The last drill: the archetype's signature move. */
const SIGNATURE_STEPS: Record<ArchetypeId, TutorialStep> = {
  brawler: {
    title: `Your signature: ${ARCHETYPES.brawler.moveName}`,
    how: (b) => `From across the stage, ${signature(b)}`,
    dummy: "stand", goal: 2, progress: landed("charge"), move: "charge",
  },
  grappler: {
    title: `Your signature: ${ARCHETYPES.grappler.moveName}`,
    how: (b) => `A step outside throw range, ${signature(b)}: it can't be broken`,
    dummy: "block", goal: 2,
    progress: (s) => count(s, (ev) => ev.type === "throw" && ev.attacker === 0 && ev.grab === "bearHug"),
    move: "bearHug",
  },
  guardian: {
    title: `Your signature: ${ARCHETYPES.guardian.moveName}`,
    how: (b) => `Just before its punch lands, ${signature(b)}`,
    dummy: "pressure", goal: 2,
    progress: (s) => count(s, (ev) => ev.type === "parry" && ev.player === 0),
  },
  acrobat: {
    title: `Your signature: ${ARCHETYPES.acrobat.moveName}`,
    how: (b) => `It's crouching: ${signature(b)} to hit it over its guard`,
    dummy: "crouch", goal: 2, progress: landed("flyingKnee"), move: "flyingKnee",
  },
};

/** Every drill for a fighter: the shared ones, then their signature move. */
export function tutorialSteps(archetype: ArchetypeId): readonly TutorialStep[] {
  return [...TUTORIAL_STEPS, SIGNATURE_STEPS[archetype]];
}

/** What a nudge says: the attempt didn't reach, or punch + kick from afar taunted instead of throwing. */
export type NudgeKind = "tooFar" | "taunted";

export const NUDGES: Record<NudgeKind, string> = {
  tooFar: "Too far: get closer!",
  taunted: "That's a taunt: get right up close first!",
};

/** Frames between finishing a step and the next one starting (the "Nice!" moment). */
export const STEP_GAP_FRAMES = 60;

export type TutorialEvent =
  | { type: "step"; index: number }
  | { type: "progress"; index: number; count: number }
  | { type: "cleared"; index: number }
  | { type: "nudge"; kind: NudgeKind }
  | { type: "finished" };

/**
 * The guided drill: fed every stepped FightState, it counts the player's
 * successes and says when to move on, or that an attempt was out of reach.
 * Runs only while the round is "fighting" (not during the intro or a reset). Pure.
 */
export class Tutorial {
  readonly steps: readonly TutorialStep[];
  /** Index into steps; -1 before the first starts. */
  step = -1;
  count = 0;
  finished = false;
  private gapLeft = 0;
  private prev: FightState | null = null;
  /**
   * The player is doing the drilled move: whether it has scored yet, and whether
   * the dummy could be hit when it started (standing in neutral, not down or reeling).
   */
  private attempt: { scored: boolean; fair: boolean } | null = null;

  /** `archetype`: the player's (P1), for the signature drill. */
  constructor(archetype: ArchetypeId) {
    this.steps = tutorialSteps(archetype);
  }

  /** The step being drilled (also during the gap after clearing it), or null before the first and after the last. */
  get current(): TutorialStep | null {
    return this.finished ? null : this.steps[this.step] ?? null;
  }

  update(state: FightState): TutorialEvent[] {
    const prev = this.prev;
    this.prev = state;
    if (this.finished || state.round.phase !== "fighting" || !prev) return [];
    if (this.gapLeft > 0) return --this.gapLeft > 0 ? [] : this.advance();
    if (this.step < 0) return this.advance();
    const step = this.steps[this.step];
    const out: TutorialEvent[] = [];
    const done = step.progress(state, prev);
    if (this.attempt && done > 0) this.attempt.scored = true;
    out.push(...this.checkAttempt(step, state, prev));
    for (let i = 0; i < done; i++) {
      this.count++;
      out.push({ type: "progress", index: this.step, count: this.count });
      if (this.count >= step.goal) {
        this.gapLeft = STEP_GAP_FRAMES;
        this.attempt = null;
        out.push({ type: "cleared", index: this.step });
        break;
      }
    }
    return out;
  }

  /** Nudge when the drilled move ends without scoring, or a throw attempt came out as a taunt. */
  private checkAttempt(step: TutorialStep, state: FightState, prev: FightState): TutorialEvent[] {
    if (!step.move) return [];
    const now = state.fighters[0].action, before = prev.fighters[0].action;
    if (step.move === "throw" && state.events.some((ev) => ev.type === "taunt" && ev.player === 0)) return [{ type: "nudge", kind: "taunted" }];
    if (now === step.move && before !== step.move) this.attempt = { scored: false, fair: isThrowable(state.fighters[1]) };
    if (this.attempt && now !== step.move) {
      const { scored, fair } = this.attempt;
      this.attempt = null;
      // Swinging at a dummy that's down, or getting hit mid-move, isn't being out of reach.
      if (!scored && fair && now !== "hurt") return [{ type: "nudge", kind: "tooFar" }];
    }
    return [];
  }

  private advance(): TutorialEvent[] {
    this.count = 0;
    this.attempt = null;
    if (++this.step >= this.steps.length) {
      this.finished = true;
      return [{ type: "finished" }];
    }
    return [{ type: "step", index: this.step }];
  }
}
