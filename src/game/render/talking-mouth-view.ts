import Phaser from "phaser";
import { SPRITE_CANVAS_SIZE, type NormalizedLandmark } from "../../shared/fighter-model";
import { COLOR } from "./theme";
import { DEFAULT_ENVELOPE, dropJaw, jawBounds, jawDropFor, loudnessEnvelope, mouthFrameOf, mouthHole, opennessAt, type MouthEllipse, type MouthFrame, type PixelBox } from "./talking-mouth";

/*
 * Phaser glue for talking-mouth.ts: a fighter's jaw drops along with their voice
 * line. A `Voice` follows the line playing (its loudness, at the sound's own
 * playback position, so pausing holds it), and `JawTextures` stands in a copy of
 * each capture texture with the jaw dropped that far, which the sprite and the
 * pose-tween meshes draw instead: the warp follows every morph for free.
 */

/** The mouth's inside: no theme colour, like battle damage's. */
const MOUTH_COLOR = "#22060f";
/** Below this openness the plain capture is drawn. */
const MIN_OPEN = 0.02;

/** A sound the mouth can follow (Phaser's WebAudio and HTML5 sounds both report `seek`). */
type PlayingSound = Phaser.Sound.BaseSound & { seek: number };

const envelopes = new WeakMap<AudioBuffer, Float32Array>();

/** The loudness envelope of a cached clip, worked out once per clip; null without Web Audio. */
function envelopeOf(sound: Phaser.Sound.BaseSound): Float32Array | null {
  const buffer: unknown = sound.manager.game.cache.audio.get(sound.key);
  if (typeof AudioBuffer === "undefined" || !(buffer instanceof AudioBuffer)) return null;
  let envelope = envelopes.get(buffer);
  if (!envelope) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    envelope = loudnessEnvelope(channels, buffer.sampleRate);
    envelopes.set(buffer, envelope);
  }
  return envelope;
}

/** Who's saying a line: how open their mouth is follows it. */
export class Voice {
  private line: { sound: PlayingSound; envelope: Float32Array } | null = null;

  /** Follow `sound` (just started); a new line replaces the last. */
  say(sound: Phaser.Sound.BaseSound): void {
    const envelope = envelopeOf(sound);
    if (!envelope) return;
    const line = { sound: sound as PlayingSound, envelope };
    this.line = line;
    const end = () => { if (this.line === line) this.line = null; };
    for (const event of [Phaser.Sound.Events.COMPLETE, Phaser.Sound.Events.STOP, Phaser.Sound.Events.DESTROY]) sound.once(event, end);
  }

  /** 0 (shut, or not talking) to 1. */
  get openness(): number {
    const line = this.line;
    return line ? opennessAt(line.envelope, DEFAULT_ENVELOPE.fps, line.sound.seek) : 0;
  }
}

/**
 * Play a voice line (from the audio cache) and have `speaker`'s mouth follow it.
 * Returns the sound, or null when muted or missing.
 */
export function playVoice(scene: Phaser.Scene, key: string, volume: number, speaker?: { say(sound: Phaser.Sound.BaseSound): void } | null): Phaser.Sound.BaseSound | null {
  if (volume <= 0 || !scene.cache.audio.exists(key)) return null;
  const sound = scene.sound.add(key, { volume });
  const done = () => sound.destroy();
  sound.once(Phaser.Sound.Events.COMPLETE, done);
  sound.once(Phaser.Sound.Events.STOP, done);
  sound.play();
  speaker?.say(sound);
  return sound;
}

interface Jaw {
  key: string;
  texture: Phaser.Textures.CanvasTexture;
  frame: MouthFrame;
  box: PixelBox;
  src: Uint8ClampedArray;
  out: Uint8ClampedArray<ArrayBuffer>;
  image: ImageData;
  drawnOpen: number;
}

let nextJawId = 0;

/**
 * Talking stand-ins for a fighter's capture textures, made the first time each
 * talks and removed by `destroy` or with the scene. Only the jaw's box is
 * redrawn, and only when the openness changes. Keys are this set's own, so two
 * views of the same fighter (both players picked them) don't share one.
 */
export class JawTextures {
  /** Null: that capture has no face to talk with. */
  private readonly jaws = new Map<string, Jaw | null>();
  private readonly id = nextJawId++;
  private readonly onShutdown = () => this.destroy();

  constructor(private readonly scene: Phaser.Scene) {
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
  }

  /** The texture to draw capture `base` (landmarks in its pixels) with, `open` (0..1) mid-word: `base` itself while shut. */
  textureFor(base: string, landmarks: () => readonly NormalizedLandmark[], open: number): string {
    if (open < MIN_OPEN) return base;
    let jaw = this.jaws.get(base);
    if (jaw === undefined) {
      jaw = this.build(base, landmarks());
      this.jaws.set(base, jaw);
    }
    if (!jaw) return base;
    if (jaw.drawnOpen !== open) {
      jaw.drawnOpen = open;
      const drop = jawDropFor(jaw.frame, open);
      dropJaw(jaw.src, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE, jaw.frame, drop, jaw.out);
      const { x, y, width, height } = jaw.box;
      const ctx = jaw.texture.context;
      ctx.putImageData(jaw.image, 0, 0, x, y, width, height);
      const hole = mouthHole(jaw.frame, drop);
      if (hole) drawMouthHole(ctx, hole, jaw.frame);
      jaw.texture.refresh();
    }
    return jaw.key;
  }

  private build(base: string, landmarks: readonly NormalizedLandmark[]): Jaw | null {
    const frame = mouthFrameOf(landmarks);
    if (!frame || !this.scene.textures.exists(base)) return null;
    const key = `${base}:jaw${this.id}`;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    const texture = this.scene.textures.createCanvas(key, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
    if (!texture) return null;
    const ctx = texture.context;
    ctx.drawImage(this.scene.textures.get(base).getSourceImage() as CanvasImageSource, 0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
    const src = ctx.getImageData(0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE).data;
    const out = new Uint8ClampedArray(src);
    return { key, texture, frame, box: jawBounds(frame, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE), src, out, image: new ImageData(out, SPRITE_CANVAS_SIZE), drawnOpen: 0 };
  }

  destroy(): void {
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
    for (const jaw of this.jaws.values()) if (jaw && this.scene.textures.exists(jaw.key)) this.scene.textures.remove(jaw.key);
    this.jaws.clear();
  }
}

/** The dark gap between dropped lips, soft-edged, with a hint of upper teeth once it's open wide enough to see in. */
export function drawMouthHole(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, m: MouthEllipse, f: MouthFrame): void {
  ctx.save();
  // Into the mouth's own axes: x along the mouth line, y down the face.
  ctx.translate(m.center.x, m.center.y);
  ctx.transform(m.along.x, m.along.y, -m.up.x, -m.up.y, 0, 0);
  ctx.filter = `blur(${Math.max(0.5, 0.012 * f.headSize).toFixed(1)}px)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = MOUTH_COLOR;
  ctx.globalAlpha = 0.94;
  ctx.fill();
  if (m.ry > 0.05 * f.headSize) {
    ctx.clip();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = COLOR.fg;
    ctx.fillRect(-m.rx, -m.ry, 2 * m.rx, m.ry * 0.28);
  }
  ctx.restore();
}
