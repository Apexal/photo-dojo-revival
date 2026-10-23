import type Phaser from "phaser";
import { getOptions } from "./options";

/** Bundled game sound effects (not voices): controlled by the "Game volume" setting. */
export type GameSoundId = "hit" | "block" | "tick" | "thud";
export const GAME_SOUND_IDS: readonly GameSoundId[] = ["hit", "block", "tick", "thud"];
export const gameSoundKey = (id: GameSoundId) => `sfx:${id}`;

/** Play a game sound effect at `volume` (0..1) times the player's "Game volume". */
export function playGameSound(scene: Phaser.Scene, id: GameSoundId, volume = 0.8): void {
  const v = volume * getOptions(scene.registry).gameVolume;
  if (v > 0 && scene.cache.audio.exists(gameSoundKey(id))) scene.sound.play(gameSoundKey(id), { volume: v });
}
