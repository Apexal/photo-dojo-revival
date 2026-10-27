import { LANDMARK, POSE_IDS, type LandmarkName, type NormalizedLandmark } from "../shared/fighter-model";
import { groundAnchorFor, type FighterGeometry } from "../shared/frame-data";
import { REQUIRED_VISIBILITY_THRESHOLD, distance, torsoLength } from "../shared/pose-geometry";

/*
 * The tale of the tape before a match: each fighter's height, reach and legs,
 * measured from their landmarks. Photos have no real-world scale (every pose
 * is scaled to a standard body size), so it's all proportions, in torsos
 * (mid-shoulder to mid-hip, as stood in the idle pose), next to an average
 * adult's, with a broadcaster's verdict.
 */

export type TapeStat = "height" | "reach" | "legs";
export const TAPE_STATS: readonly TapeStat[] = ["height", "reach", "legs"];

export const TAPE_LABELS: Record<TapeStat, string> = { height: "Height", reach: "Reach", legs: "Legs" };

/** An average adult, in torsos: crown to floor, shoulder to wrist, hip to ankle. */
export const TYPICAL_TAPE: Record<TapeStat, number> = { height: 3.3, reach: 1.12, legs: 1.6 };

/** From well short of average to well past it (TAPE_TIERS). */
export const TAPE_VERDICTS: Record<TapeStat, readonly [string, string, string, string, string]> = {
  height: ["fun-sized", "compact", "regulation", "towering", "suspiciously tall"],
  reach: ["T. rex arms", "short", "regulation", "long", "suspiciously long"],
  legs: ["low to the ground", "sturdy", "regulation", "leggy", "all legs"],
};

/** Upper bounds of the first four verdicts, as a fraction of average. */
const TAPE_TIERS = [0.9, 0.96, 1.04, 1.1] as const;

/** Bigger by less than this fraction isn't an edge. */
export const EDGE_MARGIN = 0.02;

/** Foreshortening only shortens a limb in 2D: over every capture, take a long one (not the longest, which may be a bad detection). */
const LIMB_PERCENTILE = 0.8;

export type TapeMeasurements = Record<TapeStat, number>;

export function tapeVerdict(stat: TapeStat, value: number): string {
  const ratio = value / TYPICAL_TAPE[stat];
  const tier = TAPE_TIERS.findIndex((bound) => ratio < bound);
  return TAPE_VERDICTS[stat][tier === -1 ? 4 : tier];
}

/** One fighter's measurements, in torsos. */
export function measureFighter(geometry: FighterGeometry): TapeMeasurements {
  const idle = geometry.idle.landmarks;
  const torso = torsoLength(idle) || 1;
  const captures = POSE_IDS.flatMap((poseId) => [geometry[poseId].landmarks, ...(geometry.variants?.[poseId] ?? []).map((v) => v.landmarks)]);
  const limb = (joints: (side: "left" | "right") => LandmarkName[]) => {
    const lengths = captures.flatMap((landmarks) => (["left", "right"] as const).map((side) => chainLength(landmarks, joints(side))));
    return percentile(lengths.filter((l): l is number => l !== null), LIMB_PERCENTILE) / torso;
  };
  return {
    height: (groundAnchorFor(geometry, "idle").y - crownY(idle)) / torso,
    reach: limb((side) => [`${side}Shoulder`, `${side}Elbow`, `${side}Wrist`]),
    legs: limb((side) => [`${side}Hip`, `${side}Knee`, `${side}Ankle`]),
  };
}

/**
 * Who has the edge on each stat (null: within EDGE_MARGIN), and overall: whoever
 * has more of them (null: even).
 */
export function tapeEdges(a: TapeMeasurements, b: TapeMeasurements): { stats: Record<TapeStat, 0 | 1 | null>; overall: 0 | 1 | null } {
  const stats = Object.fromEntries(TAPE_STATS.map((stat) => {
    const [x, y] = [a[stat], b[stat]];
    return [stat, Math.abs(x - y) <= EDGE_MARGIN * Math.min(x, y) ? null : x > y ? 0 : 1];
  })) as Record<TapeStat, 0 | 1 | null>;
  const count = (p: 0 | 1) => TAPE_STATS.filter((s) => stats[s] === p).length;
  const [c0, c1] = [count(0), count(1)];
  return { stats, overall: c0 === c1 ? null : c0 > c1 ? 0 : 1 };
}

/** "3.3 torsos". */
export const formatTape = (value: number) => `${value.toFixed(1)} torsos`;

/**
 * The top of the head, which has no landmark: the eyes are about halfway down
 * the head, and the chin about 1.5× as far below them as the mouth.
 */
function crownY(landmarks: readonly NormalizedLandmark[]): number {
  const y = (a: LandmarkName, b: LandmarkName) => (landmarks[LANDMARK[a]].y + landmarks[LANDMARK[b]].y) / 2;
  const eyes = y("leftEye", "rightEye");
  return eyes - 1.5 * (y("mouthLeft", "mouthRight") - eyes);
}

/** A limb's length along its joints, or null if any of them wasn't seen clearly. */
function chainLength(landmarks: readonly NormalizedLandmark[], joints: LandmarkName[]): number | null {
  const points = joints.map((j) => landmarks[LANDMARK[j]]);
  if (points.some((p) => p.visibility < REQUIRED_VISIBILITY_THRESHOLD)) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
