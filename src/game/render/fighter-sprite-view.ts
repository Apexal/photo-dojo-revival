import Phaser from "phaser";
import { trimLeadingSilence } from "../../shared/audio-trim";
import { groundAnchorFor, type FighterGeometry } from "../../shared/frame-data";
import { POSE_IDS, SOUND_IDS, SPRITE_CANVAS_SIZE, soundTakes, type Fighter, type PoseId, type SoundId } from "../../shared/fighter-model";
import { frameOf } from "../../simulation/fight-simulation";
import type { FighterState } from "../../simulation/fighter-state-machine";
import { worldToScreen } from "./stage";

export const textureKey = (prefix: string, poseId: PoseId, variant = 0) => `${prefix}:pose:${poseId}${variant ? `#${variant}` : ""}`;
export const soundKey = (prefix: string, soundId: SoundId, take = 0) => `${prefix}:sound:${soundId}${take ? `#${take}` : ""}`;
export const fallbackSoundKey = (soundId: SoundId) => `fallback:${soundId}`;

/** Every texture key preloadFighterTextures creates for a fighter (to clean up afterwards). */
export function fighterTextureKeys(fighter: Fighter, prefix: string): string[] {
  return POSE_IDS.flatMap((poseId) => [
    textureKey(prefix, poseId),
    ...(fighter.poseVariants?.[poseId] ?? []).map((_, i) => textureKey(prefix, poseId, i + 1)),
  ]);
}

/**
 * Queue each pose Blob as a texture: object URL → this.load.image. 8 textures
 * per fighter, no atlas. Call from preload(); returns the URLs to revoke later.
 */
export function preloadFighterTextures(scene: Phaser.Scene, fighter: Fighter, prefix: string): string[] {
  const urls: string[] = [];
  const queue = (key: string, blob: Blob) => {
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const url = URL.createObjectURL(blob);
    urls.push(url);
    scene.load.image(key, url);
  };
  for (const poseId of POSE_IDS) {
    queue(textureKey(prefix, poseId), fighter.poses[poseId].imageBlob);
    fighter.poseVariants?.[poseId]?.forEach((pose, i) => queue(textureKey(prefix, poseId, i + 1), pose.imageBlob));
  }
  return urls;
}

/**
 * Decode the fighter's voice clips into Phaser's audio cache. Missing or
 * undecodable clips map to the bundled generic sounds.
 */
export async function loadFighterSounds(scene: Phaser.Scene, fighter: Fighter, prefix: string): Promise<Record<SoundId, string[]>> {
  const keys = Object.fromEntries(SOUND_IDS.map((id) => [id, [] as string[]])) as Record<SoundId, string[]>;
  const manager = scene.sound as Phaser.Sound.WebAudioSoundManager;
  if ("context" in manager && manager.context) {
    await Promise.all(
      SOUND_IDS.flatMap((id) =>
        soundTakes(fighter, id).map(async (blob, take) => {
          try {
            // Trim leading silence so the line lands on the action.
            const buffer = trimLeadingSilence(manager.context, await manager.context.decodeAudioData(await blob.arrayBuffer()));
            const key = soundKey(prefix, id, take);
            if (scene.cache.audio.exists(key)) scene.cache.audio.remove(key);
            scene.cache.audio.add(key, buffer);
            keys[id][take] = key;
          } catch (err) {
            console.warn(`[sound] couldn't decode ${fighter.name}'s ${id} clip, skipping it`, err);
          }
        }),
      ),
    );
  }
  for (const id of SOUND_IDS) {
    keys[id] = keys[id].filter(Boolean);
    if (!keys[id].length) keys[id] = [fallbackSoundKey(id)];
  }
  return keys;
}


/** One fighter on screen. Pose swaps are hard cuts; the sprite origin is the feet anchor so they stay planted. */
export class FighterSpriteView {
  readonly sprite: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private currentFrame: string | null = null;

  constructor(scene: Phaser.Scene, private readonly prefix: string, private readonly geometry: FighterGeometry, tint?: number) {
    this.shadow = scene.add.ellipse(0, 0, 150, 22, 0x000000, 0.35);
    this.sprite = scene.add.image(0, 0, textureKey(prefix, "idle"));
    if (tint !== undefined) this.sprite.setTint(tint);
  }

  render(state: FighterState): void {
    const { poseId, variant } = frameOf(state);
    const key = textureKey(this.prefix, poseId, variant);
    if (key !== this.currentFrame) {
      this.currentFrame = key;
      this.sprite.setTexture(this.sprite.scene.textures.exists(key) ? key : textureKey(this.prefix, poseId));
      const anchor = groundAnchorFor(this.geometry, poseId, variant);
      this.sprite.setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE);
    }
    // Captures face right; flipping mirrors around the origin (the anchor).
    this.sprite.setFlipX(state.facing === -1);
    const p = worldToScreen(state.position);
    this.sprite.setPosition(p.x, p.y);
    const floor = worldToScreen({ x: state.position.x, y: 0 });
    this.shadow.setPosition(floor.x, floor.y + 4);
    this.shadow.setScale(Math.max(0.4, 1 + state.position.y / 400));
  }

  setDepth(depth: number): void {
    this.sprite.setDepth(depth);
    this.shadow.setDepth(depth - 1);
  }
}
