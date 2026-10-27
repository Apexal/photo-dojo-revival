/** Screen y of the simulation's floor (y = 0). The stage is 1280 logical px wide, same as the screen. */
export const FLOOR_SCREEN_Y = 670;
/**
 * Where stages draw the floor's far edge: above the feet, so fighters stand on
 * the floor (a little way into it) rather than on its back edge like a ledge.
 * Drawing only; the feet stay at FLOOR_SCREEN_Y.
 */
export const FLOOR_BACK_Y = FLOOR_SCREEN_Y - 40;
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** Each player's colour: P1 red, P2 blue (fighter select cursors, hit sparks). */
export const PLAYER_COLORS = [0xff5a47, 0x4aa8ff] as const;

export const worldToScreen = (p: { x: number; y: number }) => ({ x: p.x, y: FLOOR_SCREEN_Y + p.y });
