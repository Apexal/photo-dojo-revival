import { describe, expect, it } from "vitest";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, type FightState } from "../src/simulation/fight-simulation";
import { input, type InputFrame } from "../src/simulation/input-frame";
import { MatchStatsTracker, accuracy } from "../src/simulation/match-stats";
import { MAX_HEALTH, ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const geo = stickFigureGeometry();
const idle = input();

/** A sim and a tracker fed every step, fighters `gap` px apart. */
function tracked(gap = 150) {
  const sim = new FightSimulation([geo, geo], { startPositions: [640 - gap / 2, 640 + gap / 2] });
  const stats = new MatchStatsTracker();
  const step = (p1: InputFrame = idle, p2: InputFrame = idle): FightState => {
    const state = sim.step([p1, p2]);
    stats.record(state);
    return state;
  };
  for (let i = 0; i < ROUND_INTRO_FRAMES; i++) step();
  return { sim, stats, step };
}

/** Tap punch once and let it play out (plus recovery time). */
function punch(step: (p1?: InputFrame, p2?: InputFrame) => FightState, frames = 40, p2: InputFrame = idle) {
  step(input({ punch: true }), p2);
  for (let i = 0; i < frames; i++) step(idle, p2);
}

describe("MatchStatsTracker", () => {
  it("counts attacks, clean hits, damage and the favorite move", () => {
    const { sim, stats, step } = tracked();
    punch(step);
    const s = stats.result.players[0];
    expect(s.attacks).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.damageDealt).toBe(MAX_HEALTH - sim.current.fighters[1].health);
    expect(s.damageDealt).toBeGreaterThan(0);
    expect(s.favoriteMove).toBe("punch");
    expect(s.movesLanded).toEqual({ punch: 1 });
    expect(accuracy(s)).toBe(1);
    expect(stats.result.players[1].hits).toBe(0);
  });

  it("counts a whiff as an attack, not a hit", () => {
    const { stats, step } = tracked(900);
    punch(step);
    const s = stats.result.players[0];
    expect(s.attacks).toBe(1);
    expect(s.hits).toBe(0);
    expect(accuracy(s)).toBe(0);
  });

  it("credits blocks to the defender and doesn't count them as hits", () => {
    const { stats, step } = tracked();
    // P2 holds back (right, away from P1) to block.
    punch(step, 40, input({ right: true }));
    const [p1, p2] = stats.result.players;
    expect(p1.blockedByOpponent).toBe(1);
    expect(p1.hits).toBe(0);
    expect(p2.blocks).toBe(1);
  });

  it("separate hits after the opponent recovers are combos of one", () => {
    const { stats, step } = tracked();
    punch(step, 60);
    punch(step, 60);
    expect(stats.result.players[0].hits).toBe(2);
    expect(stats.result.players[0].longestCombo).toBe(1);
  });

  it("records a round: winner, reason, health left, perfect round", () => {
    const { sim, stats, step } = tracked();
    // Hit until the round ends.
    for (let i = 0; i < 400 && sim.current.round.phase === "fighting"; i++) punch(step, 30);
    for (let i = 0; i < 400 && !stats.result.rounds.length; i++) step();
    const { rounds, players, frames } = stats.result;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, outcome: 0, reason: "ko" });
    expect(rounds[0].health[1]).toBe(0);
    expect(players[0].roundsWon).toBe(1);
    expect(players[0].perfectRounds).toBe(1); // P2 never fought back
    expect(players[0].damageDealt).toBe(MAX_HEALTH);
    expect(frames).toBeGreaterThan(0);
    expect(rounds[0].frames).toBe(frames);
  });

  it("counts hits that land while the opponent is still reeling as one combo", () => {
    const { sim } = tracked();
    const stats = new MatchStatsTracker();
    const base = sim.current;
    const at = (defenderAction: string, events: FightState["events"] = []): FightState => ({
      ...base,
      events,
      fighters: [base.fighters[0], { ...base.fighters[1], action: defenderAction as FightState["fighters"][1]["action"] }],
    });
    const hit = { type: "hit", attacker: 0, defender: 1, attack: "punch", blocked: false, damage: 5, at: { x: 0, y: 0 } } as const;
    stats.record(at("hurt", [hit])); // 1
    stats.record(at("hurt"));
    stats.record(at("hurt", [hit])); // 2: still reeling
    stats.record(at("hurt", [{ ...hit, attack: "kick" }])); // 3
    stats.record(at("idle")); // recovered: the combo's over
    stats.record(at("hurt", [hit])); // a new one
    expect(stats.result.players[0].longestCombo).toBe(3);
    expect(stats.result.players[0].hits).toBe(4);
    expect(stats.result.players[0].favoriteMove).toBe("punch");
  });
});
