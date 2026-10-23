/**
 * King of the hill: pure, no Phaser, so it's Node-tested. The first two
 * entrants fight; the winner stays on (on the same side, so the same
 * controller) and the next challenger in the queue steps in, while the loser
 * goes to the back of it. Whoever beats every other entrant in a row rules
 * the hill and it's over.
 */

export class KingOfTheHill<T> {
  /** Entrant index on each side: P1's, P2's. */
  readonly sides: [number, number];
  /** Which side the king is on; null before the first match. */
  kingSide: 0 | 1 | null = null;
  /** Wins in a row by the current king. */
  streak = 0;
  /** Up next, in order. */
  readonly queue: number[];
  readonly wins: number[];
  best: { entrant: number; streak: number } | null = null;
  private ruler: number | null = null;

  constructor(readonly entrants: readonly T[]) {
    if (entrants.length < 2) throw new Error("King of the hill needs at least two entrants");
    this.sides = [0, 1];
    this.queue = entrants.slice(2).map((_, i) => i + 2);
    this.wins = entrants.map(() => 0);
  }

  /** Wins in a row the king needs to rule the hill: one over each other entrant. */
  get target(): number {
    return this.entrants.length - 1;
  }

  get king(): number | null {
    return this.kingSide === null ? null : this.sides[this.kingSide];
  }

  /** Who rules the hill, once someone has beaten everyone in a row. */
  get champion(): T | null {
    return this.ruler === null ? null : this.entrants[this.ruler];
  }

  /** The current match's result: `side` 0 is P1's fighter, 1 P2's. */
  record(side: 0 | 1): void {
    if (this.ruler !== null) throw new Error("The hill already has a ruler");
    const winner = this.sides[side];
    const loserSide: 0 | 1 = side === 0 ? 1 : 0;
    this.streak = winner === this.king ? this.streak + 1 : 1;
    this.kingSide = side;
    this.wins[winner]++;
    if (!this.best || this.streak > this.best.streak) this.best = { entrant: winner, streak: this.streak };
    if (this.streak >= this.target) {
      this.ruler = winner;
      return;
    }
    this.queue.push(this.sides[loserSide]);
    this.sides[loserSide] = this.queue.shift()!;
  }
}
