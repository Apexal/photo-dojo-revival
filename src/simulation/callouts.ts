import type { FightState } from "./fight-simulation";
import { ComboCounter } from "./match-stats";
import { MAX_HEALTH, type PlayerIndex, type RoundPhase } from "./round-rules";

/** An announcer callout for one player: the round's first hit, a combo as it grows, a round won untouched. */
export type Callout =
  | { type: "firstBlood"; player: PlayerIndex }
  | { type: "combo"; player: PlayerIndex; hits: number }
  | { type: "perfect"; player: PlayerIndex };

export const calloutText = (c: Callout): string =>
  c.type === "firstBlood" ? "FIRST BLOOD" : c.type === "combo" ? `${c.hits} HIT COMBO` : "PERFECT";

/**
 * Picks out callouts as the fight is played: feed it every state the
 * simulation steps to (not replays), in order. `firstBlood` and `perfect`
 * are for matches; practice only gets combos.
 */
export class CalloutTracker {
  private combo = new ComboCounter();
  private bloodied = false;
  private lastPhase: RoundPhase | null = null;

  constructor(private readonly options: { match: boolean }) {}

  record(state: FightState): Callout[] {
    const out: Callout[] = [];
    for (const ev of state.events) {
      switch (ev.type) {
        case "roundStart":
          // Also a restarted round.
          this.combo = new ComboCounter();
          this.bloodied = false;
          break;
        case "hit": {
          if (ev.blocked) {
            this.combo.blocked(ev.attacker);
            break;
          }
          this.firstBlood(ev.attacker, out);
          const hits = this.combo.hit(ev.attacker);
          if (hits >= 2) out.push({ type: "combo", player: ev.attacker, hits });
          break;
        }
        case "throw":
          this.firstBlood(ev.attacker, out);
          break;
      }
    }
    this.combo.settle(state);
    // Called as the round is decided (the outro starts), not at its end, so it lands with the K.O.
    const { round } = state;
    const decided = round.phase === "outro" && this.lastPhase === "fighting";
    this.lastPhase = round.phase;
    if (this.options.match && decided && round.roundWinner !== null && round.roundWinner !== "draw" && state.fighters[round.roundWinner].health === MAX_HEALTH) {
      out.push({ type: "perfect", player: round.roundWinner });
    }
    return out;
  }

  private firstBlood(player: PlayerIndex, out: Callout[]): void {
    if (!this.options.match || this.bloodied) return;
    this.bloodied = true;
    out.push({ type: "firstBlood", player });
  }
}
