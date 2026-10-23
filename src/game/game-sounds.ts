/** Bundled game sound effects (not voices): controlled by the "Game volume" setting. */
export type GameSoundId = "hit" | "block" | "tick" | "thud";
export const GAME_SOUND_IDS: readonly GameSoundId[] = ["hit", "block", "tick", "thud"];
export const gameSoundKey = (id: GameSoundId) => `sfx:${id}`;
