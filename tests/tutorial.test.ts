import { describe, expect, it } from "vitest";
import { DummyInputSource } from "../src/game/input/dummy-input-source";
import { rangesFor } from "../src/game/input/cpu-player";
import { STEP_GAP_FRAMES, TUTORIAL_STEPS, Tutorial, tutorialSteps, type TutorialEvent } from "../src/game/tutorial";
import { ARCHETYPE_IDS, type ArchetypeId } from "../src/shared/archetypes";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, type FightEvent, type FightState } from "../src/simulation/fight-simulation";
import { createFighterState, isGrounded, isThreatening, type FighterState } from "../src/simulation/fighter-state-machine";
import { input, type InputFrame } from "../src/simulation/input-frame";

const geo = stickFigureGeometry();
const at = { x: 0, y: 0 };
const punchHit: FightEvent = { type: "hit", attacker: 0, defender: 1, attack: "punch", blocked: false, damage: 5, at };
const step = (name: string) => TUTORIAL_STEPS.findIndex((s) => s.title === name);
const PUNCH = step("Punch the dummy");

function state(events: FightEvent[] = [], phase = "fighting", player: Partial<FighterState> = {}, dummy: Partial<FighterState> = {}): FightState {
  const fighters = [{ ...createFighterState(400, 1, 100), ...player }, { ...createFighterState(1200, -1, 100), ...dummy }];
  return { events, fighters, round: { phase } } as unknown as FightState;
}

/** A tutorial already on step `index` (and fed one frame, so it has a previous state). */
function tutorialAt(index: number): Tutorial {
  const t = new Tutorial("brawler");
  t.update(state());
  t.update(state());
  t.step = index;
  return t;
}

describe("tutorial steps", () => {
  it("covers every move on the controls screen, ending with the fighter's signature", () => {
    expect(TUTORIAL_STEPS.map((s) => s.title)).toEqual(["Walk up to the dummy", "Jump", "Punch the dummy", "Kick it", "Uppercut", "Low kick", "Now block", "Now throw"]);
    for (const archetype of ARCHETYPE_IDS) {
      const steps = tutorialSteps(archetype);
      expect(steps.slice(0, -1)).toEqual(TUTORIAL_STEPS);
      expect(steps.at(-1)!.title).toMatch(/^Your signature: /);
    }
  });

  it("waits for the fight to start, then opens with walking", () => {
    const t = new Tutorial("brawler");
    expect(t.update(state([], "intro"))).toEqual([]);
    expect(t.current).toBeNull();
    expect(t.update(state())).toEqual([{ type: "step", index: 0 }]);
  });

  it("counts only what the step asks for", () => {
    const t = tutorialAt(PUNCH);
    t.update(state([{ ...punchHit, blocked: true }, { ...punchHit, attack: "kick" }, { ...punchHit, attacker: 1, defender: 0 }]));
    expect(t.count).toBe(0);
    expect(t.update(state([punchHit]))).toEqual([{ type: "progress", index: PUNCH, count: 1 }]);
  });

  it("clears a step at its goal, pauses, then moves on; finishes after the last", () => {
    const last = tutorialSteps("brawler").length - 1;
    const t = tutorialAt(last);
    const charged: FightEvent = { ...punchHit, attack: "charge" };
    t.update(state([charged]));
    expect(t.update(state([charged]))).toContainEqual({ type: "cleared", index: last });
    // Extra successes during the pause don't count.
    expect(t.update(state([charged]))).toEqual([]);
    const rest = Array.from({ length: STEP_GAP_FRAMES }, () => t.update(state())).flat();
    expect(rest).toEqual([{ type: "finished" }]);
    expect(t.current).toBeNull();
  });

  it("holds still while the round resets", () => {
    const t = tutorialAt(PUNCH);
    t.update(state([punchHit]));
    expect(t.update(state([punchHit], "intro"))).toEqual([]);
    expect(t.count).toBe(1);
  });

  it("nudges when the drilled move ends without landing", () => {
    const t = tutorialAt(PUNCH);
    expect(t.update(state([], "fighting", { action: "punch" }))).toEqual([]);
    expect(t.update(state([], "fighting", { action: "idle" }))).toEqual([{ type: "nudge", kind: "tooFar" }]);
    // One that lands doesn't.
    t.update(state([], "fighting", { action: "punch" }));
    t.update(state([punchHit], "fighting", { action: "punch" }));
    expect(t.update(state([], "fighting", { action: "idle" }))).toEqual([]);
  });

  it("doesn't call it too far when the dummy couldn't be hit (knocked down)", () => {
    const t = tutorialAt(step("Now throw"));
    t.update(state([], "fighting", { action: "throw" }, { action: "downed" }));
    expect(t.update(state([], "fighting", { action: "idle" }))).toEqual([]);
  });

  it("says a throw from too far came out as a taunt", () => {
    const t = tutorialAt(step("Now throw"));
    expect(t.update(state([{ type: "taunt", player: 0 }]))).toEqual([{ type: "nudge", kind: "taunted" }]);
  });

  it("the throw drill doesn't count a bear hug, and the grappler's drill counts only that", () => {
    const thrown = (grab: "throw" | "bearHug"): FightEvent => ({ type: "throw", attacker: 0, defender: 1, grab, damage: 10 });
    const t = tutorialAt(step("Now throw"));
    t.update(state([thrown("bearHug")]));
    expect(t.count).toBe(0);
    const g = new Tutorial("grappler");
    g.update(state());
    g.update(state());
    g.step = g.steps.length - 1;
    g.update(state([thrown("throw")]));
    expect(g.count).toBe(0);
    g.update(state([thrown("bearHug")]));
    expect(g.count).toBe(1);
  });
});

describe("tutorial drill in the simulation", () => {
  /** Plays P1 (of this archetype) the way each prompt says; returns the tutorial events and how long the drill took. */
  function playThrough(archetype: ArchetypeId) {
    const me = stickFigureGeometry(archetype);
    const sim = new FightSimulation([me, geo], { practice: true, seed: 5 });
    const dummy = new DummyInputSource(sim, 1);
    const tutorial = new Tutorial(archetype);
    const ranges = rangesFor(me, geo);
    const signature = { down: true, punch: true, kick: true };
    const events: TutorialEvent[] = [];
    let fightingFrames = 0;
    let wait = 0;
    const player = (s: FightState): InputFrame => {
      const [me, them] = s.fighters;
      const distance = Math.abs(them.position.x - me.position.x);
      const forward = me.facing === 1 ? { right: true } : { left: true };
      const back = me.facing === 1 ? { left: true } : { right: true };
      if (wait > 0) return wait--, input();
      if (!isGrounded(me) || me.action !== "idle" && me.action !== "walk" && me.action !== "block") return input();
      /** Walk to `reach`, then press `press` and wait for the move to finish. */
      const attack = (reach: number, press: Partial<InputFrame>) => (distance > reach ? input(forward) : ((wait = 30), input(press)));
      switch (tutorial.current?.title) {
        case "Walk up to the dummy": return input(forward);
        case "Jump": return (wait = 50), input({ up: true });
        case "Punch the dummy": return attack(150, { punch: true });
        case "Kick it": return attack(150, { kick: true });
        case "Uppercut": return attack(120, { down: true, punch: true });
        case "Low kick": return attack(150, { down: true, kick: true });
        case "Now block": return isThreatening(them) ? input(back) : input();
        case "Now throw": return attack(ranges.throw, { punch: true, kick: true });
        default:
          if (!tutorial.current?.title.startsWith("Your signature")) return input();
          // The parry goes up as the dummy's punch starts; the others are walked into range.
          if (archetype === "guardian") return them.action === "punch" && them.actionFrame === 0 ? ((wait = 30), input(signature)) : input();
          return attack(ranges.signature, signature);
      }
    };
    for (let f = 0; f < 180 * 60 && !tutorial.finished; f++) {
      const s = sim.step([player(sim.current), dummy.read()]);
      if (s.round.phase === "fighting") fightingFrames++;
      for (const ev of tutorial.update(s)) {
        events.push(ev);
        if (ev.type === "step") dummy.setBehavior(tutorial.steps[ev.index].dummy);
      }
    }
    return { tutorial, events, seconds: fightingFrames / 60 };
  }

  it.each(ARCHETYPE_IDS)("a %s following the prompts gets through every step, with no false nudges", (archetype) => {
    const { tutorial, events, seconds } = playThrough(archetype);
    expect(tutorial.finished).toBe(true);
    expect(events.filter((e) => e.type === "cleared").map((e) => e.type === "cleared" && e.index)).toEqual(tutorial.steps.map((_, i) => i));
    expect(events.filter((e) => e.type === "nudge")).toEqual([]);
    // Perfect play is well under a minute; a new player takes a few tries per step.
    expect(seconds).toBeLessThan(45);
  });

  it("the blocking drill's dummy walks in and swings", () => {
    const sim = new FightSimulation([geo, geo], { practice: true, seed: 5 });
    const dummy = new DummyInputSource(sim, 1);
    dummy.setBehavior("pressure");
    let swung = false;
    for (let f = 0; f < 600 && !swung; f++) {
      swung = sim.step([input(), dummy.read()]).events.some((e) => e.type === "hit" && e.attacker === 1);
    }
    expect(swung).toBe(true);
  });
});
