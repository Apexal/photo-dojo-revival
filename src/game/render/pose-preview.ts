import Phaser from "phaser";
import { IDLE_SWAY_FRAMES, idleSwayAt } from "../../shared/frame-data";
import { SPRITE_CANVAS_SIZE, type NormalizedLandmark } from "../../shared/fighter-model";
import type { FrameTween } from "../../simulation/fight-simulation";
import type { Point } from "./arap";
import { PoseTweener, breathingStance, type FrameRef, type TweenSource } from "./pose-tweener";
import { TweenMeshes, readAlpha } from "./tween-meshes";
import { JawTextures, Voice } from "./talking-mouth-view";

export type PreviewPose = "flex" | "win";

/** One capture the preview can show. */
export interface PreviewCapture {
  texture: string;
  landmarks: NormalizedLandmark[];
  anchor: Point;
}

/**
 * Ids for the tweener, which only needs them distinct, and which warps a
 * stand-in's pose's variant 0. So each pose gets its own poseId, and variant 1
 * is its breathing stand-in, as in the fight's idle sway.
 */
const FRAMES: Record<PreviewPose, FrameRef> = { flex: { poseId: "idle", variant: 0 }, win: { poseId: "win", variant: 0 } };
const breathOf = (frame: FrameRef): FrameRef => ({ poseId: frame.poseId, variant: 1 });
const poseOf = (frame: FrameRef): PreviewPose => (frame.poseId === "win" ? "win" : "flex");
const FRAME_MS = 1000 / 60;
const MORPH_FRAMES = 12;
/** Below this, the breath is drawn as the plain sprite. */
const BREATH_EPSILON = 0.01;

/**
 * A fighter on the select screen's preview panel: breathing on its pose, and
 * morphing between flex and win pose as the player picks and un-picks (ARAP
 * meshes, PLAN §9). Without WebGL, or where a warp fails, it's the plain sprite
 * with hard cuts. Rendering only; times are scene time in ms.
 */
export class PosePreview {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly tweener: PoseTweener | null;
  private readonly meshes: TweenMeshes;
  private morph: { from: PreviewPose; start: number } | null = null;
  private breathStart: number;
  private shownKey: string | null = null;
  /** The line it's saying (a pick's victory line), and its captures with the jaw dropped to match. */
  private readonly voice = new Voice();
  private readonly jaws: JawTextures;
  private open = 0;

  constructor(
    scene: Phaser.Scene,
    /** Which fighter (and version of it) this shows. */
    readonly id: string,
    private readonly captures: Record<PreviewPose, PreviewCapture>,
    private readonly at: Point,
    private readonly scale: number,
    private readonly facing: 1 | -1,
    private readonly depth: number,
    private pose: PreviewPose,
    now: number,
  ) {
    this.sprite = scene.add.image(at.x, at.y, captures[pose].texture).setScale(scale).setFlipX(facing === -1).setDepth(depth);
    this.jaws = new JawTextures(scene);
    this.meshes = new TweenMeshes(scene, (frame) => this.texture(poseOf(frame)));
    this.tweener = scene.renderer.type === Phaser.WEBGL ? new PoseTweener((frame) => this.tweenSource(scene, frame)) : null;
    this.breathStart = now;
  }

  setPose(pose: PreviewPose, now: number): void {
    if (pose === this.pose) return;
    this.morph = { from: this.pose, start: now };
    this.pose = pose;
  }

  /** Say a voice line (just started playing): the jaw drops along with it. */
  say(sound: Phaser.Sound.BaseSound): void {
    this.voice.say(sound);
  }

  update(now: number): void {
    this.open = this.voice.openness;
    let tween: FrameTween;
    if (this.morph && now - this.morph.start < MORPH_FRAMES * FRAME_MS) {
      const x = (now - this.morph.start) / (MORPH_FRAMES * FRAME_MS);
      tween = { from: FRAMES[this.morph.from], to: FRAMES[this.pose], t: 1 - (1 - x) * (1 - x) };
    } else {
      if (this.morph) this.breathStart = now; // breathe in from the pose just reached
      this.morph = null;
      const frame = FRAMES[this.pose];
      tween = { from: frame, to: breathOf(frame), t: idleSwayAt(((now - this.breathStart) / FRAME_MS) % IDLE_SWAY_FRAMES) };
    }
    const layers = this.tweener && (this.morph || tween.t >= BREATH_EPSILON) ? this.tweener.layers(tween) : null;
    if (layers) {
      this.meshes.show(layers, this.facing, this.at, this.depth, this.scale);
      this.sprite.setVisible(false);
      return;
    }
    this.meshes.hide();
    this.showSprite(this.morph && tween.t < 0.5 ? this.morph.from : this.pose);
  }

  destroy(): void {
    this.sprite.destroy();
    this.meshes.destroy();
    this.jaws.destroy();
  }

  private showSprite(pose: PreviewPose): void {
    const { anchor } = this.captures[pose];
    const texture = this.texture(pose);
    if (texture !== this.shownKey) {
      this.shownKey = texture;
      this.sprite.setTexture(texture).setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE);
    }
    this.sprite.setVisible(true);
  }

  /** The texture a pose is drawn with: its capture's, or that capture talking mid-line. */
  private texture(pose: PreviewPose): string {
    const { texture, landmarks } = this.captures[pose];
    return this.jaws.textureFor(texture, () => landmarks, this.open);
  }

  private tweenSource(scene: Phaser.Scene, frame: FrameRef): TweenSource | null {
    const { texture, landmarks, anchor } = this.captures[poseOf(frame)];
    const mask = readAlpha(scene, texture);
    if (!mask) return null;
    return frame.variant === 1 ? { mask, landmarks: breathingStance(landmarks), anchor, standIn: true } : { mask, landmarks, anchor };
  }
}
