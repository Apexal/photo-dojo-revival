import Phaser from "phaser";
import { ARCHETYPES } from "../../shared/archetypes";
import type { SoundId } from "../../shared/fighter-model";
import { geometryOf } from "../fighter-library";
import { createFighterState, type FighterState } from "../../simulation/fighter-state-machine";
import type { InputFrame } from "../../simulation/input-frame";
import { announce } from "../announcer";
import { recordOf, winLoss } from "../fighter-records";
import { playGameSound } from "../game-sounds";
import { createInputSource, isPlayerInput, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { getOptions } from "../options";
import { FighterSpriteView, fighterTextureKeys, loadFighterSounds, preloadFighterTextures } from "../render/fighter-sprite-view";
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from "../render/stage";
import { bodyText, COLOR, displayText, HEX, popBox, RADIUS, SHADOW, stamp } from "../render/theme";
import { stageFor } from "../stages/stages";
import { pickTake } from "../sound-choice";
import { formatTape, measureFighter, TAPE_LABELS, TAPE_STATS, tapeEdges, tapeVerdict } from "../tale-of-the-tape";
import { cycleLength, routineAt, routineLength, showOffRoutine, signatureStartFrame, type RoutineStep } from "../versus-intro";
import { MIRROR_TINT } from "./controls-scene";
import type { FightSceneData } from "./fight-scene";

const PREFIXES = ["vs0", "vs1"] as const;
const PLAYER_CSS = [COLOR.bad, COLOR.p2];
const STEP_MS = 1000 / 60;
/** Where each fighter stands (world x), either side of the tape. */
const FIGHTER_X = [190, GAME_WIDTH - 190] as const;
/** They leap in from off screen. */
const LEAP_FROM_X = [-220, GAME_WIDTH + 220] as const;
const LEAP_FRAMES = 34;
const LEAP_HEIGHT = 260;
/** P2 lands a beat after P1, and shows off a beat later too. */
const P2_DELAY_FRAMES = 14;
/** The timeline, in frames from the scene opening. */
const T = { slabs: 0, leap: 6, vs: 52, rows: 70, rowGap: 24, routine: 64 } as const;
/** After the last fighter first strikes their victory pose, the edge is stamped. */
const EDGE_AFTER_POSE = 10;
/** The whole intro, unless both players skip it: the show-off goes round again meanwhile. */
const INTRO_FRAMES = 15 * 60;
const TAPE_W = 470;
const TAPE_TOP = 140;
const ROW_H = 64;
/** A press carried over from stage select doesn't count as a skip. */
const INPUT_DELAY_MS = 300;
const DEPTH = { stage: 0, dim: 1, slabs: 2, fighters: 5, tape: 10, banner: 20, flash: 30 } as const;

/**
 * The versus intro, between stage select and the controls screen: both
 * fighters leap in, "VS" slams down, and the tale of the tape counts off
 * (tale-of-the-tape.ts) while each fighter shows off their moves
 * (versus-intro.ts), over and over. Either player alone can't skip it: both
 * press punch (the CPU always agrees). It moves on by itself after 15 seconds.
 */
export class VersusScene extends Phaser.Scene {
  private setup!: FightSceneData;
  private views: FighterSpriteView[] = [];
  private routines: RoutineStep[][] = [];
  private sounds: Record<SoundId, string[]>[] = [];
  private sources: InputSource[] = [];
  private seats: (0 | 1)[] = [];
  private previous: InputFrame[] = [];
  private skips: [boolean, boolean] = [false, false];
  private skipTexts: Phaser.GameObjects.Text[] = [];
  private progress!: Phaser.GameObjects.Graphics;
  private objectUrls: string[] = [];
  private openedAt = 0;
  private frame = -1;
  /** When the edge is stamped (from the routines' lengths) and the scene moves on (frames). */
  private timeline = { edge: 0, end: 0 };
  private cues: { at: number; run: () => void }[] = [];
  private leaving = false;

  constructor() {
    super("versus");
  }

  init(data: FightSceneData): void {
    this.setup = data;
    this.leaving = false;
    this.frame = -1;
    this.cues = [];
    this.views = [];
    // The CPU always agrees to skip.
    this.skips = [!isPlayerInput(data.inputs[0]), !isPlayerInput(data.inputs[1])];
  }

  preload(): void {
    stageFor(this.setup.stageId).preload?.(this);
    this.setup.entries.forEach((e, i) => this.objectUrls.push(...preloadFighterTextures(this, e.fighter, PREFIXES[i])));
  }

  create(): void {
    this.openedAt = performance.now();
    const fighters = this.setup.entries.map((e) => e.fighter);
    const geometry = fighters.map(geometryOf);
    const mirror = fighters[0].fighterId === fighters[1].fighterId;
    this.routines = fighters.map((f) => showOffRoutine(f.archetype));
    this.sounds = [];
    void Promise.all(fighters.map((f, i) => loadFighterSounds(this, f, PREFIXES[i]))).then((s) => { this.sounds = s; });

    // The stage, dimmed, under a slab of each player's colour.
    stageFor(this.setup.stageId).build(this, this.add.container(0, 0).setDepth(DEPTH.stage));
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, HEX.ink, 0.55).setOrigin(0).setDepth(DEPTH.dim);
    [0, 1].forEach((i) => this.buildSlab(i));

    this.views = geometry.map((g, i) => {
      const view = new FighterSpriteView(this, PREFIXES[i], g, i === 1 && mirror ? MIRROR_TINT : undefined);
      view.setDepth(DEPTH.fighters);
      return view;
    });

    const lastPose = Math.max(...this.routines.map((r, i) => T.routine + i * P2_DELAY_FRAMES + routineLength(r)));
    this.timeline = { edge: lastPose + EDGE_AFTER_POSE, end: INTRO_FRAMES };
    this.buildTape(fighters, geometry);
    this.cueVs();
    this.cueBattleCries(fighters.map((f) => f.archetype));

    this.seats = ([0, 1] as const).filter((i) => isPlayerInput(this.setup.inputs[i]));
    this.sources = this.seats.map((i) => createInputSource(this, this.setup.inputs[i] as PlayerInputDescriptor));
    this.previous = this.sources.map((s) => s.read());
    this.skipTexts = [0, 1].map((i) => this.add.text(i === 0 ? 24 : GAME_WIDTH - 24, GAME_HEIGHT - 24, "", bodyText(17, PLAYER_CSS[i], 800, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(i === 0 ? 0 : 1, 1).setDepth(DEPTH.banner));
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 24, "both press punch to skip", bodyText(16, COLOR.muted, 600, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(0.5, 1).setDepth(DEPTH.banner);
    this.progress = this.add.graphics().setDepth(DEPTH.banner);
    this.updateSkipTexts();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.tweens.killAll();
      fighters.forEach((f, i) => fighterTextureKeys(f, PREFIXES[i]).forEach((k) => this.textures.exists(k) && this.textures.remove(k)));
      this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
      this.objectUrls = [];
    });
  }

  update(): void {
    if (this.leaving) return;
    this.readSkips();
    if (this.leaving) return;
    const frame = Math.floor((performance.now() - this.openedAt) / STEP_MS);
    while (this.frame < frame) {
      this.frame++;
      for (const cue of this.cues) if (cue.at === this.frame) cue.run();
    }
    const tweening = getOptions(this.registry).poseTweening;
    const states = [0, 1].map((i) => this.fighterAt(i, this.frame));
    this.views.forEach((v, i) => v.render(states[i], this.frame, tweening));
    const t = Math.min(1, this.frame / this.timeline.end);
    this.progress.clear().fillStyle(HEX.accent, 0.8).fillRect(0, GAME_HEIGHT - 4, GAME_WIDTH * t, 4);
    if (this.frame >= this.timeline.end) this.leave();
  }

  // --- the fighters --------------------------------------------------------------

  /** Leaping in, standing ready, then the show-off. */
  private fighterAt(i: number, frame: number): FighterState {
    const facing = i === 0 ? 1 : -1;
    const base = createFighterState(FIGHTER_X[i], facing, 100);
    const leap = frame - (T.leap + i * P2_DELAY_FRAMES);
    if (leap < 0) return { ...base, position: { x: LEAP_FROM_X[i], y: 0 } };
    if (leap < LEAP_FRAMES) {
      const t = (leap + 1) / LEAP_FRAMES;
      const x = LEAP_FROM_X[i] + (FIGHTER_X[i] - LEAP_FROM_X[i]) * t;
      return { ...base, action: "jump", actionFrame: leap, position: { x, y: -4 * LEAP_HEIGHT * t * (1 - t) } };
    }
    const step = routineAt(this.routines[i], frame - (T.routine + i * P2_DELAY_FRAMES));
    // The victory pose is the flex photo (the second win capture) when there is one.
    const variant = step.action === "taunt" && this.setup.entries[i].fighter.poseVariants.win?.length ? 1 : 0;
    return { ...base, action: step.action, actionFrame: step.actionFrame, variant };
  }

  /** The landing thuds, and each fighter's battle cry (their attack clip) each time the signature move comes out. */
  private cueBattleCries(archetypes: (keyof typeof ARCHETYPES)[]): void {
    [0, 1].forEach((i) => {
      this.cue(T.leap + i * P2_DELAY_FRAMES + LEAP_FRAMES, () => {
        playGameSound(this, "thud", 0.9);
        this.shake(140, 4);
      });
      const start = signatureStartFrame(this.routines[i], archetypes[i]);
      if (start < 0) return;
      for (let at = T.routine + i * P2_DELAY_FRAMES + start; at < INTRO_FRAMES; at += cycleLength(this.routines[i])) {
        this.cue(at, () => this.playVoice(i, "attack"));
      }
    });
  }

  private playVoice(player: number, id: SoundId): void {
    const takes = this.sounds[player]?.[id] ?? [`fallback:${id}`];
    const key = pickTake(takes, undefined);
    const v = 0.9 * getOptions(this.registry).voiceVolume;
    if (v > 0 && this.cache.audio.exists(key)) this.sound.play(key, { volume: v });
  }

  // --- the set ---------------------------------------------------------------------

  /** A slanted slab of the player's colour behind their fighter, swept in from their side. */
  private buildSlab(i: number): void {
    const left = i === 0;
    const w = 470, slant = 120;
    const g = this.add.graphics().setDepth(DEPTH.slabs);
    const pts = left
      ? [{ x: -40, y: 0 }, { x: w + slant, y: 0 }, { x: w, y: GAME_HEIGHT }, { x: -40, y: GAME_HEIGHT }]
      : [{ x: GAME_WIDTH - w, y: 0 }, { x: GAME_WIDTH + 40, y: 0 }, { x: GAME_WIDTH + 40, y: GAME_HEIGHT }, { x: GAME_WIDTH - w - slant, y: GAME_HEIGHT }];
    g.fillStyle(PLAYER_COLORS[i], 0.32).fillPoints(pts, true);
    // A bright leading edge.
    g.lineStyle(6, PLAYER_COLORS[i], 0.9).lineBetween(pts[left ? 1 : 0].x, 0, pts[left ? 2 : 3].x, GAME_HEIGHT);
    g.x = left ? -700 : 700;
    this.tweens.add({ targets: g, x: 0, duration: 280, ease: "Cubic.easeOut", delay: T.slabs * STEP_MS });

    const fighter = this.setup.entries[i].fighter;
    const x = left ? 40 : GAME_WIDTH - 40;
    const name = this.add.text(x, 40, fighter.name, displayText(46, PLAYER_CSS[i])).setOrigin(left ? 0 : 1, 0).setDepth(DEPTH.banner);
    const style = this.add.text(x, 100, `P${i + 1} · ${ARCHETYPES[fighter.archetype].name}`, bodyText(18, COLOR.fg, 800, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(left ? 0 : 1, 0).setDepth(DEPTH.banner);
    // Names slam down as their fighter lands.
    const lands = (T.leap + i * P2_DELAY_FRAMES + LEAP_FRAMES) * STEP_MS;
    for (const [text, scale] of [[name, 2.2], [style, 1.6]] as const) {
      text.setAlpha(0).setScale(scale);
      this.tweens.add({ targets: text, alpha: 1, scale: 1, duration: 220, ease: "Back.easeOut", delay: lands });
    }
  }

  /** VS slams down with a flash, and the announcer calls it. */
  private cueVs(): void {
    const cx = GAME_WIDTH / 2;
    const vs = this.add.text(cx, 74, "VS", displayText(96, COLOR.accent)).setOrigin(0.5).setDepth(DEPTH.banner).setAlpha(0).setScale(4).setAngle(-12);
    const flash = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0xffffff, 0).setOrigin(0).setDepth(DEPTH.flash);
    this.cue(T.vs, () => {
      this.tweens.add({ targets: vs, alpha: 1, scale: 1, angle: -4, duration: 200, ease: "Cubic.easeIn" });
      this.time.delayedCall(200, () => {
        flash.setAlpha(0.55);
        this.tweens.add({ targets: flash, alpha: 0, duration: 260 });
        playGameSound(this, "hit", 1);
        this.shake(220, 8);
        announce(this, "tale-of-the-tape");
      });
    });
  }

  /** The tape: one row per stat between the fighters, counted off one by one; then who has the edge. */
  private buildTape(fighters: FightSceneData["entries"][number]["fighter"][], geometry: ReturnType<typeof geometryOf>[]): void {
    const cx = GAME_WIDTH / 2;
    const mirror = fighters[0].fighterId === fighters[1].fighterId;
    const tape = geometry.map(measureFighter);
    const edges = tapeEdges(tape[0], tape[1]);
    const records = fighters.map((f) => recordOf(this.registry, f.fighterId));
    const rows: { label: string; values: [string, string]; notes: [string, string]; edge: 0 | 1 | null }[] = [
      ...TAPE_STATS.map((stat) => ({
        label: TAPE_LABELS[stat],
        values: [formatTape(tape[0][stat]), formatTape(tape[1][stat])] as [string, string],
        notes: [tapeVerdict(stat, tape[0][stat]), tapeVerdict(stat, tape[1][stat])] as [string, string],
        edge: edges.stats[stat],
      })),
      {
        label: "Style",
        values: fighters.map((f) => ARCHETYPES[f.archetype].name) as [string, string],
        notes: fighters.map((f) => ARCHETYPES[f.archetype].moveName) as [string, string],
        edge: null,
      },
      {
        label: "Record",
        values: records.map((r) => (r?.matches ? winLoss(r) : "Debut")) as [string, string],
        notes: records.map((r) => (r?.matches ? `best streak ${r.longestStreak}` : "first fight")) as [string, string],
        edge: null,
      },
    ];

    const height = rows.length * ROW_H + 60;
    const panel = popBox(this, cx - TAPE_W / 2, TAPE_TOP, TAPE_W, height, { fill: HEX.panel, border: HEX.edge, radius: RADIUS.lg, shadow: SHADOW.lg }).setDepth(DEPTH.tape);
    const title = this.add.text(cx, TAPE_TOP + 14, "TALE OF THE TAPE", displayText(26, COLOR.accent, { outline: false, letterSpacing: 3 })).setOrigin(0.5, 0).setDepth(DEPTH.tape);
    for (const o of [panel, title]) {
      o.setAlpha(0);
      this.tweens.add({ targets: o, alpha: 1, duration: 200, delay: (T.rows - 8) * STEP_MS });
    }

    rows.forEach((row, r) => {
      const y = TAPE_TOP + 56 + r * ROW_H;
      const label = this.add.text(cx, y + 14, row.label.toUpperCase(), bodyText(14, COLOR.faint, 800, { letterSpacing: 2 })).setOrigin(0.5, 0);
      const sides = ([0, 1] as const).map((i) => {
        const x = i === 0 ? cx - 62 : cx + 62;
        const origin = i === 0 ? 1 : 0;
        const color = row.edge === i ? PLAYER_CSS[i] : COLOR.fg;
        const value = this.add.text(x, y, row.values[i], displayText(26, color, { outline: false })).setOrigin(origin, 0);
        const note = this.add.text(x, y + 34, row.notes[i], bodyText(15, row.edge === i ? COLOR.accent : COLOR.muted, 800)).setOrigin(origin, 0);
        fit(value, TAPE_W / 2 - 80);
        fit(note, TAPE_W / 2 - 80);
        return [value, note];
      });
      const all = [label, ...sides.flat()].map((o) => o.setDepth(DEPTH.tape).setAlpha(0));
      const at = T.rows + r * T.rowGap;
      // Each side slides in from its own fighter.
      sides.forEach((objects, i) => objects.forEach((o) => { o.x += i === 0 ? -40 : 40; }));
      this.cue(at, () => {
        playGameSound(this, "tick", 0.7);
        all.forEach((o) => this.tweens.add({ targets: o, alpha: 1, x: o === label ? o.x : o.x + (o.originX === 1 ? 40 : -40), duration: 180, ease: "Cubic.easeOut" }));
        // The edge pulses once.
        if (row.edge !== null) {
          const [value] = sides[row.edge];
          this.tweens.add({ targets: value, scale: value.scaleX * 1.18, duration: 120, yoyo: true, delay: 180 });
        }
      });
    });

    // Who has the edge overall, stamped on as the show-off ends.
    const overall = mirror ? null : edges.overall;
    const verdict = overall === null ? (mirror ? "Mirror match" : "Dead even") : `Edge: ${fighters[overall].name}`;
    const edgeStamp = stamp(this, cx, TAPE_TOP + height + 34, verdict, overall === null ? HEX.accent : PLAYER_COLORS[overall], 26)
      .setDepth(DEPTH.banner).setAlpha(0).setScale(3);
    this.cue(this.timeline.edge, () => {
      this.tweens.add({ targets: edgeStamp, alpha: 1, scale: 1, duration: 180, ease: "Cubic.easeIn" });
      this.time.delayedCall(180, () => { playGameSound(this, "thud", 1); this.shake(160, 5); });
    });
  }

  // --- skipping and moving on ----------------------------------------------------------

  private readSkips(): void {
    const accepting = performance.now() - this.openedAt > INPUT_DELAY_MS;
    this.sources.forEach((source, s) => {
      const now = source.read();
      source.pausePressed();
      if (accepting && now.punch && !this.previous[s].punch && !this.skips[this.seats[s]]) {
        this.skips[this.seats[s]] = true;
        playGameSound(this, "tick", 0.5);
        this.updateSkipTexts();
      }
      this.previous[s] = now;
    });
    if (this.skips[0] && this.skips[1]) this.leave();
  }

  private updateSkipTexts(): void {
    this.skipTexts.forEach((t, i) => t.setText(!isPlayerInput(this.setup.inputs[i]) ? "" : this.skips[i] ? `P${i + 1} ✓ skip` : `P${i + 1}: punch to skip`));
  }

  private leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.scene.start("controls", this.setup);
  }

  private cue(at: number, run: () => void): void {
    this.cues.push({ at, run });
  }

  private shake(ms: number, pixels: number): void {
    if (getOptions(this.registry).screenShake) this.cameras.main.shake(ms, pixels / GAME_WIDTH);
  }
}

/** Shrink a text wider than `width`. */
function fit(text: Phaser.GameObjects.Text, width: number): void {
  if (text.width > width) text.setScale(width / text.width);
}
