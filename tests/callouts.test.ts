import { describe, expect, it } from "vitest";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { CalloutTracker, calloutText, type Callout } from "../src/simulation/callouts";
import { FightSimulation, type FightState } from "../src/simulation/fight-simulation";
import { input, type InputFrame } from "../src/simulation/input-frame";
import { MAX_HEALTH, ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const geo = stickFigureGeometry();
const idle = input();

/** A sim and a tracker fed every step, fighters `gap` px apart; `seen` collects every callout. */
function tracked(options = { match: true }, gap = 150) {
  const sim = new FightSimulation([geo, geo], { startPositions: [640 - gap / 2, 640 + gap / 2] });
  const callouts = new CalloutTracker(options);
  const seen: Callout[] = [];
  const step = (p1: InputFrame = idle, p2: InputFrame = idle): FightState => {
    const state = sim.step([p1, p2]);
    seen.push(...callouts.record(state));
    return state;
  };
  seen.push(...callouts.record(sim.current));
  for (let i = 0; i < ROUND_INTRO_FRAMES; i++) step();
  return { sim, callouts, seen, step };
}

function punch(step: (p1?: InputFrame, p2?: InputFrame) => FightState, frames = 40, p2: InputFrame = idle) {
  step(input({ punch: true }), p2);
  for (let i = 0; i < frames; i++) step(idle, p2);
}

describe("CalloutTracker", () => {
  it("calls a refused handshake, in practice too", () => {
    const sim = new FightSimulation([geo, geo], { practice: true });
    const callouts = new CalloutTracker({ match: false });
    const seen: Callout[] = [];
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) seen.push(...callouts.record(sim.step([input({ left: true }), idle])));
    expect(seen).toEqual([{ type: "snub", player: 0 }]);
    expect(calloutText(seen[0])).toBe("NO HANDSHAKE");
  });

  it("calls the round's first clean hit, once", () => {
    const { seen, step } = tracked();
    punch(step, 60);
    punch(step, 60);
    expect(seen.filter((c) => c.type !== "streak")).toEqual([{ type: "firstBlood", player: 0 }]);
  });

  it("doesn't call a blocked hit first blood", () => {
    const { seen, step } = tracked();
    punch(step, 40, input({ right: true }));
    expect(seen).toEqual([]);
  });

  it("calls PERFECT as an untouched winner takes the round, and first blood again next round", () => {
    const { sim, callouts, seen, step } = tracked();
    for (let i = 0; i < 400 && sim.current.round.phase === "fighting"; i++) punch(step, 30);
    expect(seen.filter((c) => c.type !== "streak")).toEqual([{ type: "firstBlood", player: 0 }, { type: "perfect", player: 0 }]);
    for (let i = 0; i < 400 && sim.current.round.phase !== "roundOver"; i++) step();
    sim.startNextRound();
    seen.length = 0;
    seen.push(...callouts.record(sim.current)); // its roundStart
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) step();
    punch(step, 60);
    expect(seen.filter((c) => c.type === "firstBlood")).toHaveLength(1);
  });

  it("doesn't call PERFECT for a winner who took damage", () => {
    const { sim, seen, step } = tracked();
    punch(step, 60);
    // P2 lands one back, then P1 finishes the round.
    step(idle, input({ punch: true }));
    for (let i = 0; i < 60; i++) step();
    expect(sim.current.fighters[0].health).toBeLessThan(MAX_HEALTH);
    for (let i = 0; i < 400 && sim.current.round.phase === "fighting"; i++) punch(step, 30);
    expect(sim.current.round.roundWinner).toBe(0);
    expect(seen.some((c) => c.type === "perfect")).toBe(false);
  });

  it("calls hit streaks from 2 hits up, until the opponent lands one back", () => {
    const { sim } = tracked();
    const callouts = new CalloutTracker({ match: false });
    const base = sim.current;
    const at = (events: FightState["events"] = []): FightState => ({ ...base, events });
    const hit = { type: "hit", attacker: 0, defender: 1, attack: "punch", blocked: false, damage: 5, at: { x: 0, y: 0 } } as const;
    expect(callouts.record(at([hit]))).toEqual([]); // 1, and no first blood in practice
    callouts.record(at());
    expect(callouts.record(at([hit]))).toEqual([{ type: "streak", player: 0, hits: 2 }]);
    expect(callouts.record(at([hit]))).toEqual([{ type: "streak", player: 0, hits: 3 }]);
    callouts.record(at([{ ...hit, attacker: 1, defender: 0 }])); // P2 hits back
    expect(callouts.record(at([hit]))).toEqual([]);
  });

  it("calls nothing but hit streaks in practice", () => {
    const { seen, step } = tracked({ match: false });
    punch(step, 60);
    punch(step, 60);
    expect(seen).toEqual([{ type: "streak", player: 0, hits: 2 }]);
  });

  it("words them for the screen", () => {
    expect(calloutText({ type: "firstBlood", player: 0 })).toBe("FIRST BLOOD");
    expect(calloutText({ type: "streak", player: 1, hits: 3 })).toBe("3 HIT STREAK");
    expect(calloutText({ type: "perfect", player: 1 })).toBe("PERFECT");
  });
});
