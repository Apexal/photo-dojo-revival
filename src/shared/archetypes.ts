/**
 * Fighter archetypes: chosen during capture, each adds one captured pose (the
 * `signature` pose) and one move on down + punch + kick. Everything else is the
 * shared core moveset. Frame data lives in frame-data.ts, the pose to capture in
 * pose-definitions.ts and its skeleton in stick-figure.ts.
 */
export type ArchetypeId = "brawler" | "grappler" | "guardian" | "acrobat";

export const ARCHETYPE_IDS: readonly ArchetypeId[] = ["brawler", "grappler", "guardian", "acrobat"];

/** The action each archetype's signature move starts (frame-data.ts). */
export type SignatureAction = "charge" | "bearHug" | "parry" | "flyingKnee";

export interface ArchetypeInfo {
  name: string;
  move: SignatureAction;
  moveName: string;
  /** One line: what the move is for. */
  blurb: string;
}

export const ARCHETYPES: Record<ArchetypeId, ArchetypeInfo> = {
  brawler: { name: "Brawler", move: "charge", moveName: "Shoulder Charge", blurb: "Barrel across the stage and knock them flat. Easy to see coming." },
  grappler: { name: "Grappler", move: "bearHug", moveName: "Bear Hug", blurb: "A long grab that can't be broken. Loses to attacks." },
  guardian: { name: "Guardian", move: "parry", moveName: "Parry", blurb: "Catch any strike and hit back for free. Loses to throws." },
  acrobat: { name: "Acrobat", move: "flyingKnee", moveName: "Flying Knee", blurb: "An overhead from the ground: beats crouching guards." },
};

export function isArchetypeId(value: unknown): value is ArchetypeId {
  return typeof value === "string" && (ARCHETYPE_IDS as readonly string[]).includes(value);
}

/** The archetype whose signature a move is (null for the shared moves). */
export function archetypeOfMove(action: string): ArchetypeId | null {
  return ARCHETYPE_IDS.find((id) => ARCHETYPES[id].move === action) ?? null;
}
