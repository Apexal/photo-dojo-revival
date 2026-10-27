import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import { playGameSound } from "../game-sounds";
import { announce } from "../announcer";
import { stageLine } from "../announcer-lines";
import { createInputSource, isPlayerInput } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";

import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, HEX, popBox, RADIUS, SHADOW } from "../render/theme";
import { STAGES, randomStage, stageFor } from "../stages/stages";
import { playStageMusic, preloadStage, stopStageMusic } from "../stages/stage-music";
import { REGISTRY } from "./boot-scene";
import { menuSceneFor, type FightSceneData } from "./fight-scene";
import { stopMenuMusic } from "../menu-music";

/** The last option on the stage select screen. */
const RANDOM = "random";
const OVERLAY_DEPTH = 50;

/**
 * After fighter select: pick a stage if there's a choice, then the versus
 * intro and the controls screen (or straight into practice).
 */
export function startMatch(scene: Phaser.Scene, data: FightSceneData): void {
  if (STAGES.length > 1) scene.scene.start("stage-select", data);
  else startWithStage(scene, { ...data, stageId: STAGES[0].id });
}

function startWithStage(scene: Phaser.Scene, data: FightSceneData): void {
  scene.scene.start(data.practice ? "fight" : "versus", data);
}

/**
 * Stage select: the highlighted stage fills the screen behind its name.
 * Either player moves (left / right) and confirms (punch); kick goes back to
 * fighter select (or the series: the bracket, the hill). Starts on the last stage picked this session.
 */
export class StageSelectScene extends Phaser.Scene {
  private setup!: FightSceneData;
  private options: string[] = [];
  private index = 0;
  private layer!: Phaser.GameObjects.Container;
  private nameText!: Phaser.GameObjects.Text;
  private creditText!: Phaser.GameObjects.Text;
  private dots!: Phaser.GameObjects.Graphics;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private leaving = false;
  /** The highlighted stage's soundtrack, as a preview. */
  private music: Phaser.Sound.BaseSound | null = null;

  constructor() {
    super("stage-select");
  }

  init(data: FightSceneData): void {
    this.setup = data;
    this.leaving = false;
  }

  preload(): void {
    for (const stage of STAGES) preloadStage(this, stage);
  }

  create(): void {
    stopMenuMusic(this, 400); // each stage previews its own
    announce(this, "choose-stage");
    this.options = [...STAGES.map((s) => s.id), RANDOM];
    this.index = Math.max(0, this.options.indexOf(this.registry.get(REGISTRY.lastStage)));
    this.layer = this.add.container(0, 0).setDepth(0);

    const cx = GAME_WIDTH / 2;
    this.add.graphics().setDepth(OVERLAY_DEPTH - 1)
      .fillGradientStyle(HEX.ink, HEX.ink, HEX.ink, HEX.ink, 0.8, 0.8, 0, 0).fillRect(0, 0, GAME_WIDTH, 160)
      .fillStyle(HEX.ink, 0.75).fillRect(0, GAME_HEIGHT - 170, GAME_WIDTH, 170);
    this.add.text(cx, 56, "CHOOSE A STAGE", displayText(52, COLOR.accent))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH);
    const [a, b] = this.setup.entries.map((e) => e.fighter.name);
    this.add.text(cx, 104, this.setup.tutorial ? `${a} · tutorial` : this.setup.practice ? `${a} · practice` : `${a}  vs  ${b}`, bodyText(20, COLOR.fg, 800, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH);

    this.nameText = this.add.text(cx, GAME_HEIGHT - 116, "", displayText(52, COLOR.fg))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH).setInteractive({ useHandCursor: true });
    this.nameText.on("pointerdown", () => this.confirm());
    [-1, 1].forEach((dir) => {
      const arrow = this.add.text(cx + dir * 330, GAME_HEIGHT - 116, dir < 0 ? "◀" : "▶", displayText(40, COLOR.accent, { padding: { x: 12, y: 4 } }))
        .setOrigin(0.5).setDepth(OVERLAY_DEPTH).setInteractive({ useHandCursor: true });
      arrow.on("pointerdown", () => this.move(dir));
    });
    this.creditText = this.add.text(cx, GAME_HEIGHT - 158, "", bodyText(15, COLOR.muted, 600, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH);
    this.dots = this.add.graphics().setDepth(OVERLAY_DEPTH);
    this.add.text(cx, GAME_HEIGHT - 34, "◀ ▶ choose     punch: fight!     kick: back", bodyText(18, COLOR.muted, 600, { stroke: COLOR.ink, strokeThickness: 4 }))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH);

    // Practice has one player; the dummy isn't an input device.
    this.sources = this.setup.inputs.filter(isPlayerInput).map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      stopStageMusic(this, this.music);
      this.music = null;
    });
    this.show();
  }

  update(): void {
    if (this.leaving) return;
    this.sources.forEach((source, i) => {
      const now = source.read();
      const before = this.previous[i];
      this.previous[i] = now;
      source.pausePressed();
      const pressed = (k: keyof InputFrame) => now[k] && !before[k];
      if (this.leaving) return;
      if (pressed("left")) this.move(-1);
      else if (pressed("right")) this.move(1);
      else if (pressed("punch")) this.confirm();
      else if (pressed("kick")) this.back();
    });
  }

  private move(dir: number): void {
    this.index = (this.index + dir + this.options.length) % this.options.length;
    playGameSound(this, "tick", 0.3);
    this.show();
  }

  private show(): void {
    this.tweens.killTweensOf(this.layer.list); // the old stage's twinkles and such
    this.layer.removeAll(true);
    stopStageMusic(this, this.music, 250);
    this.music = null;
    const id = this.options[this.index];
    if (id === RANDOM) {
      // No stage to show: the menu ground and a framed "?" card.
      const card = 300, cy = GAME_HEIGHT / 2 - 40;
      this.layer.add([
        drawBackdrop(this),
        popBox(this, GAME_WIDTH / 2 - card / 2, cy - card / 2, card, card, { fill: HEX.panel, border: HEX.accent, borderWidth: 5, radius: RADIUS.lg, shadow: SHADOW.lg }),
        this.add.text(GAME_WIDTH / 2, cy, "?", displayText(200, COLOR.faint, { outline: false })).setOrigin(0.5),
      ]);
      this.nameText.setText("Random");
      this.creditText.setText("");
    } else {
      const stage = stageFor(id);
      stage.build(this, this.layer);
      this.nameText.setText(stage.music ? `${stage.name}  ♪` : stage.name);
      this.creditText.setText(stage.music?.credit ? `♪ ${stage.music.credit}` : "");
      this.music = playStageMusic(this, stage, 400);
    }
    // One dot per option, the current one filled.
    const gap = 22, x0 = GAME_WIDTH / 2 - ((this.options.length - 1) * gap) / 2;
    this.dots.clear();
    this.options.forEach((_, i) => {
      const x = x0 + i * gap, y = GAME_HEIGHT - 70;
      if (i === this.index) this.dots.fillStyle(HEX.accent, 1).fillCircle(x, y, 7).lineStyle(3, HEX.ink, 1).strokeCircle(x, y, 7);
      else this.dots.lineStyle(2, HEX.muted, 0.8).strokeCircle(x, y, 5);
    });
  }

  private confirm(): void {
    if (this.leaving) return;
    this.leaving = true;
    const choice = this.options[this.index];
    this.registry.set(REGISTRY.lastStage, choice);
    playGameSound(this, "hit", 0.6);
    const stageId = choice === RANDOM ? randomStage().id : choice;
    const line = stageLine(stageId);
    if (line) announce(this, line);
    startWithStage(this, { ...this.setup, stageId });
  }

  private back(): void {
    this.leaving = true;
    playGameSound(this, "block", 0.4);
    this.scene.start(menuSceneFor(this.setup));
  }

}
