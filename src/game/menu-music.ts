import type Phaser from "phaser";
import { musicUrl } from "./music-url";
import { getOptions } from "./options";

/**
 * The menus' soundtrack: one track that plays on, unbroken, across the title
 * screen and fighter select (and the Settings over them), and fades out when a
 * stage's own music or the fight takes over. The sound manager is game-wide,
 * so the track outlives the scenes; each scene just says whether it wants it.
 *
 * "Get A Move On" by TomboFry (https://music.tombofry.co.uk), credited on the About page.
 */
const KEY = "menu-music";
const FILES = ["TomboFry - Get A Move On.ogg", "TomboFry - Get A Move On.mp3"];
/** Mastered loud: this keeps it under the voices and hits. */
const TRACK_VOLUME = 0.55;
const FADE_IN_MS = 800;

const volume = (scene: Phaser.Scene) => TRACK_VOLUME * getOptions(scene.registry).musicVolume;

function current(scene: Phaser.Scene): (Phaser.Sound.WebAudioSound | Phaser.Sound.HTML5AudioSound) | null {
  return (scene.sound.get(KEY) as Phaser.Sound.WebAudioSound | Phaser.Sound.HTML5AudioSound | null) ?? null;
}

/**
 * Keep the menu music going (or start it, loading it first in the background:
 * the menus don't wait for it). Before the page's first click or key press the
 * browser holds sound back; the track then starts on that press.
 */
export function playMenuMusic(scene: Phaser.Scene): void {
  const track = current(scene);
  if (track?.isPlaying) {
    scene.tweens.killTweensOf(track); // a fade-out from leaving and coming straight back
    scene.tweens.add({ targets: track, volume: volume(scene), duration: 300 });
    return;
  }
  if (scene.cache.audio.exists(KEY)) return start(scene);
  scene.load.audio(KEY, FILES.map(musicUrl));
  scene.load.once(`filecomplete-audio-${KEY}`, () => {
    // Only if the scene that asked is still up (nobody started a fight meanwhile).
    if (scene.sys.isActive()) start(scene);
  });
  scene.load.start();
}

function start(scene: Phaser.Scene): void {
  if (current(scene)) return;
  const track = scene.sound.add(KEY, { loop: true, volume: 0 });
  track.play();
  scene.tweens.add({ targets: track, volume: volume(scene), duration: FADE_IN_MS });
}

/** Fade the menu music out and drop it. `scene` must stay up for the fade (call it from the scene that takes over). */
export function stopMenuMusic(scene: Phaser.Scene, fadeMs = 500): void {
  const track = current(scene);
  if (!track) return;
  scene.tweens.killTweensOf(track);
  scene.tweens.add({
    targets: track, volume: 0, duration: fadeMs,
    onComplete: () => { track.stop(); track.destroy(); },
  });
}

/** After Settings: the menu music at the new Music volume. */
export function updateMenuMusicVolume(scene: Phaser.Scene): void {
  current(scene)?.setVolume(volume(scene));
}
