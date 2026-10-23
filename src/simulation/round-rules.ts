import { HANDSHAKE_FRAMES } from "../shared/handshake";

export const FRAMES_PER_SECOND = 60;
export const ROUND_SECONDS = 60;
export const ROUND_FRAMES = ROUND_SECONDS * FRAMES_PER_SECOND;
export const ROUNDS_TO_WIN = 2;
/** Draws don't award a round; cap the match so it can't go forever. */
export const MAX_ROUNDS = 5;
export const MAX_HEALTH = 100;
/**
 * The round intro: the fighters walk in from their corners, pause, shake hands
 * (player 1 offers first, handshake.ts) and walk back, then a beat before
 * "FIGHT!" (fight-simulation.ts).
 */
export const INTRO = { walkIn: 72, pause: 20, shake: HANDSHAKE_FRAMES, walkOut: 72, settle: 12 } as const;
export const ROUND_INTRO_FRAMES = INTRO.walkIn + INTRO.pause + INTRO.shake + INTRO.walkOut + INTRO.settle;
export const ROUND_OUTRO_FRAMES = 120;

export type PlayerIndex = 0 | 1;
export type RoundOutcome = PlayerIndex | "draw";
export type RoundEndReason = "ko" | "timeout";

export type RoundPhase = "intro" | "fighting" | "outro" | "roundOver" | "matchOver";

export interface RoundState {
  roundNumber: number;
  phase: RoundPhase;
  phaseFrame: number;
  framesRemaining: number;
  wins: [number, number];
  roundWinner: RoundOutcome | null;
  roundEndReason: RoundEndReason | null;
  matchWinner: RoundOutcome | null;
}

export function createMatch(): RoundState {
  return {
    roundNumber: 1,
    phase: "intro",
    phaseFrame: 0,
    framesRemaining: ROUND_FRAMES,
    wins: [0, 0],
    roundWinner: null,
    roundEndReason: null,
    matchWinner: null,
  };
}

export function secondsRemaining(state: RoundState): number {
  return Math.ceil(state.framesRemaining / FRAMES_PER_SECOND);
}

/** KO wins first; otherwise on timeout the healthier fighter wins. Null while the round is still live. */
export function judgeRound(health: [number, number], framesRemaining: number): { outcome: RoundOutcome; reason: RoundEndReason } | null {
  const ko0 = health[0] <= 0;
  const ko1 = health[1] <= 0;
  if (ko0 || ko1) return { outcome: ko0 && ko1 ? "draw" : ko0 ? 1 : 0, reason: "ko" };
  if (framesRemaining > 0) return null;
  if (health[0] === health[1]) return { outcome: "draw", reason: "timeout" };
  return { outcome: health[0] > health[1] ? 0 : 1, reason: "timeout" };
}

export function matchWinnerFor(wins: [number, number], roundsPlayed: number): RoundOutcome | null {
  if (wins[0] >= ROUNDS_TO_WIN) return 0;
  if (wins[1] >= ROUNDS_TO_WIN) return 1;
  if (roundsPlayed >= MAX_ROUNDS) return wins[0] === wins[1] ? "draw" : wins[0] > wins[1] ? 0 : 1;
  return null;
}

/**
 * Advance one frame. Returns a new state; never mutates.
 * intro → fighting → (KO or timeout) → outro → roundOver | matchOver.
 * roundOver waits for `startNextRound`.
 */
export function tickRound(state: RoundState, health: [number, number]): RoundState {
  const next: RoundState = { ...state, wins: [...state.wins] as [number, number], phaseFrame: state.phaseFrame + 1 };
  switch (state.phase) {
    case "intro":
      if (next.phaseFrame >= ROUND_INTRO_FRAMES) return { ...next, phase: "fighting", phaseFrame: 0 };
      return next;
    case "fighting": {
      next.framesRemaining = Math.max(0, state.framesRemaining - 1);
      const result = judgeRound(health, next.framesRemaining);
      if (!result) return next;
      if (result.outcome !== "draw") next.wins[result.outcome] += 1;
      return { ...next, phase: "outro", phaseFrame: 0, roundWinner: result.outcome, roundEndReason: result.reason };
    }
    case "outro": {
      if (next.phaseFrame < ROUND_OUTRO_FRAMES) return next;
      const matchWinner = matchWinnerFor(next.wins, state.roundNumber);
      return { ...next, phase: matchWinner === null ? "roundOver" : "matchOver", phaseFrame: 0, matchWinner };
    }
    default:
      return next;
  }
}

/** Pause menu "Restart round": same round number, full clock, and the wins it started with. */
export function restartRound(state: RoundState, winsAtStart: [number, number]): RoundState {
  return {
    ...state,
    phase: "intro",
    phaseFrame: 0,
    framesRemaining: ROUND_FRAMES,
    wins: [...winsAtStart],
    roundWinner: null,
    roundEndReason: null,
    matchWinner: null,
  };
}

export function startNextRound(state: RoundState): RoundState {
  if (state.phase !== "roundOver") return state;
  return {
    ...state,
    roundNumber: state.roundNumber + 1,
    phase: "intro",
    phaseFrame: 0,
    framesRemaining: ROUND_FRAMES,
    roundWinner: null,
    roundEndReason: null,
  };
}
