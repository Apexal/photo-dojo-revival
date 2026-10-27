import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  DB_NAME,
  DB_VERSION,
  closeFighterDb,
  deleteFighter,
  getSetting,
  listFighters,
  loadFighter,
  loadFighterSources,
  onDbBlocked,
  openFighterDb,
  saveFighter,
  saveFighterWithSources,
  saveImportedFighter,
  setSetting,
} from "../src/shared/fighter-storage";
import { FIGHTER_SOURCES_VERSION, type FighterSources } from "../src/studio/capture-draft";
import { fighterSnapshot, makeFighter } from "./helpers";

afterEach(async () => {
  await closeFighterDb();
  indexedDB.deleteDatabase("photo-dojo");
});

describe("fighter storage", () => {
  it("saves, loads, lists newest first, and deletes", async () => {
    const a = { ...makeFighter({ name: "A" }), createdAt: 1 };
    const b = { ...makeFighter({ name: "B" }), createdAt: 2 };
    await saveFighter(a);
    await saveFighter(b);
    expect((await listFighters()).map((f) => f.name)).toEqual(["B", "A"]);
    const loaded = await loadFighter(a.fighterId);
    expect(loaded).toBeDefined();
    expect(await fighterSnapshot(loaded!)).toEqual(await fighterSnapshot(a));
    await deleteFighter(a.fighterId);
    expect((await listFighters()).map((f) => f.name)).toEqual(["B"]);
  });

  it("keeps a studio fighter's sources with it, and drops them with it", async () => {
    const f = makeFighter({ name: "Studio" });
    const sources: FighterSources = {
      version: FIGHTER_SOURCES_VERSION, fighterId: f.fighterId, savedAt: 5,
      captures: [{ key: "idle", cutPng: new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }), offsetX: 1, offsetY: 2, capturedAt: 3,
        geometry: { poseId: "idle", landmarks: [], frameWidth: 1080, frameHeight: 1920 } }],
    };
    await saveFighterWithSources(f, sources);
    const back = await loadFighterSources<FighterSources>(f.fighterId);
    expect(back?.captures[0].geometry.frameHeight).toBe(1920);
    expect(Array.from(new Uint8Array(await back!.captures[0].cutPng.arrayBuffer()))).toEqual([9, 8, 7]);
    // A rename (plain save) keeps them.
    await saveFighter({ ...f, name: "Renamed" });
    expect(await loadFighterSources(f.fighterId)).toBeDefined();
    await deleteFighter(f.fighterId);
    expect(await loadFighter(f.fighterId)).toBeUndefined();
    expect(await loadFighterSources(f.fighterId)).toBeUndefined();
    await expect(saveFighterWithSources(f, { ...sources, fighterId: "other" })).rejects.toThrow(/another fighter/);
  });

  it("an import over a studio fighter's id drops the sources (they describe another version)", async () => {
    const f = makeFighter({ name: "Original" });
    const sources: FighterSources = { version: FIGHTER_SOURCES_VERSION, fighterId: f.fighterId, savedAt: 1, captures: [] };
    await saveFighterWithSources(f, sources);
    await saveImportedFighter({ ...f, name: "From a file" });
    expect((await loadFighter(f.fighterId))?.name).toBe("From a file");
    expect(await loadFighterSources(f.fighterId)).toBeUndefined();
  });


  it("an older tab holding the database open: told it's blocked; this tab gives way to a newer one", async () => {
    await closeFighterDb();
    // An old tab (v2) that doesn't close for upgrades.
    const old = await openDB(DB_NAME, 2, { upgrade(db) { db.createObjectStore("fighters", { keyPath: "fighterId" }); } });
    let blocked = 0;
    const off = onDbBlocked(() => { blocked++; old.close(); });
    await openFighterDb();
    off();
    expect(blocked).toBe(1);
    // A newer tab upgrading: ours closes (blocking), so it isn't blocked, and ours reopens on next use.
    const newer = await openDB(DB_NAME, DB_VERSION + 1);
    newer.close();
    await expect(openFighterDb()).rejects.toThrow(); // the database is newer than this code now
    indexedDB.deleteDatabase(DB_NAME);
    await saveFighter(makeFighter({ name: "After" }));
    expect((await listFighters()).map((x) => x.name)).toEqual(["After"]);
  });

  it("stores settings", async () => {
    expect(await getSetting("debugHitboxes")).toBeUndefined();
    await setSetting("debugHitboxes", true);
    expect(await getSetting("debugHitboxes")).toBe(true);
  });
});

import { clearDraft, loadDraft, saveDraft } from "../src/shared/fighter-storage";

describe("capture drafts", () => {
  it("saves, loads and clears the in-progress capture, blobs included", async () => {
    expect(await loadDraft()).toBeUndefined();
    await saveDraft({ version: 1, name: "Half done", cut: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
    const back = await loadDraft<{ name: string; cut: Blob }>();
    expect(back?.name).toBe("Half done");
    expect(Array.from(new Uint8Array(await back!.cut.arrayBuffer()))).toEqual([1, 2, 3]);
    await clearDraft();
    expect(await loadDraft()).toBeUndefined();
  });
});

import type Phaser from "phaser";
import { hasPlayed, loadPlayedFighters, markPlayed } from "../src/game/played-fighters";

describe("played fighters", () => {
  /** Just the bit of Phaser's DataManager the module uses. */
  const registry = () => {
    const data = new Map<string, unknown>();
    return { get: (k: string) => data.get(k), set: (k: string, v: unknown) => data.set(k, v) } as unknown as Phaser.Data.DataManager;
  };

  it("starts with nobody played, remembers plays across sessions, and ignores junk", async () => {
    const a = registry();
    await loadPlayedFighters(a);
    expect(hasPlayed(a, "x")).toBe(false);
    markPlayed(a, ["x", "y"]);
    markPlayed(a, ["x"]);
    expect(hasPlayed(a, "x")).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // the save is fire-and-forget
    const b = registry();
    await loadPlayedFighters(b);
    expect(["x", "y", "z"].map((id) => hasPlayed(b, id))).toEqual([true, true, false]);
    expect(await getSetting("playedFighters")).toEqual(["x", "y"]);

    await setSetting("playedFighters", "nonsense" as unknown as string[]);
    await loadPlayedFighters(b);
    expect(hasPlayed(b, "x")).toBe(false);
  });
});

import { addMatch, emptyRecord, favoriteMoveOf, forgetFighterRecord, headToHead, loadFighterRecords, parseRecord, recordMatch, recordOf, winLoss } from "../src/game/fighter-records";
import type { PlayerStats } from "../src/simulation/match-stats";

describe("fighter records", () => {
  const registry = () => {
    const data = new Map<string, unknown>();
    return { get: (k: string) => data.get(k), set: (k: string, v: unknown) => data.set(k, v) } as unknown as Phaser.Data.DataManager;
  };
  const stats = (over: Partial<PlayerStats> = {}): PlayerStats => ({
    roundsWon: 0, perfectRounds: 0, damageDealt: 0, attacks: 0, hits: 0, blockedByOpponent: 0, blocks: 0,
    throws: 0, throwTechs: 0, knockdowns: 0, taunts: 0, snubs: 0, longestStreak: 0, favoriteMove: null, movesLanded: {}, ...over,
  });

  it("adds a match up: result from the fighter's side, totals summed, best hit streak kept", () => {
    let r = addMatch(emptyRecord(), stats({ roundsWon: 2, damageDealt: 150, hits: 9, attacks: 12, longestStreak: 4 }), 0, 0);
    r = addMatch(r, stats({ roundsWon: 1, damageDealt: 80, hits: 3, attacks: 10, longestStreak: 2 }), 1, 0);
    r = addMatch(r, stats({ longestStreak: 5 }), 1, "draw");
    expect(r).toMatchObject({ matches: 3, wins: 1, losses: 1, draws: 1, roundsWon: 3, damageDealt: 230, hits: 12, attacks: 22, longestStreak: 5 });
    expect(winLoss(r)).toBe("1W 1L 1D");
    expect(winLoss({ ...r, draws: 0 })).toBe("1W 1L");
  });

  it("sums clean hits by move into a career favorite", () => {
    let r = addMatch(emptyRecord(), stats({ movesLanded: { punch: 3, kick: 1 } }), 0, 0);
    expect(favoriteMoveOf(r)).toBe("punch");
    r = addMatch(r, stats({ movesLanded: { kick: 4 } }), 0, 0);
    expect(r.movesLanded).toEqual({ punch: 3, kick: 5 });
    expect(favoriteMoveOf(r)).toBe("kick");
    expect(favoriteMoveOf(emptyRecord())).toBeNull();
  });

  it("reads malformed saves as zeros", () => {
    expect(parseRecord("junk")).toEqual(emptyRecord());
    expect(parseRecord({ wins: 3, losses: -1, draws: "2", hits: NaN })).toEqual({ ...emptyRecord(), wins: 3 });
    expect(parseRecord({ movesLanded: { punch: 2, fireball: 9, kick: "x" }, versus: { y: { wins: 1, losses: "?" }, z: 5 } }))
      .toEqual({ ...emptyRecord(), movesLanded: { punch: 2 }, versus: { y: { wins: 1, losses: 0, draws: 0 } } });
  });


  it("records both sides (a mirror match twice), persists, and forgets deleted fighters", async () => {
    const a = registry();
    await loadFighterRecords(a);
    expect(recordOf(a, "x")).toBeNull();
    recordMatch(a, ["x", "y"], [stats({ roundsWon: 2 }), stats()], 0);
    recordMatch(a, ["x", "x"], [stats(), stats({ roundsWon: 2 })], 1);
    expect(recordOf(a, "x")).toMatchObject({ matches: 3, wins: 2, losses: 1, roundsWon: 4 });
    expect(recordOf(a, "y")).toMatchObject({ matches: 1, wins: 0, losses: 1 });
    // The rivalry, from each side; a mirror match isn't one.
    recordMatch(a, ["y", "x"], [stats(), stats()], "draw");
    expect(headToHead(a, "x", "y")).toEqual({ wins: 1, losses: 0, draws: 1 });
    expect(headToHead(a, "y", "x")).toEqual({ wins: 0, losses: 1, draws: 1 });
    expect(headToHead(a, "x", "x")).toBeNull();
    expect(recordOf(a, "x")!.versus).not.toHaveProperty("x");
    await new Promise((r) => setTimeout(r, 20)); // the save is fire-and-forget
    const b = registry();
    await loadFighterRecords(b);
    expect(recordOf(b, "x")).toEqual(recordOf(a, "x"));
    forgetFighterRecord(b, "x");
    expect(recordOf(b, "x")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await loadFighterRecords(a);
    expect(recordOf(a, "x")).toBeNull();
    expect(recordOf(a, "y")).not.toBeNull();
    expect(recordOf(a, "y")!.versus).toEqual({}); // x's gone from y's rivals too

    await setSetting("fighterRecords", ["nonsense"] as unknown as Record<string, unknown>);
    await loadFighterRecords(a);
    expect(recordOf(a, "y")).toBeNull();
  });
});
