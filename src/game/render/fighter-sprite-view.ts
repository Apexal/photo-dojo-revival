import Phaser from "phaser";
import { trimLeadingSilence } from "../../shared/audio-trim";
import { SOFT_CUTS, frameGeometry, groundAnchorFor, variantCount, type FighterGeometry } from "../../shared/frame-data";
import { LANDMARK, POSE_IDS, SOUND_FALLBACK, SOUND_IDS, SPRITE_CANVAS_SIZE, soundTakes, type Fighter, type LimbSide, type NormalizedLandmark, type PoseId, type SoundId } from "../../shared/fighter-model";
import { torsoLength } from "../../shared/pose-geometry";
import { shakenGrip, type HandshakeGrip } from "../../shared/handshake";
import { allTweens, frameOf, handshakeShakeOf, idleSwayOf, tweenOf, type FrameTween } from "../../simulation/fight-simulation";
import type { FighterState } from "../../simulation/fighter-state-machine";
import { fallPose, hitShake, holdsStruckPose } from "./hit-feel";
import { PoseTransitions } from "./pose-transitions";
import { PoseTweener, type FrameRef, type TweenLayer, type TweenSource } from "./pose-tweener";
import { GaitShape, STANCE, STEP, WalkGait, stepPose, type GaitFrame } from "./walk-gait";
import { Ragdoll, torsoCover } from "./ragdoll";
import { FLOOR_SCREEN_Y, GAME_WIDTH, worldToScreen } from "./stage";
import { TweenMeshes, readAlpha } from "./tween-meshes";
import { TOP_EDGE_STEP, blendProfiles, topProfile, type TopEdge } from "./top-edge";

export const textureKey = (prefix: string, poseId: PoseId, variant = 0) => `${prefix}:pose:${poseId}${variant ? `#${variant}` : ""}`;
export const soundKey = (prefix: string, soundId: SoundId, take = 0) => `${prefix}:sound:${soundId}${take ? `#${take}` : ""}`;
/** The bundled stand-in for a sound (an optional line uses its fallback's: SOUND_FALLBACK). */
export const fallbackSoundKey = (soundId: SoundId) => `fallback:${SOUND_FALLBACK[soundId] ?? soundId}`;

/** Every texture key preloadFighterTextures creates for a fighter (to clean up afterwards). */
export function fighterTextureKeys(fighter: Fighter, prefix: string): string[] {
  return POSE_IDS.flatMap((poseId) => [
    textureKey(prefix, poseId),
    ...(fighter.poseVariants[poseId] ?? []).map((_, i) => textureKey(prefix, poseId, i + 1)),
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
    fighter.poseVariants[poseId]?.forEach((pose, i) => queue(textureKey(prefix, poseId, i + 1), pose.imageBlob));
  }
  return urls;
}

/**
 * Decode the fighter's voice clips into Phaser's audio cache. Missing or
 * undecodable clips map to the bundled generic sounds; an optional line
 * without takes (SOUND_FALLBACK) gets its fallback line's takes.
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
  for (const id of SOUND_IDS) keys[id] = keys[id].filter(Boolean);
  for (const id of SOUND_IDS) {
    const fallback = SOUND_FALLBACK[id];
    if (!keys[id].length) keys[id] = fallback && keys[fallback].length ? keys[fallback] : [fallbackSoundKey(id)];
  }
  return keys;
}


/** Flesh behind the back joints (shoulders, hips), in torso lengths, for a fighter lying on their back. */
const BACK_PADDING_TORSOS = 0.18;
/** A photo's own lean that lying down allows for (radians); beyond it, it's probably a bad landmark. */
const MAX_LEAN = (40 * Math.PI) / 180;

/**
 * One fighter on screen. Pose swaps are hard cuts, except where the frame data
 * asks for a tween (inside a move, or a SOFT_CUTS pair between actions): then
 * ARAP-warped meshes (WebGL only) stand in for the sprite. Everything is drawn from the feet anchor so the fighter stays planted.
 */
export class FighterSpriteView {
  readonly sprite: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private currentFrame: string | null = null;
  /** Null without WebGL (the canvas renderer can't draw meshes): always hard cuts. */
  private readonly tweener: PoseTweener | null;
  private readonly transitions = new PoseTransitions();
  private readonly meshes: TweenMeshes;
  /** The last solve: the display can refresh faster than the 60 Hz simulation. */
  private lastTween: { tween: FrameTween; swing: LimbSide | null; single: boolean; layers: TweenLayer[] | null } | null = null;
  /** Undefined until the first render that can use it (walkGait). */
  private gait: WalkGait | null | undefined = undefined;
  private readonly torso: number;
  /** The capture on screen last frame (the nearer end of a morph): what a struck fighter holds. */
  private lastShown: FrameRef | null = null;
  private depth = 0;
  private readonly lyingShapes = new Map<string, { turn: number; lift: (rotation: number, facing: 1 | -1) => number }>();
  /** What was drawn last render, upright (null while tipped over): for topEdge. */
  private placed: { from: FrameRef; to: FrameRef; t: number; at: { x: number; y: number }; facing: 1 | -1 } | null = null;
  private readonly profiles = new Map<string, (number | null)[] | null>();
  /** KO'd: the capture they were hit in, going limp from where they stood (ragdoll.ts). */
  private ragdoll: { body: Ragdoll; frame: FrameRef; backing: FrameRef; origin: { x: number; y: number } } | null = null;
  /** The capture whose arms cover its torso least, with that cover (torsoCover): drawn under a ragdoll. Built on the first KO. */
  private clearestTorso: { frame: FrameRef; cover: number } | null = null;

  /** `grip`: the handshake as the round intro aims it (FightSimulation.grips); without it the hand doesn't shake. */
  constructor(
    scene: Phaser.Scene,
    private readonly prefix: string,
    private readonly geometry: FighterGeometry,
    tint?: number,
    private readonly grip?: HandshakeGrip,
  ) {
    this.shadow = scene.add.ellipse(0, 0, 150, 22, 0x000000, 0.35);
    this.sprite = scene.add.image(0, 0, textureKey(prefix, "idle"));
    if (tint !== undefined) this.sprite.setTint(tint);
    this.torso = torsoLength(geometry.idle.landmarks);
    this.meshes = new TweenMeshes(scene, (frame) => this.frameTexture(frame), tint);
    this.tweener = scene.renderer.type === Phaser.WEBGL ? new PoseTweener((frame) => this.tweenSource(frame)) : null;
    // Build every mesh now: a few ms per pose here beats a hitch on the first punch.
    if (this.tweener) for (const tween of this.everyTween()) this.tweener.prepare(tween);
  }

  /** Whether this view can morph at all (WebGL); without it, every tween is a hard cut. */
  get canTween(): boolean {
    return this.tweener !== null;
  }

  /**
   * `frame` is the simulation frame (soft cuts between actions are timed by it).
   * `tweening` off shows every tween as the hard cut it replaces. `opponent`: the
   * other fighter, so a hit that lands shakes the attacker too.
   */
  render(state: FighterState, frame: number, tweening = true, opponent?: FighterState): void {
    let tween: FrameTween | null = null;
    let step: GaitFrame | null = null;
    if (tweening && this.tweener) {
      const gait = this.walkGait();
      const stride = gait?.update(frame, { walking: state.action === "walk", x: state.position.x, facing: state.facing }, state.action === "idle") ?? null;
      // Shaking hands, the arm is aimed at the other hand from the reach on (GRIP), not held as photographed.
      const held = this.grip && state.action === "handshake" ? GRIP : frameOf(state);
      tween = this.transitions.update(frame, held, tweenOf(state) ?? (this.grip ? handshakeShakeOf(state, this.grip.offeredAt) : null), idleSwayOf(state), stride?.tween);
      if (stride && tween === stride.tween) step = stride;
      // GRIP has no photo of its own: even held still, it's the handshake capture warped.
      if (!tween && held === GRIP) tween = { from: GRIP, to: GRIP, t: 0 };
    } else {
      this.transitions.reset();
      this.gait?.reset();
    }
    const p = worldToScreen(state.position);
    p.x += hitShake(state, frame, opponent);
    // Just hit: the struck pose holds through most of the freeze (hit-feel.ts).
    const struck = holdsStruckPose(state) && this.lastShown;
    // KO'd: the photo goes limp and flops down.
    if (!struck && tweening && this.renderRagdoll(state)) return;
    // Knocked down (or KO'd without WebGL): the plain photo, tipped over (no morphs while falling or lying).
    const fall = struck ? null : fallPose(state);
    const layers = !struck && !fall && tween ? this.layersFor(tween, step) : null;
    const lying = fall ? Math.sin((fall.tilt * Math.PI) / 2) : 0;
    let rotation = 0;
    if (layers) {
      this.meshes.show(layers, state.facing, p, this.depth);
      this.lastShown = tween!.t < 0.5 ? tween!.from : tween!.to;
      this.placed = { from: tween!.from, to: tween!.to, t: tween!.t, at: p, facing: state.facing };
    } else {
      this.meshes.hide();
      const shown = struck || frameOf(state);
      if (fall) {
        // Tipped back around the feet until the body lies flat, lifted so it rests on the floor.
        const lie = this.lyingShape(shown);
        rotation = -state.facing * fall.tilt * lie.turn;
        p.y -= lie.lift(rotation, state.facing) + fall.bounce;
      }
      this.showSprite(shown, state.facing, p);
      if (!struck) this.lastShown = shown;
      this.placed = fall ? null : { from: shown, to: shown, t: 0, at: p, facing: state.facing };
    }
    this.sprite.setRotation(rotation);
    this.sprite.setVisible(!layers);
    const floor = worldToScreen({ x: state.position.x, y: 0 });
    // Lying down, the shadow stretches out behind the feet, under the body.
    this.shadow.setPosition(floor.x - state.facing * lying * 120, floor.y + 4);
    const size = Math.max(0.4, 1 + state.position.y / 400);
    this.shadow.setScale(size * (1 + 1.6 * lying), size);
  }

  /**
   * Draw a KO'd fighter as a ragdoll: false when they aren't KO'd or it can't
   * be drawn (the tipped-over photo stands in). Stepped by the KO's own frame
   * count, so the replay, which draws the same states again, flops the same way.
   */
  private renderRagdoll(state: FighterState): boolean {
    if (state.action !== "ko" || !this.tweener) {
      this.ragdoll = null;
      return false;
    }
    if (this.ragdoll && state.actionFrame < this.ragdoll.body.frames) this.ragdoll = null; // the replay went back
    if (!this.ragdoll) {
      const frame = this.lastShown ?? frameOf(state);
      const landmarks = this.tweener.skeleton({ from: frame, to: frame, t: 0 });
      if (!landmarks) return false;
      const origin = worldToScreen(state.position);
      const side = (x: number) => state.facing * (x - origin.x);
      const walls = [side(WALL_MARGIN), side(GAME_WIDTH - WALL_MARGIN)].sort((a, b) => a - b) as [number, number];
      const velocity = { x: state.facing * state.velocity.x, y: state.velocity.y };
      // Under the limp photo, whichever capture shows the most of the torso (if it's clearer than this one).
      const clearest = this.clearestCapture();
      const backing = clearest.cover < torsoCover(landmarks) ? clearest.frame : frame;
      this.ragdoll = { body: new Ragdoll({ landmarks, velocity, floor: FLOOR_SCREEN_Y - origin.y, walls }), frame, backing, origin };
    }
    const { body, frame, backing, origin } = this.ragdoll;
    body.advanceTo(state.actionFrame);
    const skeleton = body.skeleton();
    const layers = this.tweener.limp(frame, skeleton, backing);
    if (!layers) {
      this.ragdoll = null;
      return false;
    }
    this.meshes.show(layers, state.facing, origin, this.depth);
    this.sprite.setVisible(false);
    this.placed = null;
    // The shadow spreads under whatever of them is near the floor.
    const xs = skeleton.map((l) => origin.x + state.facing * l.x);
    const left = Math.min(...xs), right = Math.max(...xs);
    const pelvisHeight = FLOOR_SCREEN_Y - (origin.y + (skeleton[LANDMARK.leftHip].y + skeleton[LANDMARK.rightHip].y) / 2);
    const size = Math.max(0.4, 1 - pelvisHeight / 600);
    this.shadow.setPosition((left + right) / 2, FLOOR_SCREEN_Y + 4);
    this.shadow.setScale(size * Math.max(0.8, (right - left) / 140), size);
    return true;
  }

  private clearestCapture(): { frame: FrameRef; cover: number } {
    if (!this.clearestTorso) {
      for (const poseId of POSE_IDS) {
        for (let variant = 0; variant < variantCount(this.geometry, poseId); variant++) {
          const cover = torsoCover(frameGeometry(this.geometry, poseId, variant).landmarks);
          if (!this.clearestTorso || cover < this.clearestTorso.cover) this.clearestTorso = { frame: { poseId, variant }, cover };
        }
      }
    }
    return this.clearestTorso!;
  }

  /**
   * The top edge of the fighter as last rendered, in screen px (one point per
   * TOP_EDGE_STEP-wide sprite column, so the same index stays on the same part
   * of them as they turn): what snow settles on. A morph blends its two
   * captures' edges, which is close for small ones like the idle sway. Null
   * while they're tipped over, or before the textures can be read.
   */
  topEdge(): TopEdge | null {
    const placed = this.placed;
    if (!placed) return null;
    const capture = (f: FrameRef): FrameRef => (f.poseId === "handshake" ? { poseId: "handshake", variant: 0 } : f);
    const from = capture(placed.from), to = capture(placed.to);
    const a = this.profile(from), b = this.profile(to);
    if (!a || !b) return null;
    const anchorA = groundAnchorFor(this.geometry, from.poseId, from.variant);
    const anchorB = groundAnchorFor(this.geometry, to.poseId, to.variant);
    const t = placed.t;
    const ax = anchorA.x + (anchorB.x - anchorA.x) * t, ay = anchorA.y + (anchorB.y - anchorA.y) * t;
    return blendProfiles(a, b, t).map((y, i) => y === null ? null : {
      x: placed.at.x + placed.facing * ((i + 0.5) * TOP_EDGE_STEP - ax),
      y: placed.at.y + y - ay,
    });
  }

  private profile(frame: FrameRef): (number | null)[] | null {
    const key = this.frameTexture(frame);
    if (!this.profiles.has(key)) {
      const mask = readAlpha(this.sprite.scene, key);
      this.profiles.set(key, mask && topProfile(mask));
    }
    return this.profiles.get(key)!;
  }

  /**
   * How a capture lies down: `turn`, the backward rotation (radians) that lays
   * its feet-to-head line flat (less than a quarter turn for a photo already
   * leaning back), and `lift(rotation, facing)`, how far to raise it so its
   * lowest joint (plus flesh) rests on the floor at that rotation.
   */
  private lyingShape(frame: FrameRef): { turn: number; lift: (rotation: number, facing: 1 | -1) => number } {
    const key = `${frame.poseId}#${frame.variant}`;
    let shape = this.lyingShapes.get(key);
    if (!shape) {
      const { landmarks } = frameGeometry(this.geometry, frame.poseId, frame.variant);
      const anchor = groundAnchorFor(this.geometry, frame.poseId, frame.variant);
      const joints = landmarks.filter((l) => l.visibility > 0.3).map((l) => ({ x: l.x - anchor.x, y: l.y - anchor.y }));
      const head = landmarks[LANDMARK.nose];
      // Lean from upright, positive forward; a hurt photo usually leans back already.
      const lean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan2(head.x - anchor.x, anchor.y - head.y)));
      const padding = BACK_PADDING_TORSOS * torsoLength(landmarks);
      shape = {
        turn: Math.PI / 2 + lean,
        lift: (rotation, facing) => {
          // Screen rotation of each joint (mirrored for a fighter facing left); the lowest one touches down.
          const sin = Math.sin(rotation), cos = Math.cos(rotation);
          const lowest = Math.max(...joints.map((j) => facing * j.x * sin + j.y * cos));
          return Math.max(0, lowest + padding * Math.abs(sin));
        },
      };
      this.lyingShapes.set(key, shape);
    }
    return shape;
  }

  private showSprite(frame: FrameRef, facing: 1 | -1, at: { x: number; y: number }): void {
    const key = this.frameTexture(frame);
    if (key !== this.currentFrame) {
      this.currentFrame = key;
      this.sprite.setTexture(key);
      const anchor = groundAnchorFor(this.geometry, frame.poseId, frame.variant);
      this.sprite.setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE);
    }
    // Captures face right; flipping mirrors around the origin (the anchor).
    this.sprite.setFlipX(facing === -1);
    this.sprite.setPosition(at.x, at.y);
  }

  setDepth(depth: number): void {
    this.depth = depth;
    this.sprite.setDepth(depth);
    this.shadow.setDepth(depth - 1);
  }

  /** Every from/to pair a move or a soft cut can show, with each captured version of both. */
  private everyTween(): Pick<FrameTween, "from" | "to">[] {
    const versions = (poseId: PoseId) => Array.from({ length: variantCount(this.geometry, poseId) }, (_, variant) => ({ poseId, variant }));
    return [
      ...allTweens(this.geometry.archetype),
      { from: { poseId: "idle", variant: 0 }, to: { poseId: "idle", variant: 1 } }, // the idle sway
      { from: { poseId: "handshake", variant: 1 }, to: { poseId: "handshake", variant: 2 } }, // the intro's shake
      { from: GRIP, to: GRIP },
      ...SOFT_CUTS.flatMap((cut) => versions(cut.from).flatMap((from) => versions(cut.to).map((to) => ({ from, to })))),
    ];
  }

  /** `step`: a walking stride, drawn one capture at a time (no doubled legs) with its mid-step lift (stepPose). */
  private layersFor(tween: FrameTween, step: GaitFrame | null = null): TweenLayer[] | null {
    const last = this.lastTween;
    const swing = step?.swing ?? null;
    const single = step !== null;
    const same = last && last.tween.t === tween.t && last.swing === swing && last.single === single && sameFrame(last.tween.from, tween.from) && sameFrame(last.tween.to, tween.to);
    if (!same) {
      const adjust = swing ? (skeleton: NormalizedLandmark[]) => stepPose(skeleton, tween.t, swing, this.torso) : undefined;
      this.lastTween = { tween, swing, single, layers: this.tweener!.layers(tween, adjust, single) };
    }
    return this.lastTween!.layers;
  }

  /**
   * The planted walk (walk-gait.ts), built the first time it's needed. Null
   * when this fighter's stance and step can't make one (no WebGL, or a step no
   * wider than the stance): the walk cycle's soft cuts stand in.
   */
  private walkGait(): WalkGait | null {
    if (this.gait === undefined) {
      const shape = this.tweener && GaitShape.measure((w) => this.tweener!.skeleton({ from: STANCE, to: STEP, t: w }), this.torso);
      this.gait = shape ? new WalkGait(shape) : null;
    }
    return this.gait;
  }

  /** The texture for a frame. The handshake's made-up versions (the pumping hand) show its one capture. */
  private frameTexture(frame: FrameRef): string {
    return textureKey(this.prefix, frame.poseId, frame.poseId === "handshake" ? 0 : frame.variant);
  }

  /**
   * A capture's landmarks, anchor and alpha mask (read back from its loaded
   * texture). The shaking hand is the handshake capture warped onto a raised
   * (variant 1) and a lowered (variant 2) hand, and onto the aimed one between
   * them (GRIP).
   */
  private tweenSource(frame: FrameRef): TweenSource | null {
    if (frame.poseId === "handshake" && frame.variant > 0) {
      const grip = this.grip;
      const capture = grip && this.tweenSource({ poseId: "handshake", variant: 0 });
      if (!capture) return null;
      const landmarks = frame.variant === GRIP.variant ? grip.landmarks : shakenGrip(grip, frame.variant === 1 ? -1 : 1);
      return { ...capture, landmarks, standIn: true };
    }
    const mask = readAlpha(this.sprite.scene, this.frameTexture(frame));
    if (!mask) return null;
    const anchor = groundAnchorFor(this.geometry, frame.poseId, frame.variant);
    return { mask, landmarks: frameGeometry(this.geometry, frame.poseId, frame.variant).landmarks, anchor };
  }
}

/** How close to the screen's edges a ragdoll can flop, px. */
const WALL_MARGIN = 20;

/** The handshake with the arm aimed at where the hands meet (HandshakeGrip.landmarks): a stand-in, like the shake's raised and lowered hands (variants 1 and 2). */
const GRIP: FrameRef = { poseId: "handshake", variant: 3 };

const sameFrame = (a: FrameRef, b: FrameRef) => a.poseId === b.poseId && a.variant === b.variant;
