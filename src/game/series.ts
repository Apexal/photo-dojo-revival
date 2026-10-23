import type { LibraryEntry } from "./fighter-library";
import type { PlayerInputDescriptor } from "./input/input-descriptor";
import type { KingOfTheHill } from "./king-of-the-hill";
import type { Tournament } from "./tournament";

/**
 * Multi-match modes, played with two controllers over a list of fighters.
 * Between fights each has its own scene, whose key is its kind; the session
 * lives in the registry (REGISTRY.series) for the length of the series.
 */
export type SeriesKind = "tournament" | "king-of-the-hill";

export const SERIES_KINDS: readonly SeriesKind[] = ["tournament", "king-of-the-hill"];

export const SERIES_INFO: Record<SeriesKind, { name: string; blurb: string; home: string; next: string }> = {
  tournament: {
    name: "Tournament",
    blurb: "Single elimination, drawn at random. P1 plays the top fighter of each match, P2 the bottom.",
    home: "the bracket",
    next: "To the bracket",
  },
  "king-of-the-hill": {
    name: "King of the Hill",
    blurb: "Winner stays on, the next in line steps in. Beat everyone in a row to rule the hill.",
    home: "the hill",
    next: "Next challenger",
  },
};

export const MIN_ENTRANTS = 3;
export const MAX_ENTRANTS = 8;

export type SeriesSession =
  | { kind: "tournament"; bracket: Tournament<LibraryEntry>; inputs: [PlayerInputDescriptor, PlayerInputDescriptor] }
  | { kind: "king-of-the-hill"; hill: KingOfTheHill<LibraryEntry>; inputs: [PlayerInputDescriptor, PlayerInputDescriptor] };

/** The match just played: `side` 0 won (P1's fighter) or 1. */
export function recordSeriesResult(session: SeriesSession, side: 0 | 1): void {
  if (session.kind === "tournament") session.bracket.record(side);
  else session.hill.record(side);
}
