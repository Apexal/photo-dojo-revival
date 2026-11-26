import { describe, expect, it } from "vitest";
import { controlLabels } from "../src/game/input/control-labels";
import { TIP_MATCHES, showsTips, tipFor } from "../src/game/fight-tips";
import type { FightEvent } from "../src/simulation/fight-simulation";

const at = { x: 0, y: 0 };
const labels = () => controlLabels({ kind: "keyboard", layout: "p1" }, "left");

describe("fight tips", () => {
  it("say what the caught player should have done, with their own keys", () => {
    const low: FightEvent = { type: "hit", attacker: 1, defender: 0, attack: "lowKick", blocked: false, damage: 7, at, wrongGuard: "low" };
    expect(tipFor(low, labels)).toEqual({ player: 0, text: "LOW! Block it crouching (S)" });
    const overhead: FightEvent = { ...low, attack: "jumpKick", wrongGuard: "overhead" };
    expect(tipFor(overhead, labels)!.text).toBe("OVERHEAD! Block it standing (A)");
    expect(tipFor({ type: "grab", attacker: 1, defender: 0, grab: "throw" }, labels)).toEqual({ player: 0, text: "GRABBED! L breaks free" });
  });

  it("say nothing about ordinary hits, or a bear hug (it can't be broken)", () => {
    expect(tipFor({ type: "hit", attacker: 1, defender: 0, attack: "punch", blocked: false, damage: 8, at }, labels)).toBeNull();
    expect(tipFor({ type: "grab", attacker: 1, defender: 0, grab: "bearHug" }, labels)).toBeNull();
  });

  it("are for practice's player and a fighter's first few matches, never the CPU", () => {
    expect(showsTips({ practice: true, player: 0, isPerson: true, matchesPlayed: 50 })).toBe(true);
    expect(showsTips({ practice: true, player: 1, isPerson: false, matchesPlayed: 0 })).toBe(false);
    expect(showsTips({ practice: false, player: 1, isPerson: true, matchesPlayed: TIP_MATCHES - 1 })).toBe(true);
    expect(showsTips({ practice: false, player: 1, isPerson: true, matchesPlayed: TIP_MATCHES })).toBe(false);
    expect(showsTips({ practice: false, player: 1, isPerson: false, matchesPlayed: 0 })).toBe(false);
  });
});
