import type Phaser from "phaser";
import { getSetting, setSetting } from "../shared/fighter-storage";

/**
 * Fighters someone has played (a fight, practice or the tutorial), by id:
 * fighter select suggests the tutorial for the others. Saved in the settings store.
 */
const REGISTRY_KEY = "playedFighters";

/** Boot: read the saved list (missing or malformed: nobody has played yet). */
export async function loadPlayedFighters(registry: Phaser.Data.DataManager): Promise<void> {
  const saved = await getSetting("playedFighters");
  registry.set(REGISTRY_KEY, Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
}

export function hasPlayed(registry: Phaser.Data.DataManager, fighterId: string): boolean {
  return ((registry.get(REGISTRY_KEY) as string[] | undefined) ?? []).includes(fighterId);
}

export function markPlayed(registry: Phaser.Data.DataManager, fighterIds: readonly string[]): void {
  const played: string[] = registry.get(REGISTRY_KEY) ?? [];
  const added = fighterIds.filter((id) => !played.includes(id));
  if (!added.length) return;
  const next = [...played, ...added];
  registry.set(REGISTRY_KEY, next);
  void setSetting("playedFighters", next).catch(() => {});
}
