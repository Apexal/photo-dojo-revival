import type Phaser from "phaser";
import { musicUrl } from "../music-url";
import { getOptions } from "../options";
import type { StageDefinition } from "./stage-definition";

const musicKey = (stage: StageDefinition) => `stage-music:${stage.id}`;

/** Queue a stage's assets and soundtrack (call from a scene's preload). */
export function preloadStage(scene: Phaser.Scene, stage: StageDefinition): void {
  stage.preload?.(scene);
  if (stage.music && !scene.cache.audio.exists(musicKey(stage))) {
    scene.load.audio(musicKey(stage), stage.music.files.map(musicUrl));
  }
}

/** The track's volume right now: its own balance times the player's Music volume. */
export function musicVolume(scene: Phaser.Scene, stage: StageDefinition): number {
  return (stage.music?.volume ?? 1) * getOptions(scene.registry).musicVolume;
}

/**
 * Start a stage's soundtrack, looping, fading in over `fadeMs`. Null when the
 * stage has none (or it failed to load). Stop it with stopStageMusic: the
 * sound manager is game-wide, so a track outlives its scene otherwise.
 */
export function playStageMusic(scene: Phaser.Scene, stage: StageDefinition, fadeMs = 0): Phaser.Sound.BaseSound | null {
  if (!stage.music || !scene.cache.audio.exists(musicKey(stage))) return null;
  const volume = musicVolume(scene, stage);
  const track = scene.sound.add(musicKey(stage), { loop: true, volume: fadeMs ? 0 : volume });
  track.play();
  if (fadeMs) scene.tweens.add({ targets: track, volume, duration: fadeMs });
  return track;
}

/** Bring a playing track to the current Music volume (after Settings). */
export function updateStageMusicVolume(scene: Phaser.Scene, stage: StageDefinition, track: Phaser.Sound.BaseSound | null): void {
  (track as Phaser.Sound.WebAudioSound | Phaser.Sound.HTML5AudioSound | null)?.setVolume(musicVolume(scene, stage));
}

/** Stop (fading out over `fadeMs`, if the scene lives that long) and discard a track. */
export function stopStageMusic(scene: Phaser.Scene, track: Phaser.Sound.BaseSound | null, fadeMs = 0): void {
  if (!track) return;
  scene.tweens.killTweensOf(track);
  const done = () => { track.stop(); track.destroy(); };
  if (!fadeMs || !scene.sys.isActive()) return done();
  scene.tweens.add({ targets: track, volume: 0, duration: fadeMs, onComplete: done });
}
