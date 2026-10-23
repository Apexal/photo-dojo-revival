import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { REQUIRED_VARIANT_POSES } from "./pose-definitions";
import {
  LANDMARK_COUNT,
  POSE_IDS,
  SOUND_IDS,
  isPoseId,
  isSoundId,
  type CapturedPose,
  type Fighter,
  type LimbSide,
  type NormalizedLandmark,
  type PoseId,
  type SoundId,
} from "./fighter-model";

/** Payload bytes per binary chunk; each chunk message also carries an 8-byte header. */
export const CHUNK_SIZE = 16 * 1024;
export const CHUNK_HEADER_BYTES = 8;
/** Generous cap so a malicious manifest can't make us allocate gigabytes. */
export const MAX_PART_BYTES = 8 * 1024 * 1024;
export const FIGHTER_FILE_EXTENSION = ".photodojo";

export type PartKind = "pose" | "sound" | "thumbnail";

export interface ManifestPart {
  partId: string;
  kind: PartKind;
  poseId?: PoseId;
  soundId?: SoundId;
  /** Alternate pose / extra sound take (≥ 1); absent for the main one. */
  variant?: number;
  byteLength: number;
  mimeType: string;
}

export interface FighterManifest {
  type: "manifest";
  fighterId: string;
  name: string;
  schemaVersion: 1;
  createdAt: number;
  chunkSize: number;
  parts: ManifestPart[];
  landmarks: Record<PoseId, NormalizedLandmark[]>;
  anchors: Record<PoseId, { x: number; y: number }>;
  poseMeta: Record<PoseId, { capturedAt: number; attackSide?: LimbSide }>;
  /** The second versions of punch, kick, hurt and win. */
  variantPoses: VariantPoseMeta[];
}

export interface VariantPoseMeta {
  poseId: PoseId;
  variant: number;
  landmarks: NormalizedLandmark[];
  anchor: { x: number; y: number };
  capturedAt: number;
  attackSide?: LimbSide;
}

export const MAX_VARIANTS = 8;

export type TransferMessage =
  | FighterManifest
  | { type: "done" }
  | { type: "ack"; fighterId: string }
  | { type: "error"; message: string };

export class FighterCodecError extends Error {
  override name = "FighterCodecError";
}

export interface EncodedFighter {
  manifest: FighterManifest;
  /** Index matches manifest.parts. */
  parts: Uint8Array[];
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

export async function encodeFighter(fighter: Fighter, chunkSize = CHUNK_SIZE): Promise<EncodedFighter> {
  const parts: ManifestPart[] = [];
  const data: Uint8Array[] = [];
  const push = async (part: Omit<ManifestPart, "byteLength" | "mimeType">, blob: Blob, fallbackType: string) => {
    const bytes = await bytesOf(blob);
    parts.push({ ...part, byteLength: bytes.byteLength, mimeType: blob.type || fallbackType });
    data.push(bytes);
  };
  for (const poseId of POSE_IDS) {
    await push({ partId: `pose:${poseId}`, kind: "pose", poseId }, fighter.poses[poseId].imageBlob, "image/png");
  }
  for (const soundId of SOUND_IDS) {
    const blob = fighter.sounds[soundId];
    if (blob) await push({ partId: `sound:${soundId}`, kind: "sound", soundId }, blob, "audio/webm");
  }
  await push({ partId: "thumbnail", kind: "thumbnail" }, fighter.thumbnailBlob, "image/png");
  const variantPoses: VariantPoseMeta[] = [];
  for (const poseId of POSE_IDS) {
    for (const [i, pose] of (fighter.poseVariants?.[poseId] ?? []).entries()) {
      const variant = i + 1;
      await push({ partId: `pose:${poseId}:${variant}`, kind: "pose", poseId, variant }, pose.imageBlob, "image/png");
      variantPoses.push({
        poseId, variant, landmarks: pose.landmarks, anchor: pose.anchorPoint, capturedAt: pose.capturedAt,
        ...(pose.attackSide ? { attackSide: pose.attackSide } : {}),
      });
    }
  }
  for (const soundId of SOUND_IDS) {
    for (const [i, blob] of (fighter.soundVariants?.[soundId] ?? []).entries()) {
      await push({ partId: `sound:${soundId}:${i + 1}`, kind: "sound", soundId, variant: i + 1 }, blob, "audio/webm");
    }
  }

  const pick = <T>(f: (p: CapturedPose) => T) =>
    Object.fromEntries(POSE_IDS.map((id) => [id, f(fighter.poses[id])])) as Record<PoseId, T>;

  return {
    manifest: {
      type: "manifest",
      fighterId: fighter.fighterId,
      name: fighter.name,
      schemaVersion: 1,
      createdAt: fighter.createdAt,
      chunkSize,
      parts,
      landmarks: pick((p) => p.landmarks),
      anchors: pick((p) => p.anchorPoint),
      poseMeta: pick((p) => (p.attackSide ? { capturedAt: p.capturedAt, attackSide: p.attackSide } : { capturedAt: p.capturedAt })),
      variantPoses,
    },
    parts: data,
  };
}

export function chunkCount(byteLength: number, chunkSize: number): number {
  return Math.ceil(byteLength / chunkSize);
}

/** Binary chunk messages for all parts: [u32 part index][u32 chunk index][payload]. */
export function* chunkParts(parts: Uint8Array[], chunkSize = CHUNK_SIZE): Generator<Uint8Array> {
  for (let p = 0; p < parts.length; p++) {
    const bytes = parts[p];
    const count = chunkCount(bytes.byteLength, chunkSize);
    for (let c = 0; c < count; c++) {
      const payload = bytes.subarray(c * chunkSize, Math.min(bytes.byteLength, (c + 1) * chunkSize));
      const message = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
      const view = new DataView(message.buffer);
      view.setUint32(0, p);
      view.setUint32(4, c);
      message.set(payload, CHUNK_HEADER_BYTES);
      yield message;
    }
  }
}

export function parseChunkHeader(message: Uint8Array): { partIndex: number; chunkIndex: number; payload: Uint8Array } {
  if (message.byteLength < CHUNK_HEADER_BYTES) throw new FighterCodecError("Chunk shorter than its header");
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return { partIndex: view.getUint32(0), chunkIndex: view.getUint32(4), payload: message.subarray(CHUNK_HEADER_BYTES) };
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isPoint = (p: unknown): p is { x: number; y: number } =>
  !!p && typeof p === "object" && isFiniteNumber((p as { x: unknown }).x) && isFiniteNumber((p as { y: unknown }).y);

/** Throws FighterCodecError if the manifest is malformed. */
export function validateManifest(value: unknown): FighterManifest {
  const fail = (why: string): never => { throw new FighterCodecError(`Invalid manifest: ${why}`); };
  if (!value || typeof value !== "object") fail("not an object");
  const m = value as FighterManifest;
  if (m.type !== "manifest") fail("wrong type");
  if (m.schemaVersion !== 1) fail(`unsupported schema version ${String(m.schemaVersion)}`);
  if (typeof m.fighterId !== "string" || !m.fighterId) fail("missing fighterId");
  if (typeof m.name !== "string") fail("missing name");
  if (!isFiniteNumber(m.createdAt)) fail("missing createdAt");
  if (!Number.isInteger(m.chunkSize) || m.chunkSize <= 0 || m.chunkSize > 256 * 1024) fail("bad chunkSize");
  if (!Array.isArray(m.parts)) fail("parts must be an array");
  const seen = new Set<string>();
  for (const part of m.parts) {
    if (typeof part.partId !== "string" || seen.has(part.partId)) fail("duplicate or missing partId");
    seen.add(part.partId);
    if (!Number.isInteger(part.byteLength) || part.byteLength < 0 || part.byteLength > MAX_PART_BYTES) fail(`bad byteLength for ${part.partId}`);
    if (typeof part.mimeType !== "string") fail(`bad mimeType for ${part.partId}`);
    if (part.kind === "pose" && !isPoseId(part.poseId)) fail(`bad poseId for ${part.partId}`);
    if (part.kind === "sound" && !isSoundId(part.soundId)) fail(`bad soundId for ${part.partId}`);
    if (!["pose", "sound", "thumbnail"].includes(part.kind)) fail(`bad kind for ${part.partId}`);
    if (part.variant !== undefined && (!Number.isInteger(part.variant) || part.variant < 1 || part.variant > MAX_VARIANTS)) {
      fail(`bad variant for ${part.partId}`);
    }
  }
  {
    if (!Array.isArray(m.variantPoses)) fail("variantPoses must be an array");
    for (const poseId of REQUIRED_VARIANT_POSES) {
      if (!m.variantPoses.some((v) => v.poseId === poseId && v.variant === 1)) fail(`missing the second ${poseId} pose`);
    }
    for (const v of m.variantPoses) {
      if (!isPoseId(v.poseId) || !Number.isInteger(v.variant) || v.variant < 1 || v.variant > MAX_VARIANTS) fail("bad pose variant");
      if (!Array.isArray(v.landmarks) || v.landmarks.length !== LANDMARK_COUNT || !v.landmarks.every((l) => isPoint(l) && isFiniteNumber(l.visibility))) {
        fail(`bad landmarks for ${v.poseId} variant ${v.variant}`);
      }
      if (!isPoint(v.anchor) || !isFiniteNumber(v.capturedAt)) fail(`bad metadata for ${v.poseId} variant ${v.variant}`);
      if (!m.parts.some((p) => p.kind === "pose" && p.poseId === v.poseId && p.variant === v.variant)) fail(`no image for ${v.poseId} variant ${v.variant}`);
    }
  }
  for (const poseId of POSE_IDS) {
    if (!m.parts.some((p) => p.kind === "pose" && p.poseId === poseId && !p.variant)) fail(`no image for pose ${poseId}`);
    const lms = m.landmarks?.[poseId];
    if (!Array.isArray(lms) || lms.length !== LANDMARK_COUNT || !lms.every((l) => isPoint(l) && isFiniteNumber(l.visibility))) {
      fail(`bad landmarks for pose ${poseId}`);
    }
    if (!isPoint(m.anchors?.[poseId])) fail(`bad anchor for pose ${poseId}`);
    if (!isFiniteNumber(m.poseMeta?.[poseId]?.capturedAt)) fail(`bad metadata for pose ${poseId}`);
  }
  if (!m.parts.some((p) => p.kind === "thumbnail")) fail("no thumbnail");
  return m;
}

/** Builds a Fighter from a manifest and its fully received parts. */
export function decodeFighter(manifest: FighterManifest, parts: Uint8Array[]): Fighter {
  validateManifest(manifest);
  if (parts.length !== manifest.parts.length) throw new FighterCodecError("Part count doesn't match the manifest");
  manifest.parts.forEach((part, i) => {
    if (parts[i]?.byteLength !== part.byteLength) {
      throw new FighterCodecError(`Part ${part.partId} is ${parts[i]?.byteLength ?? 0} bytes, expected ${part.byteLength}`);
    }
  });
  const blobOf = (i: number) => new Blob([parts[i] as Uint8Array<ArrayBuffer>], { type: manifest.parts[i].mimeType });
  const indexOf = (pred: (p: ManifestPart) => boolean) => manifest.parts.findIndex(pred);

  const poses = Object.fromEntries(
    POSE_IDS.map((poseId) => {
      const meta = manifest.poseMeta[poseId];
      const pose: CapturedPose = {
        poseId,
        imageBlob: blobOf(indexOf((p) => p.kind === "pose" && p.poseId === poseId && !p.variant)),
        landmarks: manifest.landmarks[poseId].map((l) => ({ x: l.x, y: l.y, visibility: l.visibility })),
        anchorPoint: { x: manifest.anchors[poseId].x, y: manifest.anchors[poseId].y },
        capturedAt: meta.capturedAt,
      };
      if (meta.attackSide === "left" || meta.attackSide === "right") pose.attackSide = meta.attackSide;
      return [poseId, pose];
    }),
  ) as Record<PoseId, CapturedPose>;

  const sounds = Object.fromEntries(
    SOUND_IDS.map((soundId) => {
      const i = indexOf((p) => p.kind === "sound" && p.soundId === soundId && !p.variant);
      return [soundId, i >= 0 ? blobOf(i) : null];
    }),
  ) as Record<SoundId, Blob | null>;

  const poseVariants: Partial<Record<PoseId, CapturedPose[]>> = {};
  for (const v of [...manifest.variantPoses].sort((a, b) => a.variant - b.variant)) {
    const pose: CapturedPose = {
      poseId: v.poseId,
      imageBlob: blobOf(indexOf((p) => p.kind === "pose" && p.poseId === v.poseId && p.variant === v.variant)),
      landmarks: v.landmarks.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility })),
      anchorPoint: { x: v.anchor.x, y: v.anchor.y },
      capturedAt: v.capturedAt,
      ...(v.attackSide === "left" || v.attackSide === "right" ? { attackSide: v.attackSide } : {}),
    };
    (poseVariants[v.poseId] ??= []).push(pose);
  }
  const soundVariants: Partial<Record<SoundId, Blob[]>> = {};
  manifest.parts
    .map((part, i) => ({ part, i }))
    .filter(({ part }) => part.kind === "sound" && part.variant)
    .sort((a, b) => a.part.variant! - b.part.variant!)
    .forEach(({ part, i }) => (soundVariants[part.soundId!] ??= []).push(blobOf(i)));

  return {
    poseVariants,
    ...(Object.keys(soundVariants).length ? { soundVariants } : {}),
    fighterId: manifest.fighterId,
    name: manifest.name,
    schemaVersion: 1,
    createdAt: manifest.createdAt,
    facingDirection: "right",
    poses,
    sounds,
    thumbnailBlob: blobOf(indexOf((p) => p.kind === "thumbnail")),
  };
}

/**
 * Reassembles a fighter from data-channel messages: manifest (JSON string),
 * binary chunks in any order, then {type:"done"}.
 */
export class FighterAssembler {
  private manifest: FighterManifest | null = null;
  private buffers: Uint8Array[] = [];
  private received: Set<number>[] = [];
  private done = false;
  bytesReceived = 0;

  get totalBytes(): number {
    return this.manifest?.parts.reduce((sum, p) => sum + p.byteLength, 0) ?? 0;
  }

  get fighterName(): string | null {
    return this.manifest?.name ?? null;
  }

  get isDone(): boolean {
    return this.done;
  }

  /** Returns the parsed control message for strings, or null for binary chunks. */
  accept(message: string | ArrayBuffer | Uint8Array): TransferMessage | null {
    if (typeof message === "string") {
      let parsed: TransferMessage;
      try {
        parsed = JSON.parse(message);
      } catch {
        throw new FighterCodecError("Control message is not JSON");
      }
      if (parsed.type === "manifest") this.start(validateManifest(parsed));
      else if (parsed.type === "done") {
        if (!this.manifest) throw new FighterCodecError("Got done before the manifest");
        this.done = true;
      }
      return parsed;
    }
    this.acceptChunk(message instanceof Uint8Array ? message : new Uint8Array(message));
    return null;
  }

  private start(manifest: FighterManifest): void {
    this.manifest = manifest;
    this.buffers = manifest.parts.map((p) => new Uint8Array(p.byteLength));
    this.received = manifest.parts.map(() => new Set());
    this.done = false;
    this.bytesReceived = 0;
  }

  private acceptChunk(message: Uint8Array): void {
    const manifest = this.manifest;
    if (!manifest) throw new FighterCodecError("Got a chunk before the manifest");
    const { partIndex, chunkIndex, payload } = parseChunkHeader(message);
    const part = manifest.parts[partIndex];
    if (!part) throw new FighterCodecError(`Chunk for unknown part ${partIndex}`);
    const count = chunkCount(part.byteLength, manifest.chunkSize);
    if (chunkIndex >= count) throw new FighterCodecError(`Chunk ${chunkIndex} out of range for ${part.partId}`);
    const offset = chunkIndex * manifest.chunkSize;
    const expected = Math.min(manifest.chunkSize, part.byteLength - offset);
    if (payload.byteLength !== expected) {
      throw new FighterCodecError(`Chunk ${chunkIndex} of ${part.partId} is ${payload.byteLength} bytes, expected ${expected}`);
    }
    if (this.received[partIndex].has(chunkIndex)) return;
    this.buffers[partIndex].set(payload, offset);
    this.received[partIndex].add(chunkIndex);
    this.bytesReceived += payload.byteLength;
  }

  missingParts(): string[] {
    if (!this.manifest) return ["manifest"];
    const chunkSize = this.manifest.chunkSize;
    return this.manifest.parts
      .filter((p, i) => this.received[i].size !== chunkCount(p.byteLength, chunkSize))
      .map((p) => p.partId);
  }

  build(): Fighter {
    if (!this.manifest) throw new FighterCodecError("No manifest received");
    const missing = this.missingParts();
    if (missing.length) throw new FighterCodecError(`Missing parts: ${missing.join(", ")}`);
    return decodeFighter(this.manifest, this.buffers);
  }
}

// ---------------------------------------------------------------------------
// .photodojo file: a zip with fighter.json + PNGs + audio clips.

const extensionFor = (mime: string) =>
  mime.includes("png") ? "png" : mime.includes("webm") ? "webm" : mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "bin";

function pathFor(part: ManifestPart): string {
  const ext = extensionFor(part.mimeType);
  const suffix = part.variant ? `-${part.variant + 1}` : "";
  if (part.kind === "pose") return `poses/${part.poseId}${suffix}.${ext}`;
  if (part.kind === "sound") return `sounds/${part.soundId}${suffix}.${ext}`;
  return `thumbnail.${ext}`;
}

export async function exportFighterFile(fighter: Fighter): Promise<Blob> {
  const { manifest, parts } = await encodeFighter(fighter);
  const files: Zippable = {
    "fighter.json": strToU8(JSON.stringify({ ...manifest, files: manifest.parts.map(pathFor) }, null, 1)),
  };
  manifest.parts.forEach((part, i) => {
    // Images and opus are already compressed.
    files[pathFor(part)] = [parts[i], { level: 0 }];
  });
  return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export async function importFighterFile(data: Blob | ArrayBuffer | Uint8Array): Promise<Fighter> {
  const bytes = data instanceof Blob ? await bytesOf(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new FighterCodecError("Not a fighter file (couldn't unzip)");
  }
  const json = entries["fighter.json"];
  if (!json) throw new FighterCodecError("Not a fighter file (no fighter.json)");
  let parsed: FighterManifest & { files?: unknown };
  try {
    parsed = JSON.parse(strFromU8(json));
  } catch {
    throw new FighterCodecError("fighter.json is not valid JSON");
  }
  const { files, ...rest } = parsed;
  const manifest = validateManifest(rest);
  const paths = Array.isArray(files) ? (files as unknown[]) : manifest.parts.map(pathFor);
  const parts = manifest.parts.map((part, i) => {
    const path = paths[i];
    const entry = typeof path === "string" ? entries[path] : undefined;
    if (!entry) throw new FighterCodecError(`Fighter file is missing ${part.partId}`);
    return entry;
  });
  return decodeFighter(manifest, parts);
}

export function fighterFileName(fighter: Pick<Fighter, "name">): string {
  const base = fighter.name.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "fighter";
  return base + FIGHTER_FILE_EXTENSION;
}
