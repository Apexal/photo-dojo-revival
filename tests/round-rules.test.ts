import { describe, expect, it } from "vitest";
import {
  MAX_HEALTH,
  MAX_ROUNDS,
  ROUND_FRAMES,
  ROUND_INTRO_FRAMES,
  ROUND_OUTRO_FRAMES,
  createMatch,
  judgeRound,
  matchWinnerFor,
  nextRoundStakes,
  secondsRemaining,
  startNextRound,
  tickRound,
  type RoundState,
} from "../src/simulation/round-rules";

const full: [number, number] = [MAX_HEALTH, MAX_HEALTH];

function tick(state: RoundState, frames: number, health: [number, number] = full): RoundState {
  for (let i = 0; i < frames; i++) state = tickRound(state, health);
  return state;
}

function toFighting(state = createMatch()): RoundState {
  return tick(state, ROUND_INTRO_FRAMES);
}

describe("round rules", () => {
  it("starts with a 60-second clock after the intro", () => {
    const s = toFighting();
    expect(s.phase).toBe("fighting");
    expect(s.framesRemaining).toBe(ROUND_FRAMES);
    expect(secondsRemaining(s)).toBe(60);
    expect(secondsRemaining(tick(s, 1))).toBe(60);
    expect(secondsRemaining(tick(s, 60))).toBe(59);
  });

  it("does not tick the clock during the intro", () => {
    expect(tick(createMatch(), ROUND_INTRO_FRAMES - 1).framesRemaining).toBe(ROUND_FRAMES);
  });

  it("timer expiry awards the round to the healthier fighter", () => {
    const s = tick(toFighting(), ROUND_FRAMES, [40, 70]);
    expect(s.phase).toBe("outro");
    expect(s.roundWinner).toBe(1);
    expect(s.roundEndReason).toBe("timeout");
    expect(s.wins).toEqual([0, 1]);
  });

  it("timer expiry at equal health is a draw and awards nothing", () => {
    const s = tick(toFighting(), ROUND_FRAMES, [50, 50]);
    expect(s.roundWinner).toBe("draw");
    expect(s.wins).toEqual([0, 0]);
  });

  it("KO ends the round immediately", () => {
    const s = tick(toFighting(), 1, [0, 30]);
    expect(s.phase).toBe("outro");
    expect(s.roundWinner).toBe(1);
    expect(s.roundEndReason).toBe("ko");
    expect(s.framesRemaining).toBe(ROUND_FRAMES - 1);
  });

  it("double KO is a draw", () => {
    expect(judgeRound([0, 0], 100)).toEqual({ outcome: "draw", reason: "ko" });
  });

  it("outro leads to roundOver, then the next round resets the clock", () => {
    let s = tick(toFighting(), 1, [100, 0]);
    s = tick(s, ROUND_OUTRO_FRAMES);
    expect(s.phase).toBe("roundOver");
    expect(s.matchWinner).toBeNull();
    s = startNextRound(s);
    expect(s).toMatchObject({ roundNumber: 2, phase: "intro", framesRemaining: ROUND_FRAMES, roundWinner: null, wins: [1, 0] });
  });

  it("best of 3: first to two round wins takes the match", () => {
    let s = createMatch();
    const playRound = (health: [number, number]) => {
      s = toFighting(s);
      s = tick(s, 1, health);
      s = tick(s, ROUND_OUTRO_FRAMES);
    };
    playRound([100, 0]);
    expect(s.phase).toBe("roundOver");
    s = startNextRound(s);
    playRound([0, 100]);
    expect(s.phase).toBe("roundOver");
    expect(s.wins).toEqual([1, 1]);
    s = startNextRound(s);
    playRound([10, 0]);
    expect(s.phase).toBe("matchOver");
    expect(s.matchWinner).toBe(0);
    expect(s.roundNumber).toBe(3);
    expect(startNextRound(s)).toBe(s);
  });

  it("2-0 ends the match after two rounds", () => {
    expect(matchWinnerFor([2, 0], 2)).toBe(0);
    expect(matchWinnerFor([1, 0], 2)).toBeNull();
  });

  it("draws are capped at MAX_ROUNDS", () => {
    expect(matchWinnerFor([0, 0], MAX_ROUNDS)).toBe("draw");
    expect(matchWinnerFor([1, 0], MAX_ROUNDS)).toBe(0);
    expect(matchWinnerFor([0, 0], MAX_ROUNDS - 1)).toBeNull();
  });

  it("never mutates the input state", () => {
    const s = toFighting();
    const copy = structuredClone(s);
    tickRound(s, [0, 100]);
    expect(s).toEqual(copy);
  });
});

describe("nextRoundStakes", () => {
  it("is match point for a player a round from the match, the final round when both are or the cap is next", () => {
    expect(nextRoundStakes(1, [1, 0])).toEqual({ kind: "matchPoint", player: 0 });
    expect(nextRoundStakes(1, [0, 1])).toEqual({ kind: "matchPoint", player: 1 });
    expect(nextRoundStakes(2, [1, 1])).toEqual({ kind: "final" });
    expect(nextRoundStakes(1, [0, 0])).toEqual({ kind: "next", round: 2 }); // a draw
    expect(nextRoundStakes(MAX_ROUNDS - 1, [0, 0])).toEqual({ kind: "final" });
  });
});
