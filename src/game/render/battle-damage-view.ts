import Phaser from "phaser";
import type { Point } from "./arap";
import type { Scar, ScarKind } from "./battle-damage";
import { HEX } from "./theme";

/**
 * The scars' own colours: bruise, sticking plaster, sore skin. Not theme
 * colours: they're drawn on someone's face, not on the interface.
 */
const SCAR_COLOR = {
  bruise: 0x4b1f73,
  bruiseCore: 0x2a0f45,
  plaster: 0xf0c08e,
  plasterPad: 0xd99a6c,
  bump: 0xff8f8f,
  lip: 0xd23c55,
  gauze: 0xf6f2e8,
  gauzeFold: 0xd6cfbf,
} as const;

/** A new scar pops on over this long (ms), overshooting a little. */
const POP_MS = 240;

/** Ease out with an overshoot: 0 → 1, peaking a little past 1. */
function easeOutBack(t: number): number {
  const c = 1.7, x = t - 1;
  return 1 + x * x * ((c + 1) * x + c);
}

/** Points of an ellipse centred (u, v) with radii (ru, rv), in scar units. */
const ellipse = (u: number, v: number, ru: number, rv: number, n = 20): Point[] =>
  Array.from({ length: n }, (_, k) => ({ x: u + ru * Math.cos((2 * Math.PI * k) / n), y: v + rv * Math.sin((2 * Math.PI * k) / n) }));

/** A strip with rounded ends (a plaster), `length` long and `width` wide, along angle `a` in the scar's frame. */
function strip(length: number, width: number, a: number): Point[] {
  const r = width / 2, half = length / 2 - r;
  const ends = [
    ...Array.from({ length: 9 }, (_, k) => { const t = -Math.PI / 2 + (Math.PI * k) / 8; return { x: half + r * Math.cos(t), y: r * Math.sin(t) }; }),
    ...Array.from({ length: 9 }, (_, k) => { const t = Math.PI / 2 + (Math.PI * k) / 8; return { x: -half + r * Math.cos(t), y: r * Math.sin(t) }; }),
  ];
  return ends.map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
}

/** A plaster: the strip, its pad, and a couple of breathing holes each side. */
function plasterShapes(length: number, width: number, a: number): Shape[] {
  const along = (d: number): Point => ({ x: d * Math.cos(a), y: d * Math.sin(a) });
  const holes = [-0.34, -0.26, 0.26, 0.34].map((d) => ({ points: ellipse(along(d * length).x, along(d * length).y, 0.025, 0.025, 6), fill: SCAR_COLOR.plasterPad }));
  return [
    { points: strip(length, width, a), fill: SCAR_COLOR.plaster, outline: true },
    { points: strip(0.3 * length, 0.7 * width, a), fill: SCAR_COLOR.plasterPad },
    ...holes,
  ];
}

/** One filled polygon in scar units: u along the face, v up the head. */
interface Shape { points: Point[]; fill: number; alpha?: number; outline?: boolean }

/** A bandage wrapped round a limb: a band across it, with the folds of the wrapping slanting over it and a loose end. */
function wrapShapes(length: number, width: number): Shape[] {
  const u = length / 2, v = width / 2;
  const fold = (c: number): Shape => ({
    points: [{ x: c - 0.12 * length, y: -v }, { x: c - 0.04 * length, y: -v }, { x: c + 0.12 * length, y: v }, { x: c + 0.04 * length, y: v }],
    fill: SCAR_COLOR.gauzeFold,
  });
  return [
    { points: [{ x: 0.2 * u, y: 0 }, { x: 0.8 * u, y: 0 }, { x: 1.3 * u, y: 1.9 * v }, { x: 0.7 * u, y: 2 * v }], fill: SCAR_COLOR.gauze, outline: true },
    { points: [{ x: -u, y: -v }, { x: u, y: -v }, { x: u, y: v }, { x: -u, y: v }], fill: SCAR_COLOR.gauze, outline: true },
    fold(-0.22 * length), fold(0.18 * length),
  ];
}

/**
 * Each scar drawn around its centre: face scars in units of the head's size,
 * body scars (u along the limb, v across it) in torso lengths.
 */
const SHAPES: Record<ScarKind, Shape[]> = {
  blackEye: [
    { points: ellipse(0, 0, 0.42, 0.34), fill: SCAR_COLOR.bruise, alpha: 0.55 },
    { points: ellipse(0, -0.02, 0.27, 0.2), fill: SCAR_COLOR.bruiseCore, alpha: 0.45 },
  ],
  bandAid: plasterShapes(0.95, 0.28, 0),
  plaster: [...plasterShapes(0.9, 0.26, Math.PI / 4), ...plasterShapes(0.9, 0.26, -Math.PI / 4)],
  bump: [
    { points: ellipse(0, 0, 0.36, 0.42, 24).filter((p) => p.y >= -0.02), fill: SCAR_COLOR.bump, outline: true },
    { points: ellipse(-0.1, 0.24, 0.08, 0.06, 10), fill: HEX.fg, alpha: 0.8 },
  ],
  fatLip: [
    { points: ellipse(0, 0, 0.26, 0.14), fill: SCAR_COLOR.lip, alpha: 0.9, outline: true },
    { points: ellipse(0.04, 0.05, 0.1, 0.04, 10), fill: HEX.fg, alpha: 0.45 },
  ],
  noseTape: plasterShapes(0.62, 0.22, Math.PI / 2),
  armWrap: wrapShapes(0.26, 0.2),
  shinBruise: [
    { points: ellipse(0, 0, 0.14, 0.07), fill: SCAR_COLOR.bruise, alpha: 0.55 },
    { points: ellipse(0.01, 0, 0.08, 0.04), fill: SCAR_COLOR.bruiseCore, alpha: 0.45 },
  ],
  kneePatch: [...plasterShapes(0.3, 0.09, Math.PI / 4), ...plasterShapes(0.3, 0.09, -Math.PI / 4)],
};

/**
 * Draws one fighter's scars into a Graphics, mapped onto the screen by
 * `toScreen` (from the head's space: the landmarks of whatever is drawn, so the
 * scars follow it), each one popping on the first time it shows.
 */
export class BattleDamageView {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly born = new Map<ScarKind, number>();

  constructor(scene: Phaser.Scene, depth: number, private readonly outlineWidth = 2) {
    this.graphics = scene.add.graphics().setDepth(depth);
  }

  /** `now` in ms; `pop` false shows every scar at full size straight away. */
  render(scars: readonly Scar[], toScreen: (p: Point) => Point, now: number, pop = true): void {
    const g = this.graphics.clear().setVisible(true);
    for (const kind of this.born.keys()) if (!scars.some((s) => s.kind === kind)) this.born.delete(kind);
    for (const scar of scars) {
      if (!this.born.has(scar.kind)) this.born.set(scar.kind, pop ? now : -Infinity);
      const grow = easeOutBack(Math.min(1, (now - this.born.get(scar.kind)!) / POP_MS));
      const k = scar.size * grow;
      const place = (p: Point) => toScreen({
        x: scar.at.x + (scar.forward.x * p.x + scar.up.x * p.y) * k,
        y: scar.at.y + (scar.forward.y * p.x + scar.up.y * p.y) * k,
      });
      for (const shape of SHAPES[scar.kind]) {
        const points = shape.points.map(place);
        g.fillStyle(shape.fill, shape.alpha ?? 1).fillPoints(points, true);
        if (shape.outline) g.lineStyle(this.outlineWidth, HEX.ink, 0.85).strokePoints(points, true);
      }
    }
  }

  hide(): void {
    this.graphics.clear().setVisible(false);
  }

  setAlpha(alpha: number): this {
    this.graphics.setAlpha(alpha);
    return this;
  }

  setDepth(depth: number): this {
    this.graphics.setDepth(depth);
    return this;
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
