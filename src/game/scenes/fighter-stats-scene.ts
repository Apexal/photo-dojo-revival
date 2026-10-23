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
const GOLD = 0xf2c14e;
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
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x121018, 1).setOrigin(0).setInteractive().on("pointerdown", () => this.close());
    if (!entry) return this.close();
    const archetype = ARCHETYPES[entry.fighter.archetype];

    this.add.text(GAME_WIDTH / 2, 34, entry.fighter.name.toUpperCase(), { fontSize: "52px", fontStyle: "bold", color: "#f2c14e", align: "center" }).setOrigin(0.5, 0);
    this.add.text(GAME_WIDTH / 2, 100, `${archetype.name}  ·  ${archetype.moveName}`, { fontSize: "20px", color: "#c9c3b8" }).setOrigin(0.5, 0);
    this.drawFighter(entry);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 44, "punch / kick / Esc: back", { fontSize: "17px", color: "#a8a196" }).setOrigin(0.5, 0);
    if (!record) {
      this.add.text(640, 340, "No matches yet.\nFinish a match and it starts counting.", { fontSize: "24px", color: "#c9c3b8", align: "center", lineSpacing: 8 }).setOrigin(0.5);
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
    this.add.ellipse(feet.x, feet.y + 4, 180, 20, 0x000000, 0.4);
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
      ["Best combo", String(r.longestCombo)],
      ["Favorite move", favorite ? MOVE_NAMES[favorite] : "–"],
    ];
    const rowH = 31;
    const g = this.add.graphics();
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      if (i % 2 === 0) g.fillStyle(0xffffff, 0.04).fillRect(x - 10, y - 3, 380, rowH);
      this.add.text(x, y + 2, label, { fontSize: "17px", color: "#a8a196" });
      this.add.text(x + 360, y, value, { fontSize: "21px", fontStyle: i === 0 ? "bold" : "normal", color: i === 0 ? "#f2c14e" : "#f3efe6" }).setOrigin(1, 0);
    });
  }

  /** Clean hits by move: one bar each, in one colour, longest = most landed. Returns the bottom edge. */
  private drawMoves(r: FighterRecord, moves: AttackId[], x: number, top: number): number {
    this.add.text(x, top, "Clean hits by move", { fontSize: "19px", fontStyle: "bold", color: "#f3efe6" });
    const max = Math.max(1, ...moves.map((m) => r.movesLanded[m] ?? 0));
    const favorite = favoriteMoveOf(r);
    const g = this.add.graphics();
    const rowH = 32;
    moves.forEach((move, i) => {
      const y = top + 38 + i * rowH;
      const n = r.movesLanded[move] ?? 0;
      this.add.text(x, y + 2, MOVE_NAMES[move], { fontSize: "16px", color: move === favorite ? "#f3efe6" : "#a8a196", fontStyle: move === favorite ? "bold" : "normal" });
      const barX = x + 160;
      // A faint track, then the bar from the baseline with a rounded data end.
      g.fillStyle(0xffffff, 0.05).fillRect(barX, y + 4, BAR_W, 16);
      const w = Math.round((n / max) * BAR_W);
      if (w > 0) g.fillStyle(GOLD, move === favorite ? 1 : 0.6).fillRoundedRect(barX, y + 4, w, 16, { tl: 0, bl: 0, tr: Math.min(4, w), br: Math.min(4, w) });
      this.add.text(barX + w + 8, y + 1, String(n), { fontSize: "16px", color: "#f3efe6" });
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
    this.add.text(x, top, "Rivals", { fontSize: "19px", fontStyle: "bold", color: "#f3efe6" });
    if (!rivals.length) {
      this.add.text(x, top + 36, "Only mirror matches so far", { fontSize: "16px", color: "#a8a196" });
      return;
    }
    rivals.forEach(([id, tally], i) => {
      const y = top + 36 + i * 30;
      const name = names.get(id)!;
      this.add.text(x, y, `vs ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`, { fontSize: "16px", color: "#c9c3b8" });
      this.add.text(x + 340, y, winLoss(tally), { fontSize: "16px", color: "#f3efe6" }).setOrigin(1, 0);
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
