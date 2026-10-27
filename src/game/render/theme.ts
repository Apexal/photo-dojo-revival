import Phaser from "phaser";

/**
 * Arcade night, for the canvas: the same colours and type as `src/shared/theme.css`.
 * Display text (Lilita One) is for anything shouted (titles, menus, buttons, numbers) and carries an ink
 * outline and a hard drop; body text (Nunito) is for anything read. Boxes sit on a hard ink shadow.
 */
export const COLOR = {
  bg: "#1d1240",
  dot: "#271852",
  well: "#120a2a",
  panel: "#2b1d5c",
  tile: "#38287a",
  showcaseGlow: "#4a3399",
  line: "#4d3b8c",
  edge: "#8f7ddb",
  ink: "#0d0820",
  fg: "#fff4dc",
  muted: "#c9bde8",
  faint: "#a596d4",
  disabled: "#6e5fa3",
  accent: "#ffc83d",
  accentDeep: "#e59a00",
  bad: "#ff5a47",
  ok: "#5be08a",
  party: "#ff7ac0",
  p2: "#4aa8ff",
  healthEmpty: "#5c1a3a",
  healthGlow: "#ffd0c8",
} as const;

type ColorName = keyof typeof COLOR;
/** The same colours as numbers, for Graphics and shapes. */
export const HEX = Object.fromEntries(Object.entries(COLOR).map(([k, v]) => [k, parseInt(v.slice(1), 16)])) as Record<ColorName, number>;

export const FONT = {
  display: '"Lilita One", "Arial Rounded MT Bold", system-ui, sans-serif',
  body: 'Nunito, "Arial Rounded MT Bold", system-ui, sans-serif',
} as const;

export const RADIUS = { sm: 8, md: 14, lg: 22 } as const;
/** Hard drop-shadow offsets (straight down, solid ink). */
export const SHADOW = { sm: 3, md: 5, lg: 8 } as const;
/** Outline width around boxes. */
export const BORDER = 3;

type TextStyle = Phaser.Types.GameObjects.Text.TextStyle;

/** Ink outline width for display text of this size. */
export function strokeFor(size: number): number {
  return size <= 30 ? 4 : size <= 64 ? 7 : 12;
}

/** Lilita One with an ink outline and a hard drop. `outline: false` for text sitting on a fill (a gold pill, a stamp). */
export function displayText(size: number, color: string = COLOR.fg, extra: TextStyle & { outline?: boolean } = {}): TextStyle {
  const { outline = true, ...rest } = extra;
  const drop = size >= 30 ? 4 : 3;
  return {
    fontFamily: FONT.display,
    fontSize: `${size}px`,
    color,
    ...(outline
      ? { stroke: COLOR.ink, strokeThickness: strokeFor(size), shadow: { offsetX: 0, offsetY: drop, color: COLOR.ink, blur: 0, fill: true, stroke: true }, padding: { left: 0, right: 0, top: 0, bottom: drop } }
      : {}),
    ...rest,
  };
}

/** Nunito for reading. Weight 500 for copy, 800 for emphasis and labels. */
export function bodyText(size: number, color: string = COLOR.fg, weight: 500 | 600 | 800 = 500, extra: TextStyle = {}): TextStyle {
  return { fontFamily: FONT.body, fontSize: `${size}px`, fontStyle: String(weight), color, ...extra };
}

export interface PopBoxOptions {
  fill?: number;
  fillAlpha?: number;
  /** Outline colour; `null` for none. */
  border?: number | null;
  borderWidth?: number;
  radius?: number;
  /** Drop offset; 0 for none. */
  shadow?: number;
}

/** Draws a popped box (fill, outline, hard ink drop) into `g` at local (x, y). */
export function drawPopBox(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, opts: PopBoxOptions = {}): Phaser.GameObjects.Graphics {
  const { fill = HEX.panel, fillAlpha = 1, border = HEX.ink, borderWidth = BORDER, radius = RADIUS.md, shadow = SHADOW.md } = opts;
  const r = Math.min(radius, w / 2, h / 2);
  if (shadow > 0) g.fillStyle(HEX.ink, 1).fillRoundedRect(x, y + shadow, w, h, r);
  g.fillStyle(fill, fillAlpha).fillRoundedRect(x, y, w, h, r);
  if (border !== null && borderWidth > 0) g.lineStyle(borderWidth, border, 1).strokeRoundedRect(x, y, w, h, r);
  return g;
}

/** A new Graphics at (x, y) holding one popped box of w × h from its top-left. */
export function popBox(scene: Phaser.Scene, x: number, y: number, w: number, h: number, opts: PopBoxOptions = {}): Phaser.GameObjects.Graphics {
  return drawPopBox(scene.add.graphics({ x, y }), 0, 0, w, h, opts);
}

const HALFTONE = "theme-halftone";

/** The menu ground: `bg` with the printed halftone dots, behind everything (depth -100). */
export function drawBackdrop(scene: Phaser.Scene): Phaser.GameObjects.TileSprite {
  if (!scene.textures.exists(HALFTONE)) {
    const tex = scene.textures.createCanvas(HALFTONE, 14, 14)!;
    const ctx = tex.getContext();
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, 14, 14);
    ctx.fillStyle = COLOR.dot;
    ctx.beginPath();
    ctx.arc(7, 7, 2.2, 0, Math.PI * 2);
    ctx.fill();
    tex.refresh();
  }
  return scene.add.tileSprite(0, 0, scene.scale.width, scene.scale.height, HALFTONE).setOrigin(0).setDepth(-100).setScrollFactor(0);
}

/** A tilted label (REVIVAL, READY, NEW!) on a colour fill: returns a container centred on (x, y). */
export function stamp(scene: Phaser.Scene, x: number, y: number, label: string, fill: number = HEX.bad, size = 22): Phaser.GameObjects.Container {
  const text = scene.add.text(0, 0, label.toUpperCase(), displayText(size, COLOR.ink, { outline: false, letterSpacing: Math.round(size * 0.12) })).setOrigin(0.5);
  const w = text.width + size * 1.1;
  const h = size * 1.5;
  const box = drawPopBox(scene.add.graphics(), -w / 2, -h / 2, w, h, { fill, radius: RADIUS.sm, shadow: SHADOW.sm });
  return scene.add.container(x, y, [box, text]).setAngle(-5);
}

/**
 * Waits (briefly) for the two faces so Phaser measures text in them, not in a fallback.
 * Phaser draws text once into a canvas; a font arriving later would not redraw it.
 */
export async function loadFonts(timeoutMs = 3000): Promise<void> {
  if (!("fonts" in document)) return;
  const faces = ['400 30px "Lilita One"', "500 18px Nunito", "600 18px Nunito", "800 18px Nunito"].map((f) => document.fonts.load(f));
  await Promise.race([Promise.all(faces).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
