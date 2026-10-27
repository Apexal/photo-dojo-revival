import type Phaser from "phaser";
import { FLOOR_BACK_Y, GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { StageDefinition } from "./stage-definition";

/** Same sky every time (and on every screen that shows it). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Points along part of a tilted ellipse, for the planet's ring (drawn in a back and a front half). */
function ellipseArc(cx: number, cy: number, rx: number, ry: number, tilt: number, from: number, to: number): Phaser.Types.Math.Vector2Like[] {
  const points: Phaser.Types.Math.Vector2Like[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = from + ((to - from) * i) / 48;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    points.push({ x: cx + x * Math.cos(tilt) - y * Math.sin(tilt), y: cy + x * Math.sin(tilt) + y * Math.cos(tilt) });
  }
  return points;
}

/**
 * The shadowed side of a sphere lit from the upper left: the disc's right edge,
 * back along the terminator (a half-ellipse bulging the same way), as a polygon
 * that stays inside the disc.
 */
function nightSide(cx: number, cy: number, r: number, lit: number, rotation: number): Phaser.Types.Math.Vector2Like[] {
  const rotate = (x: number, y: number) => ({ x: cx + x * Math.cos(rotation) - y * Math.sin(rotation), y: cy + x * Math.sin(rotation) + y * Math.cos(rotation) });
  const points: Phaser.Types.Math.Vector2Like[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 32;
    points.push(rotate(r * Math.cos(a), r * Math.sin(a)));
  }
  for (let i = 32; i >= 0; i--) {
    const a = -Math.PI / 2 + (Math.PI * i) / 32;
    points.push(rotate(r * lit * Math.cos(a), r * Math.sin(a)));
  }
  return points;
}

/** A dojo on the Moon: deep space, a ringed planet, Earth rising over the ridges, a cratered floor. */
export const LUNAR_DOJO: StageDefinition = {
  id: "lunar-dojo",
  name: "Lunar Dojo",
  // "Space-Time" by TomboFry (https://music.tombofry.co.uk). Mastered louder than the
  // rest of the game's audio, hence the lower volume.
  music: {
    files: ["TomboFry - Space-Time.ogg", "TomboFry - Space-Time.mp3"],
    volume: 0.6,
    credit: "“Space-Time” by TomboFry",
  },
  build(scene, layer) {
    const rnd = seeded(1969);
    const sky = scene.add.graphics();
    sky.fillGradientStyle(0x04030c, 0x04030c, 0x1b1236, 0x1b1236, 1).fillRect(0, 0, GAME_WIDTH, FLOOR_BACK_Y);
    // Nebula: overlapping blobs of magenta and teal, each a stack of faint discs so it fades out at the edge.
    for (const [x, y, r, color, alpha] of [
      [420, 180, 260, 0x7a2d8c, 0.1], [560, 120, 200, 0xb04a9c, 0.08], [320, 260, 180, 0x2d6b8c, 0.1],
      [700, 220, 150, 0x3fa0b8, 0.06], [480, 200, 120, 0xe08ad0, 0.06],
    ] as const) {
      for (let k = 1; k <= 8; k++) sky.fillStyle(color, alpha / 4).fillCircle(x, y, (r * k) / 8);
    }
    // Faint stars.
    for (let i = 0; i < 220; i++) sky.fillStyle(0xffffff, 0.25 + 0.5 * rnd()).fillCircle(rnd() * GAME_WIDTH, rnd() * 560, rnd() < 0.85 ? 1 : 1.6);
    layer.add(sky);

    // Bright stars that twinkle.
    for (let i = 0; i < 26; i++) {
      const star = scene.add.circle(rnd() * GAME_WIDTH, rnd() * 520, 1.6 + rnd() * 1.4, rnd() < 0.3 ? 0xcfe3ff : 0xffffff);
      layer.add(star);
      scene.tweens.add({ targets: star, alpha: 0.2, duration: 900 + rnd() * 1800, delay: rnd() * 2000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }

    // A ringed planet, far off: back half of the ring, the planet, then the front half over it.
    const planet = scene.add.graphics();
    const [px, py, pr, tilt] = [200, 150, 46, -0.35];
    planet.lineStyle(5, 0xd9b38c, 0.55).strokePoints(ellipseArc(px, py, 92, 22, tilt, Math.PI, 2 * Math.PI));
    planet.fillStyle(0xc98a5a, 1).fillCircle(px, py, pr);
    planet.fillStyle(0xe0a874, 1).fillEllipse(px - 4, py - 14, 80, 14).fillEllipse(px + 2, py + 10, 86, 10);
    planet.fillStyle(0x000000, 0.35).fillPoints(nightSide(px, py, pr, 0.45, 0.6), true);
    planet.lineStyle(5, 0xf0d2a8, 0.8).strokePoints(ellipseArc(px, py, 92, 22, tilt, 0, Math.PI));
    layer.add(planet);

    // Earth, rising over the ridges: glow, oceans, continents, clouds, night side.
    const earth = scene.add.graphics();
    const [ex, ey, er] = [1010, 470, 110];
    for (let k = 4; k >= 1; k--) earth.fillStyle(0x6fb6ff, 0.05).fillCircle(ex, ey, er + k * 9);
    earth.fillStyle(0x2a62c9, 1).fillCircle(ex, ey, er);
    for (const [x, y, r] of [[-40, -30, 34], [-12, -50, 26], [-58, 6, 22], [30, 20, 30], [52, -8, 20], [10, 52, 18]] as const) {
      earth.fillStyle(0x3d9a5a, 1).fillCircle(ex + x, ey + y, r);
    }
    for (const [x, y, w, h] of [[-30, -70, 90, 14], [20, -10, 110, 12], [-60, 40, 70, 10], [30, 70, 80, 12]] as const) {
      earth.fillStyle(0xffffff, 0.55).fillEllipse(ex + x, ey + y, w, h);
    }
    earth.fillStyle(0x020214, 0.55).fillPoints(nightSide(ex, ey, er, 0.25, 0.35), true);
    layer.add(earth);

    // Shooting star every few seconds, from the upper left.
    const streak = scene.add.graphics();
    layer.add(streak);
    const timer = scene.time.addEvent({
      delay: 5200, loop: true,
      callback: () => {
        if (!streak.active) return timer.remove(); // the stage was torn down (stage select moved on)
        const x0 = 150 + rnd() * 700, y0 = 30 + rnd() * 160;
        const state = { t: 0 };
        scene.tweens.add({
          targets: state, t: 1, duration: 650, ease: "Cubic.easeIn",
          onUpdate: () => {
            if (!streak.active) return;
            const x = x0 + 260 * state.t, y = y0 + 110 * state.t;
            streak.clear().lineStyle(2, 0xffffff, 0.8 * (1 - state.t)).lineBetween(x - 70, y - 30, x, y);
          },
          onComplete: () => { if (streak.active) streak.clear(); },
        });
      },
    });

    // Lunar ridges on the horizon, with a little torii gate (the dojo's) on the nearer one. Heights are
    // above the floor's far edge (H), so they sit on it.
    const H = FLOOR_BACK_Y;
    const ridges = scene.add.graphics();
    ridges.fillStyle(0x2a2838, 1).fillPoints([
      { x: 0, y: H - 80 }, { x: 140, y: H - 110 }, { x: 300, y: H - 95 }, { x: 470, y: H - 130 }, { x: 620, y: H - 98 },
      { x: 800, y: H - 122 }, { x: 960, y: H - 92 }, { x: 1120, y: H - 118 }, { x: GAME_WIDTH, y: H - 100 },
      { x: GAME_WIDTH, y: H }, { x: 0, y: H },
    ], true);
    ridges.fillStyle(0x3d3a4f, 1).fillPoints([
      { x: 0, y: H - 42 }, { x: 180, y: H - 64 }, { x: 360, y: H - 48 }, { x: 560, y: H - 70 }, { x: 760, y: H - 44 },
      { x: 940, y: H - 62 }, { x: 1120, y: H - 40 }, { x: GAME_WIDTH, y: H - 58 },
      { x: GAME_WIDTH, y: H }, { x: 0, y: H },
    ], true);
    const tx = 560, ty = H - 70; // standing on the near ridge's peak
    ridges.fillStyle(0xb8322a, 1)
      .fillRect(tx - 22, ty - 40, 5, 40).fillRect(tx + 17, ty - 40, 5, 40) // posts
      .fillRect(tx - 32, ty - 46, 64, 6).fillRect(tx - 26, ty - 33, 52, 4); // beams
    layer.add(ridges);

    // The floor: grey regolith with craters, and a glowing edge like a training mat.
    const floor = scene.add.graphics();
    floor.fillGradientStyle(0x77748a, 0x77748a, 0x4a4759, 0x4a4759, 1).fillRect(0, FLOOR_BACK_Y, GAME_WIDTH, GAME_HEIGHT - FLOOR_BACK_Y);
    for (let i = 0; i < 14; i++) {
      const cx = rnd() * GAME_WIDTH, cy = FLOOR_BACK_Y + 12 + rnd() * (GAME_HEIGHT - FLOOR_BACK_Y - 26), w = 30 + rnd() * 70;
      floor.fillStyle(0x3c3a4a, 0.7).fillEllipse(cx, cy, w, w * 0.22);
      floor.fillStyle(0xa9a6bb, 0.35).fillEllipse(cx + 3, cy + 3, w * 0.8, w * 0.12);
    }
    floor.lineStyle(6, 0x7fd8ff, 0.18).lineBetween(0, FLOOR_BACK_Y, GAME_WIDTH, FLOOR_BACK_Y);
    floor.lineStyle(2, 0x9fe6ff, 0.8).lineBetween(0, FLOOR_BACK_Y, GAME_WIDTH, FLOOR_BACK_Y);
    layer.add(floor);
  },
};
