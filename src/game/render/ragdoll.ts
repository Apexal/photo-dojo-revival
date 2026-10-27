import { LANDMARK, LANDMARK_COUNT, type NormalizedLandmark } from "../../shared/fighter-model";
import { midHip, midShoulder, torsoLength } from "../../shared/pose-geometry";
import { GRAVITY } from "../../simulation/fighter-state-machine";
import type { Point } from "./arap";

/*
 * The K.O. ragdoll: a knocked-out fighter goes limp from the pose they were hit
 * in and flops to the floor, the photo ARAP-warped onto a verlet skeleton (all
 * 33 landmarks are particles; bones and the torso, head, hands and feet are
 * distance constraints). Rendering only: the simulation's KO'd fighter flies
 * and lands as before, untouchable, and nothing reads where the ragdoll ends up.
 *
 * Coordinates are the capture's own: relative to its feet anchor, facing right,
 * y down, 1 unit = 1 screen px; the renderer mirrors it for a fighter facing
 * left. It's stepped once per simulation frame and has no randomness, so the
 * K.O. replay flops exactly the same way.
 */

export interface RagdollStart {
  /** The pose they were hit in, relative to its feet anchor. */
  landmarks: readonly NormalizedLandmark[];
  /** Px per frame, facing right (negative x: knocked backwards). */
  velocity: Point;
  /** The floor's y (0 when they were standing on it). */
  floor: number;
  /** How far left and right (x) the stage lets them go. */
  walls: [number, number];
}

/** Backward spin given at the blow, radians per frame: about the quarter turn to lie flat over the knockdown's flight. */
const SPIN = 0.07;
/** Air drag per frame (fraction of velocity kept). */
const DRAG = 0.995;
/** Sideways speed kept per substep by a particle touching the floor. */
const FLOOR_GRIP = 0.6;
/** Upward speed (torso lengths per frame) the hands get at the blow: the arms fling up. */
const FLING = 0.012;
/**
 * How firmly each upper arm (and thigh) keeps its photographed angle to the
 * torso (per solver pass; it compounds over SUBSTEPS × ITERATIONS). A little:
 * the arms still flail, but don't swing as far off the chest and bare the hole
 * behind them.
 */
const SHOULDER_STIFFNESS = 0.02;
const SUBSTEPS = 2;
const ITERATIONS = 8;
/** Below this speed (px/frame) for SETTLE_FRAMES frames in a row, it stops simulating. */
const SETTLE_SPEED = 0.1;
const SETTLE_FRAMES = 20;

const L = LANDMARK;
const FACE = Array.from({ length: L.mouthRight + 1 }, (_, i) => i);
const SIDES = ["left", "right"] as const;

/** Flesh around each landmark, in torso lengths: how far above the floor it rests. */
function radiusOf(i: number): number {
  if (i <= L.mouthRight) return 0.16;
  if (i === L.leftShoulder || i === L.rightShoulder || i === L.leftHip || i === L.rightHip) return 0.18;
  if (i === L.leftElbow || i === L.rightElbow || i === L.leftKnee || i === L.rightKnee) return 0.08;
  return 0.05;
}

/** Heavier particles move less when a constraint pulls: the trunk swings the limbs, not the other way round. */
function massOf(i: number): number {
  if (i === L.leftShoulder || i === L.rightShoulder || i === L.leftHip || i === L.rightHip) return 4;
  if (i <= L.mouthRight) return 0.5;
  return 1;
}

interface Stick { a: number; b: number; length: number; stiffness: number }
/** Keeps a folding limb from closing up flat: root and end at least `length` apart. */
interface Spacer { a: number; b: number; length: number }
/** Keeps a knee bending the way knees bend: `joint` stays on side `sign` of the root→end line, in the body's frame. */
interface Hinge { root: number; joint: number; end: number; sign: 1 | -1 }

const pairs = (ids: number[]): [number, number][] => ids.flatMap((a, i) => ids.slice(i + 1).map((b): [number, number] => [a, b]));

export class Ragdoll {
  private readonly x = new Float64Array(LANDMARK_COUNT);
  private readonly y = new Float64Array(LANDMARK_COUNT);
  private readonly px = new Float64Array(LANDMARK_COUNT);
  private readonly py = new Float64Array(LANDMARK_COUNT);
  private readonly inverseMass = new Float64Array(LANDMARK_COUNT);
  private readonly ground = new Float64Array(LANDMARK_COUNT);
  private readonly sticks: Stick[] = [];
  private readonly spacers: Spacer[] = [];
  private readonly hinges: Hinge[] = [];
  private readonly visibility: number[];
  private readonly walls: [number, number];
  private still = 0;
  /** Simulation frames stepped so far. */
  frames = 0;

  constructor(start: RagdollStart) {
    const l = start.landmarks as NormalizedLandmark[];
    const torso = torsoLength(l) || 100;
    const pelvis = midHip(l);
    this.visibility = l.map((p) => p.visibility);
    this.walls = start.walls;
    const dt = 1 / SUBSTEPS;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      this.x[i] = l[i].x;
      this.y[i] = l[i].y;
      this.inverseMass[i] = 1 / massOf(i);
      this.ground[i] = start.floor - radiusOf(i) * torso;
      // Knocked off their feet: the head goes back, the feet come forward (spinning about the pelvis).
      const rx = l[i].x - pelvis.x, ry = l[i].y - pelvis.y;
      const vx = start.velocity.x + SPIN * ry;
      const vy = start.velocity.y - SPIN * rx;
      const fling = i >= L.leftWrist && i <= L.rightThumb ? FLING * torso : i === L.leftElbow || i === L.rightElbow ? FLING * torso / 2 : 0;
      this.px[i] = this.x[i] - vx * dt;
      this.py[i] = this.y[i] - (vy - fling) * dt;
    }

    const stick = (a: number, b: number, stiffness = 1) =>
      this.sticks.push({ a, b, length: Math.hypot(l[a].x - l[b].x, l[a].y - l[b].y), stiffness });
    for (const [a, b] of pairs([L.leftShoulder, L.rightShoulder, L.leftHip, L.rightHip])) stick(a, b);
    for (const [a, b] of pairs(FACE)) stick(a, b);
    // The neck: firm enough to carry the head, loose enough to loll.
    for (const head of [L.nose, L.leftEar, L.rightEar]) for (const shoulder of [L.leftShoulder, L.rightShoulder]) stick(head, shoulder, 0.35);
    for (const side of SIDES) {
      const s = (name: string) => L[`${side}${name}` as keyof typeof L];
      stick(s("Shoulder"), s("Elbow"));
      const other = side === "left" ? "right" : "left";
      stick(s("Elbow"), L[`${other}Shoulder`], SHOULDER_STIFFNESS);
      stick(s("Elbow"), s("Hip"), SHOULDER_STIFFNESS);
      stick(s("Elbow"), s("Wrist"));
      // The hand moves with the forearm.
      for (const [a, b] of pairs([s("Wrist"), s("Pinky"), s("Index"), s("Thumb")])) stick(a, b);
      for (const finger of [s("Pinky"), s("Index"), s("Thumb")]) stick(finger, s("Elbow"));
      stick(s("Hip"), s("Knee"));
      // Same at the hips, so a leg doesn't fold up over the chest.
      stick(s("Knee"), L[`${other}Hip`], SHOULDER_STIFFNESS);
      stick(s("Knee"), s("Shoulder"), SHOULDER_STIFFNESS);
      stick(s("Knee"), s("Ankle"));
      // The foot moves with the shin.
      for (const [a, b] of pairs([s("Ankle"), s("Heel"), s("FootIndex")])) stick(a, b);
      for (const foot of [s("Heel"), s("FootIndex")]) stick(foot, s("Knee"));

      const reach = (a: number, b: number, c: number) => Math.hypot(l[a].x - l[b].x, l[a].y - l[b].y) + Math.hypot(l[b].x - l[c].x, l[b].y - l[c].y);
      this.spacers.push({ a: s("Shoulder"), b: s("Wrist"), length: 0.35 * reach(s("Shoulder"), s("Elbow"), s("Wrist")) });
      this.spacers.push({ a: s("Hip"), b: s("Ankle"), length: 0.5 * reach(s("Hip"), s("Knee"), s("Ankle")) });
      // Which way this knee bends: as photographed if it's bent, else forward.
      const side0 = this.bendSide(s("Hip"), s("Knee"), s("Ankle"));
      this.hinges.push({ root: s("Hip"), joint: s("Knee"), end: s("Ankle"), sign: Math.abs(side0) > 0.05 * torso ? (Math.sign(side0) as 1 | -1) : 1 });
    }
  }

  /** Stopped moving: it lies there from now on. */
  get settled(): boolean {
    return this.still >= SETTLE_FRAMES;
  }

  /** Step until `frames` frames have been simulated (no-op once settled). */
  advanceTo(frames: number): void {
    while (this.frames < frames) this.step();
  }

  step(): void {
    this.frames++;
    if (this.settled) return;
    const dt = 1 / SUBSTEPS;
    let fastest = 0;
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        const vx = (this.x[i] - this.px[i]) * DRAG, vy = (this.y[i] - this.py[i]) * DRAG;
        this.px[i] = this.x[i];
        this.py[i] = this.y[i];
        this.x[i] += vx;
        this.y[i] += vy + GRAVITY * dt * dt;
      }
      for (let k = 0; k < ITERATIONS; k++) {
        for (const s of this.sticks) this.solveDistance(s.a, s.b, s.length, s.stiffness, false);
        for (const s of this.spacers) this.solveDistance(s.a, s.b, s.length, 1, true);
        for (const h of this.hinges) this.solveHinge(h);
        this.collide();
      }
      // Lying on the floor drags: whatever touches it slows sideways.
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        if (this.y[i] >= this.ground[i] - 0.5) this.px[i] = this.x[i] - (this.x[i] - this.px[i]) * FLOOR_GRIP;
      }
    }
    for (let i = 0; i < LANDMARK_COUNT; i++) fastest = Math.max(fastest, Math.hypot(this.x[i] - this.px[i], this.y[i] - this.py[i]) * SUBSTEPS);
    this.still = fastest < SETTLE_SPEED ? this.still + 1 : 0;
  }

  /** The landmarks now (same space as the start's). */
  skeleton(): NormalizedLandmark[] {
    return this.visibility.map((visibility, i) => ({ x: this.x[i], y: this.y[i], visibility }));
  }

  private solveDistance(a: number, b: number, length: number, stiffness: number, minOnly: boolean): void {
    const dx = this.x[b] - this.x[a], dy = this.y[b] - this.y[a];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6 || (minOnly && d >= length)) return;
    const wa = this.inverseMass[a], wb = this.inverseMass[b];
    const push = (stiffness * (d - length)) / (d * (wa + wb));
    this.x[a] += dx * push * wa;
    this.y[a] += dy * push * wa;
    this.x[b] -= dx * push * wb;
    this.y[b] -= dy * push * wb;
  }

  /** Signed distance of `joint` off the root→end line, measured along the body's forward direction (positive: forward). */
  private bendSide(root: number, joint: number, end: number): number {
    const spine = this.spine();
    const forward = { x: -spine.y, y: spine.x };
    const mx = (this.x[root] + this.x[end]) / 2, my = (this.y[root] + this.y[end]) / 2;
    return (this.x[joint] - mx) * forward.x + (this.y[joint] - my) * forward.y;
  }

  /** Unit vector from the pelvis up the spine. */
  private spine(): Point {
    const dx = (this.x[L.leftShoulder] + this.x[L.rightShoulder] - this.x[L.leftHip] - this.x[L.rightHip]) / 2;
    const dy = (this.y[L.leftShoulder] + this.y[L.rightShoulder] - this.y[L.leftHip] - this.y[L.rightHip]) / 2;
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }

  /**
   * A knee pushed past straight the wrong way is moved back onto the line, the
   * hip and ankle the other way (weighted by mass), so the fix adds no momentum:
   * moving the knee alone would make the body creep along the floor.
   */
  private solveHinge(h: Hinge): void {
    const off = this.bendSide(h.root, h.joint, h.end) * h.sign;
    if (off >= 0) return;
    const spine = this.spine();
    const forward = { x: -spine.y * h.sign, y: spine.x * h.sign };
    const wj = this.inverseMass[h.joint], wr = this.inverseMass[h.root], we = this.inverseMass[h.end];
    // The knee's distance off the line changes by (moved knee) − (mean of the moved ends).
    const k = -off / (wj + (wr + we) / 4);
    this.x[h.joint] += forward.x * k * wj;
    this.y[h.joint] += forward.y * k * wj;
    for (const [i, w] of [[h.root, wr], [h.end, we]]) {
      this.x[i] -= (forward.x * k * w) / 2;
      this.y[i] -= (forward.y * k * w) / 2;
    }
  }

  private collide(): void {
    const [left, right] = this.walls;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      // The floor stops them dead (no bounce: they're out cold).
      if (this.y[i] > this.ground[i]) this.y[i] = this.ground[i];
      if (this.x[i] < left) { this.x[i] = left; this.px[i] = left; }
      if (this.x[i] > right) { this.x[i] = right; this.px[i] = right; }
    }
  }
}

/** How wide the torso is taken to be around the spine, in torso lengths (a side-on chest, front to back). */
const TORSO_RADIUS = 0.3;
/** The top of the upper arm is always over the shoulder: only the arm beyond this fraction of it counts. */
const ARM_FROM = 0.4;

/**
 * How much of a capture's arms lie over its torso (0: none, 1: both arms
 * entirely). A limp arm swings off the chest and bares what the photo has
 * behind it, nothing; the capture that covers its torso least is drawn under
 * the ragdoll to fill that in.
 */
export function torsoCover(landmarks: readonly NormalizedLandmark[]): number {
  const l = landmarks as NormalizedLandmark[];
  const torso = torsoLength(l);
  if (!torso) return 1;
  const neck = midShoulder(l), pelvis = midHip(l);
  const dx = pelvis.x - neck.x, dy = pelvis.y - neck.y, len2 = dx * dx + dy * dy;
  const overTorso = (x: number, y: number) => {
    const raw = ((x - neck.x) * dx + (y - neck.y) * dy) / len2;
    if (raw < 0 || raw > 1) return false; // above the shoulders or below the hips: not over the torso
    return Math.hypot(x - neck.x - raw * dx, y - neck.y - raw * dy) < TORSO_RADIUS * torso;
  };
  const SAMPLES = 20;
  let covered = 0;
  for (const side of SIDES) {
    const chain = [l[L[`${side}Shoulder`]], l[L[`${side}Elbow`]], l[L[`${side}Wrist`]], l[L[`${side}Index`]]];
    for (let k = 0; k < SAMPLES; k++) {
      // Evenly along shoulder → elbow → wrist → fingers, starting ARM_FROM down the upper arm.
      const u = ARM_FROM / 3 + (k / (SAMPLES - 1)) * (1 - ARM_FROM / 3);
      const segment = Math.min(2, Math.floor(u * 3)), t = u * 3 - segment;
      const a = chain[segment], b = chain[segment + 1];
      if (overTorso(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) covered++;
    }
  }
  return covered / (2 * SAMPLES);
}
