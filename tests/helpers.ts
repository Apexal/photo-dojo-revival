import { POSE_IDS, type CapturedPose, type Fighter, type PoseId } from "../src/shared/fighter-model";
import { anchorTargetFor } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

/** Deterministic pseudo-random bytes so blob contents differ per part. */
export function bytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let x = seed * 2654435761;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export function makeFighter(options: { poseBytes?: Partial<Record<PoseId, number>>; withSounds?: boolean; name?: string; extraTakes?: boolean } = {}): Fighter {
  const poses = Object.fromEntries(
    POSE_IDS.map((poseId, i): [PoseId, CapturedPose] => [
      poseId,
      {
        poseId,
        imageBlob: new Blob([bytes(options.poseBytes?.[poseId] ?? 1000 + i * 37, i + 1)], { type: "image/png" }),
        landmarks: buildStickFigureLandmarks(poseId),
        anchorPoint: anchorTargetFor(poseId),
        capturedAt: 1_700_000_000_000 + i,
        ...(poseId === "punch" ? { attackSide: "left" as const } : {}),
      },
    ]),
  ) as Record<PoseId, CapturedPose>;
  const withSounds = options.withSounds ?? true;
  return {
    fighterId: crypto.randomUUID(),
    name: options.name ?? "Test Fighter",
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    facingDirection: "right",
    poses,
    sounds: {
      attack: withSounds ? new Blob([bytes(3000, 50)], { type: "audio/webm;codecs=opus" }) : null,
      hurt: null,
      win: withSounds ? new Blob([bytes(2500, 51)], { type: "audio/webm;codecs=opus" }) : null,
    },
    thumbnailBlob: new Blob([bytes(400, 99)], { type: "image/png" }),
    poseVariants: Object.fromEntries(
      (["punch", "kick", "hurt", "win"] as const).map((id, i) => [id, [{ ...poses[id], imageBlob: new Blob([bytes(900 + i, 70 + i)], { type: "image/png" }), capturedAt: 10 + i }]]),
    ),
    ...(options.extraTakes ? { soundVariants: { attack: [new Blob([bytes(800, 80)], { type: "audio/webm" }), new Blob([bytes(801, 81)], { type: "audio/webm" })] } } : {}),
  };
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Compares two fighters including blob contents. */
export async function fighterSnapshot(f: Fighter) {
  const poses: Record<string, unknown> = {};
  for (const id of POSE_IDS) {
    const p = f.poses[id];
    poses[id] = { ...p, imageBlob: { type: p.imageBlob.type, bytes: Array.from(await blobBytes(p.imageBlob)) } };
  }
  const sounds: Record<string, unknown> = {};
  for (const [id, blob] of Object.entries(f.sounds)) {
    sounds[id] = blob ? { type: blob.type, bytes: Array.from(await blobBytes(blob)) } : null;
  }
  const poseVariants: Record<string, unknown> = {};
  for (const [id, list] of Object.entries(f.poseVariants ?? {})) {
    poseVariants[id] = await Promise.all((list ?? []).map(async (p) => ({ ...p, imageBlob: Array.from(await blobBytes(p.imageBlob)) })));
  }
  const soundVariants: Record<string, unknown> = {};
  for (const [id, list] of Object.entries(f.soundVariants ?? {})) {
    soundVariants[id] = await Promise.all((list ?? []).map(async (b) => ({ type: b.type, bytes: Array.from(await blobBytes(b)) })));
  }
  return {
    ...f, poses, sounds, thumbnailBlob: Array.from(await blobBytes(f.thumbnailBlob)),
    poseVariants,
    soundVariants: f.soundVariants ? soundVariants : undefined,
  };
}
