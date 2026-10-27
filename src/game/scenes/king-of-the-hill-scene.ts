import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { playGameSound } from "../game-sounds";
import { announce } from "../announcer";
import { createInputSource } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { playMenuMusic } from "../menu-music";

import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, popBox, RADIUS, SHADOW } from "../render/theme";
import type { SeriesSession } from "../series";
import { REGISTRY } from "./boot-scene";
import { startMatch } from "./stage-select-scene";

type HillSession = Extract<SeriesSession, { kind: "king-of-the-hill" }>;

const PLAYER_CSS = [COLOR.bad, COLOR.p2];
const INPUT_DELAY_MS = 500;
/** A second kick within this long abandons the series. */
const QUIT_CONFIRM_MS = 2000;
const CARD = 200;
const CARD_Y = 260;
const QUEUE_Y = 480;
const QUEUE_THUMB = 64;

const thumbKey = (e: LibraryEntry) => `thumb:${e.fighter.fighterId}`;

/**
 * Between king of the hill matches: the king (on the side they won from, so
 * they keep their controller) against the next challenger, the streak they
 * need, and who's waiting in line. Punch starts the match; kick twice
 * abandons it. Once someone has beaten everyone in a row they rule the hill,
 * and any button goes back to fighter select.
 */
export class KingOfTheHillScene extends Phaser.Scene {
  private session!: HillSession;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private openedAt = 0;
  private quitUntil = 0;
  private hint!: Phaser.GameObjects.Text;
  private leaving = false;

  constructor() {
    super("king-of-the-hill");
  }

  init(): void {
    this.leaving = false;
    this.quitUntil = 0;
  }

  create(): void {
    const session: SeriesSession | undefined = this.registry.get(REGISTRY.series);
    if (session?.kind !== "king-of-the-hill") {
      this.scene.start("character-select");
      return;
    }
    this.session = session;
    playMenuMusic(this);
    this.openedAt = performance.now();
    this.sources = session.inputs.map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());

    drawBackdrop(this);
    this.add.text(GAME_WIDTH / 2, 30, "KING OF THE HILL", displayText(52, COLOR.party)).setOrigin(0.5, 0);
    const champion = session.hill.champion;
    if (champion) this.drawChampion(champion);
    else this.drawMatch();
    announce(this, champion ? "hill-champion" : session.hill.kingSide === null ? "king-of-the-hill" : "new-challenger");
    this.hint = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 28, "", bodyText(17, COLOR.muted, 600)).setOrigin(0.5);
    this.setHint();
  }

  /** A fighter's thumbnail, framed, with a label above and their name below. */
  private drawCard(x: number, y: number, entry: LibraryEntry, label: string, labelColor: string, nameColor: string, gold: boolean): void {
    popBox(this, x - CARD / 2, y - CARD / 2, CARD, CARD, { fill: HEX.panel, border: gold ? HEX.accent : HEX.ink, borderWidth: gold ? 5 : 3, radius: RADIUS.md, shadow: SHADOW.md });
    if (this.textures.exists(thumbKey(entry))) this.add.image(x, y, thumbKey(entry)).setDisplaySize(CARD - 16, CARD - 16);
    this.add.text(x, y - CARD / 2 - 10, label, displayText(20, labelColor)).setOrigin(0.5, 1);
    this.add.text(x, y + CARD / 2 + 10, entry.fighter.name, displayText(28, nameColor, { align: "center", wordWrap: { width: CARD + 140 } })).setOrigin(0.5, 0);
  }

  private drawMatch(): void {
    const { hill } = this.session;
    const cx = GAME_WIDTH / 2;
    hill.sides.forEach((who, side) => {
      const king = hill.kingSide === side;
      const label = hill.kingSide === null ? `P${side + 1}` : king ? `👑 P${side + 1} · KING · ${hill.streak} / ${hill.target}` : `P${side + 1} · CHALLENGER`;
      this.drawCard(cx + (side === 0 ? -250 : 250), CARD_Y, hill.entrants[who], label, king ? COLOR.accent : PLAYER_CSS[side], PLAYER_CSS[side], king);
    });
    this.add.text(cx, CARD_Y, "vs", displayText(48, COLOR.accent)).setOrigin(0.5);
    this.add.text(cx, CARD_Y + 60, hill.kingSide === null ? "Opening match" : `${hill.target - hill.streak} more to rule the hill`, {
      ...bodyText(16, COLOR.muted, 600), align: "center", wordWrap: { width: 280 },
    }).setOrigin(0.5, 0);
    this.drawQueue(cx);
    button(this, cx, 630, "Fight!  (punch)", 24, true).on("pointerdown", () => this.fight());
  }

  /** "Up next": the waiting line, in order, and the best streak so far. */
  private drawQueue(cx: number): void {
    const { hill } = this.session;
    this.add.text(cx, QUEUE_Y - 54, hill.queue.length ? "UP NEXT" : "", bodyText(16, COLOR.party, 800, { letterSpacing: 2 })).setOrigin(0.5, 0);
    const step = QUEUE_THUMB + 70;
    hill.queue.forEach((who, i) => {
      const x = cx + (i - (hill.queue.length - 1) / 2) * step;
      const entry = hill.entrants[who];
      popBox(this, x - QUEUE_THUMB / 2, QUEUE_Y - QUEUE_THUMB / 2, QUEUE_THUMB, QUEUE_THUMB, { fill: HEX.panel, border: i ? HEX.ink : HEX.edge, radius: RADIUS.sm, shadow: SHADOW.sm });
      if (this.textures.exists(thumbKey(entry))) this.add.image(x, QUEUE_Y, thumbKey(entry)).setDisplaySize(QUEUE_THUMB - 6, QUEUE_THUMB - 6).setAlpha(i ? 0.6 : 1);
      this.add.text(x, QUEUE_Y + QUEUE_THUMB / 2 + 6, entry.fighter.name, bodyText(13, i ? COLOR.faint : COLOR.fg, i ? 600 : 800, { fixedWidth: step - 6, align: "center" }))
        .setOrigin(0.5, 0);
    });
    if (hill.best) {
      this.add.text(cx, QUEUE_Y + 72, `Best streak: ${hill.entrants[hill.best.entrant].fighter.name} × ${hill.best.streak}`, bodyText(16, COLOR.muted, 600))
        .setOrigin(0.5, 0);
    }
  }

  private drawChampion(champion: LibraryEntry): void {
    const { hill } = this.session;
    const cx = GAME_WIDTH / 2;
    this.drawCard(cx, CARD_Y, champion, "👑", COLOR.accent, COLOR.accent, true);
    this.add.text(cx, 450, `${champion.fighter.name.toUpperCase()} RULES THE HILL!`, displayText(48, COLOR.accent, {
      align: "center", wordWrap: { width: GAME_WIDTH - 120 },
    })).setOrigin(0.5);
    const total = hill.wins.reduce((a, b) => a + b, 0);
    this.add.text(cx, 504, `${hill.streak} wins in a row  ·  ${total} matches played`, bodyText(20, COLOR.muted, 600)).setOrigin(0.5, 0);
    button(this, cx, 600, "Back to fighter select", 22, false).on("pointerdown", () => this.quit());
    playGameSound(this, "hit", 0.8);
  }

  private setHint(): void {
    const confirming = performance.now() < this.quitUntil;
    this.hint.setText(
      this.session.hill.champion ? "Any button: fighter select"
      : confirming ? "Kick again to leave the hill"
      : "Punch: fight  ·  kick twice: leave the hill",
    ).setColor(confirming ? COLOR.accent : COLOR.muted);
  }

  private fight(): void {
    const { hill, inputs } = this.session;
    if (this.leaving || hill.champion) return;
    this.leaving = true;
    playGameSound(this, "hit", 0.6);
    const [a, b] = hill.sides;
    startMatch(this, { entries: [hill.entrants[a], hill.entrants[b]], inputs: [...inputs], series: "king-of-the-hill" });
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
    if (this.session.hill.champion) {
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
