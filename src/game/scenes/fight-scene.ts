import Phaser from "phaser";
import { ATTACKS, frameGeometry, groundAnchorFor, type FighterGeometry } from "../../shared/frame-data";
import { LANDMARK, type Fighter, type PoseId, type SoundId } from "../../shared/fighter-model";
import { setSetting } from "../../shared/fighter-storage";
import { FightSimulation, frameOf, type FightState } from "../../simulation/fight-simulation";
import { currentAttackPhase, isAttack, type FighterState } from "../../simulation/fighter-state-machine";
import type { InputFrame } from "../../simulation/input-frame";
import { MAX_HEALTH, secondsRemaining, type PlayerIndex } from "../../simulation/round-rules";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { DUMMY_BEHAVIORS, DummyInputSource, cpuBehavior, nextCpuBehavior } from "../input/dummy-input-source";
import { createInputSource, isPlayerInput, sameInput, type InputDescriptor, type PlayerInputDescriptor } from "../input/input-descriptor";
import { PAD_BUTTON } from "../input/gamepad-input-source";
import type { InputSource } from "../input/input-source";
import { layoutForKey } from "../input/key-bindings";
import { FighterSpriteView, fallbackSoundKey, fighterTextureKeys, loadFighterSounds, preloadFighterTextures } from "../render/fighter-sprite-view";
import { FightCamera, FULL_VIEW, type CameraImpact } from "../render/fight-camera";
import { HitMarkers } from "../render/hit-markers";
import { REPLAY_SPEED, ReplayBuffer } from "../replay-buffer";
import { pickTake } from "../sound-choice";
import { JOIN_RUMBLE, RumbleScheduler, rumbleFor } from "../input/rumble";
import { playGameSound } from "../game-sounds";
import { playVoice } from "../render/talking-mouth-view";
import { announce } from "../announcer";
import { calloutLine, roundEndLine, roundStartLine } from "../announcer-lines";
import { getOptions, setOption } from "../options";
import { HitboxDebugView } from "../render/hitbox-debug-view";
import { BattleDamageView } from "../render/battle-damage-view";
import { damageInRounds, scarCount, scarsOn } from "../render/battle-damage";
import { LOW_HEALTH, clockCue, clockTicked, lowHealthPulse } from "../render/hud-cues";
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS, worldToScreen } from "../render/stage";
import { stageFor, type StageDefinition, type StageEffects } from "../stages/stages";
import { playStageMusic, preloadStage, stopStageMusic, updateStageMusicVolume } from "../stages/stage-music";
import { REGISTRY } from "./boot-scene";
import { MIRROR_TINT } from "./controls-scene";
import type { RoundResultData } from "./round-result-scene";
import type { MatchResultData } from "./match-result-scene";
import { MatchStatsTracker } from "../../simulation/match-stats";
import { CalloutTracker, calloutText, type Callout } from "../../simulation/callouts";
import { stopMenuMusic } from "../menu-music";
import { controlLabels } from "../input/control-labels";
import { recordMatch } from "../fighter-records";
import { markPlayed } from "../played-fighters";
import { NUDGES, Tutorial, type TutorialEvent } from "../tutorial";
import type { SeriesKind, SeriesSession } from "../series";
import { BORDER, bodyText, COLOR, displayText, drawPopBox, HEX, popBox, RADIUS, SHADOW, strokeFor } from "../render/theme";

export interface FightSceneData {
  entries: [LibraryEntry, LibraryEntry];
  /** P2 is the training dummy in practice mode, or the CPU (`{ kind: "cpu" }`) in a match against it. */
  inputs: [PlayerInputDescriptor, InputDescriptor];
  practice?: boolean;
  /** Practice that opens with the guided drill (tutorial.ts), then carries on as practice. */
  tutorial?: boolean;
  /** StageDefinition id (stages/stages.ts); the default stage when missing or unknown. */
  stageId?: string;
  /** A match of the series in the registry (series.ts): it ends back at that series' scene. */
  series?: SeriesKind;
}

/** Where backing out of a match (or its lead-up) goes: the series' scene (the bracket, the hill), else fighter select. */
export function menuSceneFor(data: FightSceneData): string {
  return data.series ?? "character-select";
}

const STEP_MS = 1000 / 60;
const MAX_FRAME_MS = 100;
const PREFIXES = ["p0", "p1"] as const;
const BAR_W = 520;
const BAR_H = 26;
const PILL_R = BAR_H / 2;
/** Emitted on a footer panel's text after setText, to refit its chip. */
const PANEL_FIT = "panel-fit";
/** Objects at this depth or above are HUD: drawn by the fixed HUD camera, not the zooming fight camera. */
const HUD_DEPTH = 100;
/** How far above a thrown fighter's feet (px) the throw spark goes: about mid-body. */

/**
 * Owns a FightSimulation, steps it at a fixed 60 Hz with an accumulator, and
 * renders the latest state. Render code never mutates simulation state.
 */
export class FightScene extends Phaser.Scene {
  private setup!: FightSceneData;
  private sim!: FightSimulation;
  private geometry!: [FighterGeometry, FighterGeometry];
  private sources: InputSource[] = [];
  private dummy: DummyInputSource | null = null;
  private replayBuffer = new ReplayBuffer<FightState>();
  private replay: { states: FightState[]; position: number; shown: number } | null = null;
  private replayDone = false;
  private replayUi: Phaser.GameObjects.GameObject[] = [];
  private views: FighterSpriteView[] = [];
  private scars: BattleDamageView[] = [];
  /** For the end-of-match stats page. */
  private stats = new MatchStatsTracker();
  /** FIRST BLOOD, N HIT STREAK, PERFECT. */
  private callouts = new CalloutTracker({ match: true });
  /** Per player, under their health bar: first blood and hit streaks. */
  private calloutTexts: Phaser.GameObjects.Text[] = [];
  /** Under the center banner, after the K.O. */
  private perfectText!: Phaser.GameObjects.Text;
  private stage!: StageDefinition;
  /** The stage's weather around the fighters (null if it has none). */
  private stageEffects: StageEffects | null = null;
  /** The stage's soundtrack (null if it has none). */
  private music: Phaser.Sound.BaseSound | null = null;
  private sounds: Record<SoundId, string[]>[] = [];
  private lastTake = new Map<string, string>();
  private objectUrls: string[] = [];
  private accumulator = 0;
  private paused = false;
  private waitingForResult = false;
  private motion!: Phaser.GameObjects.Graphics;
  private markers!: HitMarkers;
  /** Follows the fight on the main camera; the HUD camera stays put (HUD objects: depth ≥ HUD_DEPTH). */
  private camera = new FightCamera();
  private hudCamera!: Phaser.Cameras.Scene2D.Camera;
  private lastCameraUpdate = 0;
  private hud!: Phaser.GameObjects.Graphics;
  private debug!: HitboxDebugView;
  private timerText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;
  /** Player whose gamepad dropped out (the fight stays paused until they're back). */
  private disconnected: PlayerIndex | null = null;
  /** Buttons held when play resumed; ignored until released so "Resume" isn't also a punch. */
  private heldMask: Set<keyof InputFrame>[] = [new Set(), new Set()];
  private shownHealth: [number, number] = [MAX_HEALTH, MAX_HEALTH];
  private bannerUntil = 0;
  private tutorial: Tutorial | null = null;
  private tutorialUi: { title: Phaser.GameObjects.Text; how: Phaser.GameObjects.Text; pips: Phaser.GameObjects.Graphics; nudge: Phaser.GameObjects.Text; footer: Phaser.GameObjects.Text } | null = null;
  /** When the tutorial's "too far" nudge goes away (performance.now()). */
  private nudgeUntil = 0;

  constructor() {
    super("fight");
  }

  init(data: FightSceneData): void {
    this.setup = data;
    this.accumulator = 0;
    this.paused = false;
    this.disconnected = null;
    this.heldMask = [new Set(), new Set()];
    this.waitingForResult = false;
    this.shownHealth = [MAX_HEALTH, MAX_HEALTH];
    this.views = [];
    this.stats = new MatchStatsTracker(); // a rematch restarts the scene: fresh stats
    this.callouts = new CalloutTracker({ match: !data.practice });
    this.sounds = [];
    this.replayBuffer = new ReplayBuffer<FightState>();
    this.replay = null;
    this.replayDone = false;
    this.rumbles = [new RumbleScheduler(), new RumbleScheduler()];
    this.tutorial = data.tutorial ? new Tutorial(data.entries[0].fighter.archetype) : null;
  }

  preload(): void {
    this.setup.entries.forEach((e, i) => this.objectUrls.push(...preloadFighterTextures(this, e.fighter, PREFIXES[i])));
    preloadStage(this, stageFor(this.setup.stageId));
  }

  create(): void {
    stopMenuMusic(this); // practice comes straight here from the menus
    const [a, b] = this.setup.entries;
    markPlayed(this.registry, this.setup.entries.filter((_, i) => isPlayerInput(this.setup.inputs[i])).map((e) => e.fighter.fighterId));
    this.geometry = [geometryOf(a.fighter), geometryOf(b.fighter)];
    // A fresh seed per match so variant choices differ between fights (and stay replayable within one).
    this.sim = new FightSimulation(this.geometry, { seed: (Math.random() * 2 ** 32) >>> 0, practice: this.setup.practice });
    this.sources = this.setup.inputs.map((d) =>
      isPlayerInput(d) ? createInputSource(this, d) : (this.dummy = new DummyInputSource(this.sim, 1)),
    );
    // Practice opens against an easy CPU; 1–8 / Tab switch to the scripted dummies. The tutorial's dummy waits.
    const opponent = this.setup.inputs[1];
    this.dummy?.setBehavior(opponent.kind === "cpu" ? cpuBehavior(opponent.level) : this.tutorial ? "stand" : "cpuEasy");
    void Promise.all(this.setup.entries.map((e, i) => loadFighterSounds(this, e.fighter, PREFIXES[i]))).then((s) => { this.sounds = s; });

    this.stage = stageFor(this.setup.stageId);
    this.stage.build(this, this.add.container(0, 0).setDepth(0));
    this.stageEffects = this.stage.effects?.(this, { under: 5, over: 15 }) ?? null;
    this.music = playStageMusic(this, this.stage, 800);
    const mirrorMatch = a.fighter.fighterId === b.fighter.fighterId;
    this.views = [0, 1].map((i) => new FighterSpriteView(this, PREFIXES[i], this.geometry[i], i === 1 && mirrorMatch ? MIRROR_TINT : undefined, this.sim.grips[i]));
    this.views.forEach((v, i) => v.setDepth(10 + i));
    this.scars = this.views.map((_, i) => new BattleDamageView(this, 10 + i + 0.5));
    this.motion = this.add.graphics().setDepth(20);
    this.markers = new HitMarkers(this.add.graphics().setDepth(25));
    this.hud = this.add.graphics().setDepth(100);
    this.debug = new HitboxDebugView(this);
    this.debug.visible = Boolean(this.registry.get(REGISTRY.debugHitboxes));

    // Whose bar is whose: a P1 / P2 (or CPU) tag and the name, in the player's colour.
    [a, b].forEach((entry, i) => {
      const css = `#${PLAYER_COLORS[i].toString(16).padStart(6, "0")}`;
      const right = i === 1;
      const x = right ? GAME_WIDTH - 40 : 40;
      const input = this.setup.inputs[i];
      const tag = this.add.text(x + (right ? -8 : 8), 65, isPlayerInput(input) ? `P${i + 1}` : "CPU", displayText(18, COLOR.ink, { outline: false }))
        .setOrigin(right ? 1 : 0, 0).setDepth(101);
      const chipW = tag.width + 16;
      popBox(this, right ? x - chipW : x, 62, chipW, tag.height + 6, { fill: PLAYER_COLORS[i], radius: RADIUS.sm, shadow: SHADOW.sm }).setDepth(100);
      this.add.text(x + (right ? -1 : 1) * (chipW + 10), 60, entry.fighter.name, displayText(24, css))
        .setOrigin(right ? 1 : 0, 0).setDepth(100);
    });
    this.timerText = this.add.text(GAME_WIDTH / 2, 14, "60", displayText(52, COLOR.accent)).setOrigin(0.5, 0).setDepth(100);
    this.bannerText = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 80, "", displayText(96, COLOR.accent)).setOrigin(0.5).setDepth(200);
    this.calloutTexts = [0, 1].map((i) => {
      return this.add.text(i === 0 ? 40 : GAME_WIDTH - 40, 150, "", displayText(40, COLOR.party)).setOrigin(i === 0 ? 0 : 1, 0.5).setDepth(200).setVisible(false);
    });
    this.perfectText = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 20, "", displayText(64, COLOR.accent)).setOrigin(0.5).setDepth(200).setVisible(false);

    // Pause-menu shortcut (also in Settings).
    this.input.keyboard!.on("keydown-R", () => {
      if (!this.paused) return;
      const on = !getOptions(this.registry).rumble;
      setOption(this.registry, "rumble", on);
      if (on) this.sources.forEach((s) => s.rumble?.({ duration: 120, strong: 0.4, weak: 0.4 }));
    });
    // "Press any button to reconnect" on a keyboard half nobody else is using (pads: pollReconnect).
    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
      const layout = layoutForKey(ev.keyCode);
      if (layout) this.reconnect({ kind: "keyboard", layout });
    });
    this.input.keyboard!.on("keydown-F1", (ev: KeyboardEvent) => {
      ev.preventDefault();
      this.debug.visible = !this.debug.visible;
      this.registry.set(REGISTRY.debugHitboxes, this.debug.visible);
      void setSetting("debugHitboxes", this.debug.visible).catch(() => {});
    });
    if (this.tutorial) this.buildTutorialPanel();
    else if (this.setup.practice) this.buildPracticePanel();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      stopStageMusic(this, this.music);
      this.music = null;
      this.scene.stop("pause");
      this.scene.stop("settings");
      this.input.keyboard?.removeAllListeners("keydown-F1");
      this.input.keyboard?.removeAllListeners("keydown-R");
      this.input.keyboard?.removeAllListeners("keydown");
      this.input.gamepad?.removeAllListeners("down");
      this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
      this.objectUrls = [];
      this.setup.entries.forEach((e, i) => fighterTextureKeys(e.fighter, PREFIXES[i]).forEach((k) => this.textures.exists(k) && this.textures.remove(k)));
    });
    this.hudCamera = this.cameras.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.camera = new FightCamera();
    this.camera.snap(this.sim.current.fighters.map((f) => worldToScreen(f.position)));
    this.handleEvents(this.sim.current);
    this.showCallouts(this.callouts.record(this.sim.current));
    this.renderState(this.sim.current);
  }

  /** Frame the fight on the main camera, and split objects between it and the HUD camera. */
  private updateCamera(state: FightState): void {
    const now = performance.now();
    const frames = this.lastCameraUpdate ? Math.min(6, (now - this.lastCameraUpdate) / STEP_MS) : 1;
    this.lastCameraUpdate = now;
    const view = getOptions(this.registry).dynamicCamera
      ? this.camera.update(state.fighters.map((f) => worldToScreen(f.position)), frames)
      : FULL_VIEW;
    this.cameras.main.setZoom(view.zoom).centerOn(view.centerX, view.centerY);
    // Re-done every frame: some world objects (the fighters' morph meshes) appear mid-fight.
    for (const child of this.children.list) {
      const hud = (child as Phaser.GameObjects.GameObject & { depth: number }).depth >= HUD_DEPTH;
      child.cameraFilter = hud ? this.cameras.main.id : this.hudCamera.id;
    }
  }

  private cameraImpact(kind: CameraImpact): void {
    if (getOptions(this.registry).dynamicCamera) this.camera.kick(kind);
  }

  /** Practice: dummy behavior picker (1–8, 9 for the CPU levels, Tab, or a pad's Select button). */
  private buildPracticePanel(): void {
    this.timerText.setText("PRACTICE").setFontSize(26).setStroke(COLOR.ink, strokeFor(26)).setY(30);
    const panel = this.footerPanel("");
    const show = () => {
      const i = DUMMY_BEHAVIORS.findIndex((b) => b.behavior === this.dummy?.behavior);
      const n = Math.min(i + 1, 9);
      panel.setText(`Dummy: ${n}. ${DUMMY_BEHAVIORS[i].label}   ·   1–8 or Tab: change   ·   9: CPU level   ·   Esc: menu   ·   F1: hitboxes`);
      panel.emit(PANEL_FIT);
    };
    const select = (i: number) => {
      this.dummy?.setBehavior(DUMMY_BEHAVIORS[(i + DUMMY_BEHAVIORS.length) % DUMMY_BEHAVIORS.length].behavior);
      show();
    };
    const cpuIndex = DUMMY_BEHAVIORS.findIndex((b) => b.behavior === "cpuEasy");
    const current = () => DUMMY_BEHAVIORS.findIndex((b) => b.behavior === this.dummy?.behavior);
    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
      if (this.paused) return;
      const n = Number(ev.key);
      if (Number.isInteger(n) && n >= 1 && n <= cpuIndex) select(n - 1);
      if (n === 9 && this.dummy) select(DUMMY_BEHAVIORS.findIndex((b) => b.behavior === nextCpuBehavior(this.dummy!.behavior)));
      if (ev.key === "Tab") {
        ev.preventDefault();
        select(current() + 1);
      }
    });
    this.input.gamepad?.on("down", (_pad: Phaser.Input.Gamepad.Gamepad, button: Phaser.Input.Gamepad.Button) => {
      if (button.index === PAD_BUTTON.SELECT && !this.paused) select(current() + 1);
    });
    show();
  }

  /** Bottom-centre help line on a small dark chip (redrawn on PANEL_FIT; destroyed with the text). */
  private footerPanel(text: string): Phaser.GameObjects.Text {
    const label = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 28, text, bodyText(17, COLOR.fg, 600)).setOrigin(0.5).setDepth(150);
    const box = this.add.graphics().setDepth(149);
    const fit = () => {
      const w = label.width + 28, h = label.height + 12;
      drawPopBox(box.clear(), label.x - w / 2, label.y - h / 2, w, h, { fill: HEX.panel, fillAlpha: 0.92, radius: RADIUS.sm, shadow: SHADOW.sm });
    };
    label.on(PANEL_FIT, fit).once(Phaser.GameObjects.Events.DESTROY, () => box.destroy());
    fit();
    return label;
  }

  // --- tutorial ---------------------------------------------------------------

  /** The drill's instruction, the player's buttons for it, and a pip per repetition. */
  private buildTutorialPanel(): void {
    this.timerText.setText("TUTORIAL").setFontSize(26).setStroke(COLOR.ink, strokeFor(26)).setY(30);
    this.tutorialUi = {
      title: this.add.text(GAME_WIDTH / 2, 150, "", displayText(52, COLOR.fg)).setOrigin(0.5).setDepth(150),
      how: this.add.text(GAME_WIDTH / 2, 206, "", displayText(28, COLOR.accent)).setOrigin(0.5).setDepth(150),
      pips: this.add.graphics().setDepth(150),
      nudge: this.add.text(GAME_WIDTH / 2, 292, "", displayText(26, COLOR.bad)).setOrigin(0.5).setDepth(150),
      footer: this.footerPanel("Esc: menu"),
    };
  }

  private handleTutorial(events: TutorialEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case "step": this.dummy?.setBehavior(this.tutorial!.steps[ev.index].dummy); break;
        case "progress":
          playGameSound(this, "tick", 0.6);
          this.nudgeUntil = 0;
          break;
        case "nudge":
          this.tutorialUi?.nudge.setText(NUDGES[ev.kind]);
          this.nudgeUntil = performance.now() + 1800;
          break;
        case "cleared":
          this.dummy?.setBehavior("stand"); // a breather before the next drill
          this.banner("NICE!", 900);
          announce(this, "nice");
          break;
        case "finished": {
          // Carry on as plain practice against the easy CPU.
          this.banner("WELL DONE!", 1500);
          announce(this, "well-done");
          const ui = this.tutorialUi!;
          ui.pips.clear();
          ui.footer.destroy();
          ui.nudge.destroy();
          ui.title.setText("You're ready!");
          ui.how.setText("Keep practicing against the CPU");
          this.time.delayedCall(4000, () => [ui.title, ui.how, ui.pips].forEach((o) => o.destroy()));
          this.tutorialUi = null;
          this.dummy?.setBehavior("cpuEasy");
          this.buildPracticePanel();
          break;
        }
      }
    }
  }

  private drawTutorial(state: FightState): void {
    const step = this.tutorial?.current;
    const ui = this.tutorialUi;
    if (!ui) return;
    ui.pips.clear();
    ui.nudge.setVisible(performance.now() < this.nudgeUntil);
    if (!step) {
      ui.title.setText("");
      ui.how.setText("");
      return;
    }
    // Forward / back follow the way the player faces now (they may have crossed over).
    const labels = controlLabels(this.setup.inputs[0], state.fighters[0].facing === 1 ? "left" : "right");
    const how = step.how(labels);
    if (ui.title.text !== step.title) ui.title.setText(step.title);
    if (ui.how.text !== how) ui.how.setText(how);
    const gap = 34;
    const x0 = GAME_WIDTH / 2 - ((step.goal - 1) * gap) / 2;
    for (let i = 0; i < step.goal; i++) {
      const done = i < this.tutorial!.count;
      ui.pips.fillStyle(HEX.ink, 1).fillCircle(x0 + i * gap, 250 + SHADOW.sm, 11);
      ui.pips.fillStyle(done ? HEX.accent : HEX.line, 1).fillCircle(x0 + i * gap, 250, 11);
      ui.pips.lineStyle(3, HEX.ink, 1).strokeCircle(x0 + i * gap, 250, 11);
    }
  }

  update(_time: number, delta: number): void {
    if (this.replay) return this.updateReplay(delta);
    if (this.waitingForResult) return;
    this.checkControllers();
    if (this.paused) {
      // The pause menu reads its own inputs; drain ours so nothing fires on resume.
      this.sources.forEach((s) => { if (s !== this.dummy) { s.read(); s.pausePressed(); } });
      return;
    }
    // Poll every source (no short-circuit) so a press shared by both keyboard halves is consumed once.
    if (this.sources.map((s) => s.pausePressed()).includes(true)) return this.pause();
    this.accumulator += Math.min(delta, MAX_FRAME_MS);
    let state = this.sim.current;
    while (this.accumulator >= STEP_MS) {
      const inputs = [this.readInput(0), this.readInput(1)] as [InputFrame, InputFrame];
      const before = state;
      state = this.sim.step(inputs);
      if (!this.setup.practice && clockTicked(before.round, state.round)) playGameSound(this, "tick", 0.7);
      this.replayBuffer.push(state);
      this.stats.record(state);
      this.showCallouts(this.callouts.record(state));
      if (state.events.some((e) => e.type === "ko")) this.replayBuffer.markFinish();
      this.handleEvents(state);
      if (this.tutorial) this.handleTutorial(this.tutorial.update(state));
      this.accumulator -= STEP_MS;
      if (state.round.phase === "roundOver" || state.round.phase === "matchOver") break;
    }
    this.renderState(state);
    this.flushRumble();
    if (state.round.phase === "roundOver" || state.round.phase === "matchOver") {
      if (this.replayBuffer.hasFinish && !this.replayDone) this.startReplay();
      else this.showResult(state);
    }
  }

  // --- KO replay ----------------------------------------------------------------

  /** Slow-motion replay of the knockout from recorded states; any button skips. */
  private startReplay(): void {
    const states = this.replayBuffer.clip();
    if (!states.length) {
      this.replayDone = true;
      return;
    }
    this.replay = { states, position: 0, shown: -1 };
    this.camera.snap(states[0].fighters.map((f) => worldToScreen(f.position)));
    const bar = (y: number) => this.add.rectangle(0, y, GAME_WIDTH, 56, 0x000000, 0.85).setOrigin(0).setDepth(400);
    this.replayUi = [
      bar(0),
      bar(GAME_HEIGHT - 56),
      this.add.text(40, 12, "● REPLAY", displayText(28, COLOR.bad)).setDepth(401),
      this.add.text(GAME_WIDTH - 40, GAME_HEIGHT - 40, "Press any button to skip", bodyText(18, COLOR.muted, 600)).setOrigin(1, 0).setDepth(401),
    ];
    this.bannerText.setVisible(false);
    [...this.calloutTexts, this.perfectText].forEach((t) => { this.tweens.killTweensOf(t); t.setVisible(false); });
    // Players are often still mashing from the knockout: ignore input for the first second.
    this.replaySkipArmedAt = performance.now() + 1000;
    this.replayPrevious = this.players.map((src) => src.read());
  }

  private replaySkipArmedAt = 0;

  /** The people's controllers (not the dummy or CPU, which would "press" skip). */
  private get players(): InputSource[] {
    return this.sources.filter((s) => s !== this.dummy);
  }
  private replayPrevious: InputFrame[] = [];

  private updateReplay(delta: number): void {
    const replay = this.replay!;
    replay.position += (Math.min(delta, MAX_FRAME_MS) / STEP_MS) * REPLAY_SPEED;
    const index = Math.min(replay.states.length - 1, Math.floor(replay.position));
    // Replay the sounds and shakes of every frame we pass (no banners).
    for (let i = replay.shown + 1; i <= index; i++) this.handleEvents(replay.states[i], { replay: true });
    replay.shown = index;
    const state = replay.states[index];
    this.shownHealth = [state.fighters[0].health, state.fighters[1].health];
    this.renderState(state);

    const now = this.players.map((src) => src.read());
    const pressed = now.some((f, i) => (["punch", "kick"] as const).some((k) => f[k] && !this.replayPrevious[i]?.[k]));
    this.replayPrevious = now;
    const skip = performance.now() > this.replaySkipArmedAt && (pressed || this.players.map((src) => src.pausePressed()).includes(true));
    if (replay.position >= replay.states.length || skip) this.endReplay();
  }

  private endReplay(): void {
    this.replayUi.forEach((o) => o.destroy());
    this.replayUi = [];
    this.replay = null;
    this.replayDone = true;
    const state = this.sim.current;
    this.shownHealth = [state.fighters[0].health, state.fighters[1].health];
    this.renderState(state);
    this.showResult(state);
  }

  // --- pause menu and controllers ------------------------------------------------

  get isPractice(): boolean {
    return Boolean(this.setup.practice);
  }

  get series(): SeriesKind | undefined {
    return this.setup.series;
  }

  get playerInfo(): { inputs: [PlayerInputDescriptor, InputDescriptor]; fighters: [Fighter, Fighter] } {
    return { inputs: this.setup.inputs, fighters: [this.setup.entries[0].fighter, this.setup.entries[1].fighter] };
  }

  get disconnectedPlayer(): PlayerIndex | null {
    return this.disconnected;
  }

  private pause(): void {
    this.paused = true;
    this.sound.pauseAll();
    this.scene.launch("pause");
  }

  /** From the pause menu. Not while a controller is missing. */
  resumeFromPause(): void {
    if (this.disconnected !== null) return;
    this.scene.stop("pause");
    this.paused = false;
    this.sound.resumeAll();
    updateStageMusicVolume(this, this.stage, this.music); // Settings may have changed it
    this.maskHeldButtons();
  }

  /** Pause menu: start the current round over (wins as they were when it began). */
  restartRound(): void {
    if (this.disconnected !== null) return;
    this.scene.stop("pause");
    this.sound.stopAll();
    this.music?.play(); // from the top, with the round
    updateStageMusicVolume(this, this.stage, this.music);
    this.paused = false;
    this.sim.restartRound();
    // Starts the dummy's loop (or the CPU's memory of the fight) over.
    this.dummy?.setBehavior(this.dummy.behavior);
    this.replayBuffer.reset();
    this.replayDone = false;
    this.shownHealth = [MAX_HEALTH, MAX_HEALTH];
    this.accumulator = 0;
    this.maskHeldButtons();
    this.handleEvents(this.sim.current);
    this.showCallouts(this.callouts.record(this.sim.current));
    this.renderState(this.sim.current);
  }

  /**
   * On resume. Also swallows the Start / Esc press that closed the menu: overlays
   * update before this scene, so it would otherwise pause again this same frame.
   */
  private maskHeldButtons(): void {
    this.heldMask = this.sources.map((s) => {
      if (s === this.dummy) return new Set<keyof InputFrame>();
      s.pausePressed();
      const now = s.read();
      return new Set((Object.keys(now) as (keyof InputFrame)[]).filter((k) => now[k]));
    });
  }

  private readInput(player: PlayerIndex): InputFrame {
    const frame = this.sources[player].read();
    for (const k of this.heldMask[player]) {
      if (frame[k]) frame[k] = false;
      else this.heldMask[player].delete(k);
    }
    return frame;
  }

  /** A player's gamepad unplugged or out of battery: pause until they press a button again. */
  private checkControllers(): void {
    if (this.disconnected !== null) return;
    const lost = this.setup.inputs.findIndex((d, i) => d.kind === "pad" && !this.sources[i].connected);
    if (lost < 0) return;
    this.disconnected = lost as PlayerIndex;
    if (!this.paused) this.pause();
  }

  /**
   * Called by the pause menu each frame, before it reads its own input: a button
   * on any pad the other player isn't using takes over the missing controller.
   * Polled from the browser because Phaser's per-scene pad events don't reach
   * this scene while the menu is on top.
   */
  pollReconnect(): void {
    if (this.disconnected === null || typeof navigator === "undefined" || !navigator.getGamepads) return;
    for (const pad of navigator.getGamepads()) {
      if (pad?.connected && pad.buttons.some((b) => b.pressed)) {
        this.reconnect({ kind: "pad", index: pad.index });
        if (this.disconnected === null) return;
      }
    }
  }

  /** Any button on a pad or keyboard half the other player isn't using takes over the missing controller. */
  private reconnect(input: PlayerInputDescriptor): void {
    const player = this.disconnected;
    if (player === null) return;
    const other = this.setup.inputs[player === 0 ? 1 : 0];
    if (sameInput(other, input)) return;
    (this.setup.inputs as InputDescriptor[])[player] = input; // a rematch keeps the new controller
    // So does the next match of a tournament / king of the hill (built from the series' own inputs).
    const series: SeriesSession | undefined = this.setup.series ? this.registry.get(REGISTRY.series) : undefined;
    if (series) series.inputs[player] = input;
    this.sources[player] = createInputSource(this, input);
    this.heldMask[player] = new Set();
    this.disconnected = null;
    if (getOptions(this.registry).rumble) this.sources[player].rumble?.(JOIN_RUMBLE);
  }

  quitToSelect(): void {
    this.sound.stopAll();
    this.scene.stop("round-result");
    this.scene.stop("match-result");
    this.scene.start(menuSceneFor(this.setup));
  }

  /** Called by the round result screen. */
  nextRound(): void {
    this.sim.startNextRound();
    this.replayBuffer.reset();
    this.replayDone = false;
    this.shownHealth = [MAX_HEALTH, MAX_HEALTH];
    this.waitingForResult = false;
    this.accumulator = 0;
    this.handleEvents(this.sim.current);
    this.showCallouts(this.callouts.record(this.sim.current));
  }

  rematch(): void {
    this.scene.restart(this.setup);
  }

  private showResult(state: FightState): void {
    this.waitingForResult = true;
    if (state.round.phase === "matchOver") {
      const stats = this.stats.result;
      const winner = state.round.matchWinner ?? "draw";
      // Career records are for fights between people (not practice or the CPU).
      if (!this.setup.practice && this.setup.inputs.every(isPlayerInput)) {
        const [a, b] = this.setup.entries;
        recordMatch(this.registry, [a.fighter.fighterId, b.fighter.fighterId], stats.players, winner);
      }
      const data: MatchResultData = {
        stats,
        winner,
        entries: this.setup.entries,
        inputs: this.setup.inputs,
        prefixes: PREFIXES,
        series: this.setup.series,
      };
      this.scene.launch("match-result", data);
      return;
    }
    const names = this.setup.entries.map((e) => e.fighter.name);
    const rounds = this.stats.result.rounds;
    const data: RoundResultData = {
      summary: rounds[rounds.length - 1],
      wins: state.round.wins,
      names: [names[0], names[1]],
      inputs: this.setup.inputs,
    };
    this.scene.launch("round-result", data);
  }

  // --- events → sound and banners ---------------------------------------------

  /** A fighter's voice (their clip, or the bundled stand-in): the "Voice volume" setting. */
  private play(player: number, id: SoundId, volume = 0.8): void {
    const takes = this.sounds[player]?.[id] ?? [fallbackSoundKey(id)];
    const key = pickTake(takes, this.lastTake.get(`${player}:${id}`));
    this.lastTake.set(`${player}:${id}`, key);
    playVoice(this, key, volume * getOptions(this.registry).voiceVolume, this.views[player]);
  }

  private shake(ms: number, pixels: number): void {
    if (getOptions(this.registry).screenShake) this.cameras.main.shake(ms, pixels / GAME_WIDTH);
  }

  private banner(text: string, ms: number): void {
    const color = text === "K.O." ? COLOR.bad : COLOR.accent;
    if (this.bannerText.style.color !== color) this.bannerText.setColor(color);
    this.bannerText.setText(text).setVisible(true);
    this.bannerUntil = performance.now() + ms;
  }

  /** Pops the text in, holds it, fades it. A longer streak replaces the shorter one in place. */
  private showCallouts(callouts: Callout[]): void {
    for (const c of callouts) {
      const perfect = c.type === "perfect";
      const text = perfect ? this.perfectText : this.calloutTexts[c.player];
      this.tweens.killTweensOf(text);
      text.setText(calloutText(c)).setAlpha(perfect ? 0 : 1).setScale(1.4).setVisible(true);
      const line = calloutLine(c);
      // PERFECT comes after the K.O.
      if (line) announce(this, line, { queue: perfect });
      this.tweens.chain({
        targets: text,
        tweens: [
          // PERFECT waits for the K.O. banner to land first, and is gone before the replay.
          { alpha: 1, scale: 1, duration: 160, ease: "Back.easeOut", delay: perfect ? 500 : 0 },
          { alpha: 0, duration: 300, delay: perfect ? 1000 : 900, onComplete: () => text.setVisible(false) },
        ],
      });
    }
  }

  private rumbles = [new RumbleScheduler(), new RumbleScheduler()];

  /** Once per frame: each controller plays the strongest effect asked for this frame. */
  private flushRumble(): void {
    const now = performance.now();
    this.rumbles.forEach((queue, i) => {
      const r = queue.flush(now);
      if (r) this.sources[i]?.rumble?.(r);
    });
  }

  private handleEvents(state: FightState, options: { replay?: boolean } = {}): void {
    const events = state.events;
    for (const ev of events) {
      if (getOptions(this.registry).rumble && !options.replay) {
        this.rumbles.forEach((queue, i) => {
          const r = rumbleFor(ev, i as PlayerIndex);
          if (r) queue.request(r);
        });
      }
      this.markers.addFor(ev, state);
      // In a replay only the sounds and shakes come back, not the announcer banners.
      if (options.replay && (ev.type === "roundStart" || ev.type === "fight" || ev.type === "roundEnd" || ev.type === "matchEnd" || ev.type === "throwTech")) continue;
      switch (ev.type) {
        case "roundStart": {
          const tutorial = this.tutorial && !this.tutorial.finished;
          this.banner(tutorial ? "TUTORIAL" : this.setup.practice ? "PRACTICE" : `ROUND ${ev.round}`, 900);
          announce(this, tutorial ? "tutorial" : this.setup.practice ? "practice" : roundStartLine(ev.round, state.round.wins));
          this.camera.snap(state.fighters.map((f) => worldToScreen(f.position)));
          break;
        }
        case "fight":
          this.banner("FIGHT!", 700);
          announce(this, "fight");
          break;
        case "attackActive": this.play(ev.player, "attack", 0.6); break;
        case "hit": {
          const ko = events.some((e) => e.type === "ko" && e.player === ev.defender);
          if (!ev.blocked) this.cameraImpact(ko ? "ko" : "hit");
          const heavy = ATTACKS[ev.attack].limb !== "arm";
          playGameSound(this, ev.blocked ? "block" : "hit", heavy ? 0.9 : 0.7);
          if (!ev.blocked) this.play(ev.defender, "hurt");
          if (heavy && !ev.blocked) this.shake(90, 2);
          break;
        }
        case "parry": {
          playGameSound(this, "block", 1);
          if (!options.replay) {
            this.banner("PARRY!", 600);
            announce(this, "parry");
          }
          break;
        }
        case "grab": this.play(ev.attacker, "attack", 0.6); break;
        case "throw": {
          this.cameraImpact(events.some((e) => e.type === "ko") ? "ko" : "throw");
          playGameSound(this, "hit", 1);
          this.play(ev.defender, "hurt");
          this.shake(140, 4);
          break;
        }
        case "throwTech":
          this.banner("BREAK!", 500);
          announce(this, "throw-break");
          break;
        case "taunt": this.play(ev.player, "taunt", 0.9); break;
        // The callout and "Disrespectful!" come from CalloutTracker; then the snubber's own voice.
        case "snub": this.time.delayedCall(700, () => this.play(ev.player, "win", 0.9)); break;
        case "ko":
          if (!options.replay) this.banner("K.O.", 2000);
          break;
        case "landed": {
          // Hitting the floor after a knockdown (or a KO): dust, a thud, a jolt.
          playGameSound(this, "thud", 0.9);
          this.shake(120, 3);
          break;
        }
        case "roundEnd":
          if (ev.reason === "timeout") this.banner("TIME", 2000);
          announce(this, roundEndLine(ev.outcome, ev.reason));
          if (ev.outcome !== "draw") this.time.delayedCall(500, () => this.play(ev.outcome as PlayerIndex, "win"));
          break;
        default: break;
      }
    }
  }

  // --- rendering ----------------------------------------------------------------

  private renderState(state: FightState): void {
    const tweening = getOptions(this.registry).poseTweening;
    state.fighters.forEach((f, i) => this.views[i]?.render(f, state.frame, tweening, state.fighters[1 - i]));
    this.drawBattleDamage(state);
    this.stageEffects?.update(state.fighters.map((f, i) => ({ state: f, topEdge: () => this.views[i].topEdge() })));
    // The streaks stand in for the motion a hard cut skips; when the poses morph, the motion is shown.
    this.drawMotionLines(state.fighters, (i) => !(tweening && this.views[i]?.canTween));
    this.markers.render(state.frame);
    this.updateCamera(state);
    this.debug.render(state.fighters, this.geometry);
    this.drawHud(state);
    this.drawTutorial(state);
    if (performance.now() > this.bannerUntil) this.bannerText.setVisible(false);
  }

  /**
   * Each fighter's scars for the health they've lost this match: the rounds
   * already over (the stats' summaries, so a replay doesn't count its own round
   * twice) and this one so far.
   */
  private drawBattleDamage(state: FightState): void {
    const over = this.stats.result.rounds.filter((r) => r.round < state.round.roundNumber);
    state.fighters.forEach((f, i) => {
      const count = scarCount(damageInRounds(over, i as PlayerIndex) + MAX_HEALTH - f.health);
      const drawn = this.views[i]?.drawnSkeleton();
      if (drawn && count > 0) this.scars[i].render(scarsOn(drawn.landmarks, count), drawn.toScreen, this.time.now);
      else this.scars[i]?.hide();
    });
  }

  /** World position of a landmark of the given pose, placed where the fighter stands. */
  private landmarkWorld(geo: FighterGeometry, f: FighterState, poseId: PoseId, variant: number, index: number) {
    const anchor = groundAnchorFor(geo, poseId, variant);
    const l = frameGeometry(geo, poseId, variant).landmarks[index];
    return worldToScreen({ x: f.position.x + f.facing * (l.x - anchor.x), y: f.position.y + (l.y - anchor.y) });
  }

  /** 2–3 procedural streaks between the previous and current wrist/ankle positions on active frames, for fighters `shown` picks. */
  private drawMotionLines(fighters: readonly FighterState[], shown: (index: number) => boolean): void {
    this.motion.clear();
    fighters.forEach((f, i) => {
      if (!shown(i) || !isAttack(f.action) || currentAttackPhase(f) !== "active") return;
      const geo = this.geometry[i];
      const frame = frameOf(f);
      const side = frameGeometry(geo, frame.poseId, frame.variant).attackSide ?? "right";
      const limb = ATTACKS[f.action].limb;
      const index = LANDMARK[`${side}${limb === "arm" ? "Wrist" : limb === "leg" ? "Ankle" : "Shoulder"}`];
      const from = this.landmarkWorld(geo, f, "idle", 0, index);
      const to = this.landmarkWorld(geo, f, frame.poseId, frame.variant, index);
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      [-14, 0, 14].forEach((off, k) => {
        this.motion.lineStyle(k === 1 ? 5 : 3, 0xffffff, 0.75 - Math.abs(off) / 40);
        this.motion.lineBetween(from.x + nx * off + dx * 0.15, from.y + ny * off + dy * 0.15, to.x + nx * off * 0.4 - dx * 0.12, to.y + ny * off * 0.4 - dy * 0.12);
      });
    });
  }

  private drawHud(state: FightState): void {
    const g = this.hud.clear();
    state.fighters.forEach((f, i) => {
      // Trailing damage bar drains toward the real value.
      this.shownHealth[i] = Math.max(f.health, this.shownHealth[i] - 0.6);
      const x = i === 0 ? 40 : GAME_WIDTH - 40 - BAR_W;
      const y = 28;
      const w = (v: number) => (BAR_W * Math.max(0, v)) / MAX_HEALTH;
      // A pill: hard ink drop, dark track, fills (radius clamped to their width), ink outline on top.
      const pill = (px: number, pw: number) => { if (pw > 0) g.fillRoundedRect(px, y, pw, BAR_H, Math.min(PILL_R, pw / 2)); };
      g.fillStyle(HEX.ink, 1).fillRoundedRect(x, y + SHADOW.sm, BAR_W, BAR_H, PILL_R);
      g.fillStyle(HEX.healthEmpty, 1).fillRoundedRect(x, y, BAR_W, BAR_H, PILL_R);
      // P1 drains toward the center from the left, P2 from the right.
      const trail = w(this.shownHealth[i]);
      const now = w(f.health);
      g.fillStyle(HEX.fg, 1);
      pill(i === 0 ? x + BAR_W - trail : x, trail);
      g.fillStyle(f.health > LOW_HEALTH ? HEX.accent : HEX.bad, 1);
      pill(i === 0 ? x + BAR_W - now : x, now);
      // Low health: the bar pulses brighter and its frame glows.
      const pulse = lowHealthPulse(f.health, state.frame);
      if (pulse > 0) {
        g.fillStyle(HEX.healthGlow, 0.45 * pulse);
        pill(i === 0 ? x + BAR_W - now : x, now);
      }
      g.lineStyle(BORDER, HEX.ink, 1).strokeRoundedRect(x, y, BAR_W, BAR_H, PILL_R);
      if (pulse > 0) g.lineStyle(3, HEX.bad, 0.35 + 0.65 * pulse).strokeRoundedRect(x - 4, y - 4, BAR_W + 8, BAR_H + 8, PILL_R + 4);
      // Round wins (none in practice)
      for (let r = 0; r < (this.setup.practice ? 0 : 2); r++) {
        const cx = i === 0 ? x + BAR_W - 12 - r * 26 : x + 12 + r * 26;
        g.fillStyle(r < state.round.wins[i] ? HEX.accent : HEX.line, 1).fillCircle(cx, y + BAR_H + 52, 9);
        g.lineStyle(3, HEX.ink, 1).strokeCircle(cx, y + BAR_H + 52, 9);
      }
    });
    if (!this.setup.practice) {
      const cue = clockCue(state.round);
      // setColor redraws the text even when it's unchanged; only call it when the colour flips.
      const color = cue.red ? COLOR.bad : COLOR.accent;
      this.timerText.setText(String(secondsRemaining(state.round))).setScale(cue.scale);
      if (this.timerText.style.color !== color) this.timerText.setColor(color);
    }
  }
}
