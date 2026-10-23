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
