import { ARCHETYPES } from "../shared/archetypes";
import type { AttackId } from "../shared/frame-data";

/** Player-facing attack names (stats pages). */
export const MOVE_NAMES: Record<AttackId, string> = {
  punch: "Punch", kick: "Kick", uppercut: "Uppercut", lowKick: "Low kick", jumpKick: "Jump kick",
  charge: ARCHETYPES.brawler.moveName, flyingKnee: ARCHETYPES.acrobat.moveName,
};
