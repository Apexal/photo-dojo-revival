import Phaser from "phaser";
import QRCode from "qrcode";
import { exportFighterFile, fighterFileName, importFighterFile } from "../../shared/fighter-codec";
import { formatCountdown } from "../../shared/room-code";
import { SPRITE_CANVAS_SIZE, type Fighter, type SoundId } from "../../shared/fighter-model";
import { frameGeometry, groundAnchorFor } from "../../shared/frame-data";
import { deleteFighter, getSetting, isStoragePersisted, saveFighter, setSetting } from "../../shared/fighter-storage";
import type { InputFrame } from "../../simulation/input-frame";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { gameSoundKey, type GameSoundId } from "../game-sounds";
import { HostSession, type HostStatus } from "../host-session";
import { PAD_BUTTON } from "../input/gamepad-input-source";
import { createInputSource, describeInput, sameInput, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { KeyboardInputSource } from "../input/keyboard-input-source";
import { KEY, actionKeyLabel } from "../input/key-bindings";
import { JOIN_RUMBLE } from "../input/rumble";
import { getOptions } from "../options";
import { loadFighterSounds } from "../render/fighter-sprite-view";
import { PosePreview, type PreviewCapture, type PreviewPose } from "../render/pose-preview";
import { PLAYER_COLORS } from "../render/stage";
import { pickTake } from "../sound-choice";
import { REGISTRY } from "./boot-scene";
import type { FightSceneData } from "./fight-scene";
import { startMatch } from "./stage-select-scene";
import { playMenuMusic, updateMenuMusicVolume } from "../menu-music";

const ROWS = 2;
const TILE = 120;
const GAP = 12;
const ROW_H = TILE + 28;
const GRID_X = 40;
const GRID_Y = 116;
/** "Add a fighter" column, while the panel is full size. */
const HOST_X = 880;
const HOST_W = 360;
const PLAYER_CSS = ["#e8483b", "#3f86f0"];
/** Each player's preview panel under the grid: their fighter large, plus their status. */
const PANEL_Y = 436;
const PANEL_W = 400;
const PANEL_H = 270;
const PREVIEW_SIZE = 250;
const PREVIEW_TEXT_W = 175;
const PREVIEW_DEPTH = 26;
/** A pick fades out the other player's victory line this fast, so the two don't talk over each other. */
const VOICE_FADE_MS = 250;
/** Both players ready: "VS" holds this long (kick cancels) before the controls screen. */
const VS_MS = 1500;
/**
 * First show only: the screen assembles itself. Header drops in, tiles ripple
 * in diagonally, previews rise and "Add a fighter" slides in, each piece taking
 * INTRO_MS from its delay.
 */
const INTRO_MS = 450;
const INTRO_TILE_STAGGER_MS = 45;
const INTRO_TILES_MS = 120;
const INTRO_PANELS_MS = 300;
const INTRO_HOST_MS = 220;
/** Cursors and fighters arrive last, once there's something to stand on. */
const INTRO_SETTLED_MS = 750;
let introPlayed = false;

type IntroTarget = Phaser.GameObjects.GameObject & {
  x: number;
  y: number;
  alpha: number;
  setPosition(x: number, y: number): unknown;
  setAlpha(alpha: number): unknown;
};

interface Preview {
  frame: Phaser.GameObjects.Rectangle;
  /** Where the fighter stands: feet anchor, and which way they face. */
  feet: { x: number; y: number };
  facing: 1 | -1;
  fighter: PosePreview | null;
  title: Phaser.GameObjects.Text;
  name: Phaser.GameObjects.Text;
  status: Phaser.GameObjects.Text;
  device: Phaser.GameObjects.Text;
  /** "Press any button", centred in an empty panel. */
  join: Phaser.GameObjects.Text;
}

/** Re-measure the game's parent box (refresh() alone reuses the last measurement) and rescale the canvas to it. */
function refitGame(game: Phaser.Game): void {
  game.scale.getParentBounds();
  game.scale.refresh();
}

export interface CharacterSelectData {
  /** The controller that pressed start on the title screen: it joins as P1. */
  join?: PlayerInputDescriptor;
}

interface PlayerSlot {
  input: PlayerInputDescriptor;
  source: InputSource;
  cursor: number;
  ready: boolean;
  previous: InputFrame;
  /**
   * Joined this frame. Phaser re-dispatches the frame's earlier key events on
   * each new one, so a second key in the same frame replays the joining press
   * into the new source, where it would read as a pick.
   */
  fresh: boolean;
}

/**
 * Grid of fighters from IndexedDB plus the bundled placeholders. "Press any
 * button" assigns each pad/keyboard half to the next free player slot; each
 * player moves a cursor and confirms with punch. The "Add a fighter" panel
 * shows a QR code for the phone and receives fighters live.
 */
export class CharacterSelectScene extends Phaser.Scene {
  private library: LibraryEntry[] = [];
  private players: (PlayerSlot | null)[] = [null, null];
  private tiles!: Phaser.GameObjects.Container;
  private cursors!: Phaser.GameObjects.Graphics;
  /** "P1" / "P2" on the corner of each player's cursor. */
  private cursorTags: Phaser.GameObjects.Text[] = [];
  private previews: Preview[] = [];
  /** Grid page on screen: the one the last moved cursor is on. */
  private page = 0;
  private pageText!: Phaser.GameObjects.Text;
  private pageArrows: Phaser.GameObjects.Text[] = [];
  private vs: { until: number; objects: Phaser.GameObjects.GameObject[] } | null = null;
  /** Decoded voice clips per fighter id, loaded when a cursor first lands on them. */
  private voices = new Map<string, Promise<Record<SoundId, string[]>>>();
  private voiceLines: (Phaser.Sound.BaseSound | null)[] = [null, null];
  private lastVoice = new Map<string, string>();
  private hostText!: Phaser.GameObjects.Text;
  private codeText!: Phaser.GameObjects.Text;
  private expiryText!: Phaser.GameObjects.Text;
  private expiresAt: number | undefined;
  private qrImage: Phaser.GameObjects.Image | null = null;
  private hostStatus: HostStatus | null = null;
  private hostObjects: Phaser.GameObjects.GameObject[] = [];
  /**
   * Compact "Add a fighter": a small panel beside the previews, and the grid
   * takes the whole width. Automatic once there are captured fighters or a phone
   * is linked (it has scanned already); clicking the panel overrides that until
   * the automatic choice changes.
   */
  private compact = false;
  private autoCompact: boolean | null = null;
  private compactOverride: boolean | null = null;
  private noticeText!: Phaser.GameObjects.Text;
  private unsubscribeHost: (() => void) | null = null;
  private thumbUrls: string[] = [];
  private thumbs = new Map<number, Phaser.GameObjects.Image>();
  private cursorPoses: (Phaser.GameObjects.Image | null)[] = [null, null];
  private loadingPoses = new Set<string>();
  private pendingDelete: { fighterId: string; until: number } | null = null;
  /** Tile chosen with the mouse / touch (shows its export / delete buttons). */
  private selected: number | null = null;
  private buttonPressedAt = 0;
  private tileButtons: Phaser.GameObjects.Text[] = [];
  private toolbarCleanup: (() => void) | null = null;
  /** False after shutdown, for async work that finishes late. */
  private alive = false;
  /** When the first-show intro started (game loop time: the scene clock reads 0 until its first frame); null when it isn't playing. */
  private introAt: number | null = null;
  /** No preview fighters until the intro has brought their panels in. */
  private previewsHeld = false;

  constructor() {
    super("character-select");
  }

  private pendingJoin: PlayerInputDescriptor | null = null;

  init(data: CharacterSelectData): void {
    this.pendingJoin = data?.join ?? null;
  }

  create(): void {
    playMenuMusic(this);
    this.library = this.registry.get(REGISTRY.library) ?? [];
    this.players = [null, null];
    this.selected = null;
    this.pendingDelete = null;
    this.tileButtons = [];
    this.cursorPoses = [null, null];
    this.loadingPoses.clear();
    this.page = 0;
    this.vs = null;
    this.hostStatus = null;
    this.hostObjects = [];
    this.qrImage = null;
    this.autoCompact = null;
    this.compactOverride = null;
    this.voiceLines = [null, null];
    this.alive = true;
    this.introAt = introPlayed ? null : this.game.loop.time;
    introPlayed = true;
    const logo = this.add.text(GRID_X, 36, "PHOTO DOJO", { fontSize: "52px", fontStyle: "bold", color: "#f2c14e" });
    const stamp = this.add.text(logo.x + logo.width + 12, 50, "REVIVAL", { fontSize: "18px", fontStyle: "bold", color: "#e8483b", letterSpacing: 4 }).setAngle(-5);
    const subtitle = this.add.text(stamp.x + stamp.width + 28, 60, "Pick your fighters", { fontSize: "22px", color: "#c9c3b8" });
    this.tiles = this.add.container(0, 0);
    this.cursors = this.add.graphics().setDepth(10);
    this.cursorTags = [0, 1].map((i) =>
      this.add.text(0, 0, `P${i + 1}`, { fontSize: "13px", fontStyle: "bold", color: "#121018", backgroundColor: PLAYER_CSS[i], padding: { x: 5, y: 1 } })
        .setOrigin(i, 0).setDepth(12).setVisible(false));
    this.introduce([this.cursors, ...this.cursorTags], INTRO_SETTLED_MS);
    this.buildPager();
    this.previews = [0, 1].map((i) => this.buildPreview(i));
    this.noticeText = this.add.text(0, 0, "", { fontSize: "13px", color: "#a8a196" });
    this.introduce([this.noticeText], INTRO_SETTLED_MS);
    this.updateHostLayout();
    this.refreshGrid();
    this.updatePreviews();

    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => this.onKeyDown(ev));
    this.input.gamepad?.on("down", (pad: Phaser.Input.Gamepad.Gamepad, button: Phaser.Input.Gamepad.Button) => {
      if (button.index === PAD_BUTTON.SELECT) this.openSettings();
      else this.join({ kind: "pad", index: pad.index });
    });
    const settings = this.add.text(1240, 60, "⚙ Settings (Tab)", { fontSize: "20px", color: "#c9c3b8", backgroundColor: "#1c1824", padding: { x: 10, y: 6 } })
      .setOrigin(1, 0).setInteractive({ useHandCursor: true });
    settings.on("pointerover", () => settings.setColor("#f2c14e"));
    settings.on("pointerout", () => settings.setColor("#c9c3b8"));
    settings.on("pointerdown", () => this.openSettings());
    this.introduce([logo, stamp, subtitle, settings], 0, { y: -60 });
    // The preview fighters step in once their panels have landed.
    this.previewsHeld = this.introAt !== null;
    if (this.previewsHeld) this.time.delayedCall(INTRO_SETTLED_MS, () => {
      this.previewsHeld = false;
      this.drawPreviewSprites();
    });
    this.events.on(Phaser.Scenes.Events.RESUME, this.onResume, this);
    this.setupToolbar();
    void this.showStorageNotices();

    const host: HostSession | undefined = this.registry.get(REGISTRY.host);
    this.unsubscribeHost = host?.subscribe((s) => this.showHostStatus(s), (f) => this.onFighterReceived(f)) ?? null;

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    if (this.pendingJoin) this.join(this.pendingJoin);
  }

  private cleanup(): void {
    this.alive = false;
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    this.events.off(Phaser.Scenes.Events.RESUME, this.onResume, this);
    this.toolbarCleanup?.();
    this.input.keyboard?.removeAllListeners("keydown");
    this.input.gamepad?.removeAllListeners("down");
    this.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    this.thumbUrls = [];
  }

  /**
   * First show only: `objects` slide in from `from` (an offset) and fade up,
   * `delay` ms into the intro. Objects made mid-intro (a redrawn grid, the QR
   * arriving) join at the point the intro has reached, not from the start.
   */
  private introduce(objects: IntroTarget[], delay: number, from: { x?: number; y?: number } = {}): void {
    if (this.introAt === null) return;
    const elapsed = this.game.loop.time - this.introAt - delay;
    if (elapsed >= INTRO_MS) return;
    const t0 = Math.max(0, elapsed) / INTRO_MS;
    const ease = Phaser.Math.Easing.Cubic.Out;
    const done = ease(t0);
    for (const o of objects) {
      // Only the axes that move: others may still be laid out after this (the notice text is).
      const to = { alpha: o.alpha, ...(from.x ? { x: o.x } : {}), ...(from.y ? { y: o.y } : {}) };
      o.setPosition(o.x + (from.x ?? 0) * (1 - done), o.y + (from.y ?? 0) * (1 - done));
      o.setAlpha(to.alpha * done);
      this.tweens.add({
        targets: o, ...to,
        delay: Math.max(0, -elapsed),
        duration: INTRO_MS * (1 - t0),
        // The rest of the same curve, rescaled to 0..1.
        ease: (v: number) => (ease(t0 + v * (1 - t0)) - done) / (1 - done),
      });
      o.once(Phaser.GameObjects.Events.DESTROY, () => this.tweens.killTweensOf(o));
    }
  }

  /** Tiles ripple in from the top-left corner. */
  private introTileDelay(index: number): number {
    const slot = index % this.pageSize;
    return INTRO_TILES_MS + (slot % this.cols + Math.floor(slot / this.cols)) * INTRO_TILE_STAGGER_MS;
  }

  // --- library grid ---------------------------------------------------------

  private thumbKey = (f: Fighter) => `thumb:${f.fighterId}`;

  private refreshGrid(): void {
    const missing = this.library.filter((e) => !this.textures.exists(this.thumbKey(e.fighter)));
    if (missing.length) {
      for (const e of missing) {
        const url = URL.createObjectURL(e.fighter.thumbnailBlob);
        this.thumbUrls.push(url);
        this.load.image(this.thumbKey(e.fighter), url);
      }
      this.load.once(Phaser.Loader.Events.COMPLETE, () => this.drawGrid());
      this.load.start();
    }
    this.drawGrid();
  }

  /** Position of a library index's tile within its page. */
  private tilePosition(index: number) {
    const slot = index % this.pageSize;
    return { x: GRID_X + (slot % this.cols) * (TILE + GAP), y: GRID_Y + Math.floor(slot / this.cols) * ROW_H };
  }

  /** The grid widens into the host column when that panel is compact. */
  private get cols(): number {
    return this.compact ? 9 : 6;
  }

  private get pageSize(): number {
    return this.cols * ROWS;
  }

  private get gridWidth(): number {
    return this.cols * (TILE + GAP) - GAP;
  }

  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.library.length / this.pageSize));
  }

  private onPage = (index: number) => Math.floor(index / this.pageSize) === this.page;

  private buildPager(): void {
    const y = GRID_Y + ROWS * ROW_H - 4;
    this.pageText = this.add.text(0, y, "", { fontSize: "15px", color: "#c9c3b8" }).setOrigin(0.5, 0);
    this.pageArrows = [-1, 1].map((dir) => {
      const arrow = this.add.text(dir * 80, y - 4, dir < 0 ? "◀" : "▶", { fontSize: "20px", color: "#c9c3b8", padding: { x: 8, y: 2 } })
        .setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
      arrow.on("pointerover", () => arrow.setColor("#f2c14e"));
      arrow.on("pointerout", () => arrow.setColor("#c9c3b8"));
      arrow.on("pointerdown", () => {
        this.playEffect("tick", 0.3);
        this.showPage((this.page + dir + this.pageCount) % this.pageCount);
      });
      return arrow;
    });
    this.introduce([this.pageText, ...this.pageArrows], INTRO_SETTLED_MS);
  }

  private showPage(page: number): void {
    page = Math.min(Math.max(0, page), this.pageCount - 1);
    if (page === this.page) return;
    this.page = page;
    this.selected = null;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private drawGrid(): void {
    this.tiles.removeAll(true);
    this.tileButtons.forEach((b) => b.destroy());
    this.tileButtons = [];
    this.thumbs.clear();
    // Tiles may have moved (page or grid width changed): poses are placed afresh below.
    this.cursorPoses.forEach((pose) => pose?.destroy());
    this.cursorPoses = [null, null];
    this.page = Math.min(this.page, this.pageCount - 1);
    const paged = this.pageCount > 1;
    this.pageText.setText(paged ? `page ${this.page + 1} / ${this.pageCount}` : "").setVisible(paged);
    const center = GRID_X + this.gridWidth / 2;
    this.pageText.setX(center);
    this.pageArrows.forEach((a, i) => a.setVisible(paged).setX(center + (i ? 80 : -80)));
    this.library.forEach((entry, i) => {
      if (!this.onPage(i)) return;
      const { x, y } = this.tilePosition(i);
      const selected = this.selected === i;
      const bg = this.add.rectangle(x, y, TILE, TILE, 0x241f2e).setOrigin(0).setStrokeStyle(selected ? 3 : 2, selected ? 0xf2c14e : 0x3a3346);
      bg.setInteractive({ useHandCursor: true });
      // Select on pointer-up so a tap on one of the tile's buttons (handled on pointer-down) doesn't also select.
      bg.on("pointerup", () => { if (performance.now() - this.buttonPressedAt > 300) this.clickTile(i); });
      bg.on("pointerover", () => { if (this.selected !== i) bg.setStrokeStyle(2, 0x8a8478); });
      bg.on("pointerout", () => { if (this.selected !== i) bg.setStrokeStyle(2, 0x3a3346); });
      const items: Phaser.GameObjects.GameObject[] = [bg];
      const key = this.thumbKey(entry.fighter);
      if (this.textures.exists(key)) {
        const thumb = this.add.image(x + TILE / 2, y + TILE / 2, key).setDisplaySize(TILE - 10, TILE - 10);
        this.thumbs.set(i, thumb);
        items.push(thumb);
      }
      items.push(this.add.text(x + TILE / 2, y + TILE + 4, entry.fighter.name, { fontSize: "14px", color: "#f3efe6", fixedWidth: TILE + GAP, align: "center" }).setOrigin(0.5, 0));
      if (entry.builtIn) items.push(this.add.text(x + 6, y + TILE - 4, "built-in", { fontSize: "11px", color: "#8a8478" }).setOrigin(0, 1));
      // Buttons live outside the container: Phaser's hit-testing doesn't reliably put container siblings above the tile.
      if (selected) this.tileButtons = this.tileActions(entry, x, y).map((b) => b.setDepth(20));
      this.introduce(items as IntroTarget[], this.introTileDelay(i), { y: 30 });
      this.tiles.add(items);
    });
    this.drawCursors();
  }

  /** Clickable buttons on the selected tile: export, and delete with an inline confirm. */
  private tileActions(entry: LibraryEntry, x: number, y: number): Phaser.GameObjects.Text[] {
    const button = (bx: number, label: string, color: string, onClick: () => void) => {
      const t = this.add.text(bx, y + TILE - 6, label, { fontSize: "13px", fontStyle: "bold", color, backgroundColor: "#121018dd", padding: { x: 6, y: 4 } })
        .setOrigin(0, 1).setInteractive({ useHandCursor: true });
      t.on("pointerdown", (_p: unknown, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation();
        this.buttonPressedAt = performance.now();
        onClick();
      });
      return t;
    };
    const confirming = this.pendingDelete?.fighterId === entry.fighter.fighterId;
    if (confirming) {
      return [
        button(x + 6, "Delete?", "#e8483b", () => void this.deleteEntry(entry)),
        button(x + 72, "Keep", "#f3efe6", () => { this.pendingDelete = null; this.drawGrid(); }),
      ];
    }
    return [
      button(x + 6, "⬇ Export", "#f3efe6", () => void this.exportEntry(entry)),
      ...(entry.builtIn ? [] : [button(x + 86, "🗑", "#e8483b", () => {
        this.pendingDelete = { fighterId: entry.fighter.fighterId, until: performance.now() + 5000 };
        this.drawGrid();
      })]),
    ];
  }

  /**
   * Mouse / touch: select a tile (for its export/delete buttons). A joined player
   * who hasn't picked yet moves their cursor there; clicking the same tile again picks it.
   */
  private clickTile(index: number): void {
    const i = this.players.findIndex((p) => p && !p.ready);
    const chooser = this.players[i];
    if (chooser) {
      if (chooser.cursor === index && this.selected === index) this.setReady(i, true);
      else if (chooser.cursor !== index) this.playEffect("tick", 0.3);
      chooser.cursor = index;
      this.updatePreviews();
    }
    this.selected = index;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private drawCursors(): void {
    this.cursors.clear();
    this.players.forEach((p, i) => {
      const tag = this.cursorTags[i];
      if (!p || !this.library.length || !this.onPage(p.cursor)) return tag.setVisible(false);
      const { x, y } = this.tilePosition(p.cursor);
      const inset = i * 6;
      this.cursors.lineStyle(p.ready ? 7 : 4, PLAYER_COLORS[i], 1).strokeRect(x - 4 + inset, y - 4 + inset, TILE + 8 - 2 * inset, TILE + 8 - 2 * inset);
      // P1's tag in the top-left corner of its outline, P2's in the top-right of its (inset) one.
      tag.setPosition(i ? x + TILE + 4 - inset : x - 4, y - 4 + inset).setVisible(true);
    });
    this.drawCursorPoses();
  }

  /** Win pose (variant 0) or flex (variant 1, the win-2 capture). */
  private winKey = (f: Fighter, variant: 0 | 1) => `win${variant ? "#1" : ""}:${f.fighterId}`;

  /**
   * The fighter under each cursor replaces the tile's thumbnail (same scale, P2
   * facing left): flexing while hovered, win pose once picked. One pose per tile;
   * a ready player's wins.
   */
  private drawCursorPoses(): void {
    const owner = new Map<number, number>();
    const order = [0, 1].sort((a, b) => Number(!!this.players[b]?.ready) - Number(!!this.players[a]?.ready));
    for (const i of order) {
      const p = this.players[i];
      if (p && this.library[p.cursor] && this.onPage(p.cursor) && !owner.has(p.cursor)) owner.set(p.cursor, i);
    }
    const covered = new Set<number>();
    this.players.forEach((p, i) => {
      const entry = p && owner.get(p.cursor) === i ? this.library[p.cursor] : undefined;
      const key = entry && this.winKey(entry.fighter, p!.ready ? 0 : 1);
      const current = this.cursorPoses[i];
      if (current && current.texture.key === key && current.getData("tile") === p!.cursor) {
        covered.add(p!.cursor);
        return;
      }
      current?.destroy();
      this.cursorPoses[i] = null;
      if (!entry || !key) return;
      if (!this.textures.exists(key)) return this.loadWinPoses(entry.fighter);
      const { x, y } = this.tilePosition(p!.cursor);
      this.cursorPoses[i] = this.add.image(x + TILE / 2, y + TILE / 2, key)
        .setDisplaySize(TILE - 10, TILE - 10)
        .setFlipX(i === 1)
        .setDepth(11)
        .setData("tile", p!.cursor);
      this.introduce([this.cursorPoses[i]!], this.introTileDelay(p!.cursor), { y: 30 });
      covered.add(p!.cursor);
    });
    this.thumbs.forEach((thumb, i) => thumb.setVisible(!covered.has(i)));
    this.drawPreviewSprites();
  }

  /** Both at once: a hovered fighter is usually picked next. Older fighters without a flex flex with their win pose. */
  private loadWinPoses(fighter: Fighter): void {
    const blobs: [string, Blob][] = [
      [this.winKey(fighter, 0), fighter.poses.win.imageBlob],
      [this.winKey(fighter, 1), fighter.poseVariants.win?.[0]?.imageBlob ?? fighter.poses.win.imageBlob],
    ];
    let queued = false;
    for (const [key, blob] of blobs) {
      if (this.textures.exists(key) || this.loadingPoses.has(key)) continue;
      this.loadingPoses.add(key);
      queued = true;
      const url = URL.createObjectURL(blob);
      this.thumbUrls.push(url);
      this.load.image(key, url);
      this.load.once(`filecomplete-image-${key}`, () => {
        this.loadingPoses.delete(key);
        if (this.alive) this.drawCursorPoses();
      });
    }
    if (queued) this.load.start();
  }

  /** The boot scene already added it to the registry library. */
  private onFighterReceived(fighter: Fighter): void {
    this.voices.delete(fighter.fighterId);
    this.library = this.registry.get(REGISTRY.library) ?? this.library;
    this.afterLibraryGrew(fighter);
  }

  private addFighter(fighter: Fighter): void {
    this.voices.delete(fighter.fighterId);
    const replacing = this.library.some((e) => e.fighter.fighterId === fighter.fighterId);
    this.library = [{ fighter, builtIn: false }, ...this.library.filter((e) => e.fighter.fighterId !== fighter.fighterId)];
    if (replacing) {
      this.registry.set(REGISTRY.library, this.library);
      this.refreshGrid();
      return this.setToolbarStatus(`Updated ${fighter.name}`);
    }
    this.registry.set(REGISTRY.library, this.library);
    this.afterLibraryGrew(fighter);
  }

  private afterLibraryGrew(fighter: Fighter): void {
    // Keep cursors on the same fighters.
    for (const p of this.players) if (p) p.cursor = Math.min(this.library.length - 1, p.cursor + 1);
    if (this.selected !== null) this.selected = Math.min(this.library.length - 1, this.selected + 1);
    this.updateHostLayout();
    this.refreshGrid();
    this.setToolbarStatus(`Added ${fighter.name}`);
  }

  // --- players ----------------------------------------------------------------

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.repeat) return;
    if (ev.keyCode === KEY.TAB) {
      ev.preventDefault();
      return this.openSettings();
    }
    const layout = KeyboardInputSource.layoutForKey(ev.keyCode);
    if (layout) this.join({ kind: "keyboard", layout });
  }

  /** "Press any button": the first unassigned controller takes the next free slot. */
  private join(input: PlayerInputDescriptor): void {
    if (this.players.some((p) => p && sameInput(p.input, input))) return;
    const slot = this.players.findIndex((p) => p === null);
    if (slot < 0) return;
    const source = createInputSource(this, input);
    const cursor = Math.min(slot, Math.max(0, this.library.length - 1));
    this.players[slot] = { input, source, cursor, ready: false, previous: source.read(), fresh: true };
    // "That's you": a pad buzzes when it joins.
    if (getOptions(this.registry).rumble) source.rumble?.(JOIN_RUMBLE);
    this.playEffect("tick", 0.6);
    this.showPage(Math.floor(cursor / this.pageSize));
    this.updatePreviews();
    this.drawCursors();
  }

  /** Picking plays the fighter's victory line; un-picking cuts it off. `quiet`: no pick / un-pick sound. */
  private setReady(i: number, ready: boolean, quiet = false): void {
    const p = this.players[i];
    if (!p || p.ready === ready) return;
    p.ready = ready;
    if (!quiet) this.playEffect(ready ? "hit" : "block", ready ? 0.6 : 0.4);
    this.stopVoice(i);
    const entry = this.library[p.cursor];
    if (ready && entry) void this.playWinLine(i, entry.fighter);
  }

  private fighterVoices(fighter: Fighter): Promise<Record<SoundId, string[]>> {
    let voices = this.voices.get(fighter.fighterId);
    if (!voices) {
      voices = loadFighterSounds(this, fighter, `select:${fighter.fighterId}`);
      this.voices.set(fighter.fighterId, voices);
    }
    return voices;
  }

  private async playWinLine(i: number, fighter: Fighter): Promise<void> {
    const takes = (await this.fighterVoices(fighter)).win;
    const p = this.players[i];
    // Still picked by the time the clips decoded?
    if (!this.alive || !p?.ready || this.library[p.cursor]?.fighter !== fighter) return;
    const key = pickTake(takes, this.lastVoice.get(fighter.fighterId));
    this.lastVoice.set(fighter.fighterId, key);
    const volume = 0.9 * getOptions(this.registry).voiceVolume;
    if (volume <= 0 || !this.cache.audio.exists(key)) return;
    this.stopVoice(i);
    // The newest pick has the floor: the other player's line fades out.
    this.voiceLines.forEach((other, j) => { if (other && j !== i) this.fadeOutVoice(j); });
    const line = this.sound.add(key, { volume });
    line.once(Phaser.Sound.Events.COMPLETE, () => {
      if (this.voiceLines[i] === line) this.voiceLines[i] = null;
      this.tweens.killTweensOf(line); // it may end mid fade-out
      line.destroy();
    });
    line.play();
    this.voiceLines[i] = line;
  }

  private fadeOutVoice(i: number): void {
    const line = this.voiceLines[i];
    if (!line) return;
    this.voiceLines[i] = null;
    this.tweens.add({ targets: line, volume: 0, duration: VOICE_FADE_MS, onComplete: () => { line.stop(); line.destroy(); } });
  }

  /** Menu sounds: the "Game volume" setting. */
  private playEffect(id: GameSoundId, volume: number): void {
    const v = volume * getOptions(this.registry).gameVolume;
    if (v > 0 && this.cache.audio.exists(gameSoundKey(id))) this.sound.play(gameSoundKey(id), { volume: v });
  }

  private stopVoice(i: number): void {
    const line = this.voiceLines[i];
    this.voiceLines[i] = null;
    line?.stop();
    line?.destroy();
  }

  // --- previews ---------------------------------------------------------------

  private buildPreview(i: number): Preview {
    const x = GRID_X + i * (PANEL_W + 20);
    const right = i === 1; // P2's panel mirrors P1's: fighter on the outside, facing in
    const feetX = right ? x + PANEL_W - 105 : x + 105;
    const textX = right ? x + PANEL_W - 215 : x + 215;
    const text = (y: number, style: Phaser.Types.GameObjects.Text.TextStyle) =>
      this.add.text(textX, y, "", { wordWrap: { width: PREVIEW_TEXT_W }, align: right ? "right" : "left", ...style }).setOrigin(right ? 1 : 0, 0);
    const preview: Preview = {
      frame: this.add.rectangle(x, PANEL_Y, PANEL_W, PANEL_H, 0x1c1824).setOrigin(0),
      feet: { x: feetX, y: PANEL_Y + PANEL_H - 8 },
      facing: right ? -1 : 1,
      fighter: null,
      title: text(PANEL_Y + 14, { fontSize: "34px", fontStyle: "bold", color: PLAYER_CSS[i] }).setText(`P${i + 1}`),
      name: text(PANEL_Y + 60, { fontSize: "26px", fontStyle: "bold", color: "#f3efe6" }),
      status: text(PANEL_Y + 136, { fontSize: "17px", color: PLAYER_CSS[i], lineSpacing: 4 }),
      device: text(PANEL_Y + PANEL_H - 40, { fontSize: "13px", color: "#8a8478" }),
      join: this.add.text(x + PANEL_W / 2, PANEL_Y + PANEL_H / 2 + 20, "", { fontSize: "20px", color: PLAYER_CSS[i], align: "center", lineSpacing: 8 }).setOrigin(0.5),
    };
    preview.title.setPosition(right ? x + PANEL_W - 20 : x + 20, PANEL_Y + 14).setOrigin(right ? 1 : 0, 0);
    // One container so the intro moves the panel as a whole; above the VS dimmer.
    const panel = this.add.container(0, 0, [preview.frame, preview.title, preview.name, preview.status, preview.device, preview.join]).setDepth(PREVIEW_DEPTH);
    this.introduce([panel], INTRO_PANELS_MS + i * 80, { y: 120 });
    return preview;
  }

  private updatePreviews(): void {
    const alone = this.players.filter(Boolean).length === 1;
    this.previews.forEach((v, i) => {
      const p = this.players[i];
      const entry = p && this.library[p.cursor];
      v.frame.setStrokeStyle(p?.ready ? 4 : 2, p ? PLAYER_COLORS[i] : 0x3a3346, p ? 1 : 0.6);
      v.title.setAlpha(p ? 1 : 0.5);
      v.name.setText(entry ? entry.fighter.name : "");
      v.join.setText(p ? "" : `Press any button to join\n(gamepad, ${actionKeyLabel("p1", "punch")}, or ${actionKeyLabel("p2", "punch")})`);
      v.status.setText(
        !p ? ""
        : !p.ready ? "punch: pick\nkick: leave"
        : alone ? "READY!\npunch: practice\nkick: change"
        : "READY!\nkick: change",
      ).setY(PANEL_Y + 64 + v.name.height + 12);
      v.device.setText(p ? describeInput(p.input) : "");
      // Have the victory line ready by the time they pick.
      if (entry) void this.fighterVoices(entry.fighter);
    });
    this.drawPreviewSprites();
  }

  /**
   * The same pose as the tile, animated (PosePreview): breathing, and morphing
   * from flex to win pose on a pick (and back on un-pick).
   */
  private drawPreviewSprites(): void {
    if (this.previewsHeld) return;
    this.previews.forEach((v, i) => {
      const p = this.players[i];
      const entry = p && this.library[p.cursor];
      const keys = entry && ([0, 1] as const).map((variant) => this.winKey(entry.fighter, variant));
      if (!entry || !keys!.every((k) => this.textures.exists(k))) {
        if (entry) this.loadWinPoses(entry.fighter);
        v.fighter?.destroy();
        v.fighter = null;
        return;
      }
      const pose: PreviewPose = p.ready ? "win" : "flex";
      if (v.fighter?.fighterId === entry.fighter.fighterId) return v.fighter.setPose(pose, this.time.now);
      v.fighter?.destroy();
      const geometry = geometryOf(entry.fighter);
      // Flex is the win-2 capture; fighters without one flex with their win pose.
      const capture = (variant: 0 | 1): PreviewCapture => ({
        texture: keys![variant],
        landmarks: frameGeometry(geometry, "win", variant).landmarks,
        anchor: groundAnchorFor(geometry, "win", variant),
      });
      v.fighter = new PosePreview(this, entry.fighter.fighterId, { win: capture(0), flex: capture(1) }, v.feet,
        PREVIEW_SIZE / SPRITE_CANVAS_SIZE, v.facing, PREVIEW_DEPTH, pose, this.time.now);
    });
  }

  // --- VS ---------------------------------------------------------------------

  private showVs(): void {
    const cx = GRID_X + this.gridWidth / 2;
    const objects = [
      this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x0b0910, 0.7).setOrigin(0).setDepth(25),
      this.add.text(cx, 270, "VS", { fontSize: "120px", fontStyle: "bold", color: "#f2c14e", stroke: "#121018", strokeThickness: 10 }).setOrigin(0.5).setDepth(30),
      this.add.text(cx, 360, "kick to cancel", { fontSize: "16px", color: "#c9c3b8" }).setOrigin(0.5, 0).setDepth(30),
    ];
    this.vs = { until: this.time.now + VS_MS, objects };
  }

  private hideVs(): void {
    this.vs?.objects.forEach((o) => o.destroy());
    this.vs = null;
  }


  // --- settings ---------------------------------------------------------------

  private openSettings(): void {
    this.scene.pause();
    this.scene.launch("settings", { returnTo: "character-select" });
  }

  /** Back from settings: key bindings may have changed, and presses made there don't count here. */
  private onResume(): void {
    for (const p of this.players) {
      if (!p) continue;
      p.previous = p.source.read();
      p.source.pausePressed();
    }
    updateMenuMusicVolume(this); // Settings may have changed it
    this.updatePreviews();
  }

  update(): void {
    this.updateExpiry();
    for (const v of this.previews) v.fighter?.update(this.time.now);
    let changed = false;
    this.players.forEach((p, i) => {
      if (!p) return;
      if (!p.source.connected && p.input.kind === "pad") {
        this.players[i] = null;
        changed = true;
        return;
      }
      const now = p.source.read();
      if (p.fresh) {
        p.fresh = false;
        p.previous = now;
        return;
      }
      const pressed = (k: keyof InputFrame) => now[k] && !p.previous[k];
      const n = this.library.length;
      if (!p.ready && n) {
        let c = p.cursor;
        if (pressed("left")) c = (c - 1 + n) % n;
        if (pressed("right")) c = (c + 1) % n;
        if (pressed("up") && c - this.cols >= 0) c -= this.cols;
        if (pressed("down") && c + this.cols < n) c += this.cols;
        if (c !== p.cursor) {
          this.playEffect("tick", 0.3);
          p.cursor = c;
          this.showPage(Math.floor(c / this.pageSize));
          changed = true;
        }
        if (pressed("punch")) { this.setReady(i, true); changed = true; }
      } else if (pressed("kick")) {
        this.setReady(i, false);
        changed = true;
      } else if (pressed("punch") && this.players.filter(Boolean).length === 1) {
        p.previous = now;
        return this.startPractice(p);
      }
      if (!p.ready && pressed("kick") && !changed) {
        this.players[i] = null; // leave the slot
        this.playEffect("block", 0.3);
        changed = true;
      }
      p.previous = now;
    });
    if (changed) {
      this.updatePreviews();
      this.drawCursors();
    }
    if (this.pendingDelete && performance.now() > this.pendingDelete.until) {
      this.pendingDelete = null;
      this.drawGrid();
    }
    const [a, b] = this.players;
    const bothReady = !!(a?.ready && b?.ready && this.library.length);
    if (bothReady && !this.vs) this.showVs();
    if (!bothReady && this.vs) this.hideVs();
    if (bothReady && this.vs && this.time.now >= this.vs.until) this.startFight(a!, b!);
  }

  private startFight(a: PlayerSlot, b: PlayerSlot): void {
    const data: FightSceneData = {
      entries: [this.library[a.cursor], this.library[b.cursor]],
      inputs: [a.input, b.input],
    };
    void setSetting("controllerMapping", { p1: a.input, p2: b.input }).catch(() => {});
    startMatch(this, data);
  }

  /** One player against a scripted dummy: another fighter from the roster (or the same one). */
  startPractice(p: PlayerSlot): void {
    const mine = this.library[p.cursor];
    const dummy = this.library.find((e) => e.fighter.fighterId !== mine.fighter.fighterId) ?? mine;
    const data: FightSceneData = { entries: [mine, dummy], inputs: [p.input, { kind: "dummy" }], practice: true };
    startMatch(this, data);
  }

  // --- add a fighter (QR + room code) ----------------------------------------

  /** Switch the panel (and the grid width) between full and compact when the choice changes. */
  private updateHostLayout(): void {
    const auto = this.library.some((e) => !e.builtIn) || (this.hostStatus?.phones ?? 0) > 0;
    if (auto !== this.autoCompact) {
      this.autoCompact = auto;
      this.compactOverride = null;
    }
    const compact = this.compactOverride ?? auto;
    if (compact === this.compact && this.hostObjects.length) return;
    this.compact = compact;
    this.buildHostPanel();
    if (this.hostStatus) this.fillHostStatus(this.hostStatus);
    // The page size changed: show the page of the first joined player's cursor.
    const anchor = this.players.find(Boolean)?.cursor ?? 0;
    this.page = Math.floor(anchor / this.pageSize);
    this.selected = null;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private buildHostPanel(): void {
    this.hostObjects.forEach((o) => o.destroy());
    this.qrImage?.destroy();
    this.qrImage = null;
    const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => (this.hostObjects.push(o), o);
    const text = (x: number, y: number, size: number, color: string, extra: Phaser.Types.GameObjects.Text.TextStyle = {}) =>
      add(this.add.text(x, y, "", { fontSize: `${size}px`, color, align: "center", ...extra }).setOrigin(0.5, 0));
    const [x, y, h] = this.compact ? [HOST_X, PANEL_Y, PANEL_H] : [HOST_X, GRID_Y, 480];
    const bg = add(this.add.rectangle(x, y, HOST_W, h, 0x1c1824).setOrigin(0).setStrokeStyle(2, 0xf2c14e));
    bg.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
      this.compactOverride = !this.compact;
      this.updateHostLayout();
    });
    const hint = this.compact ? "click to enlarge" : this.autoCompact || this.compactOverride !== null ? "click to shrink" : "";
    if (this.compact) {
      // QR on the left, code and status on the right.
      const cx = x + 265;
      text(x + HOST_W / 2, y + 12, 20, "#f2c14e", { fontStyle: "bold" }).setText("ADD A FIGHTER");
      this.codeText = text(cx, y + 62, 28, "#f3efe6", { fontStyle: "bold", fontFamily: "monospace" });
      this.expiryText = text(cx, y + 100, 12, "#8a8478");
      this.hostText = text(cx, y + 124, 14, "#c9c3b8", { wordWrap: { width: 160 } });
      text(x + HOST_W / 2, y + h - 26, 12, "#8a8478").setText(hint);
    } else {
      const cx = x + HOST_W / 2;
      text(cx, y + 14, 26, "#f2c14e", { fontStyle: "bold" }).setText("ADD A FIGHTER");
      text(cx, y + 48, 15, "#c9c3b8").setText("Scan with a phone to capture yourself");
      this.codeText = text(cx, y + 300, 40, "#f3efe6", { fontStyle: "bold", fontFamily: "monospace" });
      this.expiryText = text(cx, y + 344, 14, "#8a8478");
      this.hostText = text(cx, y + 366, 15, "#c9c3b8", { wordWrap: { width: 330 } });
      text(cx, y + h - 20, 12, "#8a8478").setText(hint);
    }
    this.introduce(this.hostObjects as IntroTarget[], INTRO_HOST_MS, { x: 80 });
    // Storage notices: under the panel, or under the previews' row when the panel is down there.
    this.noticeText.setPosition(this.compact ? GRID_X : HOST_X, this.compact ? 100 : GRID_Y + h + 16).setWordWrapWidth(this.compact ? 1180 : HOST_W);
    this.expiresAt = undefined;
  }

  private captureUrl(roomCode: string): string {
    return `${location.origin}${import.meta.env.BASE_URL}capture?room=${roomCode}`;
  }

  private async showQr(roomCode: string): Promise<void> {
    const key = `qr:${roomCode}`;
    if (!this.textures.exists(key)) {
      const dataUrl = await QRCode.toDataURL(this.captureUrl(roomCode), { margin: 1, width: 240, color: { dark: "#121018", light: "#f3efe6" } });
      await new Promise<void>((resolve) => {
        this.textures.once(Phaser.Textures.Events.ADD, () => resolve());
        this.textures.addBase64(key, dataUrl);
      });
    }
    if (!this.alive) return;
    // The room may have changed (or the panel been rebuilt) while the QR was rendering.
    if (!this.alive || this.codeText.text !== roomCode) return;
    this.qrImage?.destroy();
    this.qrImage = this.compact
      ? this.add.image(HOST_X + 20 + 75, PANEL_Y + 48 + 75, key).setDisplaySize(150, 150)
      : this.add.image(HOST_X + HOST_W / 2, GRID_Y + 186, key).setDisplaySize(220, 220);
    this.introduce([this.qrImage], INTRO_HOST_MS, { x: 80 });
  }

  /** "code refreshes in 3:12" under the room code; urgent in the last 30 s. */
  private updateExpiry(): void {
    const left = this.expiresAt === undefined ? null : this.expiresAt - Date.now();
    const text = left === null ? "" : left > 0 ? `code refreshes in ${formatCountdown(left)}` : "getting a new code…";
    if (this.expiryText.text !== text) this.expiryText.setText(text).setColor(left !== null && left < 30_000 ? "#f2c14e" : "#8a8478");
  }

  private showHostStatus(s: HostStatus): void {
    if (!this.alive) return;
    this.hostStatus = s;
    this.updateHostLayout();
    this.fillHostStatus(s);
  }

  private fillHostStatus(s: HostStatus): void {
    this.expiresAt = s.expiresAt;
    this.updateExpiry();
    if (s.roomCode && this.codeText.text !== s.roomCode) {
      this.codeText.setText(s.roomCode);
      void this.showQr(s.roomCode);
    }
    const local = ["localhost", "127.0.0.1"].includes(location.hostname)
      ? "\nTip: open this page via your network address so the phone can reach it."
      : "";
    const text =
      s.kind === "connecting" ? "Opening a room…"
      : s.kind === "waiting" ? (
        s.phones ? `📱 ${s.phones} phone${s.phones > 1 ? "s" : ""} connected — capture away!`
        : this.compact ? "Scan with a phone to add yourself"
        : `Or open ${location.host}/capture and enter the code.${local}`)
      : s.kind === "receiving" ? `Receiving ${s.name}… ${Math.round(s.progress * 100)}%`
      : s.kind === "received" ? `${s.name} joined the dojo!`
      : s.message;
    this.hostText.setText(text);
  }

  // --- storage notices + toolbar ---------------------------------------------

  private async showStorageNotices(): Promise<void> {
    const notes: string[] = [];
    const hasCaptured = this.library.some((e) => !e.builtIn);
    if (hasCaptured && !(await isStoragePersisted())) {
      notes.push("⚠ This browser may clear saved fighters under storage pressure — export the ones you want to keep.");
    }
    const shown = await getSetting("backupNoticeShown").catch(() => true);
    if (!shown) {
      notes.push("Fighters live only in this browser (no cloud backup). Use Export to keep a copy.");
      void setSetting("backupNoticeShown", true).catch(() => {});
    }
    if (this.alive) this.noticeText.setText(notes.join("   "));
  }



  private setToolbarStatus(text: string): void {
    const el = document.getElementById("toolbar-status");
    if (el) el.textContent = text;
  }

  private setupToolbar(): void {
    const toolbar = document.getElementById("toolbar");
    const fileInput = document.getElementById("import-file") as HTMLInputElement | null;
    if (!toolbar || !fileInput) return;
    toolbar.hidden = false;
    // Showing the toolbar shrinks the game's box; Phaser caches its size and position (for scaling and pointer input).
    requestAnimationFrame(() => refitGame(this.game));
    const onClick = async (ev: MouseEvent) => {
      const action = (ev.target as HTMLElement).closest("button")?.dataset.action;
      if (action === "import") fileInput.click();
      if (action === "export-all") await this.exportAll();
    };
    const onFile = async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const fighter = await importFighterFile(file);
        await saveFighter(fighter);
        this.addFighter(fighter);
        this.setToolbarStatus(`Imported ${fighter.name}`);
      } catch (err) {
        this.setToolbarStatus(`Import failed: ${(err as Error).message}`);
      }
    };
    toolbar.addEventListener("click", onClick);
    fileInput.addEventListener("change", onFile);
    this.toolbarCleanup = () => {
      toolbar.hidden = true;
      requestAnimationFrame(() => refitGame(this.game));
      toolbar.removeEventListener("click", onClick);
      fileInput.removeEventListener("change", onFile);
      this.setToolbarStatus("");
    };
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private async exportEntry(entry: LibraryEntry): Promise<void> {
    this.download(await exportFighterFile(entry.fighter), fighterFileName(entry.fighter));
    this.setToolbarStatus(`Exported ${fighterFileName(entry.fighter)}`);
  }

  /** One .photodojo file per captured fighter. */
  private async exportAll(): Promise<void> {
    const captured = this.library.filter((e) => !e.builtIn);
    if (!captured.length) return this.setToolbarStatus("No captured fighters to export yet");
    for (const entry of captured) this.download(await exportFighterFile(entry.fighter), fighterFileName(entry.fighter));
    this.setToolbarStatus(`Exported ${captured.length} fighter${captured.length > 1 ? "s" : ""}`);
  }

  private async deleteEntry(entry: LibraryEntry): Promise<void> {
    if (entry.builtIn) return;
    const id = entry.fighter.fighterId;
    this.pendingDelete = null;
    await deleteFighter(id);
    this.library = this.library.filter((e) => e.fighter.fighterId !== id);
    this.registry.set(REGISTRY.library, this.library);
    this.selected = null;
    this.updateHostLayout();
    this.players.forEach((p, i) => {
      if (!p) return;
      p.cursor = Math.min(p.cursor, Math.max(0, this.library.length - 1));
      this.setReady(i, false, true);
    });
    this.drawGrid();
    this.updatePreviews();
    this.setToolbarStatus(`Deleted ${entry.fighter.name}`);
  }

}
