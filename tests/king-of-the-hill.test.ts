import { describe, expect, it } from "vitest";
import { KingOfTheHill } from "../src/game/king-of-the-hill";

describe("king of the hill", () => {
  it("keeps the winner on their side and brings in the next challenger", () => {
    const k = new KingOfTheHill(["a", "b", "c", "d"]);
    expect(k.sides).toEqual([0, 1]);
    expect(k.king).toBeNull();
    k.record(1); // b beats a
    expect(k.king).toBe(1);
    expect(k.kingSide).toBe(1);
    expect(k.streak).toBe(1);
    expect(k.sides).toEqual([2, 1]); // c steps in on a's side
    expect(k.queue).toEqual([3, 0]);
  });

  it("dethrones: the new king's streak starts at one", () => {
    const k = new KingOfTheHill(["a", "b", "c", "d"]);
    k.record(0); // a beats b
    k.record(0); // a beats c
    expect(k.streak).toBe(2);
    k.record(1); // d beats a
    expect(k.king).toBe(3);
    expect(k.streak).toBe(1);
    expect(k.best).toEqual({ entrant: 0, streak: 2 });
    expect(k.wins).toEqual([2, 0, 0, 1]);
    expect(k.sides).toEqual([1, 3]); // b, back from the queue
  });

  it("ends when the king has beaten everyone in a row", () => {
    const k = new KingOfTheHill(["a", "b", "c"]);
    k.record(0);
    expect(k.champion).toBeNull();
    k.record(0);
    expect(k.champion).toBe("a");
    expect(k.streak).toBe(2);
    expect(() => k.record(0)).toThrow();
  });

  it("goes on past the queue's first lap", () => {
    const k = new KingOfTheHill(["a", "b", "c"]);
    for (let i = 0; i < 6; i++) k.record((i % 2) as 0 | 1); // a new king every time
    expect(k.champion).toBeNull();
    expect(k.streak).toBe(1);
    expect(new Set([...k.sides, ...k.queue])).toEqual(new Set([0, 1, 2]));
  });

  it("needs two entrants", () => {
    expect(() => new KingOfTheHill(["a"])).toThrow();
  });
});
