import { soundTakes, SOUND_IDS, type CapturedPose, type Fighter, type PoseId, type SoundId } from "../shared/fighter-model";
import { loadFighter, loadFighterSources } from "../shared/fighter-storage";
import { captureTargetsFor } from "../shared/pose-definitions";
import { FIGHTER_SOURCES_VERSION, type FighterSources } from "./capture-draft";

/**
 * Editing a saved fighter (`/studio?edit=<fighterId>`, docs/character-studio.md
 * §6): the fighter and, for one the studio built, the cut-outs it was made
 * from. Without sources (imported from a file) single
 * retakes can't be re-planned at the fighter's scale, so only renaming, the
 * sounds, or capturing every pose again are offered.
 */
export interface EditSession {
  fighter: Fighter;
  /** Null when the fighter has none, or none that cover all its poses. */
  sources: FighterSources | null;
}

/** The `edit` parameter of a studio URL, or null. */
export function editParam(search: string): string | null {
  return new URLSearchParams(search).get("edit") || null;
}

/** The fighter and its sources; null when there's no fighter by that id on this computer. */
export async function loadEditSession(fighterId: string): Promise<EditSession | null> {
  const [fighter, sources] = await Promise.all([loadFighter(fighterId), loadFighterSources<FighterSources>(fighterId)]);
  if (!fighter) return null;
  return { fighter, sources: sources && usableSources(fighter, sources) ? sources : null };
}

/** Sources a retake can build on: current format, this fighter's, and a cut-out for every pose of its archetype. */
export function usableSources(fighter: Pick<Fighter, "fighterId" | "archetype">, sources: FighterSources): boolean {
  if (sources.version !== FIGHTER_SOURCES_VERSION || sources.fighterId !== fighter.fighterId || !Array.isArray(sources.captures)) return false;
  const keys = new Set(sources.captures.map((c) => c.key));
  return captureTargetsFor(fighter.archetype).every((t) => keys.has(t.key));
}

/** The fighter's sprites as a session holds them: main poses by pose id, alternates by capture target ("punch-2"). */
export function sessionPoses(fighter: Fighter): { poses: Partial<Record<PoseId, CapturedPose>>; variants: Partial<Record<string, CapturedPose>> } {
  const poses: Partial<Record<PoseId, CapturedPose>> = {};
  const variants: Partial<Record<string, CapturedPose>> = {};
  for (const t of captureTargetsFor(fighter.archetype)) {
    const pose = t.variant ? fighter.poseVariants[t.poseId]?.[t.variant - 1] : fighter.poses[t.poseId];
    if (!pose) continue;
    if (t.variant) variants[t.key] = pose;
    else poses[t.poseId] = pose;
  }
  return { poses, variants };
}

/** Every recorded take of each sound, the main one first (as the sounds screen keeps them). */
export function sessionSounds(fighter: Fighter): Partial<Record<SoundId, Blob[]>> {
  return Object.fromEntries(SOUND_IDS.map((id) => [id, soundTakes(fighter, id)]));
}

/** An edit saves over the original: same id (career records are keyed by it) and the same place in the roster. */
export function asEditOf(original: Pick<Fighter, "fighterId" | "createdAt">, rebuilt: Fighter): Fighter {
  return { ...rebuilt, fighterId: original.fighterId, createdAt: original.createdAt };
}
