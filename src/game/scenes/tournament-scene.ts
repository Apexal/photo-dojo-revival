import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { playGameSound } from "../game-sounds";
import { announce } from "../announcer";
import { tournamentRoundLine } from "../announcer-lines";
import { createInputSource } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { playMenuMusic } from "../menu-music";

import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, popBox, RADIUS, SHADOW } from "../render/theme";
import type { Tournament } from "../tournament";
import type { SeriesSession } from "../series";
import { REGISTRY } from "./boot-scene";
import { startMatch } from "./stage-select-scene";

type TournamentSession = Extract<SeriesSession, { kind: "tournament" }>;

const PLAYER_CSS = [COLOR.bad, COLOR.p2];
const PLAYER_HEX = [HEX.bad, HEX.p2];
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
    const session: SeriesSession | undefined = this.registry.get(REGISTRY.series);
    if (session?.kind !== "tournament") {
      this.scene.start("character-select");
      return;
    }
    this.session = session;
    playMenuMusic(this);
    this.openedAt = performance.now();
    this.sources = session.inputs.map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());

    drawBackdrop(this);
    const { bracket } = session;
    this.add.text(GAME_WIDTH / 2, 30, "TOURNAMENT", displayText(52, COLOR.party)).setOrigin(0.5, 0);
    this.drawBracket(bracket);
    const champion = bracket.champion;
    if (champion) this.drawChampion(champion);
    else this.drawNext(bracket);
    const next = bracket.next;
    announce(this, champion ? "champion" : tournamentRoundLine(next ? bracket.roundName(next.round) : ""));
    this.hint = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 28, "", bodyText(17, COLOR.muted, 600)).setOrigin(0.5);
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
      this.add.text(x + BOX_W / 2, TOP - 34, final ? "Champion" : bracket.roundName(r), bodyText(16, COLOR.muted, 800)).setOrigin(0.5, 0);
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
        lines.lineStyle(playing ? 3 : 2, playing ? HEX.accent : HEX.line, 1);
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
    // The match being played: each box in its player's colour; the champion's slot gold.
    const border = style.player !== undefined ? PLAYER_HEX[style.player] : style.gold ? HEX.accent : HEX.ink;
    popBox(this, x, y - BOX_H / 2, BOX_W, BOX_H, { fill: HEX.panel, border, borderWidth: style.player !== undefined ? 4 : 3, radius: RADIUS.sm, shadow: SHADOW.sm });
    const alpha = style.lost ? 0.4 : 1;
    if (entry && this.textures.exists(`thumb:${entry.fighter.fighterId}`)) {
      this.add.image(x + 6 + THUMB / 2, y, `thumb:${entry.fighter.fighterId}`).setDisplaySize(THUMB, THUMB).setAlpha(alpha);
    }
    const color = entry ? (style.player !== undefined ? PLAYER_CSS[style.player] : style.gold ? COLOR.accent : COLOR.fg) : COLOR.disabled;
    const name = entry?.fighter.name ?? placeholder;
    const nameStyle = style.player !== undefined || style.gold
      ? displayText(18, color, { outline: false, fixedWidth: BOX_W - THUMB - 20 })
      : bodyText(17, color, 600, { fixedWidth: BOX_W - THUMB - 20 });
    this.add.text(x + THUMB + 14, y, name, nameStyle).setOrigin(0, 0.5).setAlpha(alpha);
    if (style.player !== undefined) {
      // The P1 / P2 tag sits on the box's top edge, at its right.
      const tag = this.add.text(0, 0, `P${style.player + 1}`, displayText(13, COLOR.ink, { outline: false }));
      const w = tag.width + 10, h = tag.height + 2;
      popBox(this, x + BOX_W - 4 - w, y - BOX_H / 2 - 2 - h, w, h, { fill: PLAYER_HEX[style.player], borderWidth: 2, radius: RADIUS.sm / 2, shadow: 0 });
      tag.setOrigin(0.5).setPosition(x + BOX_W - 4 - w / 2, y - BOX_H / 2 - 2 - h / 2).setDepth(1);
    }
  }

  private drawNext(bracket: Tournament<LibraryEntry>): void {
    const next = bracket.next!;
    const [a, b] = [bracket.entrants[next.a], bracket.entrants[next.b]];
    const cx = GAME_WIDTH / 2, y = 572;
    this.add.text(cx, y - 18, bracket.roundName(next.round).toUpperCase(), bodyText(16, COLOR.muted, 800)).setOrigin(0.5, 1);
    this.add.text(cx - 40, y, `P1 · ${a.fighter.name}`, displayText(32, PLAYER_CSS[0])).setOrigin(1, 0);
    this.add.text(cx, y, "vs", displayText(28, COLOR.accent)).setOrigin(0.5, 0);
    this.add.text(cx + 40, y, `${b.fighter.name} · P2`, displayText(32, PLAYER_CSS[1])).setOrigin(0, 0);
    button(this, cx, y + 66, "Fight!  (punch)", 24, true).on("pointerdown", () => this.fight());
  }

  private drawChampion(champion: LibraryEntry): void {
    const cx = GAME_WIDTH / 2;
    this.add.text(cx, 590, `${champion.fighter.name.toUpperCase()} IS THE CHAMPION!`, displayText(48, COLOR.accent, {
      align: "center", wordWrap: { width: GAME_WIDTH - 120 },
    })).setOrigin(0.5);
    button(this, cx, 648, "Back to fighter select", 22, false).on("pointerdown", () => this.quit());
    playGameSound(this, "hit", 0.8);
  }

  private setHint(): void {
    this.hint.setText(
      this.session.bracket.champion ? "Any button: fighter select"
      : performance.now() < this.quitUntil ? "Kick again to abandon the tournament"
      : "Punch: fight  ·  kick twice: abandon the tournament",
    ).setColor(performance.now() < this.quitUntil ? COLOR.accent : COLOR.muted);
  }

  private fight(): void {
    const next = this.session.bracket.next;
    if (this.leaving || !next) return;
    this.leaving = true;
    playGameSound(this, "hit", 0.6);
    const { entrants } = this.session.bracket;
    startMatch(this, { entries: [entrants[next.a], entrants[next.b]], inputs: [...this.session.inputs], series: "tournament" });
  }

  private quit(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.registry.remove(REGISTRY.series);
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
      playGameSound(this, "block", 0.4);
      this.setHint();
    }
  }

}

/**
 * A popped button centred on (cx, cy): gold with ink text (`primary`), or a panel that turns gold under the pointer.
 * Returns the label, which is the hit area.
 */
function button(scene: Phaser.Scene, cx: number, cy: number, label: string, size: number, primary: boolean): Phaser.GameObjects.Text {
  const box = scene.add.graphics();
  const text = scene.add.text(cx, cy, label, displayText(size, primary ? COLOR.ink : COLOR.fg, { outline: false, padding: { x: 20, y: 9 } }))
    .setOrigin(0.5).setInteractive({ useHandCursor: true });
  const draw = (hot: boolean) => {
    box.clear();
    drawPopBox(box, cx - text.width / 2, cy - text.height / 2, text.width, text.height, primary || hot ? { fill: HEX.accent } : { fill: HEX.panel, border: HEX.edge });
    text.setColor(primary || hot ? COLOR.ink : COLOR.fg);
  };
  draw(false);
  text.on("pointerover", () => draw(true));
  text.on("pointerout", () => draw(false));
  return text;
}
