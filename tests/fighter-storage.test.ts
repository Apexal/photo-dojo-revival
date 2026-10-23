import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFighterDb,
  deleteFighter,
  getSetting,
  listFighters,
  loadFighter,
  saveFighter,
  setSetting,
} from "../src/shared/fighter-storage";
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
