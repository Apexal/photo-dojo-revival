import type { AttackId, GrabId } from "../shared/frame-data";
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
  /** The opponent's attacks they blocked (or parried). */
  blocks: number;
  throws: number;
  /** The opponent's throws they broke. */
  throwTechs: number;
  /** Times they put the opponent on the floor. */
  knockdowns: number;
  taunts: number;
  /** Round-intro handshakes they refused. */
  snubs: number;
  /** Most clean hits in a row (HitStreak). */
  longestStreak: number;
  /** The attack they landed most often (null if none landed). */
  favoriteMove: AttackId | null;
  /** Clean hits by attack (attacks that never landed are missing). */
  movesLanded: Partial<Record<AttackId, number>>;
}

export interface RoundSummary {
  round: number;
  outcome: RoundOutcome;
  reason: RoundEndReason;
  /** Health left at the end of the round. */
  health: [number, number];
  /** Fighting time, in simulation frames. */
  frames: number;
  /** Each player's numbers over this round alone (`roundsWon` 1 for the winner). */
  players: [PlayerStats, PlayerStats];
  /** Who landed the round's first clean hit or throw (null if nobody did). */
  firstBlood: PlayerIndex | null;
  /** The hit or throw that won it by K.O. (null on time or a double K.O.). */
  finisher: AttackId | GrabId | null;
}

export interface MatchStats {
  players: [PlayerStats, PlayerStats];
  rounds: RoundSummary[];
  /** Fighting time over all rounds (not intros, outros or replays), in frames. */
  frames: number;
}

const emptyStats = (): PlayerStats => ({
  roundsWon: 0, perfectRounds: 0, damageDealt: 0, attacks: 0, hits: 0, blockedByOpponent: 0, blocks: 0,
  throws: 0, throwTechs: 0, knockdowns: 0, taunts: 0, snubs: 0, longestStreak: 0, favoriteMove: null, movesLanded: {},
});

/**
 * Clean hits in a row, per player, within a round. A streak survives whiffs and
 * waiting; it ends when the opponent lands a clean hit or throw, or when the
 * player is blocked, parried or has a throw broken. Feed it every state's events.
 */
export class HitStreak {
  private readonly streak: [number, number] = [0, 0];

  /** Updates the streaks from one state's events; returns each clean hit's attacker and the streak it's now on. */
  record(state: FightState): { player: PlayerIndex; hits: number }[] {
    const landed: { player: PlayerIndex; hits: number }[] = [];
    for (const ev of state.events) {
      switch (ev.type) {
        case "roundStart":
          this.streak[0] = this.streak[1] = 0;
          break;
        case "hit":
          if (ev.blocked) {
            this.streak[ev.attacker] = 0;
            break;
          }
          this.streak[ev.defender] = 0;
          landed.push({ player: ev.attacker, hits: ++this.streak[ev.attacker] });
          break;
        case "throw":
          this.streak[ev.defender] = 0;
          break;
        case "parry":
        case "throwTech":
          this.streak[ev.attacker] = 0;
          break;
      }
    }
    return landed;
  }
}

/**
 * Builds MatchStats from the fight as it's played: feed it every state the
 * simulation steps to (not replays), in order. Rendering-free and
 * deterministic, like the simulation it reads.
 */
export class MatchStatsTracker {
  private readonly players: [PlayerStats, PlayerStats] = [emptyStats(), emptyStats()];
  /** The same numbers for the round being played. */
  private round: [PlayerStats, PlayerStats] = [emptyStats(), emptyStats()];
  private firstBlood: PlayerIndex | null = null;
  private finisher: AttackId | GrabId | null = null;
  private readonly rounds: RoundSummary[] = [];
  private frames = 0;
  private roundFrames = 0;
  private readonly streak = new HitStreak();

  record(state: FightState): void {
    // Nothing is fought in an intro: this also starts a restarted round over.
    if (state.round.phase === "intro") this.startRound();
    // Damage: what came off each fighter's health this step (hits, throws), credited to the other.
    // It and the streaks go before the events, so the K.O. blow counts in the round it ends.
    this.trackDamage(state);
    for (const { player, hits } of this.streak.record(state)) {
      this.both(player, (s) => (s.longestStreak = Math.max(s.longestStreak, hits)));
    }
    if (state.round.phase === "fighting") {
      this.frames++;
      this.roundFrames++;
    }
    for (const ev of state.events) {
      switch (ev.type) {
        case "attackActive":
          this.both(ev.player, (s) => s.attacks++);
          break;
        case "hit": {
          if (ev.blocked) {
            this.both(ev.attacker, (s) => s.blockedByOpponent++);
            this.both(ev.defender, (s) => s.blocks++);
            break;
          }
          this.firstBlood ??= ev.attacker;
          this.both(ev.attacker, (s) => {
            s.hits++;
            s.movesLanded[ev.attack] = (s.movesLanded[ev.attack] ?? 0) + 1;
            s.favoriteMove = mostLanded(s.movesLanded);
          });
          break;
        }
        case "parry":
          this.both(ev.attacker, (s) => s.blockedByOpponent++);
          this.both(ev.player, (s) => s.blocks++);
          break;
        case "throw":
          this.firstBlood ??= ev.attacker;
          this.both(ev.attacker, (s) => s.throws++);
          break;
        case "throwTech":
          this.both(ev.defender, (s) => s.throwTechs++);
          break;
        case "knockdown":
          this.both(other(ev.player), (s) => s.knockdowns++);
          break;
        case "taunt":
          this.both(ev.player, (s) => s.taunts++);
          break;
        case "snub":
          // In the intro, which round numbers don't count: the match's only.
          this.players[ev.player].snubs++;
          break;
        case "ko":
          this.finisher = finishingMove(state, ev.player);
          break;
        case "roundEnd": {
          const health: [number, number] = [state.fighters[0].health, state.fighters[1].health];
          if (ev.outcome !== "draw") {
            this.both(ev.outcome, (s) => s.roundsWon++);
            if (health[ev.outcome] === MAX_HEALTH) this.both(ev.outcome, (s) => s.perfectRounds++);
          }
          this.rounds.push({
            round: state.round.roundNumber, outcome: ev.outcome, reason: ev.reason, health, frames: this.roundFrames,
            players: [copy(this.round[0]), copy(this.round[1])], firstBlood: this.firstBlood,
            finisher: ev.reason === "ko" && ev.outcome !== "draw" ? this.finisher : null,
          });
          this.startRound();
          break;
        }
      }
    }
  }

  /** Applies a change to a player's match numbers and their round numbers. */
  private both(p: PlayerIndex, change: (s: PlayerStats) => void): void {
    change(this.players[p]);
    change(this.round[p]);
  }

  private startRound(): void {
    this.round = [emptyStats(), emptyStats()];
    this.roundFrames = 0;
    this.firstBlood = null;
    this.finisher = null;
  }

  private lastHealth: [number, number] | null = null;
  private lastRound = 0;

  private trackDamage(state: FightState): void {
    const health: [number, number] = [state.fighters[0].health, state.fighters[1].health];
    // A new round refills health: that's not damage.
    if (this.lastHealth && state.round.roundNumber === this.lastRound) {
      for (const p of [0, 1] as const) {
        const lost = this.lastHealth[p] - health[p];
        if (lost > 0) this.both(other(p), (s) => (s.damageDealt += lost));
      }
    }
    this.lastHealth = health;
    this.lastRound = state.round.roundNumber;
  }

  get result(): MatchStats {
    return {
      players: [copy(this.players[0]), copy(this.players[1])],
      rounds: this.rounds.map((r) => ({ ...r, health: [...r.health] as [number, number], players: [copy(r.players[0]), copy(r.players[1])] })),
      frames: this.frames,
    };
  }
}

const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** What put `player` down in this step: the other fighter's clean hit or throw (null if neither, e.g. a trade). */
function finishingMove(state: FightState, player: PlayerIndex): AttackId | GrabId | null {
  for (const ev of state.events) {
    if (ev.type === "hit" && !ev.blocked && ev.defender === player) return ev.attack;
    if (ev.type === "throw" && ev.defender === player) return ev.grab;
  }
  return null;
}

const copy = (s: PlayerStats): PlayerStats => ({ ...s, movesLanded: { ...s.movesLanded } });

/** The attack with the most clean hits (the first to get there on a tie); null if none landed. */
export function mostLanded(counts: Partial<Record<AttackId, number>>): AttackId | null {
  let best: AttackId | null = null;
  for (const [id, n] of Object.entries(counts) as [AttackId, number][]) if (n > 0 && (best === null || n > counts[best]!)) best = id;
  return best;
}

/** Clean hits over attacks thrown, 0..1 (0 when nothing was thrown). */
export const accuracy = (s: PlayerStats) => (s.attacks ? s.hits / s.attacks : 0);
