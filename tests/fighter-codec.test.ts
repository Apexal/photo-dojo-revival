import { describe, expect, it } from "vitest";
import {
  encodeFighter,
  exportFighterFile,
  fighterFileName,
  importFighterFile,
  validateManifest,
} from "../src/shared/fighter-codec";
import { strToU8, zipSync } from "fflate";
import { fighterSnapshot, makeFighter } from "./helpers";

describe("fighter codec", () => {
  it("round-trips a fighter", async () => {
    const fighter = makeFighter();
    const rebuilt = await importFighterFile(await exportFighterFile(fighter));
    expect(await fighterSnapshot(rebuilt)).toEqual(await fighterSnapshot(fighter));
    expect(rebuilt.poses.punch.attackSide).toBe("left");
    expect(rebuilt.sounds.hurt).toBeNull();
  });

  it("round-trips the second poses and extra sound takes", async () => {
    const fighter = makeFighter({ extraTakes: true });
    const rebuilt = await importFighterFile(await exportFighterFile(fighter));
    expect(await fighterSnapshot(rebuilt)).toEqual(await fighterSnapshot(fighter));
    expect(Object.keys(rebuilt.poseVariants).sort()).toEqual(["hurt", "idle", "kick", "punch", "win"]);
    expect(rebuilt.archetype).toBe("brawler");
    expect(rebuilt.poseVariants.punch?.[0].attackSide).toBe("left");
    expect(rebuilt.soundVariants?.attack).toHaveLength(2);
  });

  it("requires every pose: a missing second pose or its image is rejected", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    const parts = manifest.parts.filter((p) => p.partId !== "pose:win:1");
    expect(() => validateManifest({ ...manifest, parts })).toThrow(/win variant 1/);
    expect(() => validateManifest({ ...manifest, variantPoses: manifest.variantPoses.filter((v) => v.poseId !== "kick") })).toThrow(/second kick/);
    expect(() => validateManifest({ ...manifest, variantPoses: manifest.variantPoses.filter((v) => v.poseId !== "idle") })).toThrow(/second idle/);
  });

  it("manifest lists parts, landmarks and anchors", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    expect(manifest.parts.map((p) => p.partId)).toEqual([
      "pose:idle", "pose:walk", "pose:block", "pose:crouch", "pose:punch", "pose:kick", "pose:jump", "pose:hurt", "pose:win", "pose:signature", "pose:handshake",
      "sound:attack", "sound:win", "thumbnail",
      "pose:idle:1", "pose:punch:1", "pose:kick:1", "pose:hurt:1", "pose:win:1",
    ]);
    expect(manifest.landmarks.kick).toHaveLength(33);
    expect(manifest.anchors.jump).toEqual({ x: 256, y: 300 });
    expect(manifest.chunkSize).toBe(16 * 1024);
  });

  it("validates manifests", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    expect(() => validateManifest({ ...manifest, schemaVersion: 1 })).toThrow(/schema version/);
    expect(() => validateManifest({ ...manifest, archetype: "ninja" })).toThrow(/archetype/);
    // Untrusted: no parts it doesn't need, no odd types, nothing huge.
    const pose = manifest.parts[0];
    expect(() => validateManifest({ ...manifest, parts: [...manifest.parts, { ...pose, partId: "again" }] })).toThrow(/two parts/);
    expect(() => validateManifest({ ...manifest, parts: [...manifest.parts, { ...pose, partId: "extra", variant: 5 }] })).toThrow(/bad pose/);
    expect(() => validateManifest({ ...manifest, parts: [{ ...pose, mimeType: "text/html" }, ...manifest.parts.slice(1)] })).toThrow(/mimeType/);
    expect(() => validateManifest({ ...manifest, name: "x".repeat(500) })).toThrow(/name/);
    const big = manifest.parts.map((p) => ({ ...p, byteLength: 7 * 1024 * 1024 }));
    expect(() => validateManifest({ ...manifest, parts: big })).toThrow(/too big/);
    expect(() => validateManifest({ ...manifest, parts: manifest.parts.filter((p) => p.poseId !== "win") })).toThrow(/win/);
    expect(() => validateManifest({ ...manifest, landmarks: { ...manifest.landmarks, idle: [] } })).toThrow(/landmarks/);
    expect(() =>
      validateManifest({ ...manifest, parts: [{ ...manifest.parts[0], byteLength: 1e12 }, ...manifest.parts.slice(1)] }),
    ).toThrow(/byteLength/);
  });
});

describe(".photodojo files", () => {
  it("round-trips through export/import", async () => {
    const fighter = makeFighter({ name: "Big Frank" });
    const file = await exportFighterFile(fighter);
    expect(file.type).toBe("application/zip");
    const imported = await importFighterFile(file);
    expect(await fighterSnapshot(imported)).toEqual(await fighterSnapshot(fighter));
  });

  it("rejects non-zip and zip-without-manifest", async () => {
    await expect(importFighterFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(/couldn't unzip/);
    await expect(importFighterFile(zipSync({ "x.txt": strToU8("hi") }))).rejects.toThrow(/no fighter.json/);
  });

  it("names files safely", () => {
    expect(fighterFileName({ name: "Big Frank!!" })).toBe("Big-Frank.photodojo");
    expect(fighterFileName({ name: "   " })).toBe("fighter.photodojo");
  });
});
