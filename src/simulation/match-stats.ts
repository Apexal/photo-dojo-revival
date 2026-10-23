import type { AttackId } from "../shared/frame-data";
import type { FightState } from "./fight-simulation";
import { MAX_HEALTH, type PlayerIndex, type RoundEndReason, type RoundOutcome } from "./round-rules";

/** One player's numbers over a match. */
export interface PlayerStats {
  roundsWon: number;
  /** Rounds won without losing any health. */
  perfectRounds: number;
  damageDealt: number;
  /** Attacks thrown (each one counted when it comes out). */
  attacks: number;
  /** Clean hits: attacks that landed unblocked. */
  hits: number;
  /** Their attacks the opponent blocked. */
  blockedByOpponent: number;
  /** The opponent's attacks they blocked. */
  blocks: number;
  throws: number;
  /** The opponent's throws they broke. */
  throwTechs: number;
  /** Times they put the opponent on the floor. */
  knockdowns: number;
  taunts: number;
  /** Most clean hits in a row before the opponent recovered. */
  longestCombo: number;
  /** The attack they landed most often (null if none landed). */
  favoriteMove: AttackId | null;
}

export interface RoundSummary {
  round: number;
  outcome: RoundOutcome;
  reason: RoundEndReason;
  /** Health left at the end of the round. */
  health: [number, number];
  /** Fighting time, in simulation frames. */
  frames: number;
}

export interface MatchStats {
  players: [PlayerStats, PlayerStats];
  rounds: RoundSummary[];
  /** Fighting time over all rounds (not intros, outros or replays), in frames. */
  frames: number;
}

const emptyStats = (): PlayerStats => ({
  roundsWon: 0, perfectRounds: 0, damageDealt: 0, attacks: 0, hits: 0, blockedByOpponent: 0, blocks: 0,
  throws: 0, throwTechs: 0, knockdowns: 0, taunts: 0, longestCombo: 0, favoriteMove: null,
});

/** Still reeling from the last hit, so the next one continues the combo. */
const reeling = (action: string) => action === "hurt" || action === "knockdown" || action === "downed";

/**
 * Builds MatchStats from the fight as it's played: feed it every state the
 * simulation steps to (not replays), in order. Rendering-free and
 * deterministic, like the simulation it reads.
 */
export class MatchStatsTracker {
  private readonly players: [PlayerStats, PlayerStats] = [emptyStats(), emptyStats()];
  private readonly rounds: RoundSummary[] = [];
  private frames = 0;
  private roundFrames = 0;
  private readonly combo: [number, number] = [0, 0];
  /** Per defender: still in hitstun from the attacker's last clean hit. */
  private readonly open: [boolean, boolean] = [false, false];
  private readonly landed: [Map<AttackId, number>, Map<AttackId, number>] = [new Map(), new Map()];

  record(state: FightState): void {
    if (state.round.phase === "fighting") {
      this.frames++;
      this.roundFrames++;
    }
    for (const ev of state.events) {
      switch (ev.type) {
        case "attackActive":
          this.players[ev.player].attacks++;
          break;
        case "hit": {
          const attacker = this.players[ev.attacker];
          if (ev.blocked) {
            attacker.blockedByOpponent++;
            this.players[ev.defender].blocks++;
            this.combo[ev.attacker] = 0;
            break;
          }
          attacker.hits++;
          this.combo[ev.attacker] = this.open[ev.defender] ? this.combo[ev.attacker] + 1 : 1;
          attacker.longestCombo = Math.max(attacker.longestCombo, this.combo[ev.attacker]);
          const counts = this.landed[ev.attacker];
          counts.set(ev.attack, (counts.get(ev.attack) ?? 0) + 1);
          attacker.favoriteMove = [...counts].sort((a, b) => b[1] - a[1])[0][0];
          break;
        }
        case "throw":
          this.players[ev.attacker].throws++;
          break;
        case "throwTech":
          this.players[ev.defender].throwTechs++;
          break;
        case "knockdown":
          this.players[other(ev.player)].knockdowns++;
          break;
        case "taunt":
          this.players[ev.player].taunts++;
          break;
        case "roundEnd": {
          const health: [number, number] = [state.fighters[0].health, state.fighters[1].health];
          this.rounds.push({ round: state.round.roundNumber, outcome: ev.outcome, reason: ev.reason, health, frames: this.roundFrames });
          this.roundFrames = 0;
          if (ev.outcome !== "draw") {
            this.players[ev.outcome].roundsWon++;
            if (health[ev.outcome] === MAX_HEALTH) this.players[ev.outcome].perfectRounds++;
          }
          break;
        }
      }
    }
    // Damage: what came off each fighter's health this step (hits, throws), credited to the other.
    for (const p of [0, 1] as const) {
      // A combo is open while the defender is still reeling; it closes the moment they recover.
      this.open[p] = reeling(state.fighters[p].action);
      if (!this.open[p]) this.combo[other(p)] = 0;
    }
    this.trackDamage(state);
  }

  private lastHealth: [number, number] | null = null;
  private lastRound = 0;

  private trackDamage(state: FightState): void {
    const health: [number, number] = [state.fighters[0].health, state.fighters[1].health];
    // A new round refills health: that's not damage.
    if (this.lastHealth && state.round.roundNumber === this.lastRound) {
      for (const p of [0, 1] as const) {
        const lost = this.lastHealth[p] - health[p];
        if (lost > 0) this.players[other(p)].damageDealt += lost;
      }
    }
    this.lastHealth = health;
    this.lastRound = state.round.roundNumber;
  }

  get result(): MatchStats {
    return {
      players: [{ ...this.players[0] }, { ...this.players[1] }],
      rounds: this.rounds.map((r) => ({ ...r, health: [...r.health] as [number, number] })),
      frames: this.frames,
    };
  }
}

const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** Clean hits over attacks thrown, 0..1 (0 when nothing was thrown). */
export const accuracy = (s: PlayerStats) => (s.attacks ? s.hits / s.attacks : 0);
