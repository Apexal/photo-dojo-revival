import type { FightState } from "./fight-simulation";
import { HitStreak } from "./match-stats";
import { MAX_HEALTH, type PlayerIndex, type RoundPhase } from "./round-rules";

/** An announcer callout for one player: the round's first hit, a hit streak as it grows, a round won untouched. */
export type Callout =
  | { type: "firstBlood"; player: PlayerIndex }
  | { type: "streak"; player: PlayerIndex; hits: number }
  | { type: "perfect"; player: PlayerIndex };

export const calloutText = (c: Callout): string =>
  c.type === "firstBlood" ? "FIRST BLOOD" : c.type === "streak" ? `${c.hits} HIT STREAK` : "PERFECT";

/**
 * Picks out callouts as the fight is played: feed it every state the
 * simulation steps to (not replays), in order. `firstBlood` and `perfect`
 * are for matches; practice only gets streaks.
 */
export class CalloutTracker {
  private readonly streak = new HitStreak();
  private bloodied = false;
  private lastPhase: RoundPhase | null = null;

  constructor(private readonly options: { match: boolean }) {}

  record(state: FightState): Callout[] {
    const out: Callout[] = [];
    for (const ev of state.events) {
      switch (ev.type) {
        case "roundStart":
          // Also a restarted round.
          this.bloodied = false;
          break;
        case "hit":
          if (!ev.blocked) this.firstBlood(ev.attacker, out);
          break;
        case "throw":
          this.firstBlood(ev.attacker, out);
          break;
      }
    }
    for (const { player, hits } of this.streak.record(state)) {
      if (hits >= 2) out.push({ type: "streak", player, hits });
    }
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
