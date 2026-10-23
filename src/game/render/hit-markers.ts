import type Phaser from "phaser";
import { HIT_MARKER_STYLES, hitMarkerShape, markerColors, type HitMarkerKind } from "./hit-feel";

interface Marker { kind: HitMarkerKind; player: 0 | 1; x: number; y: number; start: number; turn: number; dir: 1 | -1 }

/** Sparks where hits land (see hit-feel.ts), timed by the simulation frame so hitstop and replays line up. */
export class HitMarkers {
  private markers: Marker[] = [];

  constructor(private readonly g: Phaser.GameObjects.Graphics) {}

  /**
   * A spark for `player`'s hit at screen point (x, y), starting on simulation
   * frame `frame`. `dir` is the way the hit (or throw) goes: 1 right, -1 left.
   */
  add(kind: HitMarkerKind, player: 0 | 1, x: number, y: number, frame: number, dir: 1 | -1): void {
    // A fixed tilt per frame: no two bursts look stamped from one mould, and a replay draws the same one.
    this.markers.push({ kind, player, x, y, start: frame, turn: (frame * 0.618) % 1, dir });
  }

  render(frame: number): void {
    this.g.clear();
    // Gone once done; also dropped if a replay rewinds to before them.
    this.markers = this.markers.filter((m) => hitMarkerShape(frame - m.start) !== null);
    for (const m of this.markers) {
      const { scale, alpha } = hitMarkerShape(frame - m.start)!;
      const style = HIT_MARKER_STYLES[m.kind];
      const r = style.radius * scale;
      const { rim, core } = markerColors(m.player);
      switch (style.shape) {
        case "burst":
          this.star(m, r, 8, rim, core, alpha);
          break;
        case "bigBurst":
          this.g.lineStyle(4, rim, alpha).strokeCircle(m.x, m.y, r * 1.1);
          this.star(m, r, 12, rim, core, alpha);
          this.g.fillStyle(0xffffff, alpha).fillCircle(m.x, m.y, r * 0.18);
          break;
        case "shield":
          // Pale outside, colour inside: reads on any body, even the attacker's own colour.
          this.g.lineStyle(10, core, alpha).strokeCircle(m.x, m.y, r * 0.7);
          this.g.lineStyle(6, rim, alpha).strokeCircle(m.x, m.y, r * 0.7);
          for (let k = 0; k < 4; k++) {
            const a = (k / 4 + m.turn) * Math.PI * 2;
            this.g.lineStyle(4, rim, alpha)
              .lineBetween(m.x + Math.cos(a) * r * 0.85, m.y + Math.sin(a) * r * 0.85, m.x + Math.cos(a) * r * 1.15, m.y + Math.sin(a) * r * 1.15);
          }
          break;
        case "flash":
          // A parry: a bright double ring, and rays flaring out all round.
          this.g.lineStyle(8, core, alpha).strokeCircle(m.x, m.y, r * 0.55);
          this.g.lineStyle(4, rim, alpha).strokeCircle(m.x, m.y, r * 0.55).strokeCircle(m.x, m.y, r * 0.8);
          for (let k = 0; k < 8; k++) {
            const a = (k / 8 + m.turn) * Math.PI * 2;
            this.g.lineStyle(5, rim, alpha)
              .lineBetween(m.x + Math.cos(a) * r * 0.9, m.y + Math.sin(a) * r * 0.9, m.x + Math.cos(a) * r * 1.2, m.y + Math.sin(a) * r * 1.2);
          }
          break;
        case "chevrons":
          // Two ">" shapes pointing the way the victim is thrown.
          for (const offset of [-0.35, 0.35]) {
            const tipX = m.x + m.dir * (offset + 0.45) * r, backX = m.x + m.dir * (offset - 0.25) * r;
            const arm = [{ x: backX, y: m.y - r * 0.6 }, { x: tipX, y: m.y }, { x: backX, y: m.y + r * 0.6 }];
            this.g.lineStyle(11, rim, alpha).strokePoints(arm, false);
            this.g.lineStyle(4, core, alpha).strokePoints(arm, false);
          }
          break;
        case "dust":
          // Puffs rolling out both ways along the floor from where they landed.
          for (const side of [-1, 1]) {
            for (let k = 0; k < 3; k++) {
              const spread = (0.35 + 0.33 * k) * r;
              const size = (0.42 - 0.1 * k) * r;
              this.g.fillStyle(0xb9ada3, alpha * (0.75 - 0.15 * k)).fillCircle(m.x + side * spread, m.y - size * 0.6, size);
            }
          }
          break;
      }
    }
  }

  /** A star: `rays` long points with short ones between, and a pale hot centre. */
  private star(m: Marker, r: number, rays: number, rim: number, core: number, alpha: number): void {
    const points: Phaser.Types.Math.Vector2Like[] = [];
    for (let k = 0; k < rays * 2; k++) {
      const a = (k / (rays * 2) + m.turn) * Math.PI * 2;
      const len = k % 2 === 0 ? r : k % 4 === 1 ? r * 0.38 : r * 0.5;
      points.push({ x: m.x + Math.cos(a) * len, y: m.y + Math.sin(a) * len });
    }
    this.g.fillStyle(rim, alpha).fillPoints(points, true);
    this.g.fillStyle(core, alpha).fillCircle(m.x, m.y, r * 0.32);
  }

  clear(): void {
    this.markers = [];
    this.g.clear();
  }
}
