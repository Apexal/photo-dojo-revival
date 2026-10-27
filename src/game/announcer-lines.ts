import type { Callout } from "../simulation/callouts";
import { MAX_ROUNDS, ROUNDS_TO_WIN, type PlayerIndex, type RoundEndReason, type RoundOutcome } from "../simulation/round-rules";

/**
 * Every announcer line, by id, with what it says. Each is a file,
 * `public/announcer/<id>.mp3`; `npm run generate:announcer` makes text-to-speech
 * stand-ins for the missing ones (the text here is its script). Drop a recorded
 * take over a file to replace it. A missing file is just silence.
 */
export const ANNOUNCER_LINES = {
  "round-1": "Round one",
  "round-2": "Round two",
  "round-3": "Round three",
  "round-4": "Round four",
  "round-5": "Round five",
  "final-round": "Final round",
  fight: "Fight!",
  ko: "K.O.!",
  "double-ko": "Double K.O.!",
  time: "Time!",
  perfect: "Perfect!",
  "first-blood": "First blood!",
  "streak-3": "Three in a row!",
  "streak-4": "Four in a row!",
  "streak-5": "Five in a row!",
  "streak-huge": "Unstoppable!",
  parry: "Parry!",
  "throw-break": "Break!",
  disrespectful: "Disrespectful!",
  "p1-wins": "Player one wins!",
  "p2-wins": "Player two wins!",
  "draw-game": "Draw game!",
  "you-win": "You win!",
  "you-lose": "You lose!",
  "p1-ready": "Player one, ready!",
  "p2-ready": "Player two, ready!",
  practice: "Practice mode",
  tutorial: "Tutorial",
  nice: "Nice!",
  "well-done": "Well done! You're ready.",
  "choose-fighter": "Choose your fighter!",
  "choose-opponent": "Choose your opponent!",
  "new-challenger": "Here comes a new challenger!",
  "choose-stage": "Choose your stage!",
  "stage-dusk-dojo": "Dusk Dojo",
  "stage-lunar-dojo": "Lunar Dojo",
  quarterfinals: "Quarterfinals!",
  semifinals: "Semifinals!",
  "final-match": "The final match!",
  "next-match": "Next match!",
  champion: "We have a champion!",
  "king-of-the-hill": "King of the hill!",
  "hill-champion": "Long live the king!",
} as const;

export type AnnouncerLineId = keyof typeof ANNOUNCER_LINES;
export const ANNOUNCER_LINE_IDS = Object.keys(ANNOUNCER_LINES) as AnnouncerLineId[];

const isLine = (id: string): id is AnnouncerLineId => id in ANNOUNCER_LINES;

/** "Round two", or "Final round" when either fighter can take the match with it (or it's the last allowed). */
export function roundStartLine(round: number, wins: readonly [number, number]): AnnouncerLineId {
  const final = round >= MAX_ROUNDS || wins.every((w) => w === ROUNDS_TO_WIN - 1);
  if (final) return "final-round";
  const id = `round-${round}`;
  return isLine(id) ? id : "final-round";
}

/** As the round is decided: "K.O.", "Double K.O." or "Time". */
export function roundEndLine(outcome: RoundOutcome, reason: RoundEndReason): AnnouncerLineId {
  if (reason === "timeout") return "time";
  return outcome === "draw" ? "double-ko" : "ko";
}

/** Against the CPU (`cpu`: its side) it's the player who won or lost. */
export function matchWinnerLine(winner: RoundOutcome, cpu: PlayerIndex | null = null): AnnouncerLineId {
  if (winner === "draw") return "draw-game";
  if (cpu !== null) return winner === cpu ? "you-lose" : "you-win";
  return winner === 0 ? "p1-wins" : "p2-wins";
}

/** A callout's line, or null: hit streaks are only called from three hits, and once past five just the once. */
export function calloutLine(c: Callout): AnnouncerLineId | null {
  switch (c.type) {
    case "snub": return "disrespectful";
    case "firstBlood": return "first-blood";
    case "perfect": return "perfect";
    case "streak":
      if (c.hits >= 3 && c.hits <= 5) return `streak-${c.hits}` as AnnouncerLineId;
      return c.hits === 6 ? "streak-huge" : null;
  }
}

/** A stage's name, if it has a line (`stage-<id>`). */
export function stageLine(stageId: string): AnnouncerLineId | null {
  const id = `stage-${stageId}`;
  return isLine(id) ? id : null;
}

/** The tournament's next match, by the name of its round (Tournament.roundName). */
export function tournamentRoundLine(roundName: string): AnnouncerLineId {
  return roundName === "Final" ? "final-match" : roundName === "Semifinals" ? "semifinals" : roundName === "Quarterfinals" ? "quarterfinals" : "next-match";
}
