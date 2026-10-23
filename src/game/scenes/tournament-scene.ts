import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { gameSoundKey, type GameSoundId } from "../game-sounds";
import { createInputSource, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { playMenuMusic } from "../menu-music";
import { getOptions } from "../options";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { Tournament } from "../tournament";
import { REGISTRY } from "./boot-scene";
import { startMatch } from "./stage-select-scene";

/** The tournament in progress, kept in the registry between its matches. */
export interface TournamentSession {
  bracket: Tournament<LibraryEntry>;
  inputs: [PlayerInputDescriptor, PlayerInputDescriptor];
}

const PLAYER_CSS = ["#e8483b", "#3f86f0"];
const INPUT_DELAY_MS = 500;
/** A second kick within this long abandons the tournament. */
const QUIT_CONFIRM_MS = 2000;
const TOP = 150;
const BOTTOM = 540;
const BOX_W = 210;
const BOX_H = 40;
const THUMB = 32;

/**
 * Between a tournament's matches: the bracket, with the next match picked out
 * and who plays it (P1 the top fighter, P2 the bottom). Punch starts it; kick
 * twice abandons the tournament. Once there's a champion, any button goes back
 * to fighter select.
 */
export class TournamentScene extends Phaser.Scene {
  private session!: TournamentSession;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private openedAt = 0;
  private quitUntil = 0;
  private hint!: Phaser.GameObjects.Text;
  private leaving = false;

  constructor() {
    super("tournament");
  }

  init(): void {
    this.leaving = false;
    this.quitUntil = 0;
  }

  create(): void {
    const session: TournamentSession | undefined = this.registry.get(REGISTRY.tournament);
    if (!session) {
      this.scene.start("character-select");
      return;
    }
    this.session = session;
    playMenuMusic(this);
    this.openedAt = performance.now();
    this.sources = session.inputs.map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());

    const { bracket } = session;
    this.add.text(GAME_WIDTH / 2, 30, "TOURNAMENT", { fontSize: "48px", fontStyle: "bold", color: "#f2c14e" }).setOrigin(0.5, 0);
    this.drawBracket(bracket);
    const champion = bracket.champion;
    if (champion) this.drawChampion(champion);
    else this.drawNext(bracket);
    this.hint = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 28, "", { fontSize: "17px", color: "#a8a196" }).setOrigin(0.5);
    this.setHint();
  }

  /** One column per round, then the champion's slot; lines join each match to the slot its winner moves into. */
  private drawBracket(bracket: Tournament<LibraryEntry>): void {
    const columns = bracket.rounds.length + 1;
    const colW = Math.min(280, (GAME_WIDTH - 80 - BOX_W) / (columns - 1));
    const left = (GAME_WIDTH - (colW * (columns - 1) + BOX_W)) / 2;
    const next = bracket.next;
    const lines = this.add.graphics();
    const slotY = (round: number, slot: number) => {
      const slots = 2 ** (bracket.rounds.length - round);
      return TOP + ((slot + 0.5) * (BOTTOM - TOP)) / slots;
    };

    for (let r = 0; r <= bracket.rounds.length; r++) {
      const x = left + r * colW;
      const final = r === bracket.rounds.length;
      this.add.text(x + BOX_W / 2, TOP - 34, final ? "Champion" : bracket.roundName(r), { fontSize: "16px", color: "#a8a196" }).setOrigin(0.5, 0);
      if (final) {
        const winner = bracket.rounds[r - 1][0].winner;
        this.drawSlot(x, slotY(r, 0), winner === null ? null : bracket.entrants[winner], winner === null ? "?" : "", { gold: winner !== null });
        continue;
      }
      bracket.rounds[r].forEach((m, i) => {
        const bye = bracket.isBye(r, i);
        const playing = next?.round === r && next.index === i;
        ([m.a, m.b] as const).forEach((who, side) => {
          const y = slotY(r, 2 * i + side);
          // Byes don't get a box: the bye winner's line just runs on.
          if (bye && who === null) return;
          const decided = m.winner !== null && !bye;
          this.drawSlot(x, y, who === null ? null : bracket.entrants[who], who === null ? "…" : "", {
            lost: decided && m.winner !== who,
            player: playing ? side : undefined,
          });
        });
        // The bracket lines: out of both boxes, down/up to the middle, on into the next round.
        const [ya, yb] = [slotY(r, 2 * i), slotY(r, 2 * i + 1)];
        const mid = (ya + yb) / 2, out = x + BOX_W, turn = out + (colW - BOX_W) / 2;
        lines.lineStyle(2, playing ? 0xf2c14e : 0x3a3346, 1);
        if (bye) {
          const y = m.a === null ? yb : ya;
          lines.lineBetween(out, y, turn, y).lineBetween(turn, y, turn, mid);
        } else {
          lines.lineBetween(out, ya, turn, ya).lineBetween(out, yb, turn, yb).lineBetween(turn, ya, turn, yb);
        }
        lines.lineBetween(turn, mid, x + colW, mid);
      });
    }
  }

  private drawSlot(x: number, y: number, entry: LibraryEntry | null, placeholder: string, style: { lost?: boolean; gold?: boolean; player?: number }): void {
    const stroke = style.player !== undefined ? Phaser.Display.Color.HexStringToColor(PLAYER_CSS[style.player]).color : style.gold ? 0xf2c14e : 0x3a3346;
    this.add.rectangle(x, y - BOX_H / 2, BOX_W, BOX_H, 0x1c1824).setOrigin(0).setStrokeStyle(style.player !== undefined || style.gold ? 3 : 1, stroke);
    const alpha = style.lost ? 0.4 : 1;
    if (entry && this.textures.exists(`thumb:${entry.fighter.fighterId}`)) {
      this.add.image(x + 6 + THUMB / 2, y, `thumb:${entry.fighter.fighterId}`).setDisplaySize(THUMB, THUMB).setAlpha(alpha);
    }
    const color = style.player !== undefined ? PLAYER_CSS[style.player] : style.gold ? "#f2c14e" : "#f3efe6";
    this.add.text(x + THUMB + 14, y, entry?.fighter.name ?? placeholder, {
      fontSize: "17px", fontStyle: style.player !== undefined || style.gold ? "bold" : "normal", color: entry ? color : "#6b6574", fixedWidth: BOX_W - THUMB - 20,
    }).setOrigin(0, 0.5).setAlpha(alpha);
    if (style.player !== undefined) {
      this.add.text(x + BOX_W - 4, y - BOX_H / 2 - 2, `P${style.player + 1}`, {
        fontSize: "12px", fontStyle: "bold", color: "#121018", backgroundColor: PLAYER_CSS[style.player], padding: { x: 4, y: 1 },
      }).setOrigin(1, 1);
    }
  }

  private drawNext(bracket: Tournament<LibraryEntry>): void {
    const next = bracket.next!;
    const [a, b] = [bracket.entrants[next.a], bracket.entrants[next.b]];
    const cx = GAME_WIDTH / 2, y = 572;
    this.add.text(cx, y - 18, bracket.roundName(next.round).toUpperCase(), { fontSize: "16px", color: "#a8a196" }).setOrigin(0.5, 1);
    this.add.text(cx - 40, y, `P1 · ${a.fighter.name}`, { fontSize: "30px", fontStyle: "bold", color: PLAYER_CSS[0] }).setOrigin(1, 0);
    this.add.text(cx, y, "vs", { fontSize: "26px", color: "#f2c14e" }).setOrigin(0.5, 0);
    this.add.text(cx + 40, y, `${b.fighter.name} · P2`, { fontSize: "30px", fontStyle: "bold", color: PLAYER_CSS[1] }).setOrigin(0, 0);
    const go = this.add.text(cx, y + 66, "Fight!  (punch)", {
      fontSize: "24px", fontStyle: "bold", color: "#1a1410", backgroundColor: "#f2c14e", padding: { x: 20, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    go.on("pointerdown", () => this.fight());
  }

  private drawChampion(champion: LibraryEntry): void {
    const cx = GAME_WIDTH / 2;
    this.add.text(cx, 590, `${champion.fighter.name.toUpperCase()} IS THE CHAMPION!`, {
      fontSize: "44px", fontStyle: "bold", color: "#f2c14e", stroke: "#121018", strokeThickness: 8, align: "center", wordWrap: { width: GAME_WIDTH - 120 },
    }).setOrigin(0.5);
    const done = this.add.text(cx, 648, "Back to fighter select", {
      fontSize: "22px", fontStyle: "bold", color: "#f3efe6", backgroundColor: "#1c1824", padding: { x: 18, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    done.on("pointerdown", () => this.quit());
    this.playEffect("hit", 0.8);
  }

  private setHint(): void {
    this.hint.setText(
      this.session.bracket.champion ? "Any button: fighter select"
      : performance.now() < this.quitUntil ? "Kick again to abandon the tournament"
      : "Punch: fight  ·  kick twice: abandon the tournament",
    ).setColor(performance.now() < this.quitUntil ? "#f2c14e" : "#a8a196");
  }

  private fight(): void {
    const next = this.session.bracket.next;
    if (this.leaving || !next) return;
    this.leaving = true;
    this.playEffect("hit", 0.6);
    const { entrants } = this.session.bracket;
    startMatch(this, { entries: [entrants[next.a], entrants[next.b]], inputs: [...this.session.inputs], tournament: true });
  }

  private quit(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.registry.remove(REGISTRY.tournament);
    this.scene.start("character-select");
  }

  update(): void {
    if (this.leaving || !this.session) return;
    if (this.quitUntil && performance.now() >= this.quitUntil) {
      this.quitUntil = 0;
      this.setHint();
    }
    const now = this.sources.map((s) => s.read());
    const before = this.previous;
    this.previous = now;
    this.sources.forEach((s) => s.pausePressed());
    if (performance.now() - this.openedAt < INPUT_DELAY_MS) return;
    const pressed = (k: keyof InputFrame) => now.some((f, i) => f[k] && !before[i][k]);
    if (this.session.bracket.champion) {
      if (pressed("punch") || pressed("kick")) this.quit();
    } else if (pressed("punch")) {
      this.fight();
    } else if (pressed("kick")) {
      if (performance.now() < this.quitUntil) return this.quit();
      this.quitUntil = performance.now() + QUIT_CONFIRM_MS;
      this.playEffect("block", 0.4);
      this.setHint();
    }
  }

  /** Menu sounds: the "Game volume" setting. */
  private playEffect(id: GameSoundId, volume: number): void {
    const v = volume * getOptions(this.registry).gameVolume;
    if (v > 0 && this.cache.audio.exists(gameSoundKey(id))) this.sound.play(gameSoundKey(id), { volume: v });
  }
}
