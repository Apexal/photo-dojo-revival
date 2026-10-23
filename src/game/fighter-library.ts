import type { ArchetypeId } from "../shared/archetypes";
import type { FighterGeometry, PoseGeometry } from "../shared/frame-data";
import { POSE_IDS, type CapturedPose, type Fighter, type PoseId } from "../shared/fighter-model";
import { listFighters } from "../shared/fighter-storage";

export interface LibraryEntry {
  fighter: Fighter;
  /** Bundled stick figure: can't be deleted. */
  builtIn: boolean;
}

export const PLACEHOLDER_IDS = ["placeholder-red", "placeholder-blue", "placeholder-green", "placeholder-purple"];

interface PlaceholderJson {
  fighterId: string;
  name: string;
  archetype: ArchetypeId;
  thumbnail: string;
  poses: Record<PoseId, PlaceholderPose>;
  variants: Partial<Record<PoseId, PlaceholderPose[]>>;
}

interface PlaceholderPose { file: string; anchorPoint: { x: number; y: number }; landmarks: CapturedPose["landmarks"]; attackSide?: "left" | "right" }

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url} (${res.status})`);
  return res.blob();
}

/** Hand-drawn stick fighters from /public, loaded as regular Fighter objects. */
export async function loadPlaceholderFighter(id: string, base = import.meta.env.BASE_URL): Promise<Fighter> {
  const dir = `${base}placeholders/${id}/`;
  const res = await fetch(`${dir}fighter.json`);
  if (!res.ok) throw new Error(`Couldn't load placeholder ${id}`);
  const json = (await res.json()) as PlaceholderJson;
  const load = async (poseId: PoseId, p: PlaceholderPose): Promise<CapturedPose> => ({
    poseId,
    imageBlob: await fetchBlob(dir + p.file),
    landmarks: p.landmarks,
    anchorPoint: p.anchorPoint,
    capturedAt: 0,
    ...(p.attackSide ? { attackSide: p.attackSide } : {}),
  });
  const entries = await Promise.all(POSE_IDS.map(async (poseId): Promise<[PoseId, CapturedPose]> => [poseId, await load(poseId, json.poses[poseId])]));
  const poseVariants = Object.fromEntries(
    await Promise.all(
      Object.entries(json.variants).map(async ([poseId, list]) => [poseId, await Promise.all(list!.map((p) => load(poseId as PoseId, p)))]),
    ),
  ) as Partial<Record<PoseId, CapturedPose[]>>;
  return {
    fighterId: json.fighterId,
    name: json.name,
    schemaVersion: 2,
    archetype: json.archetype,
    createdAt: 0,
    facingDirection: "right",
    poses: Object.fromEntries(entries) as Record<PoseId, CapturedPose>,
    poseVariants,
    sounds: { attack: null, hurt: null, win: null },
    thumbnailBlob: await fetchBlob(dir + json.thumbnail),
  };
}

/** Captured fighters (newest first), then the built-in placeholders. */
export async function loadLibrary(): Promise<LibraryEntry[]> {
  const [stored, placeholders] = await Promise.all([
    listFighters().catch((err) => {
      console.error("[library] IndexedDB unavailable", err);
      return [] as Fighter[];
    }),
    Promise.all(PLACEHOLDER_IDS.map((id) => loadPlaceholderFighter(id))),
  ]);
  // Fighters saved by an older version of the game can't be played; skip rather than crash.
  const complete = stored.filter((f) => {
    if (f.schemaVersion !== 2) console.warn(`[library] skipping ${f.name}: captured with an older version`);
    return f.schemaVersion === 2;
  });
  return [...complete.map((fighter) => ({ fighter, builtIn: false })), ...placeholders.map((fighter) => ({ fighter, builtIn: true }))];
}

/** What the simulation needs from a fighter: per-pose landmarks and anchors, and the archetype. */
export function geometryOf(fighter: Fighter): FighterGeometry {
  const of = (p: CapturedPose): PoseGeometry => ({ landmarks: p.landmarks, anchorPoint: p.anchorPoint, ...(p.attackSide ? { attackSide: p.attackSide } : {}) });
  const poses = Object.fromEntries(POSE_IDS.map((poseId) => [poseId, of(fighter.poses[poseId])])) as Record<PoseId, PoseGeometry>;
  const variants = Object.fromEntries(
    Object.entries(fighter.poseVariants).map(([poseId, list]) => [poseId, list!.map(of)]),
  ) as Partial<Record<PoseId, PoseGeometry[]>>;
  return { ...poses, variants, archetype: fighter.archetype };
}
