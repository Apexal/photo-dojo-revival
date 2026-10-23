import Phaser from "phaser";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { gameSoundKey, type GameSoundId } from "../game-sounds";
import { createInputSource, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { KEY } from "../input/key-bindings";
import { playMenuMusic } from "../menu-music";
import { getOptions } from "../options";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { MAX_ENTRANTS, MIN_ENTRANTS, Tournament } from "../tournament";
import { REGISTRY } from "./boot-scene";
import type { TournamentSession } from "./tournament-scene";

export interface TournamentSetupData {
  /** The two players' controllers: P1 plays the top fighter of every match, P2 the bottom. */
  inputs: [PlayerInputDescriptor, PlayerInputDescriptor];
}

const COLS = 8;
const ROWS = 3;
const TILE = 120;
const GAP = 14;
const GRID_Y = 150;
const GRID_X = (GAME_WIDTH - (COLS * (TILE + GAP) - GAP)) / 2;
const ROW_H = TILE + 34;

/** Same keys as fighter select, so its thumbnails are reused. */
const thumbKey = (e: LibraryEntry) => `thumb:${e.fighter.fighterId}`;

/**
 * Before a tournament: either player moves the cursor and punches fighters in
 * or out of it (3–8, numbered in the order picked); Enter / Start draws the
 * bracket in a random order. Kick goes back to fighter select.
 */
export class TournamentSetupScene extends Phaser.Scene {
  private setup!: TournamentSetupData;
  private library: LibraryEntry[] = [];
  /** Library indices, in the order picked. */
  private picked: number[] = [];
  private cursor = 0;
  private sources: InputSource[] = [];
  private previous: InputFrame[] = [];
  private tiles!: Phaser.GameObjects.Container;
  private cursorBox!: Phaser.GameObjects.Graphics;
  private countText!: Phaser.GameObjects.Text;
  private startButton!: Phaser.GameObjects.Text;
  private thumbUrls: string[] = [];
  private enterLatched = false;
  private leaving = false;

  constructor() {
    super("tournament-setup");
  }

  init(data: TournamentSetupData): void {
    this.setup = data;
    this.picked = [];
    this.cursor = 0;
    this.leaving = false;
    this.enterLatched = false;
  }

  create(): void {
    playMenuMusic(this);
    this.library = this.registry.get(REGISTRY.library) ?? [];
    const cx = GAME_WIDTH / 2;
    this.add.text(cx, 44, "TOURNAMENT", { fontSize: "52px", fontStyle: "bold", color: "#f2c14e" }).setOrigin(0.5, 0);
    this.add.text(cx, 106, `Pick ${MIN_ENTRANTS}–${MAX_ENTRANTS} fighters. P1 plays the top fighter of each match, P2 the bottom.`, { fontSize: "18px", color: "#c9c3b8" })
      .setOrigin(0.5, 0);
    this.tiles = this.add.container(0, 0);
    this.cursorBox = this.add.graphics().setDepth(10);
    this.countText = this.add.text(cx, GAME_HEIGHT - 128, "", { fontSize: "22px", color: "#f3efe6" }).setOrigin(0.5);
    this.startButton = this.add.text(cx, GAME_HEIGHT - 80, "Draw the bracket ▶", {
      fontSize: "26px", fontStyle: "bold", color: "#1a1410", backgroundColor: "#f2c14e", padding: { x: 20, y: 10 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.startButton.on("pointerdown", () => this.begin());
    this.add.text(cx, GAME_HEIGHT - 30, "◀ ▶ ▲ ▼ choose  ·  punch: add / remove  ·  Enter / Start: begin  ·  kick: back", { fontSize: "17px", color: "#a8a196" })
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
    this.tiles.removeAll(true);
    const page = Math.floor(this.cursor / this.pageSize);
    const first = page * this.pageSize;
    this.library.slice(first, first + this.pageSize).forEach((entry, slot) => {
      const index = first + slot;
      const x = GRID_X + (slot % COLS) * (TILE + GAP);
      const y = GRID_Y + Math.floor(slot / COLS) * ROW_H;
      const order = this.picked.indexOf(index);
      const bg = this.add.rectangle(x, y, TILE, TILE, 0x1c1824).setOrigin(0).setStrokeStyle(order >= 0 ? 3 : 1, order >= 0 ? 0xf2c14e : 0x3a3346)
        .setInteractive({ useHandCursor: true });
      bg.on("pointerdown", () => {
        this.cursor = index;
        this.toggle();
      });
      this.tiles.add(bg);
      if (this.textures.exists(thumbKey(entry))) {
        this.tiles.add(this.add.image(x + TILE / 2, y + TILE / 2, thumbKey(entry)).setDisplaySize(TILE - 10, TILE - 10).setAlpha(order >= 0 ? 1 : 0.55));
      }
      this.tiles.add(this.add.text(x + TILE / 2, y + TILE + 6, entry.fighter.name, {
        fontSize: "14px", color: order >= 0 ? "#f2c14e" : "#c9c3b8", fixedWidth: TILE + GAP, align: "center",
      }).setOrigin(0.5, 0));
      if (order >= 0) {
        this.tiles.add(this.add.text(x + 4, y + 4, String(order + 1), {
          fontSize: "16px", fontStyle: "bold", color: "#121018", backgroundColor: "#f2c14e", padding: { x: 6, y: 1 },
        }));
      }
    });
    const pages = Math.ceil(this.library.length / this.pageSize);
    if (pages > 1) {
      this.tiles.add(this.add.text(GAME_WIDTH / 2, GRID_Y + ROWS * ROW_H, `page ${page + 1} / ${pages}`, { fontSize: "15px", color: "#c9c3b8" }).setOrigin(0.5, 0));
    }
    const slot = this.cursor - first;
    const cx = GRID_X + (slot % COLS) * (TILE + GAP), cy = GRID_Y + Math.floor(slot / COLS) * ROW_H;
    this.cursorBox.clear().lineStyle(4, 0xf3efe6, 1).strokeRect(cx - 5, cy - 5, TILE + 10, TILE + 10);

    const n = this.picked.length;
    this.countText.setText(n < MIN_ENTRANTS ? `${n} picked: pick at least ${MIN_ENTRANTS}` : `${n} fighters${n === MAX_ENTRANTS ? " (full)" : ""}`);
    this.startButton.setAlpha(n >= MIN_ENTRANTS ? 1 : 0.4);
  }

  private toggle(): void {
    const at = this.picked.indexOf(this.cursor);
    if (at >= 0) {
      this.picked.splice(at, 1);
      this.playEffect("block", 0.4);
    } else if (this.picked.length < MAX_ENTRANTS) {
      this.picked.push(this.cursor);
      this.playEffect("hit", 0.6);
    }
    this.draw();
  }

  private begin(): void {
    if (this.leaving || this.picked.length < MIN_ENTRANTS) return;
    this.leaving = true;
    this.playEffect("hit", 0.6);
    const entrants = Phaser.Utils.Array.Shuffle(this.picked.map((i) => this.library[i]));
    const session: TournamentSession = { bracket: new Tournament(entrants), inputs: this.setup.inputs };
    this.registry.set(REGISTRY.tournament, session);
    this.scene.start("tournament");
  }

  update(): void {
    if (this.leaving) return;
    const n = this.library.length;
    let start = this.enterLatched;
    this.enterLatched = false;
    this.sources.forEach((source, i) => {
      const now = source.read();
      const before = this.previous[i];
      this.previous[i] = now;
      if (source.pausePressed()) start = true;
      const pressed = (k: keyof InputFrame) => now[k] && !before[k];
      if (this.leaving || !n) return;
      let c = this.cursor;
      if (pressed("left")) c = (c - 1 + n) % n;
      if (pressed("right")) c = (c + 1) % n;
      if (pressed("up") && c - COLS >= 0) c -= COLS;
      if (pressed("down") && c + COLS < n) c += COLS;
      if (c !== this.cursor) {
        this.cursor = c;
        this.playEffect("tick", 0.3);
        this.draw();
      }
      if (pressed("punch")) this.toggle();
      else if (pressed("kick")) {
        this.leaving = true;
        this.playEffect("block", 0.4);
        this.scene.start("character-select");
      }
    });
    if (start) this.begin();
  }

  /** Menu sounds: the "Game volume" setting. */
  private playEffect(id: GameSoundId, volume: number): void {
    const v = volume * getOptions(this.registry).gameVolume;
    if (v > 0 && this.cache.audio.exists(gameSoundKey(id))) this.sound.play(gameSoundKey(id), { volume: v });
  }
}
