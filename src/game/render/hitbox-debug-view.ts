import type Phaser from "phaser";
import type { Box, FighterGeometry } from "../../shared/frame-data";
import { worldBoxesOf } from "../../simulation/fight-simulation";
import type { FighterState } from "../../simulation/fighter-state-machine";
import { worldToScreen } from "./stage";

/** Hurtboxes (green), body box (blue), active hitbox (red). Toggle with F1. */
export class HitboxDebugView {
  private readonly g: Phaser.GameObjects.Graphics;
  visible = false;

  constructor(scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(90); // over the fight, under the HUD (which the zooming camera leaves alone)
  }

  private box(b: Box, color: number, fillAlpha: number): void {
    const p = worldToScreen(b);
    this.g.fillStyle(color, fillAlpha).fillRect(p.x, p.y, b.width, b.height);
    this.g.lineStyle(2, color, 0.9).strokeRect(p.x, p.y, b.width, b.height);
  }

  render(fighters: readonly FighterState[], geometry: readonly FighterGeometry[]): void {
    this.g.clear();
    if (!this.visible) return;
    fighters.forEach((f, i) => {
      const boxes = worldBoxesOf(geometry[i], f);
      for (const h of boxes.hurtboxes) this.box(h, 0x3ddc84, 0.12);
      this.box(boxes.bodyBox, 0x4a90e2, 0.12);
      if (boxes.hitbox) this.box(boxes.hitbox, 0xff3b30, 0.35);
      const p = worldToScreen(f.position);
      this.g.fillStyle(0xffffff, 1).fillCircle(p.x, p.y, 4);
    });
  }
}
