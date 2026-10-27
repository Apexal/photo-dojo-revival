import { ARCHETYPES, ARCHETYPE_IDS } from "../../shared/archetypes";
import { GROUND_LINE_Y, SOUND_IDS, type NormalizedLandmark } from "../../shared/fighter-model";
import { CAPTURE_TARGET_COUNT, POSE_DEFINITIONS, SIGNATURE_DEFINITIONS } from "../../shared/pose-definitions";
import { evaluatePose } from "../../shared/pose-geometry";
import { buildStickFigureLandmarks } from "../../shared/stick-figure";
import { GhostOverlay } from "../../capture/ghost-overlay";
import { correctionArrows, correctionFor } from "../../capture/pose-coaching";
import { interpolateLandmarks } from "../../game/render/pose-tweener";
import { h } from "./dom";

/**
 * "How it works": a short animated walkthrough shown before setup the first
 * time the studio opens (and from setup's "How it works"). Drawn live, not a
 * video: the pose scene runs the studio's own overlay, so it shows exactly
 * what the player will see, and nothing goes stale when the screens change.
 */

export interface IntroScene { id: string; title: string; caption: string; ms: number }

export const INTRO_SCENES: readonly IntroScene[] = [
  { id: "become", title: "Become a fighter", ms: 5000,
    caption: "The studio turns photos of you into a fighter for the game: your body, your moves, your battle cries." },
  { id: "style", title: "Pick a fighting style", ms: 4500,
    caption: "Each style adds one signature move. You pick it first, then all the poses run in one go." },
  { id: "pose", title: `Match ${CAPTURE_TARGET_COUNT} poses`, ms: 7500,
    caption: "Stand back so the camera sees you head to feet. Red means fix it: follow the arrow. When you match, it turns green: hold still for the tone and the ding." },
  { id: "cutout", title: "You're cut out automatically", ms: 4500,
    caption: "Each photo is cut out of the room right here, on this computer. Nothing is uploaded." },
  { id: "sounds", title: `Record ${SOUND_IDS.length} battle cries`, ms: 4500,
    caption: "A cry for your attacks, an ouch for when you're hit, a victory line and a taunt. Or skip them." },
  { id: "fight", title: "Then fight as yourself", ms: 5500,
    caption: "Your fighter is saved in this browser, waiting on fighter select. Take on a friend or the computer." },
];

const sceneStart = (index: number) => INTRO_SCENES.slice(0, index).reduce((sum, s) => sum + s.ms, 0);
export const INTRO_TOTAL_MS = sceneStart(INTRO_SCENES.length);

/** Which scene is showing `elapsedMs` in, and how far through it (0..1). Stops on the last scene. */
export function introSceneAt(elapsedMs: number): { index: number; t: number; done: boolean } {
  let start = 0;
  for (const [index, scene] of INTRO_SCENES.entries()) {
    if (elapsedMs < start + scene.ms) return { index, t: Math.max(0, elapsedMs - start) / scene.ms, done: false };
    start += scene.ms;
  }
  return { index: INTRO_SCENES.length - 1, t: 1, done: true };
}

// --- drawing ------------------------------------------------------------------------

/** Drawing size; the canvas has twice the pixels, so text stays sharp on big and high-DPI screens. */
const W = 960;
const H = 540;
const RES = 2;
const COLOURS = { bg: "#2b1d5c", frame: "#38287a", fg: "#fff4dc", muted: "#c9bde8", accent: "#ffc83d", ok: "#5be08a", bad: "#ff5a47" };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
/** Which of `n` equal beats `t` (0..1) is in. */
const beat = (t: number, n: number) => Math.min(n - 1, Math.floor(t * n));

type Fighter = "red" | "blue";

/** The built-in stick fighters' sprites (512², feet at GROUND_LINE_Y). */
class Sprites {
  private readonly images = new Map<string, HTMLImageElement>();
  constructor(private readonly base: string) {}

  draw(ctx: CanvasRenderingContext2D, fighter: Fighter, pose: string, x: number, groundY: number, scale: number, flip = false): void {
    const key = `${fighter}/${pose}`;
    let img = this.images.get(key);
    if (!img) {
      img = new Image();
      img.src = `${this.base}placeholders/placeholder-${fighter}/${pose}.png`;
      this.images.set(key, img);
    }
    if (!img.complete || !img.naturalWidth) return;
    ctx.save();
    ctx.translate(x, groundY - GROUND_LINE_Y * scale);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -256 * scale, 0, 512 * scale, 512 * scale);
    ctx.restore();
  }
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string = COLOURS.fg, align: CanvasTextAlign = "center"): void {
  ctx.font = `400 ${size}px "Lilita One", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(4, size * 0.16);
  ctx.strokeStyle = "#0d0820";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

/** A pose's ghost outline (sprite coordinates), centred on `x` with its feet on `groundY`. */
function ghost(ctx: CanvasRenderingContext2D, path: string, x: number, groundY: number, scale: number, colour: string): void {
  ctx.save();
  ctx.translate(x - 256 * scale, groundY - GROUND_LINE_Y * scale);
  ctx.scale(scale, scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = colour;
  ctx.lineWidth = 26;
  ctx.stroke(new Path2D(path));
  ctx.restore();
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, colour: string): void {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 - 18, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x1 - 30, y - 22);
  ctx.lineTo(x1 - 30, y + 22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBecome(ctx: CanvasRenderingContext2D, t: number, sprites: Sprites): void {
  ghost(ctx, POSE_DEFINITIONS.idle.ghostSvgPath, 250, 440, 0.75, "rgba(255, 255, 255, 0.5)");
  text(ctx, "You, in front of a camera", 250, 490, 24, COLOURS.muted);
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 6);
  arrow(ctx, 420, 540, 280, `rgba(255, 200, 61, ${0.5 + 0.5 * pulse})`);
  const poses = ["idle", "punch", "idle", "kick", "win"];
  sprites.draw(ctx, "red", poses[beat(t, poses.length)], 710, 440, 0.75);
  text(ctx, "Your fighter, in the game", 710, 490, 24, COLOURS.muted);
}

function drawStyle(ctx: CanvasRenderingContext2D, t: number): void {
  const picked = beat(t, ARCHETYPE_IDS.length);
  for (const [i, id] of ARCHETYPE_IDS.entries()) {
    const x = 135 + i * 230;
    const on = i === picked;
    ghost(ctx, SIGNATURE_DEFINITIONS[id].ghostSvgPath, x, 380, 0.55, on ? COLOURS.accent : "rgba(255, 255, 255, 0.3)");
    text(ctx, ARCHETYPES[id].name, x, 430, 28, on ? COLOURS.accent : COLOURS.fg);
    text(ctx, ARCHETYPES[id].moveName, x, 465, 20, COLOURS.muted);
  }
  text(ctx, "down + punch + kick", W / 2, 70, 26, COLOURS.muted);
}

/** The live screen as the player will see it: ghost, coloured skeleton, arrow, hold ring. */
class PoseDemo {
  private readonly canvas = document.createElement("canvas");
  private readonly overlay = new GhostOverlay(this.canvas);
  private readonly stance = buildStickFigureLandmarks("idle");
  private readonly punch = buildStickFigureLandmarks("punch");

  constructor() {
    this.overlay.resize(512 * RES, 512 * RES);
  }

  draw(ctx: CanvasRenderingContext2D, t: number): void {
    const s = t * (INTRO_SCENES[2].ms / 1000); // seconds into the scene
    const def = POSE_DEFINITIONS.punch;
    // In the stance, then moving into the punch, then holding it.
    const sway = Math.sin(s * 3) * 0.04;
    const lm: NormalizedLandmark[] = s < 2.8
      ? interpolateLandmarks(this.stance, this.punch, Math.max(0, sway))
      : interpolateLandmarks(this.stance, this.punch, ease((s - 2.8) / 1.2));
    const { score, joints } = evaluatePose(lm, def);
    const holdStart = 4.2;
    const matching = s >= holdStart && score <= 1;
    const holdProgress = matching ? clamp01((s - holdStart) / 0.8) : 0;
    const worst = joints.filter((j) => j.delta !== null && j.error > 1).sort((a, b) => b.error - a.error)[0];
    const arrows = !matching && worst ? correctionArrows(lm, worst.joint, worst.delta!) : [];
    this.overlay.draw({
      ghostPath: def.ghostSvgPath,
      ghostFit: { scale: RES, groundX: 256 * RES, groundY: GROUND_LINE_Y * RES },
      landmarks: lm.map((l) => ({ ...l, x: l.x / 512, y: l.y / 512 })),
      joints,
      arrows: arrows.map(({ from, to }) => ({ from: { x: from.x * RES, y: from.y * RES }, to: { x: to.x * RES, y: to.y * RES } })),
      holdProgress,
      matching,
      large: false,
    });

    // The camera picture, with the overlay on it.
    const size = 470;
    const fx = 70;
    const fy = (H - size) / 2;
    ctx.fillStyle = COLOURS.frame;
    ctx.beginPath();
    ctx.roundRect(fx, fy, size, size, 16);
    ctx.fill();
    ctx.drawImage(this.canvas, fx, fy, size, size);
    const got = s >= holdStart + 0.8;
    text(ctx, `${got ? 2 : 1} / ${CAPTURE_TARGET_COUNT}`, fx + 20, fy + 30, 22, COLOURS.accent, "left");

    // What the hint and the voice say.
    const x = 560;
    text(ctx, "Punch", x, 150, 40, COLOURS.fg, "left");
    const hint = got ? "Got it!" : matching ? "Hold it…" : worst ? correctionFor(worst.joint, worst.delta!) : "Punch. Arm straight out.";
    text(ctx, hint, x, 215, 30, got || matching ? COLOURS.ok : COLOURS.accent, "left");
    text(ctx, "🔊 spoken too, and a tone while you hold", x, 265, 20, COLOURS.muted, "left");
    // A legend for the colours.
    const legend: [string, string][] = [[COLOURS.bad, "fix this part"], [COLOURS.accent, "nearly there"], [COLOURS.ok, "spot on"]];
    for (const [i, [colour, label]] of legend.entries()) {
      const y = 340 + i * 42;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y - 5, 40, 10);
      text(ctx, label, x + 56, y, 22, COLOURS.fg, "left");
    }
  }
}

function drawCutout(ctx: CanvasRenderingContext2D, t: number, sprites: Sprites): void {
  const fx = 210, fy = 70, fw = 540, fh = 400;
  // The cut-out side: a checkerboard (transparent).
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(fx, fy, fw, fh, 14);
  ctx.clip();
  const cell = 20;
  for (let y = fy; y < fy + fh; y += cell) {
    for (let x = fx; x < fx + fw; x += cell) {
      ctx.fillStyle = ((x - fx) / cell + (y - fy) / cell) % 2 ? "#3b3546" : "#4a4356";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  // The room, still there right of the sweep.
  const sweep = fx + fw * ease((t - 0.2) / 0.55);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sweep, fy, fx + fw - sweep, fh);
  ctx.clip();
  ctx.fillStyle = "#6e6355";
  ctx.fillRect(fx, fy, fw, fh);
  ctx.fillStyle = "#57503f";
  ctx.fillRect(fx, fy + fh - 70, fw, 70); // floor
  ctx.fillStyle = "#8a7b62";
  ctx.fillRect(fx + 40, fy + 60, 110, 270); // door
  ctx.fillStyle = "#9fc3d8";
  ctx.fillRect(fx + 380, fy + 50, 120, 90); // window
  ctx.fillStyle = "#4d7a45";
  ctx.beginPath();
  ctx.arc(fx + 460, fy + 280, 40, 0, Math.PI * 2); // plant
  ctx.fill();
  ctx.restore();
  sprites.draw(ctx, "red", "idle", fx + fw / 2, fy + fh - 20, 0.72);
  ctx.restore();
  if (sweep > fx && sweep < fx + fw) {
    ctx.fillStyle = COLOURS.accent;
    ctx.fillRect(sweep - 2, fy, 4, fh);
  }
  text(ctx, t < 0.75 ? "Removing the background…" : "Done: just you", W / 2, 505, 24, t < 0.75 ? COLOURS.muted : COLOURS.ok);
}

function drawSounds(ctx: CanvasRenderingContext2D, t: number, sprites: Sprites): void {
  const lines: [string, string][] = [["Hyah!", "punch"], ["Ouch!", "hurt"], ["I win!", "win"]];
  const i = beat(t, lines.length);
  const [word, pose] = lines[i];
  sprites.draw(ctx, "red", pose, 300, 460, 0.8);
  // A level meter, loud as the word is said.
  const within = (t * lines.length) % 1;
  const loud = Math.sin(clamp01(within / 0.6) * Math.PI);
  for (let b = 0; b < 16; b++) {
    const level = loud * (0.35 + 0.65 * Math.abs(Math.sin(b * 1.7 + t * 40)));
    const bh = 10 + level * 140;
    ctx.fillStyle = COLOURS.accent;
    ctx.fillRect(560 + b * 18, 300 - bh / 2, 10, bh);
  }
  text(ctx, word, 700, 160, 64, COLOURS.fg);
  text(ctx, `${i + 1} of ${lines.length}`, 700, 430, 22, COLOURS.muted);
}

function drawFight(ctx: CanvasRenderingContext2D, t: number, sprites: Sprites): void {
  // Hard cuts, like the studio's preview: [red, blue, hit spark on (red|blue)?].
  const beats: [string, string, Fighter?][] = [
    ["idle", "idle"], ["walk", "idle"], ["punch", "hurt", "blue"], ["idle", "idle"],
    ["block", "kick"], ["kick", "hurt", "blue"], ["win", "hurt"],
  ];
  const [red, blue, hit] = beats[beat(t, beats.length)];
  const ground = 470;
  // The floor's far edge above the feet, as on the game's stages: they stand on it, not on its edge.
  ctx.fillStyle = "#38287a";
  ctx.fillRect(0, ground - 30, W, H - ground + 30);
  sprites.draw(ctx, "red", red, 360, ground, 0.72);
  sprites.draw(ctx, "blue", blue, 600, ground, 0.72, true);
  if (hit) {
    ctx.fillStyle = COLOURS.accent;
    const cx = 520, cy = 230;
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const r = k % 2 ? 14 : 40;
      const a = (k / 16) * Math.PI * 2;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  // Health bars: blue's drops with each hit.
  const hits = beats.slice(0, beat(t, beats.length) + 1).filter((b) => b[2] === "blue").length;
  for (const [x, health, colour] of [[60, 1, "#ff5a47"], [W - 60 - 360, 1 - hits * 0.35, "#4aa8ff"]] as const) {
    ctx.fillStyle = "#00000066";
    ctx.fillRect(x, 40, 360, 22);
    ctx.fillStyle = colour;
    ctx.fillRect(x === 60 ? x : x + 360 * (1 - health), 40, 360 * health, 22);
  }
  if (red === "win") text(ctx, "K.O.!", W / 2, 130, 72, COLOURS.accent);
}

// --- the panel ----------------------------------------------------------------------

export interface IntroOptions {
  /** The site's base URL, for the placeholder sprites. */
  base: string;
  /** Skip, or "Make my fighter" at the end. */
  onDone(): void;
}

export function introPanel({ base, onDone }: IntroOptions): HTMLElement {
  const canvas = h("canvas", { class: "intro-canvas", width: W * RES, height: H * RES, "aria-hidden": "true" });
  const ctx = canvas.getContext("2d")!;
  const sprites = new Sprites(base);
  const poseDemo = new PoseDemo();
  const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const title = h("h2", {}, "");
  const caption = h("p", { class: "intro-caption", "aria-live": "polite" }, "");
  const dots = INTRO_SCENES.map((scene, i) =>
    h("button", { type: "button", class: "intro-dot", "aria-label": `${i + 1}. ${scene.title}`, on: { click: () => jump(i) } }));
  const back = h("button", { type: "button", on: { click: () => jump(shown - 1) } }, "Back");
  const next = h("button", { type: "button", class: "primary", dataset: { action: "intro-next" }, on: { click: () => (shown === INTRO_SCENES.length - 1 ? onDone() : jump(shown + 1)) } }, "Next");

  let elapsed = 0;
  let shown = -1;
  let last: number | null = null;
  const jump = (index: number) => {
    elapsed = sceneStart(Math.max(0, Math.min(INTRO_SCENES.length - 1, index)));
    last = null;
  };

  const frame = (now: number) => {
    // Stop once the panel is gone (setup started, or the studio moved on).
    if (!canvas.isConnected && shown >= 0) return;
    // Reduced motion: the clock stands still (no auto-advance), and each scene holds on a telling frame.
    if (last !== null && !reducedMotion) elapsed += now - last;
    last = now;
    const at = introSceneAt(elapsed);
    const index = at.index;
    const t = reducedMotion ? 0.7 : at.t;
    if (index !== shown) {
      shown = index;
      title.textContent = INTRO_SCENES[index].title;
      caption.textContent = INTRO_SCENES[index].caption;
      dots.forEach((d, i) => d.classList.toggle("on", i === index));
      back.disabled = index === 0;
      next.textContent = index === INTRO_SCENES.length - 1 ? "Make my fighter" : "Next";
    }
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, W, H);
    switch (INTRO_SCENES[index].id) {
      case "become": drawBecome(ctx, t, sprites); break;
      case "style": drawStyle(ctx, t); break;
      case "pose": poseDemo.draw(ctx, t); break;
      case "cutout": drawCutout(ctx, t, sprites); break;
      case "sounds": drawSounds(ctx, t, sprites); break;
      case "fight": drawFight(ctx, t, sprites); break;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return h("div", { class: "panel wide intro" },
    h("div", { class: "intro-head" },
      h("span", { class: "muted" }, "How the studio works"),
      h("button", { type: "button", class: "link", dataset: { action: "skip-intro" }, on: { click: () => onDone() } }, "Skip"),
    ),
    canvas,
    title,
    caption,
    h("div", { class: "intro-controls" },
      back,
      h("div", { class: "intro-dots" }, ...dots),
      next,
    ),
    h("p", { class: "muted intro-needs" },
      h("strong", {}, "You'll need: "),
      "about 10 minutes, room to stand 3–4 m from the camera, and a plain wall behind you. A webcam or a phone works as the camera."),
  );
}
