import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import { accuracy, type PlayerStats, type RoundSummary } from "../../simulation/match-stats";
import { FRAMES_PER_SECOND, MAX_HEALTH, nextRoundStakes, ROUNDS_TO_WIN, type PlayerIndex } from "../../simulation/round-rules";
import { createInputSource, isPlayerInput, type InputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { moveName } from "../move-names";
import { LOW_HEALTH } from "../render/hud-cues";
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from "../render/stage";
import type { FightScene } from "./fight-scene";
import { bodyText, BORDER, COLOR, displayText, HEX, popBox, RADIUS, SHADOW, stamp } from "../render/theme";

export interface RoundResultData {
  /** The round just played (match-stats.ts): who won it, how, and each player's numbers. */
  summary: RoundSummary;
  /** Rounds won so far, this one included. */
  wins: [number, number];
  names: [string, string];
  inputs: [InputDescriptor, InputDescriptor];
}

const INPUT_DELAY_MS = 700;
/** Long enough to read the numbers; the bar under "Punch to continue" shows it running out. */
const AUTO_CONTINUE_MS = 9000;
const PLAYER_CSS = [COLOR.bad, COLOR.p2];

const clock = (frames: number) => {
  const seconds = Math.round(frames / FRAMES_PER_SECOND);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** One row of the round's numbers; the better of each pair in gold. */
interface Row { label: string; value: (s: PlayerStats) => number; show?: (v: number, s: PlayerStats) => string }

const ROWS: Row[] = [
  { label: "Damage dealt", value: (s) => s.damageDealt },
  { label: "Clean hits", value: (s) => s.hits },
  { label: "Accuracy", value: (s) => accuracy(s), show: (v, s) => (s.attacks ? `${Math.round(v * 100)}%` : "–") },
  { label: "Longest hit streak", value: (s) => s.longestStreak },
  { label: "Attacks blocked", value: (s) => s.blocks },
  { label: "Throws", value: (s) => s.throws },
];

/**
 * Round result over the paused fight: how the round ended (K.O., time, perfect,
 * the finishing move), the score in round pips, each fighter's health left and
 * numbers for the round, and what's at stake next. Punch or kick (or a click)
 * continues, or it does by itself. (The match's end: match-result-scene.ts.)
 */
export class RoundResultScene extends Phaser.Scene {
  private result!: RoundResultData;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private openedAt = 0;
  private leaving = false;
  private timer!: Phaser.GameObjects.Graphics;

  constructor() {
    super("round-result");
  }

  init(data: RoundResultData): void {
    this.result = data;
    this.leaving = false;
  }

  create(): void {
    this.openedAt = performance.now();
    this.sources = this.result.inputs.filter(isPlayerInput).map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());
    const cx = GAME_WIDTH / 2;

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, HEX.ink, 0.82).setOrigin(0).setInteractive().on("pointerdown", () => this.continue());
    this.drawHeadline(cx);
    this.drawPanel(cx, 296);
    this.drawStakes(cx, 638);
    this.add.text(cx, 682, "Punch to continue", bodyText(22, COLOR.muted, 800, { stroke: COLOR.ink, strokeThickness: 5 })).setOrigin(0.5);
    this.timer = this.add.graphics();
  }

  /** ROUND n, then K.O. / TIME / PERFECT, who takes it, and how. */
  private drawHeadline(cx: number): void {
    const { summary: s, names } = this.result;
    const winner = s.outcome === "draw" ? null : s.outcome;
    const perfect = winner !== null && s.health[winner] === MAX_HEALTH;
    const shout = s.outcome === "draw"
      ? (s.reason === "ko" ? "DOUBLE K.O." : "TIME!")
      : perfect ? (s.reason === "ko" ? "PERFECT K.O.!" : "PERFECT!") : s.reason === "ko" ? "K.O.!" : "TIME!";

    stamp(this, cx, 58, `Round ${s.round}`, HEX.accent, 22);
    const big = this.add.text(cx, 140, shout, displayText(88, COLOR.accent)).setOrigin(0.5);
    this.tweens.add({ targets: big, scale: { from: 1.6, to: 1 }, alpha: { from: 0, to: 1 }, duration: 260, ease: "Back.easeOut" });

    const who = winner === null ? `Round ${s.round} is a draw` : `${names[winner]} takes the round`;
    const sub = this.add.text(cx, 220, who.toUpperCase(), displayText(36, winner === null ? COLOR.fg : PLAYER_CSS[winner], { align: "center" })).setOrigin(0.5);
    fit(sub, GAME_WIDTH - 160);

    const details: string[] = [];
    if (s.finisher) details.push(`Finished with ${article(moveName(s.finisher))}`);
    else if (s.reason === "timeout") details.push(winner === null ? "Even on health" : `Won on health, ${s.health[winner]} to ${s.health[winner === 0 ? 1 : 0]}`);
    if (s.firstBlood !== null) details.push(`First blood: ${names[s.firstBlood]}`);
    details.push(`Round time ${clock(s.frames)}`);
    const line = this.add.text(cx, 262, details.join("   ·   "), bodyText(20, COLOR.muted, 600)).setOrigin(0.5);
    fit(line, GAME_WIDTH - 160);
  }

  /** Names, round pips and health left on top; the round's numbers side by side below. */
  private drawPanel(cx: number, top: number): void {
    const { summary: s, names, wins } = this.result;
    const w = 640;
    const rowH = 27;
    const rowsTop = top + 132;
    const h = rowsTop - top + ROWS.length * rowH + 14;
    const colX = (i: number) => cx + (i === 0 ? -170 : 170);
    popBox(this, cx - w / 2, top, w, h, { fill: HEX.panel, radius: RADIUS.lg, shadow: SHADOW.lg });

    const g = this.add.graphics();
    ([0, 1] as const).forEach((i) => {
      // A strip in the player's colour over their name.
      g.fillStyle(PLAYER_COLORS[i], 1).fillRoundedRect(colX(i) - 40, top + 12, 80, 6, 3);
      fit(this.add.text(colX(i), top + 24, names[i], displayText(26, PLAYER_CSS[i])).setOrigin(0.5, 0), 270);
      this.drawPips(colX(i), top + 78, i, wins[i], s.outcome === i);
      this.drawHealth(colX(i), top + 104, s.health[i], i);
    });
    this.add.text(cx, top + 78, "Rounds", bodyText(16, COLOR.muted, 600)).setOrigin(0.5);
    this.add.text(cx, top + 111, "Health left", bodyText(16, COLOR.muted, 600)).setOrigin(0.5);

    ROWS.forEach((row, r) => {
      const y = rowsTop + r * rowH;
      if (r % 2 === 0) g.fillStyle(HEX.tile, 0.6).fillRect(cx - w / 2 + 10, y - 3, w - 20, rowH);
      const values = s.players.map(row.value);
      const best = values[0] === values[1] ? -1 : values[0] > values[1] ? 0 : 1;
      s.players.forEach((p, i) => {
        const text = row.show ? row.show(values[i], p) : String(values[i]);
        this.add.text(colX(i), y, text, displayText(22, best === i ? COLOR.accent : COLOR.fg, { outline: false })).setOrigin(0.5, 0);
      });
      this.add.text(cx, y + 3, row.label, bodyText(16, COLOR.muted, 600)).setOrigin(0.5, 0);
    });
  }

  /** ROUNDS_TO_WIN pips, gold for each round won; the one just won pops in. */
  private drawPips(x: number, y: number, player: PlayerIndex, won: number, justWon: boolean): void {
    const gap = 30;
    for (let r = 0; r < ROUNDS_TO_WIN; r++) {
      // P1's pips fill from the centre outward like the fight HUD; P2's mirror them.
      const px = x + (player === 0 ? 1 : -1) * ((ROUNDS_TO_WIN - 1) / 2 - r) * gap;
      const pip = this.add.graphics({ x: px, y });
      pip.fillStyle(HEX.ink, 1).fillCircle(0, SHADOW.sm, 10);
      pip.fillStyle(r < won ? HEX.accent : HEX.line, 1).fillCircle(0, 0, 10);
      pip.lineStyle(3, HEX.ink, 1).strokeCircle(0, 0, 10);
      if (justWon && r === won - 1) this.tweens.add({ targets: pip, scale: { from: 0, to: 1 }, delay: 300, duration: 380, ease: "Back.easeOut" });
    }
  }

  /** A small health bar that fills to what was left, with the number on its outer side. */
  private drawHealth(x: number, y: number, health: number, player: PlayerIndex): void {
    const barW = 180;
    const barH = 14;
    const left = x - barW / 2 + (player === 0 ? 16 : -16);
    const track = this.add.graphics();
    track.fillStyle(HEX.ink, 1).fillRoundedRect(left, y + SHADOW.sm, barW, barH, barH / 2);
    track.fillStyle(HEX.healthEmpty, 1).fillRoundedRect(left, y, barW, barH, barH / 2);
    const fill = this.add.graphics();
    const outline = this.add.graphics().lineStyle(BORDER, HEX.ink, 1).strokeRoundedRect(left, y, barW, barH, barH / 2);
    const label = player === 0
      ? this.add.text(left - 12, y + barH / 2, "0", displayText(20, COLOR.fg, { outline: false })).setOrigin(1, 0.5)
      : this.add.text(left + barW + 12, y + barH / 2, "0", displayText(20, COLOR.fg, { outline: false })).setOrigin(0, 0.5);
    const color = health > LOW_HEALTH ? HEX.accent : HEX.bad;
    const shown = { v: 0 };
    const draw = () => {
      const fw = (barW * Math.max(0, shown.v)) / MAX_HEALTH;
      fill.clear();
      // P1's bar drains toward the centre from the left like the HUD, so it fills from the right.
      if (fw > 0) fill.fillStyle(color, 1).fillRoundedRect(player === 0 ? left + barW - fw : left, y, fw, barH, Math.min(barH / 2, fw / 2));
      label.setText(String(Math.round(shown.v)));
    };
    draw();
    outline.setDepth(1);
    this.tweens.add({ targets: shown, v: Math.max(0, health), delay: 200, duration: 600, ease: "Cubic.easeOut", onUpdate: draw });
  }

  /** FINAL ROUND / MATCH POINT / Round n next. */
  private drawStakes(cx: number, y: number): void {
    const { summary: s, wins, names } = this.result;
    const stakes = nextRoundStakes(s.round, wins);
    if (stakes.kind === "next") {
      this.add.text(cx, y, `Round ${stakes.round} next`, displayText(28, COLOR.fg)).setOrigin(0.5);
      return;
    }
    const label = stakes.kind === "final" ? "Final round next" : `Match point: ${names[stakes.player]}`;
    const tag = stamp(this, cx, y, label, stakes.kind === "final" ? HEX.party : PLAYER_COLORS[stakes.player], 24);
    // Tilted, a long stamp's ends would reach the panel and the help line.
    const width = tag.getBounds().width;
    if (width > 460) tag.setScale(460 / width);
  }

  private get fight(): FightScene {
    return this.scene.get("fight") as FightScene;
  }

  private continue(): void {
    if (this.leaving || performance.now() - this.openedAt <= INPUT_DELAY_MS) return;
    this.leaving = true;
    this.scene.stop();
    this.fight.nextRound();
  }

  update(): void {
    const elapsed = performance.now() - this.openedAt;
    const now = this.sources.map((s) => s.read());
    const before = this.previous;
    this.previous = now;
    const pressed = (k: keyof InputFrame) => now.some((f, i) => f[k] && !before[i][k]);

    // What's left of the wait before it goes on by itself.
    const left = Math.max(0, 1 - elapsed / AUTO_CONTINUE_MS);
    const barW = 220;
    this.timer.clear().fillStyle(HEX.line, 1).fillRoundedRect(GAME_WIDTH / 2 - barW / 2, 704, barW, 5, 2.5);
    this.timer.fillStyle(HEX.accent, 1).fillRoundedRect(GAME_WIDTH / 2 - barW / 2, 704, barW * left, 5, 2.5);

    if (pressed("punch") || pressed("kick")) this.continue();
    else if (elapsed > AUTO_CONTINUE_MS) this.continue();
  }
}

/** Shrinks a text to fit a width (names can be long). */
function fit(text: Phaser.GameObjects.Text, width: number): Phaser.GameObjects.Text {
  if (text.width > width) text.setScale(width / text.width);
  return text;
}

/** "an Uppercut", "a Throw". */
const article = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
