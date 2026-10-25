import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { closeFighterDb, getSetting, listFighters, loadFighterSources, saveFighter, saveFighterWithSources, saveImportedFighter, setSetting } from "../src/shared/fighter-storage";
import { CAPTURE_KEYS, captureTargetsFor } from "../src/shared/pose-definitions";
import { FIGHTER_SOURCES_VERSION, type DraftCapture, type FighterSources } from "../src/studio/capture-draft";
import { asEditOf, editParam, loadEditSession, sessionPoses, sessionSounds, usableSources } from "../src/studio/edit-session";
import { makeFighter } from "./helpers";

afterEach(async () => {
  await closeFighterDb();
  indexedDB.deleteDatabase("photo-dojo");
});

const capture = (key: string): DraftCapture => ({
  key, cutPng: new Blob([key], { type: "image/png" }), offsetX: 1, offsetY: 2, capturedAt: 3,
  geometry: { poseId: "idle", landmarks: [], frameWidth: 10, frameHeight: 20 },
});
const sourcesFor = (fighterId: string, keys: readonly string[] = CAPTURE_KEYS): FighterSources =>
  ({ version: FIGHTER_SOURCES_VERSION, fighterId, savedAt: 9, captures: keys.map(capture) });

describe("edit sessions", () => {
  it("reads the edit parameter", () => {
    expect(editParam("?edit=abc-123")).toBe("abc-123");
    expect(editParam("?debug=1&edit=x%20y")).toBe("x y");
    expect(editParam("")).toBeNull();
    expect(editParam("?edit=")).toBeNull();
  });

  it("opens a studio-built fighter with its sources", async () => {
    const f = makeFighter({ name: "Built" });
    await saveFighterWithSources(f, sourcesFor(f.fighterId));
    const session = await loadEditSession(f.fighterId);
    expect(session?.fighter.name).toBe("Built");
    expect(session?.sources?.captures.map((c) => c.key)).toEqual([...CAPTURE_KEYS]);
    const png = session!.sources!.captures[0].cutPng;
    expect(png.size).toBeGreaterThan(0);
  });

  it("opens a fighter without sources (saved directly, or imported over a studio one)", async () => {
    const plain = makeFighter({ name: "Imported" });
    await saveFighter(plain);
    expect(await loadEditSession(plain.fighterId)).toMatchObject({ fighter: { name: "Imported" }, sources: null });

    const studio = makeFighter({ name: "Studio" });
    await saveFighterWithSources(studio, sourcesFor(studio.fighterId));
    await saveImportedFighter({ ...studio, name: "From a file" });
    expect(await loadEditSession(studio.fighterId)).toMatchObject({ fighter: { name: "From a file" }, sources: null });
  });

  it("an unknown id has no session", async () => {
    expect(await loadEditSession("not-on-this-computer")).toBeNull();
  });

  it("only uses sources that cover every pose of the fighter's style", async () => {
    const f = makeFighter();
    expect(usableSources(f, sourcesFor(f.fighterId))).toBe(true);
    expect(usableSources(f, sourcesFor(f.fighterId, CAPTURE_KEYS.filter((k) => k !== "signature")))).toBe(false);
    expect(usableSources(f, sourcesFor("someone-else"))).toBe(false);
    expect(usableSources(f, { ...sourcesFor(f.fighterId), version: 2 as never })).toBe(false);
    // Incomplete sources in storage: edited as a fighter without any.
    await saveFighterWithSources(f, sourcesFor(f.fighterId, ["idle", "walk"]));
    expect((await loadEditSession(f.fighterId))?.sources).toBeNull();
  });

  it("puts the fighter's sprites and every sound take into the session", () => {
    const f = makeFighter({ extraTakes: true });
    const { poses, variants } = sessionPoses(f);
    for (const t of captureTargetsFor(f.archetype)) {
      if (t.variant) expect(variants[t.key]).toBe(f.poseVariants[t.poseId]![t.variant - 1]);
      else expect(poses[t.poseId]).toBe(f.poses[t.poseId]);
    }
    expect(Object.keys(variants).sort()).toEqual(["hurt-2", "idle-2", "kick-2", "punch-2", "win-2"]);
    const sounds = sessionSounds(f);
    expect(sounds.attack).toEqual([f.sounds.attack, ...f.soundVariants!.attack!]);
    expect(sounds.hurt).toEqual([]);
    expect(sounds.win).toEqual([f.sounds.win]);
  });

  it("saves over the original: same id and creation time, everything else from the edit", () => {
    const original = { ...makeFighter({ name: "Old" }), createdAt: 111 };
    const rebuilt = { ...makeFighter({ name: "New" }), createdAt: 999 };
    const edited = asEditOf(original, rebuilt);
    expect(edited).toMatchObject({ fighterId: original.fighterId, createdAt: 111, name: "New" });
    expect(edited.thumbnailBlob).toBe(rebuilt.thumbnailBlob);
  });

  it("an edit saved over the fighter keeps its place in the roster and its career record", async () => {
    const older = { ...makeFighter({ name: "Older" }), createdAt: 1 };
    const f = { ...makeFighter({ name: "Edited" }), createdAt: 2 };
    const newer = { ...makeFighter({ name: "Newer" }), createdAt: 3 };
    for (const x of [older, f, newer]) await saveFighter(x);
    await setSetting("fighterRecords", { [f.fighterId]: { matches: 4, wins: 3 } });
    const edited = asEditOf(f, { ...makeFighter({ name: "Edited II" }), createdAt: 50 });
    await saveFighterWithSources(edited, sourcesFor(f.fighterId));
    expect((await listFighters()).map((x) => x.name)).toEqual(["Newer", "Edited II", "Older"]);
    expect(await loadFighterSources(f.fighterId)).toBeDefined();
    expect(await getSetting("fighterRecords")).toEqual({ [f.fighterId]: { matches: 4, wins: 3 } });
  });
});
