import type Phaser from "phaser";
import { ANNOUNCER_LINE_IDS, type AnnouncerLineId } from "./announcer-lines";
import { getOptions } from "./options";

export const announcerKey = (id: AnnouncerLineId) => `announcer:${id}`;

/** Boot: queue every line (a missing file is skipped, and that line stays silent). */
export function preloadAnnouncer(scene: Phaser.Scene): void {
  for (const id of ANNOUNCER_LINE_IDS) scene.load.audio(announcerKey(id), `${import.meta.env.BASE_URL}announcer/${id}.mp3`);
}

/**
 * One announcer, one voice: the sound manager is game-wide, so this outlives
 * scenes (a line said as a scene starts the next one plays on).
 */
let current: Phaser.Sound.BaseSound | null = null;
let queued: { scene: Phaser.Scene; id: AnnouncerLineId; volume: number }[] = [];

/**
 * Say a line at `volume` (0..1) times the player's "Announcer volume". By default
 * it cuts off whatever the announcer was saying; `queue` waits for it instead
 * (PERFECT after K.O.). Nothing before the page's first click or key press: the
 * browser would hold the line back and play it late.
 */
export function announce(scene: Phaser.Scene, id: AnnouncerLineId, options: { volume?: number; queue?: boolean } = {}): void {
  const volume = options.volume ?? 1;
  if (scene.sound.locked) return;
  if (options.queue && current?.isPlaying) {
    queued.push({ scene, id, volume });
    return;
  }
  queued = [];
  play(scene, id, volume);
}

function play(scene: Phaser.Scene, id: AnnouncerLineId, volume: number): void {
  current?.destroy();
  current = null;
  const v = volume * getOptions(scene.registry).announcerVolume;
  if (v <= 0 || !scene.cache.audio.exists(announcerKey(id))) return;
  const sound = scene.sound.add(announcerKey(id), { volume: v });
  current = sound;
  sound.once("complete", () => {
    if (current !== sound) return;
    sound.destroy();
    current = null;
    const next = queued.shift();
    if (next) play(next.scene, next.id, next.volume);
  });
  sound.play();
}

