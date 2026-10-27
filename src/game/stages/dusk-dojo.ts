import { FLOOR_BACK_Y, GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { StageDefinition } from "./stage-definition";

/** The original backdrop: dusk sky, wooden floor with a gold edge. */
export const DUSK_DOJO: StageDefinition = {
  id: "dusk-dojo",
  name: "Dusk Dojo",
  build(scene, layer) {
    const g = scene.add.graphics();
    g.fillGradientStyle(0x2b2140, 0x2b2140, 0x6b4a5e, 0x6b4a5e, 1).fillRect(0, 0, GAME_WIDTH, FLOOR_BACK_Y);
    g.fillStyle(0x3b2f2a, 1).fillRect(0, FLOOR_BACK_Y, GAME_WIDTH, GAME_HEIGHT - FLOOR_BACK_Y);
    g.lineStyle(3, 0xf2c14e, 0.6).lineBetween(0, FLOOR_BACK_Y, GAME_WIDTH, FLOOR_BACK_Y);
    // Floorboards running toward the viewer; the deeper floor keeps their slant.
    for (let x = 0; x < GAME_WIDTH + 120; x += 80) g.lineStyle(1, 0x000000, 0.25).lineBetween(x, FLOOR_BACK_Y, x - 108, GAME_HEIGHT);
    layer.add(g);
  },
};
