import type { PlayerStats } from "../simulation/match-stats";

/*
 * A fighter's reputation, a spectrum from Rude to Respectful, shown on the
 * versus intro. It's read from their manners: handshakes taken count for
 * them; handshakes refused (the snub) and gloating (taunting an opponent who's
 * on the floor) count against.
 *
 * Recent matches weigh most: each match, the tally so far fades by
 * MANNERS_DECAY before the new match's is added, so a reformed fighter wins
 * their name back over a few polite matches (and a saint who turns can lose it).
 *
 * Everyone starts with the benefit of the doubt: the score is smoothed toward
 * PRIOR, as if they'd already taken some handshakes and refused one, so a
 * single snub in a first match doesn't brand them Rude, and it takes a habit
 * to get there.
 */

export const REPUTATION_TIERS = ["Rude", "Unsporting", "Unpredictable", "Sporting", "Respectful"] as const;
export type ReputationTier = (typeof REPUTATION_TIERS)[number];

/** Upper bounds of the first four tiers' scores. */
const TIER_BOUNDS = [0.25, 0.45, 0.65, 0.85] as const;

/** The head start: good and bad manners before their first match. */
export const PRIOR = { good: 4, bad: 1 } as const;

/** What's left of the tally so far after each match: about the last five matches count. */
export const MANNERS_DECAY = 0.8;

/** A gloat against a refused handshake. */
export const GLOAT_WEIGHT = 1;

/** Good and bad manners, faded by MANNERS_DECAY each match. */
export interface Manners {
  good: number;
  bad: number;
}

export interface Reputation {
  /** 0 (all bad manners) to 1 (all good), smoothed by PRIOR. */
  score: number;
  /** Index into REPUTATION_TIERS. */
  tier: number;
  label: ReputationTier;
  /** False for a clean slate: nothing either way yet. */
  known: boolean;
}

/** The tally after one more match. */
export function addManners(m: Manners, stats: Pick<PlayerStats, "handshakes" | "snubs" | "gloats">): Manners {
  return {
    good: m.good * MANNERS_DECAY + Math.max(0, stats.handshakes - stats.snubs),
    bad: m.bad * MANNERS_DECAY + stats.snubs + GLOAT_WEIGHT * stats.gloats,
  };
}

/** For a record saved before manners were kept: its career counts, unfaded (all a snub on offer at least). */
export function seedManners(r: { handshakes: number; snubs: number; gloats: number }): Manners {
  return { good: Math.max(0, r.handshakes - r.snubs), bad: r.snubs + GLOAT_WEIGHT * r.gloats };
}

export function reputationOf(record: { manners: Manners } | null): Reputation {
  const { good, bad } = record?.manners ?? { good: 0, bad: 0 };
  const score = (good + PRIOR.good) / (good + bad + PRIOR.good + PRIOR.bad);
  const tier = tierOf(score);
  return { score, tier, label: REPUTATION_TIERS[tier], known: good + bad > 0 };
}

export function tierOf(score: number): number {
  const tier = TIER_BOUNDS.findIndex((bound) => score < bound);
  return tier === -1 ? REPUTATION_TIERS.length - 1 : tier;
}

/** The two ends of the scale wear it in the versus intro: horns for the rude, a halo for the respectful. */
export function adornmentOf(r: Reputation): "horns" | "halo" | null {
  if (!r.known) return null;
  return r.tier === 0 ? "horns" : r.tier === REPUTATION_TIERS.length - 1 ? "halo" : null;
}
