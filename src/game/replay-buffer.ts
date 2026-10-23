/** Frames of lead-up shown before the knockout blow, and how long to linger after it. */
export const REPLAY_LEAD_FRAMES = 150;
export const REPLAY_TAIL_FRAMES = 45;
/** Slow motion. */
export const REPLAY_SPEED = 0.5;

/**
 * Keeps the last few seconds of simulation states. The simulation is
 * deterministic and its states are immutable, so a replay is just these
 * states drawn again. After `markFinish()` it records a short tail, then freezes.
 */
export class ReplayBuffer<S> {
  private states: S[] = [];
  private finishIndex: number | null = null;

  constructor(private readonly lead = REPLAY_LEAD_FRAMES, private readonly tail = REPLAY_TAIL_FRAMES) {}

  get frozen(): boolean {
    return this.finishIndex !== null && this.states.length - 1 - this.finishIndex >= this.tail;
  }

  push(state: S): void {
    if (this.frozen) return;
    this.states.push(state);
    // Before the finish, keep only the lead window.
    if (this.finishIndex === null && this.states.length > this.lead) this.states.shift();
  }

  /** The finishing blow landed on the most recent state. */
  markFinish(): void {
    if (this.finishIndex === null) this.finishIndex = this.states.length - 1;
  }

  get hasFinish(): boolean {
    return this.finishIndex !== null;
  }

  /** Lead-up, the blow, and the tail. */
  clip(): S[] {
    return [...this.states];
  }

  reset(): void {
    this.states = [];
    this.finishIndex = null;
  }
}
