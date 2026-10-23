import type Phaser from "phaser";

/** Screen y of the simulation's floor (y = 0). The stage is 1280 logical px wide, same as the screen. */
export const FLOOR_SCREEN_Y = 670;
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** Each player's colour: P1 red, P2 blue (fighter select cursors, hit sparks). */
export const PLAYER_COLORS = [0xe8483b, 0x3f86f0] as const;

/** Backdrop: dusk sky, wooden floor with a gold edge. Drawn under everything (the fight, the title's demo). */
export function drawStage(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.fillGradientStyle(0x2b2140, 0x2b2140, 0x6b4a5e, 0x6b4a5e, 1).fillRect(0, 0, GAME_WIDTH, FLOOR_SCREEN_Y);
  g.fillStyle(0x3b2f2a, 1).fillRect(0, FLOOR_SCREEN_Y, GAME_WIDTH, GAME_HEIGHT - FLOOR_SCREEN_Y);
  g.lineStyle(3, 0xf2c14e, 0.6).lineBetween(0, FLOOR_SCREEN_Y, GAME_WIDTH, FLOOR_SCREEN_Y);
  for (let x = 0; x < GAME_WIDTH; x += 80) g.lineStyle(1, 0x000000, 0.25).lineBetween(x, FLOOR_SCREEN_Y, x - 60, GAME_HEIGHT);
  return g;
}

export const worldToScreen = (p: { x: number; y: number }) => ({ x: p.x, y: FLOOR_SCREEN_Y + p.y });
