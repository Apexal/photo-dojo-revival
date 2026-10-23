import { describe, expect, it } from "vitest";
import { POSE_IDS } from "../src/shared/fighter-model";
import {
  CHUNK_HEADER_BYTES,
  CHUNK_SIZE,
  FighterAssembler,
  FighterCodecError,
  chunkParts,
  encodeFighter,
  exportFighterFile,
  fighterFileName,
  importFighterFile,
  parseChunkHeader,
  validateManifest,
} from "../src/shared/fighter-codec";
import { strToU8, zipSync } from "fflate";
import { fighterSnapshot, makeFighter } from "./helpers";

async function transfer(fighter = makeFighter(), mutate?: (chunks: Uint8Array[]) => Uint8Array[]) {
  const { manifest, parts } = await encodeFighter(fighter);
  let chunks = [...chunkParts(parts, manifest.chunkSize)];
  if (mutate) chunks = mutate(chunks);
  const assembler = new FighterAssembler();
  assembler.accept(JSON.stringify(manifest));
  for (const c of chunks) assembler.accept(c);
  assembler.accept(JSON.stringify({ type: "done" }));
  return { assembler, manifest, parts, chunks };
}

describe("fighter codec", () => {
  it("round-trips a fighter through chunks", async () => {
    const fighter = makeFighter();
    const { assembler } = await transfer(fighter);
    expect(assembler.isDone).toBe(true);
    expect(assembler.missingParts()).toEqual([]);
    const rebuilt = assembler.build();
    expect(await fighterSnapshot(rebuilt)).toEqual(await fighterSnapshot(fighter));
    expect(rebuilt.poses.punch.attackSide).toBe("left");
    expect(rebuilt.sounds.hurt).toBeNull();
  });

  it("round-trips the second poses and extra sound takes", async () => {
    const fighter = makeFighter({ extraTakes: true });
    const { assembler } = await transfer(fighter);
    const rebuilt = assembler.build();
    expect(await fighterSnapshot(rebuilt)).toEqual(await fighterSnapshot(fighter));
    expect(Object.keys(rebuilt.poseVariants).sort()).toEqual(["hurt", "kick", "punch", "win"]);
    expect(rebuilt.poseVariants.punch?.[0].attackSide).toBe("left");
    expect(rebuilt.soundVariants?.attack).toHaveLength(2);
    // ...and through a .photodojo file
    const imported = await importFighterFile(await exportFighterFile(fighter));
    expect(await fighterSnapshot(imported)).toEqual(await fighterSnapshot(fighter));
  });

  it("requires every pose but the second stance: a missing second pose or its image is rejected", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    const parts = manifest.parts.filter((p) => p.partId !== "pose:win:1");
    expect(() => validateManifest({ ...manifest, parts })).toThrow(/win variant 1/);
    expect(() => validateManifest({ ...manifest, variantPoses: manifest.variantPoses.filter((v) => v.poseId !== "kick") })).toThrow(/second kick/);
  });

  it("carries the second stance when there is one (older fighters don't have it)", async () => {
    const plain = makeFighter();
    expect(plain.poseVariants.idle).toBeUndefined();
    const fighter = { ...plain, poseVariants: { ...plain.poseVariants, idle: [{ ...plain.poses.idle, capturedAt: 42 }] } };
    const imported = await importFighterFile(await exportFighterFile(fighter));
    expect(await fighterSnapshot(imported)).toEqual(await fighterSnapshot(fighter));
    expect(imported.poseVariants.idle?.[0].capturedAt).toBe(42);
  });

  it("manifest lists parts, landmarks and anchors", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    expect(manifest.parts.map((p) => p.partId)).toEqual([
      "pose:idle", "pose:walk", "pose:block", "pose:crouch", "pose:punch", "pose:kick", "pose:jump", "pose:hurt", "pose:win",
      "sound:attack", "sound:win", "thumbnail",
      "pose:punch:1", "pose:kick:1", "pose:hurt:1", "pose:win:1",
    ]);
    expect(manifest.landmarks.kick).toHaveLength(33);
    expect(manifest.anchors.jump).toEqual({ x: 256, y: 300 });
    expect(manifest.chunkSize).toBe(16 * 1024);
  });

  it("splits parts at the 16 KB boundary with an 8-byte header", async () => {
    const sizes = { idle: CHUNK_SIZE, walk: CHUNK_SIZE + 1, block: CHUNK_SIZE - 1, crouch: 3 * CHUNK_SIZE };
    const fighter = makeFighter({ poseBytes: sizes });
    const { manifest, parts } = await encodeFighter(fighter);
    const chunks = [...chunkParts(parts)];
    const byPart = (i: number) => chunks.map(parseChunkHeader).filter((c) => c.partIndex === i);
    expect(byPart(0).map((c) => c.payload.byteLength)).toEqual([CHUNK_SIZE]);
    expect(byPart(1).map((c) => c.payload.byteLength)).toEqual([CHUNK_SIZE, 1]);
    expect(byPart(2).map((c) => c.payload.byteLength)).toEqual([CHUNK_SIZE - 1]);
    expect(byPart(3).map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBe(CHUNK_SIZE + CHUNK_HEADER_BYTES);
    expect(manifest.parts[1].byteLength).toBe(CHUNK_SIZE + 1);

    const assembler = new FighterAssembler();
    assembler.accept(JSON.stringify(manifest));
    // Out-of-order delivery is fine.
    for (const c of [...chunks].reverse()) assembler.accept(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer);
    expect(await fighterSnapshot(assembler.build())).toEqual(await fighterSnapshot(fighter));
  });

  it("reports a missing part", async () => {
    const { assembler } = await transfer(makeFighter({ poseBytes: { kick: 2 * CHUNK_SIZE } }), (chunks) =>
      chunks.filter((c) => {
        const { partIndex, chunkIndex } = parseChunkHeader(c);
        return !(partIndex === POSE_IDS.indexOf("kick") && chunkIndex === 1);
      }),
    );
    expect(assembler.missingParts()).toEqual(["pose:kick"]);
    expect(() => assembler.build()).toThrow(/Missing parts: pose:kick/);
  });

  it("rejects chunks with the wrong size", async () => {
    const { manifest, parts } = await encodeFighter(makeFighter());
    const assembler = new FighterAssembler();
    assembler.accept(JSON.stringify(manifest));
    const [first] = chunkParts(parts);
    expect(() => assembler.accept(first.subarray(0, first.byteLength - 1))).toThrow(FighterCodecError);
  });

  it("rejects chunks for unknown parts and chunks before the manifest", async () => {
    const { manifest, parts } = await encodeFighter(makeFighter());
    const [first] = chunkParts(parts);
    expect(() => new FighterAssembler().accept(first)).toThrow(/before the manifest/);
    const bogus = new Uint8Array(first);
    new DataView(bogus.buffer).setUint32(0, 999);
    const a = new FighterAssembler();
    a.accept(JSON.stringify(manifest));
    expect(() => a.accept(bogus)).toThrow(/unknown part/);
  });

  it("validates manifests", async () => {
    const { manifest } = await encodeFighter(makeFighter());
    expect(() => validateManifest({ ...manifest, schemaVersion: 2 })).toThrow(/schema version/);
    expect(() => validateManifest({ ...manifest, parts: manifest.parts.filter((p) => p.poseId !== "win") })).toThrow(/win/);
    expect(() => validateManifest({ ...manifest, landmarks: { ...manifest.landmarks, idle: [] } })).toThrow(/landmarks/);
    expect(() =>
      validateManifest({ ...manifest, parts: [{ ...manifest.parts[0], byteLength: 1e12 }, ...manifest.parts.slice(1)] }),
    ).toThrow(/byteLength/);
  });

  it("tracks progress", async () => {
    const { assembler, parts } = await transfer();
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    expect(assembler.totalBytes).toBe(total);
    expect(assembler.bytesReceived).toBe(total);
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
