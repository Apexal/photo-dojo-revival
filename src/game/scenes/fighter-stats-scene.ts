import Phaser from "phaser";
import { ARCHETYPES } from "../../shared/archetypes";
import { SPRITE_CANVAS_SIZE } from "../../shared/fighter-model";
import { groundAnchorFor, isAttackId, type AttackId } from "../../shared/frame-data";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { favoriteMoveOf, recordOf, winLoss, type FighterRecord } from "../fighter-records";
import { MenuInput } from "../input/menu-input";
import { MOVE_NAMES } from "../move-names";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { REGISTRY } from "./boot-scene";
import { bodyText, COLOR, displayText, drawBackdrop, HEX, popBox, RADIUS, SHADOW } from "../render/theme";

export interface FighterStatsSceneData {
  fighterId: string;
  /** A loaded texture of the fighter (their win pose), drawn large; null: none yet. */
  texture: string | null;
  /** Scene to resume on close (it was paused while this is open). */
  returnTo: string;
}

/** Every fighter's attacks: the shared core, plus the archetype's if its move is an attack. */
const CORE_MOVES: AttackId[] = ["punch", "kick", "uppercut", "lowKick", "jumpKick"];
const BAR_W = 140;
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

/**
 * One fighter's career (fighter-records.ts): their win pose large, their
 * numbers over every match, clean hits by move, and their rivals. Opened over
 * fighter select; any button closes it.
 */
export class FighterStatsScene extends Phaser.Scene {
  private setup!: FighterStatsSceneData;
  private menuInput!: MenuInput;

  constructor() {
    super("fighter-stats");
  }

  init(data: FighterStatsSceneData): void {
    this.setup = data;
  }

  create(): void {
    this.menuInput = new MenuInput(this);
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    const entry = library.find((e) => e.fighter.fighterId === this.setup.fighterId);
    const record = recordOf(this.registry, this.setup.fighterId);
    drawBackdrop(this);
    // An invisible full-screen hit area: a click anywhere closes.
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.001).setOrigin(0).setInteractive().on("pointerdown", () => this.close());
    if (!entry) return this.close();
    const archetype = ARCHETYPES[entry.fighter.archetype];

    this.add.text(GAME_WIDTH / 2, 34, entry.fighter.name.toUpperCase(), displayText(56, COLOR.accent, { align: "center" })).setOrigin(0.5, 0);
    this.add.text(GAME_WIDTH / 2, 100, `${archetype.name}  ·  ${archetype.moveName}`, bodyText(20, COLOR.muted, 600)).setOrigin(0.5, 0);
    this.drawFighter(entry);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 44, "punch / kick / Esc: back", bodyText(17, COLOR.muted, 600)).setOrigin(0.5, 0);
    if (!record) {
      this.add.text(640, 340, "No matches yet.\nFinish a match and it starts counting.", bodyText(24, COLOR.muted, 500, { align: "center", lineSpacing: 8 })).setOrigin(0.5);
      return;
    }
    this.drawTable(record, 450, 160);
    const moves = isAttackId(archetype.move) ? [...CORE_MOVES, archetype.move] : CORE_MOVES;
    const bottom = this.drawMoves(record, moves, 880, 160);
    this.drawRivals(record, library, 880, bottom + 34);
  }

  /** The win pose, standing in the left column. */
  private drawFighter(entry: LibraryEntry): void {
    const key = this.setup.texture;
    const feet = { x: 230, y: 610 };
    this.add.ellipse(feet.x, feet.y + 4, 180, 20, HEX.ink, 0.5);
    if (!key || !this.textures.exists(key)) return;
    const anchor = groundAnchorFor(geometryOf(entry.fighter), "win");
    this.add.image(feet.x, feet.y, key).setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE).setScale(440 / SPRITE_CANVAS_SIZE);
  }

  /** Label | value rows. */
  private drawTable(r: FighterRecord, x: number, top: number): void {
    const favorite = favoriteMoveOf(r);
    const rows: [string, string][] = [
      ["Record", winLoss(r)],
      ["Matches", String(r.matches)],
      ["Win rate", percent(r.wins, r.matches)],
      ["Rounds won", String(r.roundsWon)],
      ["Perfect rounds", String(r.perfectRounds)],
      ["Damage dealt", String(r.damageDealt)],
      ["Damage per match", r.matches ? String(Math.round(r.damageDealt / r.matches)) : "–"],
      ["Accuracy", percent(r.hits, r.attacks)],
      ["Clean hits", String(r.hits)],
      ["Attacks blocked", String(r.blocks)],
      ["Throws", String(r.throws)],
      ["Knockdowns", String(r.knockdowns)],
      ["Best hit streak", String(r.longestStreak)],
      ["Favorite move", favorite ? MOVE_NAMES[favorite] : "–"],
      ...(r.snubs ? [["Handshakes refused", String(r.snubs)] as [string, string]] : []),
    ];
    const rowH = 31;
    popBox(this, x - 22, top - 16, 404, rows.length * rowH + 26, { fill: HEX.panel, radius: RADIUS.lg, shadow: SHADOW.lg }).setDepth(-2);
    const g = this.add.graphics();
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      if (i % 2 === 0) g.fillStyle(HEX.tile, 0.6).fillRect(x - 10, y - 3, 380, rowH);
      this.add.text(x, y + 3, label, bodyText(17, COLOR.muted, 600));
      this.add.text(x + 360, y, value, displayText(22, i === 0 ? COLOR.accent : COLOR.fg, { outline: false })).setOrigin(1, 0);
    });
  }

  /** Clean hits by move: one bar each, in one colour, longest = most landed. Returns the bottom edge. */
  private drawMoves(r: FighterRecord, moves: AttackId[], x: number, top: number): number {
    this.add.text(x, top - 4, "Clean hits by move", displayText(26, COLOR.fg));
    const max = Math.max(1, ...moves.map((m) => r.movesLanded[m] ?? 0));
    const favorite = favoriteMoveOf(r);
    const g = this.add.graphics();
    const rowH = 32;
    moves.forEach((move, i) => {
      const y = top + 38 + i * rowH;
      const n = r.movesLanded[move] ?? 0;
      this.add.text(x, y + 2, MOVE_NAMES[move], move === favorite ? bodyText(16, COLOR.fg, 800) : bodyText(16, COLOR.muted, 600));
      const barX = x + 160;
      // A faint track, then the bar from the baseline with a rounded data end.
      g.fillStyle(HEX.well, 1).fillRoundedRect(barX, y + 4, BAR_W, 16, 4);
      const w = Math.round((n / max) * BAR_W);
      if (w > 0) g.fillStyle(HEX.accent, move === favorite ? 1 : 0.6).fillRoundedRect(barX, y + 4, w, 16, { tl: 0, bl: 0, tr: Math.min(4, w), br: Math.min(4, w) });
      this.add.text(barX + w + 8, y + 1, String(n), displayText(18, COLOR.fg, { outline: false }));
    });
    return top + 38 + moves.length * rowH;
  }

  /** Who they've fought most, and how it's gone. */
  private drawRivals(r: FighterRecord, library: LibraryEntry[], x: number, top: number): void {
    const names = new Map(library.map((e) => [e.fighter.fighterId, e.fighter.name]));
    const rivals = Object.entries(r.versus)
      .filter(([id]) => names.has(id))
      .sort(([, a], [, b]) => b.wins + b.losses + b.draws - (a.wins + a.losses + a.draws))
      .slice(0, 4);
    this.add.text(x, top - 4, "Rivals", displayText(26, COLOR.fg));
    if (!rivals.length) {
      this.add.text(x, top + 36, "Only mirror matches so far", bodyText(16, COLOR.muted, 600));
      return;
    }
    rivals.forEach(([id, tally], i) => {
      const y = top + 36 + i * 30;
      const name = names.get(id)!;
      this.add.text(x, y, `vs ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`, bodyText(16, COLOR.muted, 600));
      this.add.text(x + 340, y, winLoss(tally), displayText(18, COLOR.fg, { outline: false })).setOrigin(1, 0);
    });
  }

  private close(): void {
    this.scene.stop();
    this.scene.resume(this.setup.returnTo);
  }

  update(): void {
    const actions = this.menuInput.poll();
    if (actions.has("confirm") || actions.has("back") || actions.has("pause")) this.close();
  }
}
