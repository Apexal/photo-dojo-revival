/**
 * Single-elimination bracket: pure, no Phaser, so it's Node-tested.
 * Entrants are seeded in the order given (shuffle first for a random draw);
 * the bracket is padded to a power of two with byes, which go to the top seeds
 * and advance at once. Matches are played round by round, top to bottom.
 */

export interface BracketMatch {
  /** Entrant indices; null while undecided, or a bye in the first round. */
  a: number | null;
  b: number | null;
  winner: number | null;
}

export interface NextMatch {
  round: number;
  index: number;
  a: number;
  b: number;
}

export const MIN_ENTRANTS = 3;
export const MAX_ENTRANTS = 8;

/** 1-based seeds in bracket order, so seeds 1 and 2 can only meet in the final: [1, 8, 4, 5, 2, 7, 3, 6] for 8. */
export function seedOrder(size: number): number[] {
  let seeds = [1];
  while (seeds.length < size) {
    const n = seeds.length * 2 + 1;
    seeds = seeds.flatMap((s) => [s, n - s]);
  }
  return seeds;
}

export class Tournament<T> {
  readonly rounds: BracketMatch[][];

  constructor(readonly entrants: readonly T[]) {
    if (entrants.length < 2) throw new Error("A tournament needs at least two entrants");
    const size = 2 ** Math.ceil(Math.log2(entrants.length));
    const slots = seedOrder(size).map((seed) => (seed <= entrants.length ? seed - 1 : null));
    this.rounds = [];
    for (let matches = size / 2; matches >= 1; matches /= 2) {
      this.rounds.push(Array.from({ length: matches }, () => ({ a: null, b: null, winner: null })));
    }
    this.rounds[0].forEach((m, i) => {
      m.a = slots[2 * i];
      m.b = slots[2 * i + 1];
      // A bye: the one entrant goes straight through.
      if (m.a === null || m.b === null) this.advance(0, i, m.a ?? m.b);
    });
  }

  /** The next match to play, or null once there's a champion. */
  get next(): NextMatch | null {
    for (let round = 0; round < this.rounds.length; round++) {
      const index = this.rounds[round].findIndex((m) => m.winner === null && m.a !== null && m.b !== null);
      if (index >= 0) {
        const m = this.rounds[round][index];
        return { round, index, a: m.a!, b: m.b! };
      }
    }
    return null;
  }

  /** The next match's result: `side` 0 is its `a`, 1 its `b`. */
  record(side: 0 | 1): void {
    const next = this.next;
    if (!next) throw new Error("The tournament is over");
    this.advance(next.round, next.index, side === 0 ? next.a : next.b);
  }

  get champion(): T | null {
    const winner = this.rounds[this.rounds.length - 1][0].winner;
    return winner === null ? null : this.entrants[winner];
  }

  /** A first-round match with only one entrant. */
  isBye(round: number, index: number): boolean {
    const m = this.rounds[round][index];
    return round === 0 && (m.a === null || m.b === null);
  }

  /** "Final", "Semifinals", "Quarterfinals", else "Round N". */
  roundName(round: number): string {
    const fromEnd = this.rounds.length - 1 - round;
    return ["Final", "Semifinals", "Quarterfinals"][fromEnd] ?? `Round ${round + 1}`;
  }

  private advance(round: number, index: number, winner: number | null): void {
    this.rounds[round][index].winner = winner;
    const into = this.rounds[round + 1]?.[Math.floor(index / 2)];
    if (!into) return;
    if (index % 2 === 0) into.a = winner;
    else into.b = winner;
  }
}
