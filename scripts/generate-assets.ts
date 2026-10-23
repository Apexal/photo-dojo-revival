/**
 * Generates the bundled assets:
 *   public/placeholders/<id>/{<pose>.png, thumbnail.png, fighter.json}  — stick-figure fighters for M1 / no-camera play
 *   public/sounds/{attack,hurt,win}.wav                                 — fallback sounds for fighters without clips
 *   public/sounds/{hit,block,tick}.wav                                  — game sound effects (impacts, the last-10-seconds clock)
 * Run: npm run generate:assets
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANDMARK, POSE_IDS, SPRITE_CANVAS_SIZE, THUMBNAIL_SIZE, type NormalizedLandmark } from "../src/shared/fighter-model";
import { anchorTargetFor, midHip, midShoulder } from "../src/shared/pose-geometry";
import { HEAD_RADIUS_PX, STICK_BONUS_POSES, buildStickFigureLandmarks, headCenter } from "../src/shared/stick-figure";
import type { PoseId } from "../src/shared/fighter-model";
import { encodePng, encodeWav } from "./lib/png";

const OUT = join(import.meta.dirname, "..", "public");
const S = SPRITE_CANVAS_SIZE;

type RGB = [number, number, number];
interface Shape { kind: "capsule"; ax: number; ay: number; bx: number; by: number; r: number; color: RGB }

function segDistance(px: number, py: number, s: Shape): number {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len2)) : 0;
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
}

/** Draw shapes back to front with a dark outline and antialiased edges. */
function rasterize(shapes: Shape[], outline: RGB): Uint8Array {
  const img = new Uint8Array(S * S * 4);
  const OUTLINE = 3;
  for (const shape of shapes) {
    const minX = Math.max(0, Math.floor(Math.min(shape.ax, shape.bx) - shape.r - OUTLINE - 1));
    const maxX = Math.min(S - 1, Math.ceil(Math.max(shape.ax, shape.bx) + shape.r + OUTLINE + 1));
    const minY = Math.max(0, Math.floor(Math.min(shape.ay, shape.by) - shape.r - OUTLINE - 1));
    const maxY = Math.min(S - 1, Math.ceil(Math.max(shape.ay, shape.by) + shape.r + OUTLINE + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = segDistance(x + 0.5, y + 0.5, shape);
        const cover = Math.max(0, Math.min(1, shape.r + OUTLINE + 0.5 - d));
        if (cover <= 0) continue;
        const fill = Math.max(0, Math.min(1, shape.r + 0.5 - d));
        const color = outline.map((o, i) => o + (shape.color[i] - o) * fill) as RGB;
        const i = (y * S + x) * 4;
        const a0 = img[i + 3] / 255;
        const a = cover + a0 * (1 - cover);
        for (let c = 0; c < 3; c++) img[i + c] = Math.round((color[c] * cover + img[i + c] * a0 * (1 - cover)) / (a || 1));
        img[i + 3] = Math.round(a * 255);
      }
    }
  }
  return img;
}

const shade = (c: RGB, k: number): RGB => c.map((v) => Math.round(v * k)) as RGB;

function stickShapes(lm: NormalizedLandmark[], body: RGB, accent: RGB): Shape[] {
  const cap = (a: { x: number; y: number }, b: { x: number; y: number }, r: number, color: RGB): Shape =>
    ({ kind: "capsule", ax: a.x, ay: a.y, bx: b.x, by: b.y, r, color });
  const far = shade(body, 0.7);
  const shapes: Shape[] = [];
  const limb = (side: "left" | "right", color: RGB) => {
    const p = (n: string) => lm[LANDMARK[`${side}${n}` as keyof typeof LANDMARK]];
    shapes.push(cap(p("Hip"), p("Knee"), 11, color), cap(p("Knee"), p("Ankle"), 9, color), cap(p("Ankle"), p("FootIndex"), 7, shade(color, 0.6)));
    shapes.push(cap(p("Shoulder"), p("Elbow"), 9, color), cap(p("Elbow"), p("Wrist"), 8, color), cap(p("Wrist"), p("Wrist"), 13, accent));
  };
  limb("left", far); // far side first
  shapes.push(cap(midShoulder(lm), midHip(lm), 24, body));
  const head = headCenter(lm);
  shapes.push(cap(head, head, HEAD_RADIUS_PX, shade(body, 1.1).map((v) => Math.min(255, v)) as RGB));
  const nose = lm[LANDMARK.nose];
  const eye = { x: head.x + (nose.x - head.x) * 0.75, y: head.y + (nose.y - head.y) * 0.75 - 4 };
  shapes.push(cap(eye, eye, 3.5, [255, 255, 255]));
  limb("right", body);
  return shapes;
}

function downscale(img: Uint8Array, from: number, to: number): Uint8Array {
  const k = from / to;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) for (let x = 0; x < to; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < k; sy++) for (let sx = 0; sx < k; sx++) {
      const i = ((y * k + sy) * from + x * k + sx) * 4;
      const a = img[i + 3];
      acc[0] += img[i] * a; acc[1] += img[i + 1] * a; acc[2] += img[i + 2] * a; acc[3] += a;
    }
    const o = (y * to + x) * 4;
    for (let c = 0; c < 3; c++) out[o + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0;
    out[o + 3] = Math.round(acc[3] / (k * k));
  }
  return out;
}

const FIGHTERS = [
  { id: "placeholder-red", name: "Red Stick", body: [214, 64, 52] as RGB, accent: [250, 210, 60] as RGB },
  { id: "placeholder-blue", name: "Blue Stick", body: [52, 112, 214] as RGB, accent: [240, 240, 240] as RGB },
];

for (const f of FIGHTERS) {
  const dir = join(OUT, "placeholders", f.id);
  mkdirSync(dir, { recursive: true });
  const poses: Record<string, unknown> = {};
  for (const poseId of POSE_IDS) {
    const landmarks = buildStickFigureLandmarks(poseId);
    const img = rasterize(stickShapes(landmarks, f.body, f.accent), [25, 20, 30]);
    writeFileSync(join(dir, `${poseId}.png`), encodePng(S, S, img));
    if (poseId === "idle") writeFileSync(join(dir, "thumbnail.png"), encodePng(THUMBNAIL_SIZE, THUMBNAIL_SIZE, downscale(img, S, THUMBNAIL_SIZE)));
    const round = (n: number) => Math.round(n * 100) / 100;
    poses[poseId] = {
      file: `${poseId}.png`,
      anchorPoint: anchorTargetFor(poseId),
      landmarks: landmarks.map((l) => ({ x: round(l.x), y: round(l.y), visibility: l.visibility })),
      ...(poseId === "punch" || poseId === "kick" ? { attackSide: "right" } : {}),
    };
  }
  const variants: Record<string, unknown[]> = {};
  for (const [key, params] of Object.entries(STICK_BONUS_POSES)) {
    const poseId = key.split("-")[0] as PoseId;
    const landmarks = buildStickFigureLandmarks(poseId, params);
    writeFileSync(join(dir, `${key}.png`), encodePng(S, S, rasterize(stickShapes(landmarks, f.body, f.accent), [25, 20, 30])));
    const round = (n: number) => Math.round(n * 100) / 100;
    (variants[poseId] ??= []).push({
      file: `${key}.png`,
      anchorPoint: anchorTargetFor(poseId),
      landmarks: landmarks.map((l) => ({ x: round(l.x), y: round(l.y), visibility: l.visibility })),
      ...(poseId === "punch" || poseId === "kick" ? { attackSide: "right" } : {}),
    });
  }
  writeFileSync(join(dir, "fighter.json"), JSON.stringify({ fighterId: f.id, name: f.name, thumbnail: "thumbnail.png", poses, variants }, null, 1));
  console.log("wrote", dir);
}

// --- fallback sounds -------------------------------------------------------
const RATE = 22050;
function synth(seconds: number, fn: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE, i);
  return out;
}
let seed = 7;
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 31) - 1;
const env = (t: number, attack: number, decay: number) => Math.min(1, t / attack) * Math.exp(-t / decay);

// attack: a "hyah" whoosh — band-ish noise with a quick pitch sweep
let lp = 0;
const attack = synth(0.28, (t) => {
  lp += (noise() - lp) * (0.15 + 0.5 * Math.exp(-t * 12));
  return 0.9 * env(t, 0.01, 0.07) * (lp * 2.2 + 0.25 * Math.sin(2 * Math.PI * (380 - 600 * t) * t));
});
// hurt: descending "oof"
const hurt = synth(0.35, (t) => {
  const f = 260 * Math.exp(-t * 2.5);
  const tone = Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.35 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25;
  return env(t, 0.005, 0.12) * (tone + noise() * 0.15);
});
// win: rising arpeggio
const notes = [523.25, 659.25, 783.99, 1046.5];
const win = synth(0.9, (t) => {
  const n = Math.min(notes.length - 1, Math.floor(t / 0.12));
  const tn = t - n * 0.12;
  const f = notes[n];
  return 0.5 * env(tn, 0.005, n === notes.length - 1 ? 0.35 : 0.1) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
});
// --- game sound effects (after the fallbacks so their noise stays the same) ---
// hit: a punchy thump — low sine drop plus a short noise crack
const hit = synth(0.22, (t) => {
  const f = 150 * Math.exp(-t * 18) + 45;
  return env(t, 0.002, 0.06) * (0.8 * Math.sin(2 * Math.PI * f * t) + 0.5 * noise() * Math.exp(-t * 60));
});
// block: a dull, damped knock
let lpb = 0;
const block = synth(0.16, (t) => {
  lpb += (noise() - lpb) * 0.08;
  return env(t, 0.002, 0.035) * (0.6 * Math.sin(2 * Math.PI * 220 * t) + 1.6 * lpb);
});
// tick: a short wooden click for the last 10 seconds
const tick = synth(0.08, (t) => env(t, 0.001, 0.012) * (0.6 * Math.sin(2 * Math.PI * 1800 * t) + 0.3 * Math.sin(2 * Math.PI * 900 * t)));

mkdirSync(join(OUT, "sounds"), { recursive: true });
for (const [name, samples] of Object.entries({ attack, hurt, win, hit, block, tick })) {
  writeFileSync(join(OUT, "sounds", `${name}.wav`), encodeWav(samples, RATE));
}
console.log("wrote", join(OUT, "sounds"));
