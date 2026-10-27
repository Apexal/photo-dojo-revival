import { ARCHETYPES } from "../shared/archetypes";
import type { AttackId, GrabId } from "../shared/frame-data";

/** Player-facing attack names (stats pages). */
export const MOVE_NAMES: Record<AttackId, string> = {
  punch: "Punch", kick: "Kick", uppercut: "Uppercut", lowKick: "Low kick", jumpKick: "Jump kick",
  charge: ARCHETYPES.brawler.moveName, flyingKnee: ARCHETYPES.acrobat.moveName,
};

/** The same for grabs. */
export const GRAB_NAMES: Record<GrabId, string> = { throw: "Throw", bearHug: ARCHETYPES.grappler.moveName };

export const moveName = (move: AttackId | GrabId): string => (move in MOVE_NAMES ? MOVE_NAMES[move as AttackId] : GRAB_NAMES[move as GrabId]);
