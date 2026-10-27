import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { playGameSound } from "../game-sounds";
import { createInputSource, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { KEY } from "../input/key-bindings";
import { KingOfTheHill } from "../king-of-the-hill";
import { playMenuMusic } from "../menu-music";

import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, popBox, RADIUS, SHADOW } from "../render/theme";
import { MAX_ENTRANTS, MIN_ENTRANTS, SERIES_INFO, SERIES_KINDS, type SeriesKind, type SeriesSession } from "../series";
import { Tournament } from "../tournament";
import { REGISTRY } from "./boot-scene";

export interface SeriesSetupData {
  /** The two players' controllers: P1 plays the left fighter of every match, P2 the right. */
  inputs: [PlayerInputDescriptor, PlayerInputDescriptor];
}

const COLS = 8;
const ROWS = 3;
const TILE = 120;
const GAP = 14;
const MODE_Y = 112;
const GRID_Y = 196;
const GRID_X = (GAME_WIDTH - (COLS * (TILE + GAP) - GAP)) / 2;
const ROW_H = TILE + 34;
/** The cursor on the mode row, above the grid. */
const MODE_ROW = -1;

/** Same keys as fighter select, so its thumbnails are reused. */
const thumbKey = (e: LibraryEntry) => `thumb:${e.fighter.fighterId}`;

/** The mode picked last, this page load. */
let lastKind: SeriesKind = "tournament";

/**
 * Before a series: up on the top row reaches the mode (◀ ▶ switches between
 * tournament and king of the hill). Either player moves the cursor and punches
 * fighters in or out (3–8, numbered in the order picked: king of the hill's
 * line-up; a tournament draws at random). Enter / Start begins; kick goes
 * back to fighter select.
 */
export class SeriesSetupScene extends Phaser.Scene {
  private setup!: SeriesSetupData;
  private kind: SeriesKind = lastKind;
  private library: LibraryEntry[] = [];
  /** Library indices, in the order picked. */
  private picked: number[] = [];
  private cursor = 0;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private tiles!: Phaser.GameObjects.Container;
  private cursorBox!: Phaser.GameObjects.Graphics;
  private modeText!: Phaser.GameObjects.Text;
  private modeBox!: Phaser.GameObjects.Graphics;
  private blurbText!: Phaser.GameObjects.Text;
  private countText!: Phaser.GameObjects.Text;
  private startButton!: Phaser.GameObjects.Text;
  private startBox!: Phaser.GameObjects.Graphics;
  private thumbUrls: string[] = [];
  private enterLatched = false;
  private leaving = false;

  constructor() {
    super("series-setup");
  }

  init(data: SeriesSetupData): void {
    this.setup = data;
    this.kind = lastKind;
    this.picked = [];
    this.cursor = 0;
    this.leaving = false;
    this.enterLatched = false;
  }

  create(): void {
    playMenuMusic(this);
    this.library = this.registry.get(REGISTRY.library) ?? [];
    const cx = GAME_WIDTH / 2;
    drawBackdrop(this);
    this.add.text(cx, 30, "PARTY MODES", displayText(52, COLOR.party)).setOrigin(0.5, 0);
    // The mode chip: redrawn behind the mode's name in draw(), gold while the cursor is on it.
    this.modeBox = this.add.graphics();
    this.modeText = this.add.text(cx, MODE_Y, "", displayText(30, COLOR.fg, { outline: false, padding: { x: 16, y: 4 } }))
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.modeText.on("pointerdown", () => this.switchKind(1));
    this.blurbText = this.add.text(cx, MODE_Y + 30, "", bodyText(17, COLOR.muted, 600)).setOrigin(0.5, 0);
    this.tiles = this.add.container(0, 0);
    this.cursorBox = this.add.graphics().setDepth(10);
    this.countText = this.add.text(cx, GAME_HEIGHT - 128, "", displayText(24, COLOR.fg)).setOrigin(0.5);
    this.startBox = this.add.graphics();
    this.startButton = this.add.text(cx, GAME_HEIGHT - 80, "", displayText(26, COLOR.ink, { outline: false, padding: { x: 20, y: 10 } }))
      .setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.startButton.on("pointerdown", () => this.begin());
    this.add.text(cx, GAME_HEIGHT - 30, "◀ ▶ ▲ ▼ choose  ·  punch: add / remove  ·  Enter / Start: begin  ·  kick: back", bodyText(17, COLOR.muted, 600))
      .setOrigin(0.5);

    this.sources = this.setup.inputs.map((d) => createInputSource(this, d));
    this.previous = this.sources.map((s) => s.read());
    this.sources.forEach((s) => s.pausePressed());
    const kb = this.input.keyboard!;
    const enter = (ev: KeyboardEvent) => { if (!ev.repeat) this.enterLatched = true; };
    kb.on("keydown-ENTER", enter);
    kb.addCapture([KEY.ENTER]);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      kb.off("keydown-ENTER", enter);
      this.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
      this.thumbUrls = [];
    });
    this.loadThumbs();
    this.draw();
  }

  private loadThumbs(): void {
    const missing = this.library.filter((e) => !this.textures.exists(thumbKey(e)));
    if (!missing.length) return;
    for (const e of missing) {
      const url = URL.createObjectURL(e.fighter.thumbnailBlob);
      this.thumbUrls.push(url);
      this.load.image(thumbKey(e), url);
    }
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.draw());
    this.load.start();
  }

  private get pageSize(): number {
    return COLS * ROWS;
  }

  private draw(): void {
    const info = SERIES_INFO[this.kind];
    const onMode = this.cursor === MODE_ROW;
    this.modeText.setText(`◀  ${info.name}  ▶`).setColor(onMode ? COLOR.ink : COLOR.fg);
    const m = this.modeText;
    this.modeBox.clear();
    drawPopBox(this.modeBox, m.x - m.width / 2, m.y - m.height / 2, m.width, m.height, onMode ? { fill: HEX.accent, radius: m.height / 2 } : { fill: HEX.panel, border: HEX.edge, radius: m.height / 2 });
    this.blurbText.setText(info.blurb);
    const b = this.startButton.setText(this.kind === "tournament" ? "Draw the bracket ▶" : "Take the hill ▶");
    this.startBox.clear();
    drawPopBox(this.startBox, b.x - b.width / 2, b.y - b.height / 2, b.width, b.height, { fill: HEX.accent });

    this.tiles.removeAll(true);
    const page = Math.floor(Math.max(0, this.cursor) / this.pageSize);
    const first = page * this.pageSize;
    this.library.slice(first, first + this.pageSize).forEach((entry, slot) => {
      const index = first + slot;
      const { x, y } = this.tilePosition(slot);
      const order = this.picked.indexOf(index);
      this.tiles.add(popBox(this, x, y, TILE, TILE, { fill: HEX.panel, border: order >= 0 ? HEX.accent : HEX.ink, borderWidth: order >= 0 ? 4 : 3, radius: RADIUS.md, shadow: SHADOW.md }));
      // An invisible hit area over the drawn tile.
      const bg = this.add.rectangle(x, y, TILE, TILE, 0x000000, 0.001).setOrigin(0)
        .setInteractive({ useHandCursor: true });
      bg.on("pointerdown", () => {
        this.cursor = index;
        this.toggle();
      });
      this.tiles.add(bg);
      if (this.textures.exists(thumbKey(entry))) {
        this.tiles.add(this.add.image(x + TILE / 2, y + TILE / 2, thumbKey(entry)).setDisplaySize(TILE - 10, TILE - 10).setAlpha(order >= 0 ? 1 : 0.55));
      }
      this.tiles.add(this.add.text(x + TILE / 2, y + TILE + 8, entry.fighter.name,
        bodyText(14, order >= 0 ? COLOR.accent : COLOR.muted, order >= 0 ? 800 : 600, { fixedWidth: TILE + GAP, align: "center" })).setOrigin(0.5, 0));
      if (order >= 0) {
        // The pick order, as a gold chip on the tile's corner.
        const num = this.add.text(0, 0, String(order + 1), displayText(18, COLOR.ink, { outline: false })).setOrigin(0.5);
        const w = Math.max(26, num.width + 12), h = 26;
        this.tiles.add(popBox(this, x - 4, y - 4, w, h, { fill: HEX.accent, radius: RADIUS.sm, shadow: SHADOW.sm }));
        this.tiles.add(num.setPosition(x - 4 + w / 2, y - 4 + h / 2));
      }
    });
    const pages = Math.ceil(this.library.length / this.pageSize);
    if (pages > 1) {
      this.tiles.add(this.add.text(GAME_WIDTH / 2, GRID_Y + ROWS * ROW_H - 10, `page ${page + 1} / ${pages}`, bodyText(15, COLOR.muted, 600)).setOrigin(0.5, 0));
    }
    this.cursorBox.clear();
    if (!onMode) {
      const { x, y } = this.tilePosition(this.cursor - first);
      this.cursorBox.lineStyle(4, HEX.fg, 1).strokeRoundedRect(x - 6, y - 6, TILE + 12, TILE + 12, RADIUS.md + 4);
    }

    const n = this.picked.length;
    this.countText.setText(n < MIN_ENTRANTS ? `${n} picked: pick at least ${MIN_ENTRANTS}` : `${n} fighters${n === MAX_ENTRANTS ? " (full)" : ""}`);
    this.startButton.setAlpha(n >= MIN_ENTRANTS ? 1 : 0.4);
    this.startBox.setAlpha(n >= MIN_ENTRANTS ? 1 : 0.4);
  }

  private tilePosition(slot: number) {
    return { x: GRID_X + (slot % COLS) * (TILE + GAP), y: GRID_Y + Math.floor(slot / COLS) * ROW_H };
  }

  private switchKind(dir: 1 | -1): void {
    const i = SERIES_KINDS.indexOf(this.kind);
    this.kind = lastKind = SERIES_KINDS[(i + dir + SERIES_KINDS.length) % SERIES_KINDS.length];
    playGameSound(this, "tick", 0.3);
    this.draw();
  }

  private toggle(): void {
    if (this.cursor === MODE_ROW) return this.switchKind(1);
    const at = this.picked.indexOf(this.cursor);
    if (at >= 0) {
      this.picked.splice(at, 1);
      playGameSound(this, "block", 0.4);
    } else if (this.picked.length < MAX_ENTRANTS) {
      this.picked.push(this.cursor);
      playGameSound(this, "hit", 0.6);
    }
    this.draw();
  }

  private begin(): void {
    if (this.leaving || this.picked.length < MIN_ENTRANTS) return;
    this.leaving = true;
    playGameSound(this, "hit", 0.6);
    const picked = this.picked.map((i) => this.library[i]);
    const { inputs } = this.setup;
    const session: SeriesSession = this.kind === "tournament"
      ? { kind: "tournament", bracket: new Tournament(Phaser.Utils.Array.Shuffle(picked)), inputs }
      : { kind: "king-of-the-hill", hill: new KingOfTheHill(picked), inputs };
    this.registry.set(REGISTRY.series, session);
    this.scene.start(this.kind);
  }

  /** Arrows on the grid; up from its top row reaches the mode row, where ◀ ▶ switch modes. */
  private move(frame: (k: keyof InputFrame) => boolean): void {
    const n = this.library.length;
    let c = this.cursor;
    if (c === MODE_ROW) {
      if (frame("left")) return this.switchKind(-1);
      if (frame("right")) return this.switchKind(1);
      if (frame("down") && n) c = 0;
    } else {
      if (frame("left")) c = (c - 1 + n) % n;
      if (frame("right")) c = (c + 1) % n;
      if (frame("up")) c = c % this.pageSize < COLS ? MODE_ROW : c - COLS;
      if (frame("down") && c + COLS < n) c += COLS;
    }
    if (c === this.cursor) return;
    this.cursor = c;
    playGameSound(this, "tick", 0.3);
    this.draw();
  }

  update(): void {
    if (this.leaving) return;
    let start = this.enterLatched;
    this.enterLatched = false;
    this.sources.forEach((source, i) => {
      const now = source.read();
      const before = this.previous[i];
      this.previous[i] = now;
      if (source.pausePressed()) start = true;
      const pressed = (k: keyof InputFrame) => now[k] && !before[k];
      if (this.leaving) return;
      this.move(pressed);
      if (pressed("punch")) this.toggle();
      else if (pressed("kick")) {
        this.leaving = true;
        playGameSound(this, "block", 0.4);
        this.scene.start("character-select");
      }
    });
    if (start) this.begin();
  }

}
