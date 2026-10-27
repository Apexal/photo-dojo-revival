import type Phaser from "phaser";
import { getSetting, setSetting } from "../shared/fighter-storage";
import { isAttackId, type AttackId } from "../shared/frame-data";
import { mostLanded, type PlayerStats } from "../simulation/match-stats";
import type { PlayerIndex, RoundOutcome } from "../simulation/round-rules";

/**
 * A fighter's career: their numbers over every match they've finished
 * (not practice), added up from each match's PlayerStats. Saved in the
 * settings store, by fighter id.
 */
export interface FighterRecord {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  roundsWon: number;
  perfectRounds: number;
  damageDealt: number;
  attacks: number;
  hits: number;
  blocks: number;
  throws: number;
  knockdowns: number;
  /** Round-intro handshakes refused. Not shown until there's one. */
  snubs: number;
  /** Best over all matches. */
  longestStreak: number;
  /** Clean hits by attack, over all matches. */
  movesLanded: Partial<Record<AttackId, number>>;
  /** Head-to-head against each opponent, by their fighter id (not mirror matches). */
  versus: Record<string, Tally>;
}

/** Results from one side: theirs against one opponent. */
export interface Tally {
  wins: number;
  losses: number;
  draws: number;
}

export type FighterRecords = Record<string, FighterRecord>;

const REGISTRY_KEY = "fighterRecords";

export const emptyRecord = (): FighterRecord => ({
  matches: 0, wins: 0, losses: 0, draws: 0, roundsWon: 0, perfectRounds: 0, damageDealt: 0,
  attacks: 0, hits: 0, blocks: 0, throws: 0, knockdowns: 0, snubs: 0, longestStreak: 0, movesLanded: {}, versus: {},
});

type CountField = Exclude<keyof FighterRecord, "movesLanded" | "versus">;
const FIELDS = (Object.keys(emptyRecord()) as (keyof FighterRecord)[]).filter((k): k is CountField => k !== "movesLanded" && k !== "versus");
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** A saved record, with anything missing or malformed as 0 (so new fields don't break old saves). */
export function parseRecord(value: unknown): FighterRecord {
  const record = emptyRecord();
  if (typeof value !== "object" || value === null) return record;
  for (const key of FIELDS) {
    const n = (value as Record<string, unknown>)[key];
    if (isCount(n)) record[key] = n;
  }
  const moves = (value as Record<string, unknown>).movesLanded;
  if (typeof moves === "object" && moves !== null) {
    for (const [id, n] of Object.entries(moves)) if (isAttackId(id as never) && isCount(n)) record.movesLanded[id as AttackId] = n;
  }
  const versus = (value as Record<string, unknown>).versus;
  if (typeof versus === "object" && versus !== null) {
    for (const [id, t] of Object.entries(versus)) {
      if (typeof t !== "object" || t === null) continue;
      const { wins, losses, draws } = t as Record<string, unknown>;
      record.versus[id] = { wins: isCount(wins) ? wins : 0, losses: isCount(losses) ? losses : 0, draws: isCount(draws) ? draws : 0 };
    }
  }
  return record;
}

/**
 * The record with one more match: `stats` are this fighter's numbers from it,
 * `winner` the match's, `opponentId` who they fought (null: a mirror match, which
 * isn't a rivalry).
 */
export function addMatch(record: FighterRecord, stats: PlayerStats, side: PlayerIndex, winner: RoundOutcome, opponentId: string | null = null): FighterRecord {
  const versus = { ...record.versus };
  if (opponentId !== null) {
    const t = versus[opponentId] ?? { wins: 0, losses: 0, draws: 0 };
    versus[opponentId] = {
      wins: t.wins + (winner === side ? 1 : 0),
      losses: t.losses + (winner !== "draw" && winner !== side ? 1 : 0),
      draws: t.draws + (winner === "draw" ? 1 : 0),
    };
  }
  return {
    matches: record.matches + 1,
    wins: record.wins + (winner === side ? 1 : 0),
    losses: record.losses + (winner !== "draw" && winner !== side ? 1 : 0),
    draws: record.draws + (winner === "draw" ? 1 : 0),
    roundsWon: record.roundsWon + stats.roundsWon,
    perfectRounds: record.perfectRounds + stats.perfectRounds,
    damageDealt: record.damageDealt + stats.damageDealt,
    attacks: record.attacks + stats.attacks,
    hits: record.hits + stats.hits,
    blocks: record.blocks + stats.blocks,
    throws: record.throws + stats.throws,
    knockdowns: record.knockdowns + stats.knockdowns,
    snubs: record.snubs + stats.snubs,
    longestStreak: Math.max(record.longestStreak, stats.longestStreak),
    movesLanded: addCounts(record.movesLanded, stats.movesLanded),
    versus,
  };
}

function addCounts(a: Partial<Record<AttackId, number>>, b: Partial<Record<AttackId, number>>): Partial<Record<AttackId, number>> {
  const sum = { ...a };
  for (const [id, n] of Object.entries(b) as [AttackId, number][]) sum[id] = (sum[id] ?? 0) + n;
  return sum;
}

/** The attack they've landed most over their career (null if none yet). */
export const favoriteMoveOf = (r: FighterRecord) => mostLanded(r.movesLanded);

/** "12W 5L" (and "1D" when there are draws). */
export const winLoss = (r: Tally) => `${r.wins}W ${r.losses}L${r.draws ? ` ${r.draws}D` : ""}`;

/** Boot: read the saved records (missing or malformed: nobody has a record yet). */
export async function loadFighterRecords(registry: Phaser.Data.DataManager): Promise<void> {
  const saved = await getSetting("fighterRecords");
  const records: FighterRecords = {};
  if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
    for (const [id, value] of Object.entries(saved)) records[id] = parseRecord(value);
  }
  registry.set(REGISTRY_KEY, records);
}

/** The fighter's record; null if they haven't finished a match. */
export function recordOf(registry: Phaser.Data.DataManager, fighterId: string): FighterRecord | null {
  return (registry.get(REGISTRY_KEY) as FighterRecords | undefined)?.[fighterId] ?? null;
}

/** `a`'s results against `b`; null if they've never finished a match against each other (or a = b). */
export function headToHead(registry: Phaser.Data.DataManager, a: string, b: string): Tally | null {
  return a === b ? null : recordOf(registry, a)?.versus[b] ?? null;
}

/**
 * A finished match goes on both fighters' records. A mirror match (one
 * fighter on both sides) counts twice: once from each side.
 */
export function recordMatch(
  registry: Phaser.Data.DataManager, fighterIds: readonly [string, string], players: readonly [PlayerStats, PlayerStats], winner: RoundOutcome,
): void {
  const records: FighterRecords = { ...(registry.get(REGISTRY_KEY) ?? {}) };
  for (const side of [0, 1] as const) {
    const id = fighterIds[side];
    const opponent = fighterIds[side === 0 ? 1 : 0];
    records[id] = addMatch(records[id] ?? emptyRecord(), players[side], side, winner, opponent === id ? null : opponent);
  }
  save(registry, records);
}

/** A deleted fighter takes their record, and everyone's rivalry with them, along. */
export function forgetFighterRecord(registry: Phaser.Data.DataManager, fighterId: string): void {
  const records: FighterRecords = { ...(registry.get(REGISTRY_KEY) ?? {}) };
  let changed = fighterId in records;
  delete records[fighterId];
  for (const [id, r] of Object.entries(records)) {
    if (!(fighterId in r.versus)) continue;
    const { [fighterId]: _, ...versus } = r.versus;
    records[id] = { ...r, versus };
    changed = true;
  }
  if (changed) save(registry, records);
}

function save(registry: Phaser.Data.DataManager, records: FighterRecords): void {
  registry.set(REGISTRY_KEY, records);
  void setSetting("fighterRecords", records).catch(() => {});
}
