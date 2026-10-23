import { describe, expect, it } from "vitest";
import { Tournament, seedOrder } from "../src/game/tournament";

/** Play every match, the lower entrant index always winning; returns the matches in play order. */
function playOut<T>(t: Tournament<T>): [number, number][] {
  const played: [number, number][] = [];
  for (let next = t.next; next; next = t.next) {
    played.push([next.a, next.b]);
    t.record(next.a < next.b ? 0 : 1);
  }
  return played;
}

describe("tournament", () => {
  it("seeds so the top two can only meet in the final", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("plays a four-fighter bracket round by round", () => {
    const t = new Tournament(["a", "b", "c", "d"]);
    expect(t.rounds.map((r) => r.length)).toEqual([2, 1]);
    expect(t.roundName(0)).toBe("Semifinals");
    expect(t.roundName(1)).toBe("Final");
    expect(playOut(t)).toEqual([[0, 3], [1, 2], [0, 1]]);
    expect(t.champion).toBe("a");
    expect(t.next).toBeNull();
  });

  it("gives byes to the top seeds and skips them", () => {
    const t = new Tournament(["a", "b", "c", "d", "e"]);
    expect(t.rounds.map((r) => r.length)).toEqual([4, 2, 1]);
    // Seeds 1, 2 and 3 have byes; only 4 v 5 is played in the first round.
    expect([0, 1, 2, 3].filter((i) => t.isBye(0, i))).toHaveLength(3);
    expect(t.rounds[1][0].a).toBe(0);
    expect(t.next).toEqual({ round: 0, index: 1, a: 3, b: 4 });
    expect(playOut(t)).toEqual([[3, 4], [0, 3], [1, 2], [0, 1]]);
    expect(t.champion).toBe("a");
  });

  it("lets the lower half win too", () => {
    const t = new Tournament(["a", "b", "c"]);
    t.record(1); // b v c: c wins
    t.record(1); // a v c: c wins
    expect(t.champion).toBe("c");
    expect(() => t.record(0)).toThrow();
  });

  it("needs two entrants", () => {
    expect(() => new Tournament(["a"])).toThrow();
    expect(playOut(new Tournament(["a", "b"]))).toEqual([[0, 1]]);
  });
});
