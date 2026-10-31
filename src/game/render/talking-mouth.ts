import { LANDMARK, type NormalizedLandmark } from "../../shared/fighter-model";
import type { Point } from "./arap";
import { headOf } from "./battle-damage";

/*
 * A talking mouth, worked out from a voice clip's loudness: rendering only, and
 * an experiment for now (the pose lab, /lab). The photo's jaw drops and a dark
 * mouth fills the gap. The pose model gives only the two mouth corners, so the
 * mouth sits on them, sized from the head (battle-damage.ts's head frame).
 * Everything here is pure.
 */

export interface EnvelopeOptions {
  /** Openness values per second. */
  fps: number;
  /** Loudness (dB under the clip's loudest moment) at which the mouth shuts. */
  gateDb: number;
  /**
   * Syllables: the mouth also closes this far (dB) under the loudest moment within
   * `syllableMs` either side, so it moves through speech that stays loud (consonants
   * are voiced too, and recorded clips are compressed). 0: loudness alone.
   */
  syllableDb: number;
  syllableMs: number;
  /** Opening and closing time constants: mouths snap open and fall shut a little slower. */
  attackMs: number;
  releaseMs: number;
}

export const DEFAULT_ENVELOPE: EnvelopeOptions = { fps: 60, gateDb: -30, syllableDb: 6, syllableMs: 100, attackMs: 15, releaseMs: 70 };

/**
 * How open the mouth is (0..1) at each of `fps` steps through a clip: the RMS
 * loudness of each step against the clip's loudest (gated) and against the
 * loudest nearby (syllables), then smoothed.
 * `channels`: the decoded clip's samples (mixed to one).
 */
export function loudnessEnvelope(channels: readonly Float32Array[], sampleRate: number, options: Partial<EnvelopeOptions> = {}): Float32Array {
  const o = { ...DEFAULT_ENVELOPE, ...options };
  const length = channels[0]?.length ?? 0;
  const step = sampleRate / o.fps;
  const frames = Math.ceil(length / step);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const from = Math.floor(f * step), to = Math.min(length, Math.floor((f + 1) * step));
    let sum = 0;
    for (let i = from; i < to; i++) {
      let v = 0;
      for (const c of channels) v += c[i];
      v /= channels.length;
      sum += v * v;
    }
    rms[f] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }
  const peak = rms.reduce((a, b) => Math.max(a, b), 0);
  const out = new Float32Array(frames);
  if (!(peak > 0)) return out;
  const attack = 1 - Math.exp(-1000 / o.fps / o.attackMs);
  const release = 1 - Math.exp(-1000 / o.fps / o.releaseMs);
  const db = Array.from(rms, (v) => (v > 0 ? 20 * Math.log10(v / peak) : -Infinity));
  const reach = Math.round((o.syllableMs / 1000) * o.fps);
  let level = 0;
  for (let f = 0; f < frames; f++) {
    let target = Math.max(0, Math.min(1, (db[f] - o.gateDb) / -o.gateDb));
    if (o.syllableDb > 0 && target > 0) {
      const near = Math.max(...db.slice(Math.max(0, f - reach), f + reach + 1));
      target *= Math.max(0, Math.min(1, 1 - (near - db[f]) / o.syllableDb));
    }
    level += (target - level) * (target > level ? attack : release);
    out[f] = level;
  }
  return out;
}

/** Openness `seconds` into a clip (0 before and after it). */
export function opennessAt(envelope: Float32Array, fps: number, seconds: number): number {
  const f = seconds * fps;
  if (!(f >= 0) || f >= envelope.length) return 0;
  const i = Math.floor(f), t = f - i;
  return envelope[i] * (1 - t) + (envelope[Math.min(envelope.length - 1, i + 1)] ?? 0) * t;
}

/**
 * Where the mouth is: `center` between the lips, `along` the mouth line, `up`
 * toward the eyes (unit vectors), `width` corner to corner. Distances are in
 * the landmarks' space; positions along the mouth line (`back`, `full`,
 * `front`) are measured from `center` along `along`, and say how much of the
 * face moves with the jaw: nothing behind `back`, all of it from `full` to `front`.
 */
export interface MouthFrame {
  center: Point;
  along: Point;
  up: Point;
  width: number;
  /** Ear to nose (battle-damage.ts's head size): the unit for everything else. */
  headSize: number;
  /** Lips to the bottom of the chin. */
  chin: number;
  back: number;
  full: number;
  front: number;
  /** Both corners seen, far enough apart: a face turned toward the camera. */
  frontal: boolean;
}

const MIN_CORNER_VISIBILITY = 0.4;
/** Head sizes from the lips to the bottom of the chin. */
export const CHIN_DEPTH = 0.5;
/** A side-on mouth's width, in head sizes, when the far corner is hidden. */
const PROFILE_MOUTH_WIDTH = 0.42;

export function mouthFrameOf(l: readonly NormalizedLandmark[]): MouthFrame | null {
  const head = headOf(l);
  if (!head) return null;
  const size = head.size;
  const left = l[LANDMARK.mouthLeft], right = l[LANDMARK.mouthRight];
  const seen = left.visibility >= MIN_CORNER_VISIBILITY && right.visibility >= MIN_CORNER_VISIBILITY;
  const span = Math.hypot(right.x - left.x, right.y - left.y);
  const frontal = seen && span >= 0.3 * size;
  const center = seen ? { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 } : head.mouth;
  const along = frontal ? { x: (right.x - left.x) / span, y: (right.y - left.y) / span } : head.forward;
  // A quarter turn off the mouth line, whichever way points at the eyes.
  let up = { x: along.y, y: -along.x };
  if (up.x * (head.eye.x - center.x) + up.y * (head.eye.y - center.y) < 0) up = { x: -up.x, y: -up.y };
  const width = frontal ? span : PROFILE_MOUTH_WIDTH * size;
  const common = { center, along, up, width, headSize: size, chin: CHIN_DEPTH * size, frontal };
  const feather = 0.2 * size;
  if (frontal) return { ...common, back: -width / 2 - 0.35 * size - feather, full: -width / 2 - 0.35 * size, front: width / 2 + 0.35 * size };
  // Side-on the jaw hinges under the ear: it moves less the further back, nothing at the ear.
  const ear = (head.ear.x - center.x) * along.x + (head.ear.y - center.y) * along.y;
  const nose = (head.nose.x - center.x) * along.x + (head.nose.y - center.y) * along.y;
  return { ...common, back: ear, full: ear * 0.35, front: Math.max(nose, width / 2) + 0.1 * size };
}

/** How the jaw moves at full openness. */
export interface TalkOptions {
  /** The jaw's drop, in head sizes (capped at `maxJawDrop`). */
  drop: number;
  /** Openness is raised to this power first: under 1, quiet sounds open the mouth more. */
  curve: number;
}

export const DEFAULT_TALK: TalkOptions = { drop: 0.35, curve: 0.85 };

/** The stretch from the lips down to where the jaw moves whole (the lower lip), in head sizes. */
const LIP_STRETCH = 0.06;
/** Below the chin, the neck takes up the drop over this much of the chin depth. */
const NECK_TAKEUP = 1.4;

/** The largest drop the warp can take without folding the neck (landmark units). */
export function maxJawDrop(f: MouthFrame): number {
  return 0.85 * NECK_TAKEUP * f.chin;
}

/** The jaw's drop for an openness (0..1), in landmark units. */
export function jawDropFor(f: MouthFrame, open: number, o: TalkOptions = DEFAULT_TALK): number {
  return Math.min(maxJawDrop(f), Math.pow(Math.max(0, Math.min(1, open)), o.curve) * o.drop * f.headSize);
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Where an output point of a dropped jaw came from: unchanged above the lips; the
 * lips stretch open; lips to chin move down whole; the top of the neck squashes
 * to make room. Points only move along `up`, so the map inverts exactly (no
 * folds, no holes). Toward the back of the jaw (side-on: toward the ear) it moves less.
 */
function jawSource(f: MouthFrame, drop: number, x: number, y: number): Point {
  const { center: c, along: a, up: u } = f;
  const dx = x - c.x, dy = y - c.y;
  const s = dx * a.x + dy * a.y;
  const v = dx * u.x + dy * u.y;
  if (v >= 0) return { x, y };
  const fade = 0.2 * f.headSize;
  const d = drop * smooth(s < f.full ? (s - f.back) / (f.full - f.back) : s > f.front ? 1 - (s - f.front) / fade : 1);
  if (!(d > 0)) return { x, y };
  const r = LIP_STRETCH * f.headSize;
  const neck = NECK_TAKEUP * f.chin;
  let from: number;
  if (v >= -(r + d)) from = v / (1 + d / r);
  else if (v >= -(f.chin + d)) from = v + d;
  else if (v >= -(f.chin + neck)) from = -f.chin - (-f.chin - d - v) / (1 - d / neck);
  else return { x, y };
  return { x: x + u.x * (from - v), y: y + u.y * (from - v) };
}

/** An integer pixel box. */
export interface PixelBox { x: number; y: number; width: number; height: number }

/**
 * The pixels the jaw can change at any drop, and the mouth hole cover (with room
 * for its soft edge): everything outside stays as it is.
 */
export function jawBounds(f: MouthFrame, width: number, height: number): PixelBox {
  const { center: c, along: a, up: u } = f;
  const margin = 0.1 * f.headSize + 2;
  const corners = [f.back - margin, f.front + 0.2 * f.headSize + margin].flatMap((s) =>
    [margin, -(f.chin + NECK_TAKEUP * f.chin) - margin].map((v) => ({ x: c.x + a.x * s + u.x * v, y: c.y + a.y * s + u.y * v })));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)))), x1 = Math.min(width, Math.ceil(Math.max(...corners.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)))), y1 = Math.min(height, Math.ceil(Math.max(...corners.map((p) => p.y))));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * The photo with its jaw dropped by `drop` (landmark units, see `jawDropFor`): `src`
 * is a width × height RGBA sprite. `out` may be passed to reuse a buffer drawn into
 * before (by this, for the same `src` and frame): only `jawBounds` is rewritten.
 */
export function dropJaw(src: Uint8ClampedArray, width: number, height: number, f: MouthFrame, drop: number, out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(src)): Uint8ClampedArray<ArrayBuffer> {
  const box = jawBounds(f, width, height);
  for (let y = box.y; y < box.y + box.height; y++) {
    const row = (y * width + box.x) * 4;
    out.set(src.subarray(row, row + box.width * 4), row);
  }
  drop = Math.min(drop, maxJawDrop(f));
  if (!(drop > 0)) return out;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const from = jawSource(f, drop, x + 0.5, y + 0.5);
      if (from.x === x + 0.5 && from.y === y + 0.5) continue;
      sample(src, out, width, height, x, y, from.x - 0.5, from.y - 0.5);
    }
  }
  return out;
}

/** Bilinear sample of `src` at (sx, sy) into pixel (x, y) of `out`. */
function sample(src: Uint8ClampedArray, out: Uint8ClampedArray, width: number, height: number, x: number, y: number, sx: number, sy: number): void {
  const fx = Math.max(0, Math.min(width - 1, sx)), fy = Math.max(0, Math.min(height - 1, sy));
  const ix = Math.min(width - 2, Math.floor(fx)), iy = Math.min(height - 2, Math.floor(fy));
  const tx = fx - ix, ty = fy - iy;
  const o = (y * width + x) * 4;
  for (let ch = 0; ch < 4; ch++) {
    const p = (yy: number, xx: number) => src[(yy * width + xx) * 4 + ch];
    const top = p(iy, ix) * (1 - tx) + p(iy, ix + 1) * tx;
    const bottom = p(iy + 1, ix) * (1 - tx) + p(iy + 1, ix + 1) * tx;
    out[o + ch] = top * (1 - ty) + bottom * ty;
  }
}

/** An ellipse in a mouth frame: centre, half-axes along the mouth line and up, and those axes. */
export interface MouthEllipse { center: Point; rx: number; ry: number; along: Point; up: Point }

/** The dark gap `dropJaw` opens between the lips (null while it's shut): the lower lip has moved down by `drop`. */
export function mouthHole(f: MouthFrame, drop: number): MouthEllipse | null {
  drop = Math.min(drop, maxJawDrop(f));
  if (drop < 0.015 * f.headSize) return null;
  const center = { x: f.center.x - f.up.x * drop * 0.5, y: f.center.y - f.up.y * drop * 0.5 };
  return { center, rx: (f.width / 2) * 0.92, ry: drop * 0.52, along: f.along, up: f.up };
}
