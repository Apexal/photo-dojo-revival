import type Phaser from "phaser";
import { FLOOR_BACK_Y, FLOOR_SCREEN_Y, GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { SPRITE_CANVAS_SIZE } from "../../shared/fighter-model";
import { TOP_EDGE_STEP, type TopEdge } from "../render/top-edge";
import { isAttack } from "../../simulation/fighter-state-machine";
import { SNOW, SnowCover, SnowDrift, type Clump } from "./snow";
import type { StageDefinition, StageFighter } from "./stage-definition";

/** Same scenery every time (and on every screen that shows it). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const SNOW_WHITE = 0xf4f8ff;
const SNOW_SHADE = 0xb7c8e0;
/** Snow lying on the floor: a touch bluer than fresh snow, so drifts knocked onto it still show. */
const SNOW_LYING = 0xe2eaf5;

interface Flake { x: number; y: number; r: number; fall: number; sway: number; rate: number; phase: number; drift: number; alpha: number }

/** The wind, shared by every flake on screen: a gentle breeze from the left that gusts and lulls (px/s). */
const wind = (seconds: number) => 18 + 22 * Math.sin(seconds * 0.23) + 12 * Math.sin(seconds * 0.61 + 1.7);

/**
 * Snowfall across the whole screen: `count` flakes at depths `near` (0 = far
 * off, 1 = right by the camera), redrawn into `g` every frame until it's
 * destroyed (stage select tears its stage down on every change). Nearer flakes
 * are bigger, fall a little faster and catch more of the wind; all of them
 * fall slowly and flutter from side to side, so it reads as snow, not rain.
 */
function snowfall(scene: Phaser.Scene, g: Phaser.GameObjects.Graphics, count: number, near: [number, number], rnd: () => number): void {
  const flake = (y: number): Flake => {
    const z = near[0] + rnd() * (near[1] - near[0]);
    return {
      x: rnd() * GAME_WIDTH, y, r: 1 + 4.4 * z ** 1.4,
      fall: 16 + 46 * z + rnd() * 14, sway: 6 + 26 * z * rnd() + 6 * rnd(), rate: 0.5 + rnd() * 1.1,
      phase: rnd() * Math.PI * 2, drift: 0.4 + 0.6 * z, alpha: 0.65 + 0.35 * z,
    };
  };
  const flakes = Array.from({ length: count }, () => flake(rnd() * GAME_HEIGHT));
  let seconds = rnd() * 100;
  const step = (_time: number, delta: number) => {
    if (!g.active) return void scene.events.off("update", step);
    const dt = Math.min(delta, 100) / 1000;
    seconds += dt;
    const breeze = wind(seconds);
    g.clear();
    for (const f of flakes) {
      f.phase += dt * f.rate * Math.PI * 2;
      f.y += f.fall * dt * (0.8 + 0.2 * Math.sin(f.phase * 0.5)); // drifting down unevenly
      f.x += breeze * f.drift * dt;
      if (f.y > GAME_HEIGHT + 8) Object.assign(f, flake(-8));
      if (f.x > GAME_WIDTH + 40) f.x -= GAME_WIDTH + 80;
      const x = f.x + Math.sin(f.phase) * f.sway;
      // A soft flake: a faint halo round a brighter core (too small to see on the far ones).
      if (f.r > 1.6) g.fillStyle(SNOW_WHITE, f.alpha * 0.3).fillCircle(x, f.y, f.r * 1.7);
      g.fillStyle(SNOW_WHITE, f.alpha).fillCircle(x, f.y, f.r);
    }
  };
  scene.events.on("update", step);
}

/** A snow-laden pine: tiers of dark needles, each with snow along its top. */
function pine(g: Phaser.GameObjects.Graphics, x: number, base: number, height: number, color: number): void {
  const width = height * 0.55;
  g.fillStyle(0x2a2420, 1).fillRect(x - height * 0.03, base - height * 0.12, height * 0.06, height * 0.12);
  for (let k = 0; k < 3; k++) {
    const top = base - height * (0.45 + 0.27 * k) - height * 0.1, bottom = base - height * (0.1 + 0.25 * k);
    const half = (width / 2) * (1 - 0.25 * k);
    g.fillStyle(color, 1).fillTriangle(x, top, x - half, bottom, x + half, bottom);
    // Snow on the tier: a pale cap from the tip partway down.
    const cap = 0.45;
    g.fillStyle(SNOW_WHITE, 0.92).fillTriangle(x, top, x - half * cap, top + (bottom - top) * cap, x + half * cap, top + (bottom - top) * cap);
    g.fillStyle(SNOW_WHITE, 0.92).fillEllipse(x, top + (bottom - top) * cap, half * cap * 2, (bottom - top) * 0.12);
  }
}

/**
 * Where each fighter's snow is, and the clumps on their way down. Snow settles
 * on whoever stands still (idle, not moving) and all of it falls off at the
 * first step, attack, hit or jump, landing in drifts on the floor that stay
 * for the rest of the scene.
 */
class SnowOnFighters {
  private readonly covers: SnowCover[] = [];
  private readonly last: ({ x: number; y: number } | null)[] = [];
  private readonly edges: (TopEdge | null)[] = [];
  private readonly falling: (Clump & { vx: number; vy: number; landY: number })[] = [];
  /** Loose powder: knocked off with the clumps and thrown up where they land; it floats, flutters and fades. */
  private readonly powder: { x: number; y: number; vx: number; vy: number; r: number; age: number; life: number; phase: number }[] = [];
  private readonly drift = new SnowDrift(GAME_WIDTH);
  private driftChanged = true;
  /** How covered the floor was when last drawn (it's redrawn as that grows). */
  private drawnCover = -1;
  /** Where snow settles first on the floor, each covered once the snowfall gets past its `from`. */
  private readonly patches: { x: number; y: number; w: number; h: number; from: number }[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly front: Phaser.GameObjects.Graphics,
    private readonly ground: Phaser.GameObjects.Graphics,
  ) {
    const rnd = seeded(2512);
    for (let i = 0; i < 260; i++) {
      const y = FLOOR_BACK_Y + rnd() * (GAME_HEIGHT - FLOOR_BACK_Y);
      const near = (y - FLOOR_BACK_Y) / (GAME_HEIGHT - FLOOR_BACK_Y); // bigger towards the front
      this.patches.push({ x: rnd() * GAME_WIDTH, y, w: 30 + rnd() * 70 + 80 * near, h: 5 + rnd() * 6 + 10 * near, from: rnd() * 0.65 });
    }
  }

  update(fighters: readonly StageFighter[]): void {
    if (!this.front.active) return;
    const dt = Math.min(this.scene.game.loop.delta, 100) / 1000;
    fighters.forEach((f, i) => {
      const cover = (this.covers[i] ??= new SnowCover(Math.ceil(SPRITE_CANVAS_SIZE / TOP_EDGE_STEP)));
      const { state } = f;
      const last = this.last[i];
      const moved = !last || Math.abs(state.position.x - last.x) > 0.5 || Math.abs(state.position.y - last.y) > 0.5;
      this.last[i] = { ...state.position };
      const still = state.action === "idle" && !moved && state.position.y === 0;
      if (still) {
        const edge = f.topEdge();
        this.edges[i] = edge;
        if (edge) cover.settle(edge, dt);
      } else if (cover.hasSnow) {
        // Thrown off from where it lay last frame (this frame's edge may be mid-swing).
        const edge = this.edges[i];
        const push = last ? (state.position.x - last.x) / Math.max(dt, 1 / 60) : 0;
        const kick = isAttack(state.action) || state.action === "hurt" ? 1.8 : 1;
        for (const c of cover.shed(edge ?? [])) {
          const vx = push * 0.6 + (Math.random() - 0.5) * 140 * kick, vy = -(30 + Math.random() * 120) * kick;
          this.falling.push({ ...c, vx, vy, landY: FLOOR_SCREEN_Y - 2 + Math.random() * 14 });
          this.puff(c.x, c.y, 2, vx * 0.5, vy * 0.6, 60 * kick);
        }
        this.edges[i] = null;
      }
    });
    this.drift.snowfall(dt);
    this.fall(dt);
    this.draw();
  }

  /** `count` specks of powder at (x, y), moving off at about (vx, vy) give or take `spread` px/s. */
  private puff(x: number, y: number, count: number, vx: number, vy: number, spread: number): void {
    for (let n = 0; n < count; n++) {
      this.powder.push({
        x: x + (Math.random() - 0.5) * 6, y, r: 1 + Math.random() * 1.6, age: 0, life: 0.9 + Math.random() * 1.2, phase: Math.random() * Math.PI * 2,
        vx: vx + (Math.random() - 0.5) * spread * 2, vy: vy - Math.random() * spread,
      });
    }
  }

  private fall(dt: number): void {
    // Clumps: light and fluffy, so the air slows them (a soft lob, not a dropped stone).
    const drag = Math.exp(-1.6 * dt);
    for (let k = this.falling.length - 1; k >= 0; k--) {
      const c = this.falling[k];
      c.vx *= drag;
      c.vy = Math.min(c.vy + 900 * dt, 320);
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (c.y >= c.landY) {
        this.drift.add(c.x, c.size);
        this.driftChanged = true;
        this.falling.splice(k, 1);
        this.puff(c.x, c.landY - 2, 3, 0, -10, 35); // it crumbles into the drift
      }
    }
    // Powder hangs in the air: it slows to a slow, fluttering fall and fades out.
    const air = Math.exp(-3 * dt);
    for (let k = this.powder.length - 1; k >= 0; k--) {
      const p = this.powder[k];
      p.age += dt;
      if (p.age >= p.life) {
        this.powder.splice(k, 1);
        continue;
      }
      p.vx *= air;
      p.vy = 25 + (p.vy - 25) * air;
      p.phase += dt * 5;
      p.x += (p.vx + Math.sin(p.phase) * 14) * dt;
      p.y += p.vy * dt;
    }
  }

  private draw(): void {
    const g = this.front.clear();
    this.covers.forEach((cover, i) => {
      const edge = this.edges[i];
      if (!edge || !cover.hasSnow) return;
      for (const run of cover.runs(edge)) {
        const dir = Math.sign(run[run.length - 1].x - run[0].x) || 1;
        const first = run[0], last = run[run.length - 1];
        // A rounded blanket: the top follows the depth, the bottom tucks into the edge.
        const top = [
          { x: first.x - dir * 2, y: first.y + 1 },
          ...run.map((p) => ({ x: p.x, y: p.y - p.depth })),
          { x: last.x + dir * 2, y: last.y + 1 },
        ];
        const bottom = run.map((p) => ({ x: p.x, y: p.y + 2 })).reverse();
        g.fillStyle(SNOW_WHITE, 1).fillPoints([...top, ...bottom], true);
        g.lineStyle(2, SNOW_SHADE, 0.9).strokePoints(run.map((p) => ({ x: p.x, y: p.y + 1.5 })));
      }
    });
    for (const c of this.falling) {
      // A lumpy clump: a shaded underside and two overlapping lumps.
      g.fillStyle(SNOW_SHADE, 1).fillCircle(c.x + 0.6, c.y + 0.8, c.size);
      g.fillStyle(SNOW_WHITE, 1).fillCircle(c.x, c.y, c.size).fillCircle(c.x - c.size * 0.5, c.y - c.size * 0.3, c.size * 0.7);
    }
    for (const p of this.powder) {
      const a = 0.85 * (1 - p.age / p.life);
      g.fillStyle(SNOW_WHITE, a * 0.3).fillCircle(p.x, p.y, p.r * 1.8);
      g.fillStyle(SNOW_WHITE, a).fillCircle(p.x, p.y, p.r);
    }
    if (this.driftChanged || this.drift.cover - this.drawnCover > 0.004) {
      this.driftChanged = false;
      this.drawnCover = this.drift.cover;
      this.drawDrift();
    }
  }

  /**
   * The snow on the floor: patches that spread and join into a blanket as the
   * snowfall goes on, then the drifts knocked off the fighters, mounds with a
   * blue shadow at their foot.
   */
  private drawDrift(): void {
    const g = this.ground.clear();
    const cover = this.drift.cover;
    const blanket = Math.max(0, (cover - 0.55) / 0.45);
    if (blanket > 0) g.fillStyle(SNOW_LYING, 0.92 * blanket).fillRect(0, FLOOR_BACK_Y, GAME_WIDTH, GAME_HEIGHT - FLOOR_BACK_Y);
    for (const p of this.patches) {
      const grown = Math.min(1, Math.max(0, (cover - p.from) / 0.3));
      if (grown > 0) g.fillStyle(SNOW_LYING, 0.9 * grown).fillEllipse(p.x, p.y, p.w * (0.5 + 0.5 * grown), p.h * (0.5 + 0.5 * grown));
    }
    const base = FLOOR_SCREEN_Y + 8;
    const heights = this.drift.heights;
    let start = -1;
    for (let i = 0; i <= heights.length; i++) {
      const h = heights[i] ?? 0;
      if (h > 0.4 && start < 0) start = i;
      if ((h <= 0.4 || i === heights.length) && start >= 0) {
        const xs = (j: number) => j * SNOW.driftStep;
        const top = [];
        for (let j = start; j < i; j++) top.push({ x: xs(j), y: base - heights[j] });
        g.fillStyle(SNOW_SHADE, 0.8).fillEllipse((xs(start) + xs(i - 1)) / 2, base + 1, xs(i - 1) - xs(start) + 10, 6);
        g.fillStyle(SNOW_WHITE, 1).fillPoints([{ x: xs(start) - 3, y: base }, ...top, { x: xs(i - 1) + 3, y: base }], true);
        start = -1;
      }
    }
  }
}

/** A mountain dojo in the snow: dusk, a hazy moon, snowy peaks and pines, a lit hall, and a swept wooden deck. */
export const WINTER_DOJO: StageDefinition = {
  id: "winter-dojo",
  name: "Winter Dojo",
  build(scene, layer) {
    const rnd = seeded(1225);
    const H = FLOOR_BACK_Y;
    const sky = scene.add.graphics();
    sky.fillGradientStyle(0x1b2440, 0x1b2440, 0x8297bb, 0x8297bb, 1).fillRect(0, 0, GAME_WIDTH, H);
    // A moon through the haze.
    for (let k = 6; k >= 1; k--) sky.fillStyle(0xf6f1df, 0.05).fillCircle(940, 150, 40 + k * 14);
    sky.fillStyle(0xf6f1df, 0.92).fillCircle(940, 150, 40);
    // Low cloud bands.
    for (const [x, y, w, h, a] of [[300, 120, 520, 40, 0.12], [820, 220, 600, 50, 0.1], [180, 300, 460, 36, 0.08], [1080, 330, 420, 40, 0.1]] as const) {
      sky.fillStyle(0xdfe7f5, a).fillEllipse(x, y, w, h);
    }
    layer.add(sky);

    // Far peaks with snowy tops.
    const peaks = scene.add.graphics();
    const far: [number, number][] = [[0, H - 170], [120, H - 250], [260, H - 190], [420, H - 300], [580, H - 210], [720, H - 280], [880, H - 200], [1030, H - 320], [1180, H - 230], [GAME_WIDTH, H - 260]];
    peaks.fillStyle(0x5d7299, 1).fillPoints([...far.map(([x, y]) => ({ x, y })), { x: GAME_WIDTH, y: H }, { x: 0, y: H }], true);
    for (let i = 1; i < far.length - 1; i++) {
      const [x, y] = far[i];
      const [lx, ly] = far[i - 1], [rx, ry] = far[i + 1];
      if (y > ly || y > ry) continue; // only real peaks
      const cap = 0.35;
      peaks.fillStyle(0xe8eff9, 1).fillPoints([
        { x, y },
        { x: x + (rx - x) * cap, y: y + (ry - y) * cap },
        { x: x + (rx - x) * cap * 0.6, y: y + (ry - y) * cap * 0.8 },
        { x: x + (lx - x) * cap * 0.4, y: y + (ly - y) * cap * 1.1 },
        { x: x + (lx - x) * cap, y: y + (ly - y) * cap },
      ], true);
    }
    // Nearer, rounder hills, all snow.
    peaks.fillStyle(0xa9bad6, 1).fillPoints([
      { x: 0, y: H - 90 }, { x: 160, y: H - 120 }, { x: 340, y: H - 100 }, { x: 520, y: H - 135 }, { x: 700, y: H - 105 },
      { x: 880, y: H - 128 }, { x: 1060, y: H - 98 }, { x: GAME_WIDTH, y: H - 118 }, { x: GAME_WIDTH, y: H }, { x: 0, y: H },
    ], true);
    layer.add(peaks);

    // Pines along the hills, the nearer ones bigger and darker.
    const trees = scene.add.graphics();
    for (let i = 0; i < 16; i++) pine(trees, rnd() * GAME_WIDTH, H - 70 - rnd() * 30, 50 + rnd() * 40, 0x3c5470);
    for (const [x, h] of [[40, 190], [120, 150], [1140, 170], [1230, 210], [860, 120]] as const) pine(trees, x, H + 2, h, 0x1f3242);
    layer.add(trees);

    // The dojo hall: timber walls, lit paper windows, and a roof under a thick blanket of snow.
    const hall = scene.add.graphics();
    const hx = 330, hw = 300, top = H - 110;
    hall.fillStyle(0x4a2f27, 1).fillRect(hx - hw / 2, top, hw, 110);
    for (let k = 0; k < 4; k++) {
      const wx = hx - hw / 2 + 30 + k * 66;
      for (let r = 3; r >= 1; r--) hall.fillStyle(0xffc66e, 0.06).fillRect(wx - r * 5, top + 26 - r * 5, 44 + r * 10, 52 + r * 10);
      hall.fillStyle(0xffd38a, 1).fillRect(wx, top + 26, 44, 52);
      hall.lineStyle(2, 0x5b3a2c, 1).lineBetween(wx + 22, top + 26, wx + 22, top + 78).lineBetween(wx, top + 52, wx + 44, top + 52);
    }
    hall.fillStyle(0x2b2230, 1).fillPoints([
      { x: hx - hw / 2 - 40, y: top + 4 }, { x: hx + hw / 2 + 40, y: top + 4 }, { x: hx + hw / 2 - 20, y: top - 54 }, { x: hx - hw / 2 + 20, y: top - 54 },
    ], true);
    hall.fillStyle(SNOW_WHITE, 1).fillPoints([
      { x: hx - hw / 2 - 44, y: top + 2 }, { x: hx - hw / 2 - 30, y: top - 6 }, { x: hx - hw / 2 + 14, y: top - 58 },
      { x: hx - hw / 2 + 30, y: top - 70 }, { x: hx + hw / 2 - 30, y: top - 70 }, { x: hx + hw / 2 - 14, y: top - 58 },
      { x: hx + hw / 2 + 30, y: top - 6 }, { x: hx + hw / 2 + 44, y: top + 2 }, { x: hx + hw / 2 + 36, y: top - 2 }, { x: hx - hw / 2 - 36, y: top - 2 },
    ], true);
    // Icicles under the eaves.
    for (let x = hx - hw / 2 - 30; x < hx + hw / 2 + 30; x += 14 + rnd() * 10) hall.fillStyle(0xdbe8f7, 0.9).fillTriangle(x - 3, top + 4, x + 3, top + 4, x, top + 12 + rnd() * 12);
    layer.add(hall);

    // A stone lantern with a cap of snow and a warm light.
    const lantern = scene.add.graphics();
    const lx = 1010, lb = H;
    for (let r = 4; r >= 1; r--) lantern.fillStyle(0xffc66e, 0.07).fillCircle(lx, lb - 70, 14 + r * 9);
    lantern.fillStyle(0x7d8698, 1)
      .fillRect(lx - 18, lb - 10, 36, 10).fillRect(lx - 6, lb - 52, 12, 42).fillRect(lx - 20, lb - 58, 40, 8)
      .fillRect(lx - 14, lb - 84, 28, 26).fillTriangle(lx - 30, lb - 84, lx + 30, lb - 84, lx, lb - 106);
    lantern.fillStyle(0xffd38a, 1).fillRect(lx - 8, lb - 79, 16, 16);
    lantern.fillStyle(SNOW_WHITE, 1).fillEllipse(lx, lb - 100, 34, 12).fillEllipse(lx, lb - 86, 64, 8).fillEllipse(lx, lb - 59, 42, 6);
    layer.add(lantern);

    // Thick snowfall hides the distance: a white haze, heaviest at the horizon.
    const haze = scene.add.graphics();
    haze.fillGradientStyle(0xdfe7f3, 0xdfe7f3, 0xdfe7f3, 0xdfe7f3, 0.05, 0.05, 0.4, 0.4).fillRect(0, 160, GAME_WIDTH, H - 160);
    haze.fillStyle(0xdfe7f3, 0.05).fillRect(0, 0, GAME_WIDTH, 160);
    layer.add(haze);

    // The floor: a swept wooden deck, snow banked along its back edge and dusting its corners.
    const floor = scene.add.graphics();
    floor.fillGradientStyle(0x5e4838, 0x5e4838, 0x35281f, 0x35281f, 1).fillRect(0, H, GAME_WIDTH, GAME_HEIGHT - H);
    for (let y = H + 14; y < GAME_HEIGHT; y += 18 + (y - H) * 0.25) floor.lineStyle(1, 0x000000, 0.22).lineBetween(0, y, GAME_WIDTH, y);
    for (let i = 0; i < 18; i++) {
      const x = rnd() < 0.5 ? rnd() * 260 : GAME_WIDTH - rnd() * 260;
      floor.fillStyle(SNOW_WHITE, 0.12 + rnd() * 0.15).fillEllipse(x, H + 20 + rnd() * (GAME_HEIGHT - H - 26), 40 + rnd() * 90, 6 + rnd() * 8);
    }
    const bank = [{ x: 0, y: H + 8 }];
    for (let x = 0; x <= GAME_WIDTH; x += 40) bank.push({ x, y: H - 6 - rnd() * 8 });
    bank.push({ x: GAME_WIDTH, y: H + 8 });
    floor.fillStyle(SNOW_SHADE, 1).fillRect(0, H, GAME_WIDTH, 9);
    floor.fillStyle(SNOW_WHITE, 1).fillPoints(bank, true);
    layer.add(floor);

    // Snow falling behind the fighters (effects add a few nearer flakes in front).
    const flakes = scene.add.graphics();
    layer.add(flakes);
    snowfall(scene, flakes, 700, [0, 0.6], rnd);
  },
  effects(scene, depths) {
    const ground = scene.add.graphics().setDepth(depths.under);
    const front = scene.add.graphics().setDepth(depths.over);
    const near = scene.add.graphics().setDepth(depths.over);
    snowfall(scene, near, 150, [0.6, 1], Math.random);
    const snow = new SnowOnFighters(scene, front, ground);
    return { update: (fighters) => snow.update(fighters) };
  },
};
