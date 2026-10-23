import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Fighter } from "./fighter-model";

export const DB_NAME = "photo-dojo";
/** v2 adds the `drafts` store (in-progress captures on the phone). */
export const DB_VERSION = 2;

export interface Settings {
  controllerMapping: Record<string, unknown>;
  debugHitboxes: boolean;
  voicePrompts: boolean;
  persistRequested: boolean;
  persisted: boolean;
  backupNoticeShown: boolean;
  rumble: boolean;
  /** 0..1: the bundled game sounds (hits, blocks, the clock). */
  gameVolume: number;
  /** 0..1: the fighters' voices (captured clips or their stand-ins). */
  voiceVolume: number;
  announcerVolume: number;
  /** 0..1: stage soundtracks. */
  musicVolume: number;
  screenShake: boolean;
  /** The fight camera zooms in when the fighters are close. */
  dynamicCamera: boolean;
  /** Morph between some captures (ARAP) instead of cutting. */
  poseTweening: boolean;
  /** Keyboard remapping; key codes per action for each keyboard half. */
  keyBindings: unknown;
  /** Ids of fighters that have been played; fighter select suggests the tutorial for the rest. */
  playedFighters: string[];
  /** Career records by fighter id (game/fighter-records.ts). */
  fighterRecords: Record<string, unknown>;
}

interface PhotoDojoDB extends DBSchema {
  fighters: { key: string; value: Fighter };
  settings: { key: string; value: unknown };
  drafts: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<PhotoDojoDB>> | null = null;

export function openFighterDb(): Promise<IDBPDatabase<PhotoDojoDB>> {
  dbPromise ??= openDB<PhotoDojoDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("fighters")) db.createObjectStore("fighters", { keyPath: "fighterId" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
    },
  });
  return dbPromise;
}

/** For tests: drop the cached connection. */
export async function closeFighterDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

/**
 * Ask the browser not to evict our data. Called once, on the first write.
 * Returns whether storage is persistent (false if unsupported or denied).
 */
export async function requestPersistence(): Promise<boolean> {
  const db = await openFighterDb();
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!(await db.get("settings", "persistRequested")) && storage?.persist) {
    const granted = await storage.persist().catch(() => false);
    await db.put("settings", true, "persistRequested");
    await db.put("settings", granted, "persisted");
    return granted;
  }
  if (storage?.persisted) return storage.persisted().catch(() => false);
  return Boolean(await db.get("settings", "persisted"));
}

export async function saveFighter(fighter: Fighter): Promise<void> {
  const db = await openFighterDb();
  await db.put("fighters", fighter);
  await requestPersistence();
}

export async function loadFighter(fighterId: string): Promise<Fighter | undefined> {
  return (await openFighterDb()).get("fighters", fighterId);
}

/** Newest first. */
export async function listFighters(): Promise<Fighter[]> {
  const all = await (await openFighterDb()).getAll("fighters");
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteFighter(fighterId: string): Promise<void> {
  await (await openFighterDb()).delete("fighters", fighterId);
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | undefined> {
  return (await (await openFighterDb()).get("settings", key)) as Settings[K] | undefined;
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await (await openFighterDb()).put("settings", value, key);
}

/** Whether storage is currently persistent; false when the API is unavailable. */
export async function isStoragePersisted(): Promise<boolean> {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage?.persisted) return false;
  return storage.persisted().catch(() => false);
}

const DRAFT_KEY = "current";

/** The phone's in-progress capture, so a reload or a locked phone doesn't lose it. */
export async function saveDraft<T>(draft: T): Promise<void> {
  await (await openFighterDb()).put("drafts", draft, DRAFT_KEY);
}

export async function loadDraft<T>(): Promise<T | undefined> {
  return (await (await openFighterDb()).get("drafts", DRAFT_KEY)) as T | undefined;
}

export async function clearDraft(): Promise<void> {
  await (await openFighterDb()).delete("drafts", DRAFT_KEY);
}
