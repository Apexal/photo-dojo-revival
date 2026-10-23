import { LANDMARK, LANDMARK_COUNT, type NormalizedLandmark, type PoseId } from "../../shared/fighter-model";
import { midHip, midShoulder, torsoLength } from "../../shared/pose-geometry";
import type { FrameTween } from "../../simulation/fight-simulation";
import { ArapDeformer, triangulateMask, type AlphaMask, type Point, type TriangleMesh } from "./arap";

/*
 * In-between frames for a tween entry in the frame data (PLAN §9). Each capture
 * gets a triangle mesh over its opaque pixels; the skeleton is interpolated
 * from one capture's landmarks to the other's; both captures are ARAP-warped
 * onto that in-between skeleton and cross-dissolved, the leaving one under the
 * arriving one. Pure geometry: fighter-sprite-view.ts puts the result on screen.
 *
 * It only holds up between side-view poses a few frames apart. A single photo
 * has no idea what's behind an arm, so a limb crossing the body drags the body
 * with it; over 4–7 frames, under a cross-dissolve, that reads as motion blur.
 */

export interface FrameRef { poseId: PoseId; variant: number }

/** What one end of a tween needs: the capture's alpha and landmarks, and the anchor the sprite is drawn from. */
export interface TweenSource {
  mask: AlphaMask;
  landmarks: NormalizedLandmark[];
  anchor: Point;
  /**
   * No photo of its own: these landmarks are made up, and the pose's main
   * capture (variant 0) is warped onto them instead (see breathingStance).
   */
  standIn?: boolean;
}

/** One warped capture. Positions are relative to the feet anchor, facing right. */
export interface TweenLayer {
  frame: FrameRef;
  /** Same id, same triangles and uvs: renderers can keep one mesh per id. */
  id: string;
  /** Three vertex indices per triangle. */
  triangles: Uint32Array;
  /** Texture coordinates (0..1) per vertex. */
  uvs: Float32Array;
  positions: Float64Array;
  alpha: number;
}

/** Landmarks this unreliable in either capture don't pull the mesh. */
export const TWEEN_HANDLE_VISIBILITY = 0.5;

const ROOT = -1; // mid-hip
const NECK = -2; // mid-shoulder

/** Parent of each landmark, parents first. Every landmark is placed relative to its parent. */
const SKELETON: [child: number, parent: number][] = [
  [LANDMARK.leftHip, ROOT], [LANDMARK.rightHip, ROOT],
  [LANDMARK.leftShoulder, ROOT], [LANDMARK.rightShoulder, ROOT],
  ...Array.from({ length: LANDMARK.mouthRight + 1 }, (_, i): [number, number] => [i, NECK]), // face
  ...(["left", "right"] as const).flatMap((side): [number, number][] => [
    [LANDMARK[`${side}Elbow`], LANDMARK[`${side}Shoulder`]],
    [LANDMARK[`${side}Wrist`], LANDMARK[`${side}Elbow`]],
    [LANDMARK[`${side}Pinky`], LANDMARK[`${side}Wrist`]],
    [LANDMARK[`${side}Index`], LANDMARK[`${side}Wrist`]],
    [LANDMARK[`${side}Thumb`], LANDMARK[`${side}Wrist`]],
    [LANDMARK[`${side}Knee`], LANDMARK[`${side}Hip`]],
    [LANDMARK[`${side}Ankle`], LANDMARK[`${side}Knee`]],
    [LANDMARK[`${side}Heel`], LANDMARK[`${side}Ankle`]],
    [LANDMARK[`${side}FootIndex`], LANDMARK[`${side}Ankle`]],
  ]),
];

/**
 * Landmarks part of the way from a to b. Joints swing: the pelvis moves in a
 * straight line and every bone turns (shortest way round) and stretches toward
 * its other length, so a straightening arm keeps its length instead of
 * shrinking through the elbow as a plain lerp would.
 */
export function interpolateLandmarks(a: readonly NormalizedLandmark[], b: readonly NormalizedLandmark[], t: number): NormalizedLandmark[] {
  if (t <= 0) return a.map((l) => ({ ...l }));
  if (t >= 1) return b.map((l) => ({ ...l }));
  const out: NormalizedLandmark[] = new Array(LANDMARK_COUNT);
  const rootA = midHip(a as NormalizedLandmark[]), rootB = midHip(b as NormalizedLandmark[]);
  const root = { x: rootA.x + (rootB.x - rootA.x) * t, y: rootA.y + (rootB.y - rootA.y) * t };
  const source = (l: readonly NormalizedLandmark[], i: number): Point =>
    i === ROOT ? midHip(l as NormalizedLandmark[]) : i === NECK ? midShoulder(l as NormalizedLandmark[]) : l[i];
  const placed = (i: number): Point =>
    i === ROOT ? root : i === NECK ? midShoulder(out) : out[i];
  for (const [child, parent] of SKELETON) {
    const pa = source(a, parent), pb = source(b, parent);
    const offset = swing({ x: a[child].x - pa.x, y: a[child].y - pa.y }, { x: b[child].x - pb.x, y: b[child].y - pb.y }, t);
    const p = placed(parent);
    out[child] = { x: p.x + offset.x, y: p.y + offset.y, visibility: Math.min(a[child].visibility, b[child].visibility) };
  }
  return out;
}

/** Turn and stretch vector u toward v. */
function swing(u: Point, v: Point, t: number): Point {
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu < 1e-6 || lv < 1e-6) return { x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t };
  let turn = Math.atan2(v.y, v.x) - Math.atan2(u.y, u.x);
  turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
  const angle = Math.atan2(u.y, u.x) + turn * t;
  const length = lu + (lv - lu) * t;
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

/**
 * A second stance for fighters captured before there was one: knees soften and
 * the body sinks a little, the chest lifts (breathing in), the fists drop a
 * touch. Feet stay put. The idle photo warped onto this is the fighter's sway.
 */
export function breathingStance(l: readonly NormalizedLandmark[]): NormalizedLandmark[] {
  const torso = torsoLength(l as NormalizedLandmark[]);
  const sink = 0.05 * torso;
  const shift = (i: number): Point => {
    if (i >= LANDMARK.leftAnkle) return { x: 0, y: 0 }; // ankles, heels, toes
    if (i >= LANDMARK.leftKnee) return { x: 0.03 * torso, y: 0.5 * sink }; // knees bend forward
    if (i >= LANDMARK.leftHip) return { x: 0, y: sink };
    if (i >= LANDMARK.leftElbow) return { x: -0.01 * torso, y: sink + 0.02 * torso }; // arms and hands
    return { x: 0, y: sink - 0.02 * torso }; // head and shoulders: the chest rises
  };
  return l.map((p, i) => ({ ...p, x: p.x + shift(i).x, y: p.y + shift(i).y }));
}

/** A handle: the point `along` the way from landmark `from` to landmark `to` (equal for a joint). */
interface HandleSpec { from: number; to: number; along: number }

const HANDLE_JOINTS = [
  "nose", "leftEar", "rightEar",
  "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
  "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle", "leftFootIndex", "rightFootIndex",
] as const;

/** Bones get handles a third and two thirds along too, so the limb between two joints moves as one piece. */
const HANDLE_BONES = (["left", "right"] as const).flatMap((side) => [
  [`${side}Shoulder`, `${side}Elbow`], [`${side}Elbow`, `${side}Wrist`],
  [`${side}Hip`, `${side}Knee`], [`${side}Knee`, `${side}Ankle`],
  [`${side}Shoulder`, `${side}Hip`],
] as const);

const HANDLES: HandleSpec[] = [
  ...HANDLE_JOINTS.map((name) => ({ from: LANDMARK[name], to: LANDMARK[name], along: 0 })),
  ...HANDLE_BONES.flatMap(([from, to]) => [1 / 3, 2 / 3].map((along) => ({ from: LANDMARK[from], to: LANDMARK[to], along }))),
];

const handlePoint = (l: readonly NormalizedLandmark[], h: HandleSpec): Point =>
  ({ x: l[h.from].x + (l[h.to].x - l[h.from].x) * h.along, y: l[h.from].y + (l[h.to].y - l[h.from].y) * h.along });

const relativeTo = (l: readonly NormalizedLandmark[], anchor: Point): NormalizedLandmark[] =>
  l.map((p) => ({ x: p.x - anchor.x, y: p.y - anchor.y, visibility: p.visibility }));

const frameKey = (f: FrameRef) => `${f.poseId}#${f.variant}`;
const trustedIn = (l: readonly NormalizedLandmark[], ...indices: number[]) => indices.every((i) => l[i].visibility >= TWEEN_HANDLE_VISIBILITY);

// --- left/right label flips -----------------------------------------------------

/** Each landmark's mirror-side counterpart (MediaPipe numbering; the nose is its own). */
const MIRROR: readonly number[] = (() => {
  const m = Array.from({ length: LANDMARK_COUNT }, (_, i) => i);
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10]];
  for (let i = LANDMARK.leftShoulder; i < LANDMARK_COUNT; i += 2) pairs.push([i, i + 1]);
  for (const [a, b] of pairs) { m[a] = b; m[b] = a; }
  return m;
})();

/** The same landmarks with every left/right label swapped. */
export function swapSides(l: readonly NormalizedLandmark[]): NormalizedLandmark[] {
  return l.map((_, i) => ({ ...l[MIRROR[i]] }));
}

/** How much better the swapped pairing has to fit, for both shoulders and hips, to count as a flip. */
const FLIP_MARGIN = 0.6;

/**
 * MediaPipe sometimes labels a side-on body with left and right swapped. Its
 * signature is the whole torso fitting the other capture better swapped:
 * shoulders and hips both. One arm fitting better swapped is not a flip; a
 * cross (rear hand punching past the lead hand) does that for real.
 */
export function sidesFlipped(a: readonly NormalizedLandmark[], b: readonly NormalizedLandmark[]): boolean {
  const flippedPair = (left: number, right: number) => {
    const straight = dist(a[left], b[left]) + dist(a[right], b[right]);
    const swapped = dist(a[left], b[right]) + dist(a[right], b[left]);
    return swapped < FLIP_MARGIN * straight;
  };
  return flippedPair(LANDMARK.leftShoulder, LANDMARK.rightShoulder) && flippedPair(LANDMARK.leftHip, LANDMARK.rightHip);
}

const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

// --- limbs that move get their own piece of mesh ----------------------------------

interface Limb { group: number; root: number; joints: [number, number]; tip: number | null; kind: "arm" | "leg" }

const LIMBS: Limb[] = (["left", "right"] as const).flatMap((side, i): Limb[] => [
  { group: 1 + i, kind: "arm", root: LANDMARK[`${side}Shoulder`], joints: [LANDMARK[`${side}Elbow`], LANDMARK[`${side}Wrist`]], tip: null },
  { group: 3 + i, kind: "leg", root: LANDMARK[`${side}Hip`], joints: [LANDMARK[`${side}Knee`], LANDMARK[`${side}Ankle`]], tip: LANDMARK[`${side}FootIndex`] },
]);

/** A limb whose elbow/wrist (knee/ankle) moves this far relative to its shoulder (hip), in torso lengths, is cut loose. */
const LIMB_MOVE_TORSOS = 0.35;
/**
 * How far from its centre line (torso lengths) a limb's piece can reach. Within
 * that, a triangle goes to whichever bone is nearest, so baggy trousers go with
 * the leg but the other fist stays with its own arm.
 */
const LIMB_REACH_TORSOS = { arm: 0.3, leg: 0.45 } as const;
/** Vertices this close (torso lengths) to where the cut starts stay shared: the limb hinges there. */
const LIMB_HINGE_TORSOS = 0.2;
/** The cut starts this far down the upper arm / thigh, so the shoulder and hip stay with the body. */
const LIMB_CUT_START = 0.3;

/**
 * Limbs that move between two captures and that both captures can see. Only
 * these are cut loose: a limb that stays put is fine as part of the body.
 */
function movingLimbs(a: readonly NormalizedLandmark[], b: readonly NormalizedLandmark[]): Limb[] {
  const torso = (torsoLength(a as NormalizedLandmark[]) + torsoLength(b as NormalizedLandmark[])) / 2;
  return LIMBS.filter((limb) => {
    const points = [limb.root, ...limb.joints];
    if (!trustedIn(a, ...points) || !trustedIn(b, ...points)) return false;
    return limb.joints.some((j) => dist(
      { x: a[j].x - a[limb.root].x, y: a[j].y - a[limb.root].y },
      { x: b[j].x - b[limb.root].x, y: b[j].y - b[limb.root].y },
    ) > LIMB_MOVE_TORSOS * torso);
  });
}

/** The limb's centre line in one capture: from partway down the upper bone to the fist (or toes). */
function limbLine(limb: Limb, l: readonly NormalizedLandmark[]): Point[] {
  const root = l[limb.root], [mid, end] = limb.joints.map((j) => l[j]);
  const start = { x: root.x + (mid.x - root.x) * LIMB_CUT_START, y: root.y + (mid.y - root.y) * LIMB_CUT_START };
  // An arm ends in a fist past the wrist; a leg ends at the toes if they're trusted.
  const tip = limb.tip !== null && trustedIn(l, limb.tip) ? l[limb.tip] : { x: end.x + (end.x - mid.x) * 0.4, y: end.y + (end.y - mid.y) * 0.4 };
  return [start, mid, end, tip];
}

/** Every bone as a line, tagged with the mesh group its pixels go to: the cut limbs' own, else the body (0). */
function boneLines(l: readonly NormalizedLandmark[], cut: Limb[]): { group: number; line: Point[] }[] {
  const L = LANDMARK;
  const neck = midShoulder(l as NormalizedLandmark[]), pelvis = midHip(l as NormalizedLandmark[]);
  const lines = [
    [neck, pelvis], [l[L.leftShoulder], l[L.rightShoulder]], [l[L.leftHip], l[L.rightHip]],
    [l[L.leftShoulder], l[L.leftHip]], [l[L.rightShoulder], l[L.rightHip]], [l[L.nose], neck],
  ].map((line) => ({ group: 0, line }));
  for (const limb of LIMBS) {
    const isCut = cut.includes(limb);
    const line = limbLine(limb, l);
    // A cut limb's top stays with the body (its hinge); an uncut limb is all body.
    lines.push(isCut ? { group: 0, line: [l[limb.root], line[0]] } : { group: 0, line: [l[limb.root], ...line] });
    if (isCut) lines.push({ group: limb.group, line });
  }
  return lines;
}

function distanceToLine(p: Point, line: Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/**
 * Cut each moving limb out of the mesh: triangles nearer its centre line than
 * any other bone (and within reach of it) become its own group, with their own copies of the vertices they shared with the
 * rest, so a forearm lying across the chest no longer drags the chest (or the
 * other fist) along. Near the shoulder / hip the vertices stay shared: the limb
 * hinges there instead of tearing away. Limb triangles come last, so they draw
 * over the body.
 */
function cutLimbs(base: MeshEntry, landmarks: readonly NormalizedLandmark[], limbs: Limb[]): { mesh: TriangleMesh; uvs: Float32Array } {
  const { positions, triangles } = base.mesh;
  if (!limbs.length) return { mesh: base.mesh, uvs: base.uvs };
  const torso = torsoLength(landmarks as NormalizedLandmark[]);
  const lines = limbs.map((limb) => limbLine(limb, landmarks));
  const radii = limbs.map((limb) => LIMB_REACH_TORSOS[limb.kind] * torso);
  const bones = boneLines(landmarks, limbs);
  const vertex = (i: number): Point => ({ x: positions[2 * i], y: positions[2 * i + 1] });

  const count = triangles.length / 3;
  const groupOf = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => vertex(triangles[3 * t + k]));
    const centre = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    let nearest = bones[0], best = Infinity;
    for (const bone of bones) {
      const d = distanceToLine(centre, bone.line);
      if (d < best) { best = d; nearest = bone; }
    }
    const i = limbs.findIndex((limb) => limb.group === nearest.group);
    if (i >= 0 && best < radii[i]) groupOf[t] = nearest.group;
  }

  // The group that keeps each original vertex: the lowest using it (the body, if it does).
  const owner = new Int16Array(positions.length / 2).fill(-1);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = triangles[3 * t + k];
      if (owner[v] < 0 || groupOf[t] < owner[v]) owner[v] = groupOf[t];
    }
  }
  const outPositions = Array.from(positions), outUvs = Array.from(base.uvs);
  const copies = new Map<string, number>();
  const vertexFor = (v: number, group: number): number => {
    if (owner[v] === group) return v;
    const i = limbs.findIndex((limb) => limb.group === group);
    if (dist(vertex(v), lines[i][0]) < LIMB_HINGE_TORSOS * torso) return v; // the hinge
    const key = `${v}:${group}`;
    let copy = copies.get(key);
    if (copy === undefined) {
      copy = outPositions.length / 2;
      outPositions.push(positions[2 * v], positions[2 * v + 1]);
      outUvs.push(base.uvs[2 * v], base.uvs[2 * v + 1]);
      copies.set(key, copy);
    }
    return copy;
  };
  const order = Array.from({ length: count }, (_, t) => t).sort((p, q) => groupOf[p] - groupOf[q]);
  const outTriangles = new Uint32Array(triangles.length);
  const outGroups = new Uint8Array(count);
  order.forEach((t, n) => {
    for (let k = 0; k < 3; k++) outTriangles[3 * n + k] = vertexFor(triangles[3 * t + k], groupOf[t]);
    outGroups[n] = groupOf[t];
  });
  // Renumber so each copy sits next to its original: the grid's row-by-row order is what
  // keeps the solver's matrices banded, and copies appended at the end would undo it.
  const originalOf = Array.from({ length: outPositions.length / 2 }, (_, i) => i);
  for (const [key, copy] of copies) originalOf[copy] = Number(key.split(":")[0]);
  const byOriginal = originalOf.map((_, i) => i).sort((p, q) => originalOf[p] - originalOf[q] || p - q);
  const renumber = new Uint32Array(byOriginal.length);
  byOriginal.forEach((old, i) => { renumber[old] = i; });
  return {
    mesh: {
      positions: Float64Array.from(byOriginal.flatMap((old) => [outPositions[2 * old], outPositions[2 * old + 1]])),
      triangles: outTriangles.map((v) => renumber[v]),
      groups: outGroups,
    },
    uvs: Float32Array.from(byOriginal.flatMap((old) => [outUvs[2 * old], outUvs[2 * old + 1]])),
  };
}

/** The piece of mesh a handle pulls on: a cut-loose limb's own bones and joints, else the body. */
function handleGroup(h: HandleSpec, cut: Limb[]): number {
  for (const limb of cut) {
    const own = [...limb.joints, ...(limb.tip === null ? [] : [limb.tip])];
    const onLimb = (i: number) => own.includes(i) || i === limb.root;
    if (onLimb(h.from) && onLimb(h.to) && !(h.from === limb.root && h.to === limb.root)) return limb.group;
  }
  return 0;
}

// --- the tweener ---------------------------------------------------------------

interface MeshEntry { mesh: TriangleMesh; uvs: Float32Array; landmarks: NormalizedLandmark[]; standIn: boolean }
interface DeformerEntry {
  deformer: ArapDeformer;
  handles: HandleSpec[];
  uvs: Float32Array;
  /** The deformer's triangles minus the cut-loose limbs. */
  bodyTriangles: Uint32Array;
}

/** Fewer bound handles than this and the warp is guesswork: show a hard cut instead. */
const MIN_BOUND_HANDLES = 6;

/**
 * Per fighter: a mesh per capture (built once) and an ARAP deformer per
 * capture and tween partner (which landmarks both trust, which limbs move and
 * whether MediaPipe flipped sides all depend on the pair). Anything that can't
 * be warped (a missing capture, an empty mask, too few handles in the mesh)
 * gives null, and the renderer falls back to a hard cut.
 */
export class PoseTweener {
  private readonly meshes = new Map<string, MeshEntry | null>();
  private readonly deformers = new Map<string, DeformerEntry | null>();

  constructor(private readonly source: (frame: FrameRef) => TweenSource | null) {}

  /** Build the meshes and deformers for a tween now (they're otherwise built the first time it plays). */
  prepare(tween: Pick<FrameTween, "from" | "to">): boolean {
    return this.layers({ ...tween, t: 0.5 }) !== null;
  }

  /**
   * Back to front: a backing (the fainter capture's body without its cut-loose
   * limbs, opaque), the leaving capture, the arriving one. Between a capture and
   * its own stand-in, or between two stand-ins for the same capture, just the
   * one capture, warped. Null for a hard cut.
   */
  layers(tween: FrameTween): TweenLayer[] | null {
    const standIn = (f: FrameRef) => this.meshFor(f)?.standIn ?? false;
    if (standIn(tween.from) || standIn(tween.to)) {
      // A stand-in has no photo: its pose's main capture is what's drawn.
      const real = (f: FrameRef): FrameRef => (standIn(f) ? { poseId: f.poseId, variant: 0 } : f);
      const from = real(tween.from), to = real(tween.to);
      if (frameKey(from) !== frameKey(to)) return this.layers({ ...tween, from, to });
      return this.warpOnly(tween, from);
    }
    const from = this.deformerFor(tween.from, tween.to), to = this.deformerFor(tween.to, tween.from);
    if (!from || !to) return null;
    const [a, b] = this.pairLandmarks(tween.from, tween.to)!;
    const skeleton = interpolateLandmarks(a, b, tween.t);
    const targets = from.handles.map((h) => handlePoint(skeleton, h));
    const fromPositions = from.deformer.deform(targets), toPositions = to.deformer.deform(targets);
    const layer = (frame: FrameRef, entry: DeformerEntry, other: FrameRef, positions: Float64Array, alpha: number): TweenLayer => ({
      frame,
      id: `${frameKey(frame)}>${frameKey(other)}`,
      triangles: entry.deformer.triangles,
      uvs: entry.uvs,
      positions,
      alpha,
    });
    // The arriving capture fades in on top; the leaving one fades out under it from halfway,
    // so the body never turns see-through.
    const leaving = layer(tween.from, from, tween.to, fromPositions, Math.min(1, 2 * (1 - tween.t)));
    const arriving = layer(tween.to, to, tween.from, toPositions, Math.min(1, 2 * tween.t));
    // Where a limb was cut loose and has moved off, its capture has a hole (a photo has
    // nothing behind an arm). The other capture's body, drawn solid underneath, fills it.
    const [faint, entry] = tween.t < 0.5 ? [arriving, to] : [leaving, from];
    const backing = { ...faint, id: `${faint.id}:body`, triangles: entry.bodyTriangles, alpha: 1 };
    return [backing, leaving, arriving];
  }

  /** One capture (`real`, the photo behind both ends) warped along the tween: toward its stand-in, or from one stand-in to another. */
  private warpOnly(tween: FrameTween, real: FrameRef): TweenLayer[] | null {
    const other = frameKey(real) === frameKey(tween.to) ? tween.from : tween.to;
    const entry = this.deformerFor(real, other);
    if (!entry) return null;
    const [a, b] = this.pairLandmarks(tween.from, tween.to)!;
    const skeleton = interpolateLandmarks(a, b, tween.t);
    const targets = entry.handles.map((h) => handlePoint(skeleton, h));
    return [{
      frame: real,
      id: `${frameKey(real)}>${frameKey(other)}`,
      triangles: entry.deformer.triangles,
      uvs: entry.uvs,
      positions: entry.deformer.deform(targets),
      alpha: 1,
    }];
  }

  /**
   * Both captures' landmarks, labelled consistently: if MediaPipe flipped sides
   * on one, the one whose key sorts later is relabelled (the same one whichever
   * end asks, so both deformers and the interpolation agree).
   */
  private pairLandmarks(x: FrameRef, y: FrameRef): [NormalizedLandmark[], NormalizedLandmark[]] | null {
    const mx = this.meshFor(x), my = this.meshFor(y);
    if (!mx || !my) return null;
    if (!sidesFlipped(mx.landmarks, my.landmarks)) return [mx.landmarks, my.landmarks];
    return frameKey(x) > frameKey(y) ? [swapSides(mx.landmarks), my.landmarks] : [mx.landmarks, swapSides(my.landmarks)];
  }

  private meshFor(frame: FrameRef): MeshEntry | null {
    const key = frameKey(frame);
    if (!this.meshes.has(key)) {
      const source = this.source(frame);
      let entry: MeshEntry | null = null;
      if (source) {
        const pixels = triangulateMask(source.mask);
        const positions = new Float64Array(pixels.positions.length);
        const uvs = new Float32Array(pixels.positions.length);
        for (let i = 0; i < positions.length; i += 2) {
          positions[i] = pixels.positions[i] - source.anchor.x;
          positions[i + 1] = pixels.positions[i + 1] - source.anchor.y;
          uvs[i] = pixels.positions[i] / source.mask.width;
          uvs[i + 1] = pixels.positions[i + 1] / source.mask.height;
        }
        if (pixels.triangles.length) {
          entry = { mesh: { positions, triangles: pixels.triangles }, uvs, landmarks: relativeTo(source.landmarks, source.anchor), standIn: Boolean(source.standIn) };
        }
      }
      this.meshes.set(key, entry);
    }
    return this.meshes.get(key)!;
  }

  private deformerFor(frame: FrameRef, other: FrameRef): DeformerEntry | null {
    const key = `${frameKey(frame)}>${frameKey(other)}`;
    if (!this.deformers.has(key)) {
      const base = this.meshFor(frame);
      const pair = this.pairLandmarks(frame, other);
      let entry: DeformerEntry | null = null;
      if (base && pair) {
        const [mine, theirs] = pair;
        const handles = HANDLES.filter((h) => trustedIn(mine, h.from, h.to) && trustedIn(theirs, h.from, h.to));
        const cut = movingLimbs(mine, theirs);
        const { mesh, uvs } = cutLimbs(base, mine, cut);
        try {
          const deformer = new ArapDeformer(mesh, handles.map((h) => handlePoint(mine, h)), {}, handles.map((h) => handleGroup(h, cut)));
          const body = Array.from(deformer.triangles).filter((_, k) => deformer.groups[Math.floor(k / 3)] === 0);
          if (deformer.bound.filter(Boolean).length >= MIN_BOUND_HANDLES) entry = { deformer, handles, uvs, bodyTriangles: Uint32Array.from(body) };
        } catch (err) {
          console.warn(`[tween] can't warp ${key}, using a hard cut`, err);
        }
      }
      this.deformers.set(key, entry);
    }
    return this.deformers.get(key)!;
  }
}
