import Phaser from "phaser";
import { groundAnchorFor } from "../../shared/frame-data";
import { SPRITE_CANVAS_SIZE, type PoseId } from "../../shared/fighter-model";
import type { InputFrame } from "../../simulation/input-frame";
import { accuracy, type MatchStats, type PlayerStats } from "../../simulation/match-stats";
import { FRAMES_PER_SECOND, type RoundOutcome } from "../../simulation/round-rules";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { recordOf, winLoss } from "../fighter-records";
import { MOVE_NAMES } from "../move-names";
import { createInputSource, isPlayerInput, type InputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { textureKey } from "../render/fighter-sprite-view";
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from "../render/stage";
import { MIRROR_TINT } from "./controls-scene";
import { REGISTRY } from "./boot-scene";
import type { FightScene } from "./fight-scene";
import { announce } from "../announcer";
import { matchWinnerLine } from "../announcer-lines";
import { SERIES_INFO, recordSeriesResult, type SeriesKind, type SeriesSession } from "../series";

export interface MatchResultData {
  stats: MatchStats;
  winner: RoundOutcome;
  entries: [LibraryEntry, LibraryEntry];
  inputs: [InputDescriptor, InputDescriptor];
  /** The fight scene's texture prefixes for each fighter's poses. */
  prefixes: readonly [string, string];
  /** A series match (tournament, king of the hill): the result goes on to it (a draw is played again). */
  series?: SeriesKind;
}

/** Long enough that mashing through the KO doesn't skip the page. */
const INPUT_DELAY_MS = 1200;
const PLAYER_CSS = ["#e8483b", "#3f86f0"];

const clock = (frames: number) => {
  const seconds = Math.round(frames / FRAMES_PER_SECOND);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** One table row: a label, how to show a player's value, and whether more is better (null: no highlight). */
interface Row { label: string; value: (s: PlayerStats) => number; show?: (v: number, s: PlayerStats) => string; higherWins?: boolean | null }

const ROWS: Row[] = [
  { label: "Rounds won", value: (s) => s.roundsWon },
  { label: "Damage dealt", value: (s) => s.damageDealt },
  { label: "Clean hits", value: (s) => s.hits },
  { label: "Accuracy", value: (s) => accuracy(s), show: (v, s) => (s.attacks ? `${Math.round(v * 100)}%` : "–") },
  { label: "Longest hit streak", value: (s) => s.longestStreak },
  { label: "Attacks blocked", value: (s) => s.blocks },
  { label: "Throws", value: (s) => s.throws },
  { label: "Throws broken", value: (s) => s.throwTechs },
  { label: "Knockdowns", value: (s) => s.knockdowns },
  { label: "Perfect rounds", value: (s) => s.perfectRounds },
  { label: "Taunts", value: (s) => s.taunts, higherWins: null },
];

/**
 * End of a match: who won and how. Each fighter large (the winner in their
 * victory pose), a side-by-side stats table with the better number of each row
 * picked out, and how each round went. Punch (or the button) for a rematch,
 * kick for fighter select. In a series, either goes on to the bracket / the
 * hill instead (or replays a draw). Runs over the stopped fight.
 */
export class MatchResultScene extends Phaser.Scene {
  private result!: MatchResultData;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private openedAt = 0;
  private leaving = false;

  constructor() {
    super("match-result");
  }

  init(data: MatchResultData): void {
    this.result = data;
    this.leaving = false;
  }

  create(): void {
    this.openedAt = performance.now();
    this.sources = this.result.inputs.filter(isPlayerInput).map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());
    const { stats, winner, entries } = this.result;
    const names = entries.map((e) => e.fighter.name);
    const cx = GAME_WIDTH / 2;

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x121018, 0.98).setOrigin(0);
    const title = winner === "draw" ? "DRAW GAME" : `${names[winner]} WINS!`;
    const cpu = this.result.inputs.findIndex((d) => d.kind === "cpu");
    announce(this, matchWinnerLine(winner, cpu < 0 ? null : (cpu as 0 | 1)));
    this.add.text(cx, 52, title.toUpperCase(), {
      fontSize: "60px", fontStyle: "bold", color: "#f2c14e", stroke: "#121018", strokeThickness: 8, align: "center", wordWrap: { width: 760 },
    }).setOrigin(0.5);
    const [w0, w1] = [stats.players[0].roundsWon, stats.players[1].roundsWon];
    const lastRound = stats.rounds[stats.rounds.length - 1];
    const how = lastRound ? (lastRound.reason === "ko" ? "by K.O." : "on time") : "";
    this.add.text(cx, 106, `${w0} – ${w1}  ·  ${how}  ·  match time ${clock(stats.frames)}`, { fontSize: "20px", color: "#c9c3b8" }).setOrigin(0.5);

    [0, 1].forEach((i) => this.drawFighter(i as 0 | 1));
    this.drawTable(cx, 150);
    this.drawRounds(cx, 572);
    this.drawActions(cx, 640);
  }

  /** The fighter, large, on their side: winner in their win pose, loser hurt, both standing on a draw. */
  private drawFighter(i: 0 | 1): void {
    const { winner, entries, prefixes } = this.result;
    const pose: PoseId = winner === "draw" ? "idle" : winner === i ? "win" : "hurt";
    const x = i === 0 ? 180 : GAME_WIDTH - 180;
    const feetY = 470;
    const key = textureKey(prefixes[i], pose);
    if (this.textures.exists(key)) {
      const anchor = groundAnchorFor(geometryOf(entries[i].fighter), pose);
      const sprite = this.add.image(x, feetY, key).setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE)
        .setScale(0.62).setFlipX(i === 1);
      if (i === 1 && entries[0].fighter.fighterId === entries[1].fighter.fighterId) sprite.setTint(MIRROR_TINT);
      if (winner !== "draw" && winner !== i) sprite.setAlpha(0.75);
    }
    this.add.ellipse(x, feetY + 4, 160, 18, 0x000000, 0.4).setDepth(-1);
    if (winner === i) {
      this.add.text(x, feetY + 22, "WINNER", { fontSize: "16px", fontStyle: "bold", color: "#121018", backgroundColor: "#f2c14e", padding: { x: 10, y: 3 } }).setOrigin(0.5, 0);
    }
    const name = this.add.text(x, feetY + 54, entries[i].fighter.name, { fontSize: "26px", fontStyle: "bold", color: PLAYER_CSS[i], align: "center", wordWrap: { width: 320 } })
      .setOrigin(0.5, 0);
    // Their career so far, this match included (the fight scene records it before opening this page).
    const record = recordOf(this.registry, entries[i].fighter.fighterId);
    if (record) {
      this.add.text(x, name.y + name.height + 2, `Career ${winLoss(record)}`, { fontSize: "16px", color: "#a8a196" }).setOrigin(0.5, 0);
    }
  }

  /** P1's numbers | label | P2's numbers; the better of each pair in gold. */
  private drawTable(cx: number, top: number): void {
    const { players } = this.result.stats;
    const rowH = 33;
    const g = this.add.graphics();
    ROWS.forEach((row, r) => {
      const y = top + r * rowH;
      if (r % 2 === 0) g.fillStyle(0xffffff, 0.04).fillRect(cx - 290, y - 3, 580, rowH);
      const values = players.map(row.value);
      const best = row.higherWins === null || values[0] === values[1] ? -1 : values[0] > values[1] ? 0 : 1;
      players.forEach((s, i) => {
        const text = row.show ? row.show(values[i], s) : String(values[i]);
        this.add.text(cx + (i === 0 ? -150 : 150), y, text, {
          fontSize: "22px", fontStyle: best === i ? "bold" : "normal", color: best === i ? "#f2c14e" : "#f3efe6",
        }).setOrigin(0.5, 0);
      });
      this.add.text(cx, y + 2, row.label, { fontSize: "17px", color: "#a8a196" }).setOrigin(0.5, 0);
    });
    // Favorite move: words, not a number.
    const y = top + ROWS.length * rowH;
    if (ROWS.length % 2 === 0) g.fillStyle(0xffffff, 0.04).fillRect(cx - 290, y - 3, 580, rowH);
    players.forEach((s, i) => {
      this.add.text(cx + (i === 0 ? -150 : 150), y + 2, s.favoriteMove ? MOVE_NAMES[s.favoriteMove] : "–", { fontSize: "19px", color: "#f3efe6" }).setOrigin(0.5, 0);
    });
    this.add.text(cx, y + 2, "Favorite move", { fontSize: "17px", color: "#a8a196" }).setOrigin(0.5, 0);
    // Column heads: the players' colours.
    players.forEach((_, i) => g.fillStyle(PLAYER_COLORS[i], 1).fillRect(cx + (i === 0 ? -190 : 110), top - 12, 80, 4));
  }

  /** "R1 · Red Stick · K.O. · 0:42" for each round. */
  private drawRounds(cx: number, y: number): void {
    const { stats, entries } = this.result;
    const chips = stats.rounds.map((r) => {
      const who = r.outcome === "draw" ? "Draw" : entries[r.outcome].fighter.name;
      return `R${r.round}  ${who}  ${r.reason === "ko" ? "K.O." : "time"}  ${clock(r.frames)}`;
    });
    const text = this.add.text(cx, y, chips.join("     "), { fontSize: "17px", color: "#c9c3b8", align: "center", wordWrap: { width: 760 } }).setOrigin(0.5, 0);
    // A line in each round winner's colour would be noise; one muted rule above is enough.
    this.add.rectangle(cx, y - 12, Math.min(760, text.width + 40), 1, 0x3a3346).setOrigin(0.5);
  }

  private drawActions(cx: number, y: number): void {
    const button = (x: number, label: string, primary: boolean, onClick: () => void) => {
      const t = this.add.text(x, y, label, {
        fontSize: "24px", fontStyle: "bold", color: primary ? "#1a1410" : "#f3efe6",
        backgroundColor: primary ? "#f2c14e" : "#1c1824", padding: { x: 20, y: 10 },
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      t.on("pointerdown", onClick);
      return t;
    };
    if (this.result.series) {
      button(cx, `${this.result.winner === "draw" ? "Play it again" : SERIES_INFO[this.result.series].next}  (punch)`, true, () => this.rematch());
      return;
    }
    button(cx - 170, "Rematch  (punch)", true, () => this.rematch());
    button(cx + 170, "Fighter select  (kick)", false, () => this.quit());
  }

  private get fight(): FightScene {
    return this.scene.get("fight") as FightScene;
  }

  private rematch(): void {
    if (this.leaving) return;
    if (this.result.series && this.result.winner !== "draw") return this.advanceSeries();
    this.leaving = true;
    this.scene.stop();
    this.fight.rematch();
  }

  /** The result counts in the series; back to its scene. */
  private advanceSeries(): void {
    this.leaving = true;
    const session: SeriesSession | undefined = this.registry.get(REGISTRY.series);
    if (session && this.result.winner !== "draw") recordSeriesResult(session, this.result.winner);
    this.fight.quitToSelect();
  }

  private quit(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.fight.quitToSelect();
  }

  update(): void {
    const ready = performance.now() - this.openedAt > INPUT_DELAY_MS;
    const now = this.sources.map((s) => s.read());
    const before = this.previous;
    this.previous = now;
    if (!ready) return;
    const pressed = (k: keyof InputFrame) => now.some((f, i) => f[k] && !before[i][k]);
    if (pressed("punch") || (this.result.series && pressed("kick"))) this.rematch();
    else if (pressed("kick")) this.quit();
  }
}
