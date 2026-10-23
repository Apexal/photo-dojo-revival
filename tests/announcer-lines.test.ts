import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANNOUNCER_LINE_IDS, calloutLine, matchWinnerLine, roundEndLine, roundStartLine, stageLine, tournamentRoundLine } from "../src/game/announcer-lines";

describe("announcer lines", () => {
  it("has a file for every line", () => {
    const missing = ANNOUNCER_LINE_IDS.filter((id) => !existsSync(join(import.meta.dirname, "..", "public", "announcer", `${id}.mp3`)));
    expect(missing).toEqual([]);
  });

  it("calls the round, or the final round when either fighter can win the match with it", () => {
    expect(roundStartLine(1, [0, 0])).toBe("round-1");
    expect(roundStartLine(2, [1, 0])).toBe("round-2");
    expect(roundStartLine(3, [1, 1])).toBe("final-round");
    // A drawn round doesn't count: round three after a draw isn't necessarily the last.
    expect(roundStartLine(3, [1, 0])).toBe("round-3");
    expect(roundStartLine(5, [0, 0])).toBe("final-round");
  });

  it("tells a K.O. from a double K.O. and a timeout", () => {
    expect(roundEndLine(0, "ko")).toBe("ko");
    expect(roundEndLine("draw", "ko")).toBe("double-ko");
    expect(roundEndLine(1, "timeout")).toBe("time");
    expect(roundEndLine("draw", "timeout")).toBe("time");
  });

  it("names the match winner", () => {
    expect(matchWinnerLine(0)).toBe("p1-wins");
    expect(matchWinnerLine(1)).toBe("p2-wins");
    expect(matchWinnerLine("draw")).toBe("draw-game");
    // Against the CPU: from the player's side.
    expect(matchWinnerLine(0, 1)).toBe("you-win");
    expect(matchWinnerLine(1, 1)).toBe("you-lose");
    expect(matchWinnerLine("draw", 1)).toBe("draw-game");
  });

  it("calls hit streaks from three hits, and a long one once", () => {
    const streak = (hits: number) => calloutLine({ type: "streak", player: 0, hits });
    expect(streak(2)).toBeNull();
    expect([3, 4, 5].map(streak)).toEqual(["streak-3", "streak-4", "streak-5"]);
    expect(streak(6)).toBe("streak-huge");
    expect(streak(7)).toBeNull();
    expect(calloutLine({ type: "firstBlood", player: 1 })).toBe("first-blood");
    expect(calloutLine({ type: "perfect", player: 1 })).toBe("perfect");
  });

  it("names stages that have a line, and tournament rounds", () => {
    expect(stageLine("lunar-dojo")).toBe("stage-lunar-dojo");
    expect(stageLine("nowhere")).toBeNull();
    expect(tournamentRoundLine("Final")).toBe("final-match");
    expect(tournamentRoundLine("Semifinals")).toBe("semifinals");
    expect(tournamentRoundLine("Round 1")).toBe("next-match");
  });
});
