/** Screen y of the simulation's floor (y = 0). The stage is 1280 logical px wide, same as the screen. */
export const FLOOR_SCREEN_Y = 670;
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

export const worldToScreen = (p: { x: number; y: number }) => ({ x: p.x, y: FLOOR_SCREEN_Y + p.y });
