import { FRAMES_PER_SECOND, secondsRemaining, type RoundState } from "../../simulation/round-rules";

/** At or below this the health bar turns red and pulses. */
export const LOW_HEALTH = 30;
/** The clock flashes and ticks for the last this-many seconds. */
export const CLOCK_WARNING_SECONDS = 10;

/**
 * Low-health pulse strength for this frame, 0..1 (0 when not low). Faster
 * when very low. Driven by the simulation frame so it freezes with the pause.
 */
export function lowHealthPulse(health: number, frame: number): number {
  if (health <= 0 || health > LOW_HEALTH) return 0;
  const period = health <= LOW_HEALTH / 2 ? 24 : 40;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * (frame % period)) / period);
}

/** Last-seconds clock: flashing red, with a little pop each time the second changes. */
export function clockCue(round: RoundState): { warning: boolean; red: boolean; scale: number } {
  const warning = round.phase === "fighting" && secondsRemaining(round) <= CLOCK_WARNING_SECONDS;
  if (!warning) return { warning, red: false, scale: 1 };
  if (round.framesRemaining <= 0) return { warning, red: true, scale: 1 };
  // The shown second (rounded up) changes on multiples of 60 frames: 1 right then, falling toward 0 before the next.
  const sinceTick = (((round.framesRemaining - 1) % FRAMES_PER_SECOND) + 1) / FRAMES_PER_SECOND;
  return { warning, red: sinceTick > 0.5, scale: 1 + 0.25 * sinceTick ** 3 };
}

/** Whether the clock just reached a new second in the warning window (play a tick). */
export function clockTicked(before: RoundState, after: RoundState): boolean {
  const s = secondsRemaining(after);
  return after.phase === "fighting" && s > 0 && s <= CLOCK_WARNING_SECONDS && s !== secondsRemaining(before);
}
