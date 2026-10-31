import Phaser from "phaser";
import { exportFighterFile, fighterFileName, importFighterFile } from "../../shared/fighter-codec";
import { ARCHETYPES } from "../../shared/archetypes";
import { SPRITE_CANVAS_SIZE, type Fighter, type SoundId } from "../../shared/fighter-model";
import { frameGeometry, groundAnchorFor } from "../../shared/frame-data";
import { CAPTURE_TARGET_COUNT } from "../../shared/pose-definitions";
import { deleteFighter, getSetting, isStoragePersisted, saveImportedFighter, setSetting } from "../../shared/fighter-storage";
import type { InputFrame } from "../../simulation/input-frame";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { playGameSound } from "../game-sounds";
import { announce } from "../announcer";
import { PAD_BUTTON } from "../input/gamepad-input-source";
import { createInputSource, describeInput, sameInput, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { KeyboardInputSource } from "../input/keyboard-input-source";
import { KEY, actionKeyLabel } from "../input/key-bindings";
import { CPU_LEVEL_IDS, CPU_LEVEL_NAMES, type CpuLevel } from "../input/cpu-player";
import { JOIN_RUMBLE } from "../input/rumble";
import { forgetFighterRecord, headToHead, recordOf, winLoss } from "../fighter-records";
import type { FighterStatsSceneData } from "./fighter-stats-scene";
import type { RenameResult, RenameSceneData } from "./rename-scene";
import { hasPlayed } from "../played-fighters";
import { getOptions } from "../options";
import { loadFighterSounds } from "../render/fighter-sprite-view";
import { PosePreview, type PreviewCapture, type PreviewPose } from "../render/pose-preview";
import { PLAYER_COLORS } from "../render/stage";
import { pickTake } from "../sound-choice";
import { REGISTRY } from "./boot-scene";
import type { FightSceneData } from "./fight-scene";
import { startMatch } from "./stage-select-scene";
import type { SeriesSetupData } from "./series-setup-scene";
import { MIN_ENTRANTS } from "../series";
import { playMenuMusic, updateMenuMusicVolume } from "../menu-music";
import { canFullscreen, toggleFullscreen, watchFullscreen } from "../fullscreen";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, popBox, RADIUS, SHADOW, stamp, type PopBoxOptions } from "../render/theme";

const ROWS = 2;
const TILE = 120;
const GAP = 12;
const ROW_H = TILE + 28;
const GRID_X = 40;
const GRID_Y = 116;
/** "Add a fighter" column, while the panel is full size. */
const ADD_X = 880;
const ADD_W = 360;
const PLAYER_CSS = [COLOR.bad, COLOR.p2];
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
const INTRO_ADD_MS = 220;
/** Cursors and fighters arrive last, once there's something to stand on. */
const INTRO_SETTLED_MS = 750;
let introPlayed = false;
/** The last CPU level picked for a match (this session). */
let cpuLevel: CpuLevel = "easy";
/** Times each fighter was replaced (imported again, or edited) since the page loaded: part of its image keys. */
const imageRevisions = new Map<string, number>();

type IntroTarget = Phaser.GameObjects.GameObject & {
  x: number;
  y: number;
  alpha: number;
  setPosition(x: number, y: number): unknown;
  setAlpha(alpha: number): unknown;
};

interface Preview {
  /** The panel box (a Graphics at the panel's top-left), redrawn when its border changes. */
  frame: Phaser.GameObjects.Graphics;
  /** The READY! stamp, at the top of the status lines once picked. */
  readyStamp: Phaser.GameObjects.Container;
  /** Where the fighter stands: feet anchor, and which way they face. */
  feet: { x: number; y: number };
  facing: 1 | -1;
  fighter: PosePreview | null;
  title: Phaser.GameObjects.Text;
  /** The fighter's career (fighter-records.ts), above the name; blank before their first match. */
  record: Phaser.GameObjects.Text;
  name: Phaser.GameObjects.Text;
  /** The archetype and its signature move, under the name. */
  style: Phaser.GameObjects.Text;
  status: Phaser.GameObjects.Text;
  /** Points at the tutorial (gold, just under the name); pulses for a fighter nobody has played yet. */
  tip: Phaser.GameObjects.Text;
  tipPulses: boolean;
  device: Phaser.GameObjects.Text;
  /** "Press any button", centred in an empty panel. */
  join: Phaser.GameObjects.Text;
}

/** The width of a `stamp(…, size)` container's box (it's centred on its position). */
function stampWidth(s: Phaser.GameObjects.Container, size: number): number {
  return (s.list[1] as Phaser.GameObjects.Text).width + size * 1.1;
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
 * A lone player's opponent, in the empty slot, driven by their controller: first
 * its fighter, then (picked) Match against the CPU at a level, or Practice.
 */
interface CpuSlot {
  slot: 0 | 1;
  cursor: number;
  picked: boolean;
  /** 0: Match, 1: Practice. */
  option: 0 | 1;
}

/** What a slot shows: a player, or the CPU opponent. */
interface SlotView {
  cursor: number;
  ready: boolean;
  cpu: boolean;
}

/**
 * Grid of fighters from IndexedDB plus the bundled placeholders. "Press any
 * button" assigns each pad/keyboard half to the next free player slot; each
 * player moves a cursor and confirms with punch. The "Add a fighter" panel
 * opens the Character Studio (its own page: /studio, which comes back to
 * /?to=select) or imports a fighter file.
 */
export class CharacterSelectScene extends Phaser.Scene {
  private library: LibraryEntry[] = [];
  private players: (PlayerSlot | null)[] = [null, null];
  private cpu: CpuSlot | null = null;
  private tiles!: Phaser.GameObjects.Container;
  private cursors!: Phaser.GameObjects.Graphics;
  /** "P1" / "P2" on the corner of each player's cursor. */
  private cursorTags: Phaser.GameObjects.Text[] = [];
  /** The cursor tags' player-colour chips, under the tags but over the cursor poses. */
  private tagChips!: Phaser.GameObjects.Graphics;
  private previews: Preview[] = [];
  /** The two picks' head-to-head, between the panels. */
  private rivalry!: { container: Phaser.GameObjects.Container; bg: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text; left: Phaser.GameObjects.Text; right: Phaser.GameObjects.Text };
  /** Grid page on screen: the one the last moved cursor is on. */
  private page = 0;
  private pageText!: Phaser.GameObjects.Text;
  private pageArrows: Phaser.GameObjects.Text[] = [];
  private vs: { until: number; objects: Phaser.GameObjects.GameObject[] } | null = null;
  /** Decoded voice clips per fighter id, loaded when a cursor first lands on them. */
  private voices = new Map<string, Promise<Record<SoundId, string[]>>>();
  private voiceLines: (Phaser.Sound.BaseSound | null)[] = [null, null];
  private lastVoice = new Map<string, string>();
  private addObjects: Phaser.GameObjects.GameObject[] = [];
  /**
   * Compact "Add a fighter": a small panel beside the previews, and the grid
   * takes the whole width. Automatic once there are captured fighters; clicking
   * the panel overrides that until the automatic choice changes.
   */
  private compact = false;
  /** The panel and grid have been laid out since the scene started. */
  private laidOut = false;
  /**
   * A tournament / king of the hill is running: no studio (leaving the page
   * would end it), so no panel, and the grid takes the whole width.
   */
  private seriesRunning = false;
  private autoCompact: boolean | null = null;
  private compactOverride: boolean | null = null;
  private noticeText!: Phaser.GameObjects.Text;
  private thumbUrls: string[] = [];
  private thumbs = new Map<number, Phaser.GameObjects.Image>();
  private cursorPoses: (Phaser.GameObjects.Image | null)[] = [null, null];
  private loadingPoses = new Set<string>();
  private pendingDelete: { fighterId: string; until: number } | null = null;
  /** Under the Party modes button: why it can't start yet. */
  private seriesHint!: Phaser.GameObjects.Text;
  /** Tile chosen with the mouse / touch (shows its export / delete buttons). */
  private selected: number | null = null;
  private buttonPressedAt = 0;
  private tileButtons: (Phaser.GameObjects.Text | Phaser.GameObjects.Graphics)[] = [];
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
    announce(this, "choose-fighter");
    this.library = this.registry.get(REGISTRY.library) ?? [];
    this.players = [null, null];
    this.cpu = null;
    this.selected = null;
    this.pendingDelete = null;
    this.tileButtons = [];
    this.cursorPoses = [null, null];
    this.loadingPoses.clear();
    this.page = 0;
    this.vs = null;
    this.addObjects = [];
    this.laidOut = false;
    this.seriesRunning = this.registry.has(REGISTRY.series);
    this.autoCompact = null;
    this.compactOverride = null;
    this.voiceLines = [null, null];
    this.alive = true;
    this.introAt = introPlayed ? null : this.game.loop.time;
    introPlayed = true;
    drawBackdrop(this);
    const logo = this.add.text(GRID_X, 36, "FOTO FIGHTER", displayText(52, COLOR.accent));
    const subtitle = this.add.text(logo.x + logo.width + 28, 58, "Pick your fighters", bodyText(22, COLOR.muted, 600));
    this.tiles = this.add.container(0, 0);
    this.cursors = this.add.graphics().setDepth(10);
    this.tagChips = this.add.graphics().setDepth(12);
    this.cursorTags = [0, 1].map((i) =>
      this.add.text(0, 0, `P${i + 1}`, displayText(14, COLOR.ink, { outline: false, padding: { left: 6, right: 6, top: 2, bottom: 2 } }))
        .setOrigin(i, 0).setDepth(13).setVisible(false));
    this.introduce([this.cursors, this.tagChips, ...this.cursorTags], INTRO_SETTLED_MS);
    this.buildPager();
    this.previews = [0, 1].map((i) => this.buildPreview(i));
    this.buildRivalry();
    this.noticeText = this.add.text(0, 0, "", bodyText(13, COLOR.muted, 600));
    this.introduce([this.noticeText], INTRO_SETTLED_MS);
    this.updateAddLayout();
    this.refreshGrid();
    this.updatePreviews();

    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => this.onKeyDown(ev));
    this.input.gamepad?.on("down", (pad: Phaser.Input.Gamepad.Gamepad, button: Phaser.Input.Gamepad.Button) => {
      if (button.index === PAD_BUTTON.SELECT) this.openSettings();
      else if (button.index === PAD_BUTTON.START && this.players.some((p) => p?.input.kind === "pad" && p.input.index === pad.index)) this.openSeries();
      else this.join({ kind: "pad", index: pad.index });
    });
    const [settings, settingsBox] = this.headerButton(1240, 56, "⚙ Settings (Tab)", 20, () => this.openSettings());
    const [modes, modesBox] = this.headerButton(settings.x - settings.width - 12, 56, "🏆 Party modes (T)", 18, () => this.openSeries());
    this.seriesHint = this.add.text(modes.x - modes.width / 2, 100, "", bodyText(14, COLOR.accent, 800)).setOrigin(0.5, 0).setDepth(30);
    this.introduce([logo, subtitle, settingsBox, settings, modesBox, modes], 0, { y: -60 });
    // The preview fighters step in once their panels have landed.
    this.previewsHeld = this.introAt !== null;
    if (this.previewsHeld) this.time.delayedCall(INTRO_SETTLED_MS, () => {
      this.previewsHeld = false;
      this.drawPreviewSprites();
    });
    this.events.on(Phaser.Scenes.Events.RESUME, this.onResume, this);
    this.setupToolbar();
    void this.showStorageNotices();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    if (this.pendingJoin) this.join(this.pendingJoin);
  }

  /** A header button (right-aligned at x): display text on a panel box whose border and text go gold on hover. */
  private headerButton(x: number, y: number, label: string, size: number, onClick: () => void): [Phaser.GameObjects.Text, Phaser.GameObjects.Graphics] {
    const box = this.add.graphics();
    const t = this.add.text(x, y, label, displayText(size, COLOR.muted, { outline: false, padding: { left: 12, right: 12, top: 7, bottom: 7 } }))
      .setOrigin(1, 0).setInteractive({ useHandCursor: true });
    box.setPosition(x - t.width, y);
    const draw = (hover: boolean) => {
      drawPopBox(box.clear(), 0, 0, t.width, t.height, { fill: HEX.panel, border: hover ? HEX.accent : HEX.edge, shadow: SHADOW.sm });
      t.setColor(hover ? COLOR.accent : COLOR.muted);
    };
    draw(false);
    t.on("pointerover", () => draw(true));
    t.on("pointerout", () => draw(false));
    t.on("pointerdown", onClick);
    return [t, box];
  }

  private cleanup(): void {
    this.alive = false;
    this.events.off(Phaser.Scenes.Events.RESUME, this.onResume, this);
    this.toolbarCleanup?.();
    this.input.keyboard?.removeAllListeners("keydown");
    this.input.gamepad?.removeAllListeners("down");
    this.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    this.thumbUrls = [];
  }

  /**
   * First show only: `objects` slide in from `from` (an offset) and fade up,
   * `delay` ms into the intro. Objects made mid-intro (a redrawn grid, a
   * rebuilt panel) join at the point the intro has reached, not from the start.
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

  /**
   * Image keys carry the fighter's id, its createdAt and how often it was
   * replaced while the game is open: an edited fighter keeps its id and
   * createdAt, so only the revision tells its new photos from the old ones.
   * Textures outlive the scene, and so do the revisions.
   */
  private imageId = (f: Fighter) => `${f.fighterId}@${f.createdAt}#${imageRevisions.get(f.fighterId) ?? 0}`;
  private thumbKey = (f: Fighter) => `thumb:${this.imageId(f)}`;

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
    this.pageText = this.add.text(0, y, "", bodyText(15, COLOR.muted, 600)).setOrigin(0.5, 0);
    this.pageArrows = [-1, 1].map((dir) => {
      const arrow = this.add.text(dir * 80, y - 4, dir < 0 ? "◀" : "▶", displayText(20, COLOR.muted, { padding: { left: 8, right: 8, top: 2, bottom: 5 } }))
        .setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
      arrow.on("pointerover", () => arrow.setColor(COLOR.accent));
      arrow.on("pointerout", () => arrow.setColor(COLOR.muted));
      arrow.on("pointerdown", () => {
        playGameSound(this, "tick", 0.3);
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
      const box = this.add.graphics({ x, y });
      const drawTile = (border: number) => drawPopBox(box.clear(), 0, 0, TILE, TILE, { fill: HEX.tile, border });
      drawTile(selected ? HEX.accent : HEX.edge);
      // An invisible hit area over the box.
      const bg = this.add.rectangle(x, y, TILE, TILE, 0x000000, 0.001).setOrigin(0);
      bg.setInteractive({ useHandCursor: true });
      // Select on pointer-up so a tap on one of the tile's buttons (handled on pointer-down) doesn't also select.
      bg.on("pointerup", () => { if (performance.now() - this.buttonPressedAt > 300) this.clickTile(i); });
      bg.on("pointerover", () => { if (this.selected !== i) drawTile(HEX.faint); });
      bg.on("pointerout", () => { if (this.selected !== i) drawTile(HEX.edge); });
      const items: Phaser.GameObjects.GameObject[] = [box, bg];
      const key = this.thumbKey(entry.fighter);
      if (this.textures.exists(key)) {
        const thumb = this.add.image(x + TILE / 2, y + TILE / 2, key).setDisplaySize(TILE - 10, TILE - 10);
        this.thumbs.set(i, thumb);
        items.push(thumb);
      }
      items.push(this.add.text(x + TILE / 2, y + TILE + 6, entry.fighter.name, displayText(15, COLOR.fg, { fixedWidth: TILE + GAP, align: "center" })).setOrigin(0.5, 0));
      if (entry.builtIn) items.push(this.add.text(x + 7, y + TILE - 5, "built-in", bodyText(11, COLOR.faint, 600)).setOrigin(0, 1));
      // Never fought yet: the tutorial is suggested when it's picked.
      if (!hasPlayed(this.registry, entry.fighter.fighterId)) {
        // Bottom-right: the top corners are where the P1 / P2 cursor tags sit.
        const tag = stamp(this, 0, y + TILE - 14, "New", HEX.accent, 11);
        items.push(tag.setX(x + TILE - 4 - stampWidth(tag, 11) / 2));
      }
      // Buttons live outside the container: Phaser's hit-testing doesn't reliably put container siblings above the tile.
      if (selected) this.tileButtons = this.tileActions(entry, x, y);
      this.introduce(items as IntroTarget[], this.introTileDelay(i), { y: 30 });
      this.tiles.add(items);
    });
    this.drawCursors();
  }

  /**
   * Clickable buttons on the selected tile: export, rename and edit (captured
   * fighters, at the top), and delete with an inline confirm.
   */
  private tileActions(entry: LibraryEntry, x: number, y: number): (Phaser.GameObjects.Text | Phaser.GameObjects.Graphics)[] {
    const objects: (Phaser.GameObjects.Text | Phaser.GameObjects.Graphics)[] = [];
    /** `row`: 0 along the bottom edge, 1 and 2 down from the top. */
    const button = (bx: number, label: string, color: string, onClick: () => void, row = 0) => {
      const t = this.add.text(bx, row ? y + 6 + (row - 1) * 28 : y + TILE - 6, label, bodyText(13, color, 800, { padding: { x: 6, y: 4 } }))
        .setOrigin(0, row ? 0 : 1).setInteractive({ useHandCursor: true }).setDepth(20);
      const b = t.getBounds();
      objects.push(popBox(this, b.x, b.y, b.width, b.height, { fill: HEX.ink, fillAlpha: 0.87, border: HEX.edge, borderWidth: 2, radius: RADIUS.sm, shadow: SHADOW.sm }).setDepth(19), t);
      t.on("pointerdown", (_p: unknown, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation();
        this.buttonPressedAt = performance.now();
        onClick();
      });
      return t;
    };
    const confirming = this.pendingDelete?.fighterId === entry.fighter.fighterId;
    if (confirming) {
      button(x + 6, "Delete?", COLOR.bad, () => void this.deleteEntry(entry));
      button(x + 72, "Keep", COLOR.fg, () => { this.pendingDelete = null; this.drawGrid(); });
      return objects;
    }
    button(x + 6, "⬇ Export", COLOR.fg, () => void this.exportEntry(entry));
    if (!entry.builtIn) {
      button(x + 86, "🗑", COLOR.bad, () => {
        this.pendingDelete = { fighterId: entry.fighter.fighterId, until: performance.now() + 5000 };
        this.drawGrid();
      });
      button(x + 6, "✎ Rename", COLOR.fg, () => this.openRename(entry), 1);
      if (!this.seriesRunning) button(x + 6, "✂ Edit", COLOR.fg, () => this.openEditor(entry), 2);
    }
    return objects;
  }

  /**
   * Mouse / touch: select a tile (for its export/delete buttons). A joined player
   * who hasn't picked yet moves their cursor there; clicking the same tile again picks it.
   */
  private clickTile(index: number): void {
    const cpu = this.cpu;
    if (cpu && !cpu.picked) {
      if (cpu.cursor === index && this.selected === index) this.pickCpu(true);
      else if (cpu.cursor !== index) playGameSound(this, "tick", 0.3);
      cpu.cursor = index;
      this.updatePreviews();
    }
    const i = this.players.findIndex((p) => p && !p.ready);
    const chooser = this.players[i];
    if (chooser) {
      if (chooser.cursor === index && this.selected === index) this.setReady(i, true);
      else if (chooser.cursor !== index) playGameSound(this, "tick", 0.3);
      chooser.cursor = index;
      this.updatePreviews();
    }
    this.selected = index;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private drawCursors(): void {
    this.cursors.clear();
    this.tagChips.clear();
    [0, 1].forEach((i) => {
      const p = this.shown(i);
      const tag = this.cursorTags[i];
      if (!p || !this.library.length || !this.onPage(p.cursor)) return tag.setVisible(false);
      const { x, y } = this.tilePosition(p.cursor);
      const inset = i * 6;
      this.cursors.lineStyle(p.ready ? 7 : 4, PLAYER_COLORS[i], 1)
        .strokeRoundedRect(x - 4 + inset, y - 4 + inset, TILE + 8 - 2 * inset, TILE + 8 - 2 * inset, RADIUS.md + 4 - inset);
      // P1's tag in the top-left corner of its outline, P2's in the top-right of its (inset) one.
      tag.setText(p.cpu ? "CPU" : `P${i + 1}`).setPosition(i ? x + TILE + 4 - inset : x - 4, y - 4 + inset).setVisible(true);
      const b = tag.getBounds();
      drawPopBox(this.tagChips, b.x, b.y, b.width, b.height, { fill: PLAYER_COLORS[i], borderWidth: 2, radius: RADIUS.sm, shadow: SHADOW.sm });
    });
    this.drawCursorPoses();
  }

  /** Win pose (variant 0) or flex (variant 1, the win-2 capture). */
  private winKey = (f: Fighter, variant: 0 | 1) => `win${variant ? "#1" : ""}:${this.imageId(f)}`;

  /**
   * The fighter under each cursor replaces the tile's thumbnail (same scale, P2
   * facing left): flexing while hovered, win pose once picked. One pose per tile;
   * a ready player's wins.
   */
  private drawCursorPoses(): void {
    const owner = new Map<number, number>();
    const order = [0, 1].sort((a, b) => Number(!!this.shown(b)?.ready) - Number(!!this.shown(a)?.ready));
    for (const i of order) {
      const p = this.shown(i);
      if (p && this.library[p.cursor] && this.onPage(p.cursor) && !owner.has(p.cursor)) owner.set(p.cursor, i);
    }
    const covered = new Set<number>();
    [0, 1].forEach((i) => {
      const p = this.shown(i);
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

  /** Both at once: a hovered fighter is usually picked next. */
  private loadWinPoses(fighter: Fighter): void {
    const blobs: [string, Blob][] = [
      [this.winKey(fighter, 0), fighter.poses.win.imageBlob],
      [this.winKey(fighter, 1), fighter.poseVariants.win![0].imageBlob],
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

  private addFighter(fighter: Fighter): void {
    const replacing = this.library.some((e) => e.fighter.fighterId === fighter.fighterId);
    this.library = [{ fighter, builtIn: false }, ...this.library.filter((e) => e.fighter.fighterId !== fighter.fighterId)];
    this.registry.set(REGISTRY.library, this.library);
    if (replacing) this.afterFighterReplaced(fighter);
    else this.afterLibraryGrew(fighter);
  }

  /**
   * The same fighter again (imported a second time, perhaps edited): the
   * cursors stay where they were (the library didn't grow), and its voice and
   * images are reloaded (a new revision, so new textures).
   */
  private afterFighterReplaced(fighter: Fighter): void {
    imageRevisions.set(fighter.fighterId, (imageRevisions.get(fighter.fighterId) ?? 0) + 1);
    this.voices.delete(fighter.fighterId);
    this.refreshGrid();
    this.updatePreviews();
    this.setToolbarStatus(`Updated ${fighter.name}`);
  }

  private afterLibraryGrew(fighter: Fighter): void {
    this.voices.delete(fighter.fighterId);
    // Keep cursors on the same fighters.
    for (const p of [...this.players, this.cpu]) if (p) p.cursor = Math.min(this.library.length - 1, p.cursor + 1);
    if (this.selected !== null) this.selected = Math.min(this.library.length - 1, this.selected + 1);
    this.updateAddLayout();
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
    else if (ev.keyCode === KEY.T) this.openSeries();
    else if (ev.keyCode === KEY.N) this.openStudio();
    else if (ev.keyCode === KEY.F) void toggleFullscreen().catch(() => {});
  }

  /** "Press any button": the first unassigned controller takes the next free slot. */
  private join(input: PlayerInputDescriptor): void {
    if (this.players.some((p) => p && sameInput(p.input, input))) return;
    this.cpu = null; // a person takes the CPU's place
    const slot = this.players.findIndex((p) => p === null);
    if (slot < 0) return;
    const source = createInputSource(this, input);
    const cursor = Math.min(slot, Math.max(0, this.library.length - 1));
    this.players[slot] = { input, source, cursor, ready: false, previous: source.read(), fresh: true };
    // "That's you": a pad buzzes when it joins.
    if (getOptions(this.registry).rumble) source.rumble?.(JOIN_RUMBLE);
    playGameSound(this, "tick", 0.6);
    if (slot === 1) announce(this, "new-challenger");
    this.showPage(Math.floor(cursor / this.pageSize));
    this.updatePreviews();
    this.drawCursors();
  }

  /** Picking plays the fighter's victory line; un-picking cuts it off. `quiet`: no pick / un-pick sound. */
  private setReady(i: number, ready: boolean, quiet = false): void {
    const p = this.players[i];
    if (!p || p.ready === ready) return;
    p.ready = ready;
    if (!quiet) playGameSound(this, ready ? "hit" : "block", ready ? 0.6 : 0.4);
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
    // The picked fighter says it: the preview's jaw drops along.
    this.previews[i]?.fighter?.say(line);
  }

  private fadeOutVoice(i: number): void {
    const line = this.voiceLines[i];
    if (!line) return;
    this.voiceLines[i] = null;
    this.tweens.add({ targets: line, volume: 0, duration: VOICE_FADE_MS, onComplete: () => { line.stop(); line.destroy(); } });
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
      frame: this.add.graphics({ x, y: PANEL_Y }),
      readyStamp: stamp(this, 0, 0, "Ready!", PLAYER_COLORS[i], 16).setVisible(false),
      feet: { x: feetX, y: PANEL_Y + PANEL_H - 8 },
      facing: right ? -1 : 1,
      fighter: null,
      title: text(PANEL_Y + 14, displayText(36, PLAYER_CSS[i])).setText(`P${i + 1}`),
      record: text(PANEL_Y + 16, bodyText(15, COLOR.muted, 600, { lineSpacing: 3 })),
      name: text(PANEL_Y + 60, displayText(26, COLOR.fg)),
      style: text(PANEL_Y + 94, bodyText(16, COLOR.muted, 500)),
      status: text(PANEL_Y + 136, bodyText(17, PLAYER_CSS[i], 600, { lineSpacing: 4 })),
      tip: text(PANEL_Y + 136, bodyText(17, COLOR.accent, 800, { lineSpacing: 4 })),
      tipPulses: false,
      device: text(PANEL_Y + PANEL_H - 40, bodyText(13, COLOR.faint, 600)),
      join: this.add.text(x + PANEL_W / 2, PANEL_Y + PANEL_H / 2 + 20, "", bodyText(20, PLAYER_CSS[i], 800, { align: "center", lineSpacing: 8 })).setOrigin(0.5),
    };
    this.drawFrame(preview, HEX.edge, 3);
    preview.title.setPosition(right ? x + PANEL_W - 20 : x + 20, PANEL_Y + 14).setOrigin(right ? 1 : 0, 0);
    preview.record.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.openStats(i));
    // One container so the intro moves the panel as a whole; above the VS dimmer.
    const panel = this.add.container(0, 0, [preview.frame, preview.title, preview.record, preview.name, preview.style, preview.status, preview.tip, preview.device, preview.join, preview.readyStamp]).setDepth(PREVIEW_DEPTH);
    this.introduce([panel], INTRO_PANELS_MS + i * 80, { y: 120 });
    return preview;
  }

  /** The panel box: `border` at `width` (the player colour, 5px once they're ready). */
  private drawFrame(v: Preview, border: number, width: number): void {
    drawPopBox(v.frame.clear(), 0, 0, PANEL_W, PANEL_H, { fill: HEX.panel, border, borderWidth: width, radius: RADIUS.lg, shadow: SHADOW.lg });
  }

  /** The READY! stamp at the top of the status column (`y`); returns where the status lines go under it. */
  private placeReadyStamp(v: Preview, ready: boolean, y: number): number {
    v.readyStamp.setVisible(ready);
    if (!ready) return y;
    const w = stampWidth(v.readyStamp, 16);
    const right = v.status.originX === 1;
    v.readyStamp.setPosition(right ? v.status.x - w / 2 - 2 : v.status.x + w / 2 + 2, y + 12);
    return y + 28;
  }

  private updatePreviews(): void {
    const alone = this.players.filter(Boolean).length === 1;
    this.previews.forEach((v, i) => {
      if (this.cpu?.slot === i) return this.updateCpuPreview(v, this.cpu);
      const p = this.players[i];
      const entry = p && this.library[p.cursor];
      this.drawFrame(v, p ? PLAYER_COLORS[i] : HEX.edge, p?.ready ? 5 : 3);
      v.title.setText(`P${i + 1}`).setAlpha(p ? 1 : 0.5);
      v.name.setText(entry ? entry.fighter.name : "");
      const record = entry && recordOf(this.registry, entry.fighter.fighterId);
      // Ready: down is free (it moves the cursor before), so it opens the career page.
      v.record.setText(record ? `${winLoss(record)}\n${p.ready ? "down: stats ▸" : `best streak ${record.longestStreak}`}` : "");
      // The signature move only: "Brawler · Shoulder Charge" wraps in the panel's text column.
      v.style.setText(entry ? ARCHETYPES[entry.fighter.archetype].moveName : "").setY(PANEL_Y + 62 + v.name.height);
      v.join.setText(p ? "" : `Press any button to join\n(gamepad, ${actionKeyLabel("p1", "punch")}, or ${actionKeyLabel("p2", "punch")})`);
      // The tutorial is one player's: suggest it to anyone alone, and push it for a fighter's first fight.
      const fresh = !!entry && !hasPlayed(this.registry, entry.fighter.fighterId);
      v.tip.setText(
        !p || this.cpu ? ""
        : alone && p.ready ? (fresh ? "First fight!\nup: TUTORIAL" : "up: tutorial")
        : alone ? (fresh ? "New? Pick, then\nup: TUTORIAL" : "")
        : fresh ? "New? Try the\ntutorial solo" : "",
      ).setY(v.style.y + v.style.height + 12).setAlpha(1);
      v.tipPulses = fresh && alone;
      // READY! is the stamp, the lines under it the status.
      v.status.setText(
        !p ? ""
        : !p.ready ? "punch: pick\nkick: leave"
        : this.cpu ? ""
        : alone ? "punch: vs CPU\nkick: change"
        : "kick: change",
      ).setY(this.placeReadyStamp(v, !!p?.ready, v.tip.y + (v.tip.text ? v.tip.height + 10 : 0)));
      v.device.setText(p ? describeInput(p.input) : "");
      
      // Have the victory line ready by the time they pick.
      if (entry) void this.fighterVoices(entry.fighter);
    });
    this.updateRivalry();
    this.drawPreviewSprites();
  }

  /** Between the panels, once both players are on different fighters: their head-to-head, or a first meeting. */
  private updateRivalry(): void {
    const [a, b] = [0, 1].map((i) => { const p = this.shown(i); return p && this.library[p.cursor]?.fighter.fighterId; });
    const r = this.rivalry;
    if (!a || !b || a === b) return void r.container.setVisible(false);
    const tally = headToHead(this.registry, a, b);
    r.container.setVisible(true);
    r.left.setText(tally ? String(tally.wins) : "");
    r.right.setText(tally ? String(tally.losses) : "");
    r.label.setText(!tally ? "FIRST MEETING" : tally.draws ? `RIVALRY · ${tally.draws} DRAW${tally.draws > 1 ? "S" : ""}` : "RIVALRY");
    const w = r.label.width + (tally ? 100 : 36);
    drawPopBox(r.bg.clear(), -w / 2, -18, w, 36, { fill: HEX.bg, border: HEX.edge, radius: 18, shadow: SHADOW.sm });
    r.left.setX(-w / 2 + 22);
    r.right.setX(w / 2 - 22);
  }

  private buildRivalry(): void {
    const x = GRID_X + PANEL_W + 10; // the gap between the two panels
    const bg = this.add.graphics();
    const label = this.add.text(0, 0, "", bodyText(15, COLOR.muted, 800)).setOrigin(0.5);
    const left = this.add.text(0, 0, "", displayText(26, PLAYER_CSS[0], { outline: false })).setOrigin(0.5);
    const right = this.add.text(0, 0, "", displayText(26, PLAYER_CSS[1], { outline: false })).setOrigin(0.5);
    // Straddles the panels' top edge; above the VS dimmer, so the stakes show during the countdown.
    const container = this.add.container(x, PANEL_Y, [bg, label, left, right]).setDepth(PREVIEW_DEPTH + 1).setVisible(false);
    this.rivalry = { container, bg, label, left, right };
    this.introduce([container], INTRO_PANELS_MS + 80, { y: 120 });
  }

  /** A player's fighter's career page (fighter-stats-scene.ts), over this scene. */
  private openStats(i: number): void {
    const p = this.players[i];
    const entry = p && this.library[p.cursor];
    if (!entry || !recordOf(this.registry, entry.fighter.fighterId) || this.vs) return;
    const winKey = this.winKey(entry.fighter, 0);
    this.scene.pause();
    this.scene.launch("fighter-stats", {
      fighterId: entry.fighter.fighterId, texture: this.textures.exists(winKey) ? winKey : null, returnTo: "character-select",
    } satisfies FighterStatsSceneData);
  }

  /**
   * The same pose as the tile, animated (PosePreview): breathing, and morphing
   * from flex to win pose on a pick (and back on un-pick).
   */
  private drawPreviewSprites(): void {
    if (this.previewsHeld) return;
    this.previews.forEach((v, i) => {
      const p = this.shown(i);
      const entry = p && this.library[p.cursor];
      const keys = entry && ([0, 1] as const).map((variant) => this.winKey(entry.fighter, variant));
      if (!entry || !keys!.every((k) => this.textures.exists(k))) {
        if (entry) this.loadWinPoses(entry.fighter);
        v.fighter?.destroy();
        v.fighter = null;
        return;
      }
      const pose: PreviewPose = p.ready ? "win" : "flex";
      if (v.fighter?.id === this.imageId(entry.fighter)) return v.fighter.setPose(pose, this.time.now);
      v.fighter?.destroy();
      const geometry = geometryOf(entry.fighter);
      // Flex is the win-2 capture.
      const capture = (variant: 0 | 1): PreviewCapture => ({
        texture: keys![variant],
        landmarks: frameGeometry(geometry, "win", variant).landmarks,
        anchor: groundAnchorFor(geometry, "win", variant),
      });
      v.fighter = new PosePreview(this, this.imageId(entry.fighter), { win: capture(0), flex: capture(1) }, v.feet,
        PREVIEW_SIZE / SPRITE_CANVAS_SIZE, v.facing, PREVIEW_DEPTH, pose, this.time.now);
    });
  }

  // --- VS ---------------------------------------------------------------------

  private showVs(): void {
    const cx = GRID_X + this.gridWidth / 2;
    const objects = [
      this.add.rectangle(0, 0, this.scale.width, this.scale.height, HEX.ink, 0.75).setOrigin(0).setDepth(25),
      this.add.text(cx, 270, "VS", displayText(120, COLOR.accent)).setOrigin(0.5).setDepth(30),
      this.add.text(cx, 360, "kick to cancel", bodyText(16, COLOR.muted, 600)).setOrigin(0.5, 0).setDepth(30),
    ];
    this.vs = { until: this.time.now + VS_MS, objects };
  }

  private hideVs(): void {
    this.vs?.objects.forEach((o) => o.destroy());
    this.vs = null;
  }

  // --- party modes (series) ---------------------------------------------------

  /** Tournament / king of the hill. Both joined players' controllers go along: P1 plays the left fighter of every match, P2 the right. */
  private openSeries(): void {
    const [a, b] = this.players;
    if (!a || !b) {
      this.seriesHint.setText("Both players join first");
      this.time.delayedCall(2000, () => this.seriesHint.setText(""));
      return playGameSound(this, "block", 0.4);
    }
    if (this.library.length < MIN_ENTRANTS) {
      this.seriesHint.setText(`Needs ${MIN_ENTRANTS} fighters`);
      this.time.delayedCall(2000, () => this.seriesHint.setText(""));
      return playGameSound(this, "block", 0.4);
    }
    playGameSound(this, "hit", 0.6);
    void setSetting("controllerMapping", { p1: a.input, p2: b.input }).catch(() => {});
    this.scene.start("series-setup", { inputs: [a.input, b.input] } satisfies SeriesSetupData);
  }

  // --- rename -----------------------------------------------------------------

  private openRename(entry: LibraryEntry): void {
    if (this.vs) return;
    this.scene.pause();
    this.scene.launch("rename", { fighterId: entry.fighter.fighterId, returnTo: "character-select" } satisfies RenameSceneData);
  }

  // --- settings ---------------------------------------------------------------

  private openSettings(): void {
    this.scene.pause();
    this.scene.launch("settings", { returnTo: "character-select" });
  }

  /**
   * Back from settings (key bindings may have changed), a career page or a rename
   * (`data`: the library in the registry has the new name). Presses made there don't count here.
   */
  private onResume(_sys: Phaser.Scenes.Systems, data?: Partial<RenameResult>): void {
    if (data?.renamed) {
      this.library = this.registry.get(REGISTRY.library) ?? this.library;
      this.drawGrid();
      this.setToolbarStatus(`Renamed ${data.renamed.from} to ${data.renamed.to}`);
    }
    for (const p of this.players) {
      if (!p) continue;
      p.previous = p.source.read();
      p.source.pausePressed();
    }
    updateMenuMusicVolume(this); // Settings may have changed it
    this.updatePreviews();
  }

  update(): void {
    for (const v of this.previews) {
      v.fighter?.update(this.time.now);
      if (v.tipPulses) v.tip.setAlpha(0.55 + 0.45 * Math.cos(this.time.now / 220));
    }
    let changed = false;
    this.players.forEach((p, i) => {
      if (!p) return;
      if (!p.source.connected && p.input.kind === "pad") {
        this.players[i] = null;
        this.cpu = null;
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
      if (this.cpu && p.ready) {
        if (this.updateCpuChoice(p, pressed)) changed = true;
        p.previous = now;
        return;
      }
      if (!p.ready && this.library.length) {
        const c = this.moveCursor(p.cursor, pressed);
        if (c !== p.cursor) {
          playGameSound(this, "tick", 0.3);
          p.cursor = c;
          this.showPage(Math.floor(c / this.pageSize));
          changed = true;
        }
        if (pressed("punch")) { this.setReady(i, true); changed = true; }
      } else if (pressed("kick")) {
        this.setReady(i, false);
        changed = true;
      } else if (pressed("down")) {
        p.previous = now;
        return this.openStats(i);
      } else if (pressed("up") && this.players.filter(Boolean).length === 1) {
        p.previous = now;
        return this.startPractice(p, true);
      } else if (pressed("punch") && this.players.filter(Boolean).length === 1) {
        this.chooseOpponent(i);
        changed = true;
      }
      if (!p.ready && pressed("kick") && !changed) {
        this.players[i] = null; // leave the slot
        playGameSound(this, "block", 0.3);
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

  /**
   * One player against the training dummy. `opponent`: the fighter it plays
   * (the tutorial's: another fighter from the roster, or the same one).
   * `tutorial`: start with the guided drill.
   */
  startPractice(p: PlayerSlot, tutorial = false, opponent?: LibraryEntry): void {
    const mine = this.library[p.cursor];
    const dummy = opponent ?? this.library.find((e) => e.fighter.fighterId !== mine.fighter.fighterId) ?? mine;
    const data: FightSceneData = { entries: [mine, dummy], inputs: [p.input, { kind: "dummy" }], practice: true, tutorial };
    startMatch(this, data);
  }

  // --- the CPU opponent (one player) -------------------------------------------

  /** Where `cursor` moves to on this frame's presses. */
  private moveCursor(cursor: number, pressed: (k: keyof InputFrame) => boolean): number {
    const n = this.library.length;
    let c = cursor;
    if (pressed("left")) c = (c - 1 + n) % n;
    if (pressed("right")) c = (c + 1) % n;
    if (pressed("up") && c - this.cols >= 0) c -= this.cols;
    if (pressed("down") && c + this.cols < n) c += this.cols;
    return c;
  }

  private shown(i: number): SlotView | null {
    const p = this.players[i];
    if (p) return { cursor: p.cursor, ready: p.ready, cpu: false };
    const cpu = this.cpu;
    return cpu?.slot === i ? { cursor: cpu.cursor, ready: cpu.picked, cpu: true } : null;
  }

  /** A lone player who has picked: the empty slot becomes the CPU, starting on the next fighter along. */
  private chooseOpponent(player: number): void {
    const p = this.players[player]!;
    const cursor = this.library.length > 1 ? (p.cursor + 1) % this.library.length : p.cursor;
    this.cpu = { slot: player === 0 ? 1 : 0, cursor, picked: false, option: 0 };
    playGameSound(this, "hit", 0.6);
    announce(this, "choose-opponent");
  }

  private pickCpu(picked: boolean): void {
    if (!this.cpu || this.cpu.picked === picked) return;
    this.cpu.picked = picked;
    playGameSound(this, picked ? "hit" : "block", picked ? 0.6 : 0.4);
  }

  /** The lone player's presses while the CPU slot is open. Kick steps back. Returns whether anything changed. */
  private updateCpuChoice(p: PlayerSlot, pressed: (k: keyof InputFrame) => boolean): boolean {
    const cpu = this.cpu!;
    if (!cpu.picked) {
      const c = this.moveCursor(cpu.cursor, pressed);
      if (c !== cpu.cursor) {
        playGameSound(this, "tick", 0.3);
        cpu.cursor = c;
        this.showPage(Math.floor(c / this.pageSize));
        return true;
      }
      if (pressed("punch")) {
        this.pickCpu(true);
        return true;
      }
      if (!pressed("kick")) return false;
      this.cpu = null;
      playGameSound(this, "block", 0.4);
      return true;
    }
    if (pressed("up") || pressed("down")) {
      cpu.option = cpu.option ? 0 : 1;
    } else if (cpu.option === 0 && (pressed("left") || pressed("right"))) {
      const n = CPU_LEVEL_IDS.length;
      cpuLevel = CPU_LEVEL_IDS[(CPU_LEVEL_IDS.indexOf(cpuLevel) + (pressed("left") ? n - 1 : 1)) % n];
    } else if (pressed("kick")) {
      this.pickCpu(false);
      return true;
    } else if (pressed("punch")) {
      const opponent = this.library[cpu.cursor];
      if (cpu.option === 1) {
        this.startPractice(p, false, opponent);
      } else {
        playGameSound(this, "hit", 0.6);
        startMatch(this, { entries: [this.library[p.cursor], opponent], inputs: [p.input, { kind: "cpu", level: cpuLevel }] });
      }
      return false;
    } else {
      return false;
    }
    playGameSound(this, "tick", 0.3);
    return true;
  }

  /** The CPU's panel: its fighter, then the Match (level) / Practice choice. */
  private updateCpuPreview(v: Preview, cpu: CpuSlot): void {
    const entry = this.library[cpu.cursor];
    this.drawFrame(v, PLAYER_COLORS[cpu.slot], cpu.picked ? 5 : 3);
    v.readyStamp.setVisible(false);
    v.title.setText("CPU").setAlpha(1);
    v.name.setText(entry ? entry.fighter.name : "");
    const record = entry && recordOf(this.registry, entry.fighter.fighterId);
    v.record.setText(record ? winLoss(record) : "");
    v.style.setText(entry ? ARCHETYPES[entry.fighter.archetype].moveName : "").setY(PANEL_Y + 62 + v.name.height);
    v.join.setText("");
    v.tip.setText("").setY(v.style.y + v.style.height + 12);
    v.tipPulses = false;
    const mark = (option: 0 | 1) => (cpu.option === option ? "▶ " : "   ");
    v.status.setText(
      !cpu.picked ? "Choose your\nopponent\npunch: pick\nkick: back"
      : `${mark(0)}Match: ${CPU_LEVEL_NAMES[cpuLevel]}\n${mark(1)}Practice\n${cpu.option === 0 ? "◀ ▶ level\n" : ""}punch: go\nkick: back`,
    ).setY(v.tip.y);
    v.device.setText("");
  }

  // --- add a fighter (the studio, or a file) ----------------------------------

  /** Switch the panel (and the grid width) between full and compact when the choice changes. */
  private updateAddLayout(): void {
    const auto = this.library.some((e) => !e.builtIn);
    if (auto !== this.autoCompact) {
      this.autoCompact = auto;
      this.compactOverride = null;
    }
    const compact = this.seriesRunning || (this.compactOverride ?? auto);
    if (compact === this.compact && this.laidOut) return;
    this.compact = compact;
    this.laidOut = true;
    this.buildAddPanel();
    // The page size changed: show the page of the first joined player's cursor.
    const anchor = this.players.find(Boolean)?.cursor ?? 0;
    this.page = Math.floor(anchor / this.pageSize);
    this.selected = null;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private buildAddPanel(): void {
    this.addObjects.forEach((o) => o.destroy());
    this.addObjects = [];
    // Storage notices: under the panel, or along the top when the panel is down by the previews (or not there).
    const noticeUnder = !this.compact;
    if (this.seriesRunning) {
      this.noticeText.setPosition(GRID_X, 100).setWordWrapWidth(1180);
      return;
    }
    const add = <T extends Phaser.GameObjects.GameObject>(o: T): T => (this.addObjects.push(o), o);
    const text = (x: number, y: number, style: Phaser.Types.GameObjects.Text.TextStyle) =>
      add(this.add.text(x, y, "", { align: "center", ...style }).setOrigin(0.5, 0));
    /** Primary: ink on gold, the border lightening on hover. Secondary: muted on a tile, border and text gold on hover. */
    const button = (x: number, y: number, label: string, size: number, primary: boolean, onClick: () => void) => {
      const color = primary ? COLOR.ink : COLOR.muted;
      const box = add(this.add.graphics());
      const b = add(this.add.text(x, y, label, displayText(size, color, { outline: false, padding: { left: 16, right: 16, top: 10, bottom: 10 } }))
        .setOrigin(0.5, 0).setInteractive({ useHandCursor: true }));
      box.setPosition(x - b.width / 2, y);
      const draw = (hover: boolean) => {
        const style: PopBoxOptions = primary
          ? { fill: HEX.accent, border: hover ? HEX.fg : HEX.ink }
          : { fill: HEX.tile, border: hover ? HEX.accent : HEX.edge };
        drawPopBox(box.clear(), 0, 0, b.width, b.height, style);
        if (!primary) b.setColor(hover ? COLOR.accent : color);
      };
      draw(false);
      b.on("pointerover", () => draw(true));
      b.on("pointerout", () => draw(false));
      b.on("pointerdown", onClick);
      return b;
    };
    const [x, y, h] = this.compact ? [ADD_X, PANEL_Y, PANEL_H] : [ADD_X, GRID_Y, 480];
    const cx = x + ADD_W / 2;
    add(popBox(this, x, y, ADD_W, h, { fill: HEX.panel, border: HEX.accent, radius: RADIUS.lg, shadow: SHADOW.lg }));
    // An invisible hit area over the box.
    const bg = add(this.add.rectangle(x, y, ADD_W, h, 0x000000, 0.001).setOrigin(0));
    bg.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
      this.compactOverride = !this.compact;
      this.updateAddLayout();
    });
    const hint = this.compact ? "click to enlarge" : this.autoCompact || this.compactOverride !== null ? "click to shrink" : "";
    const importFile = () => (document.getElementById("import-file") as HTMLInputElement | null)?.click();
    if (this.compact) {
      text(cx, y + 10, displayText(24, COLOR.accent)).setText("ADD A FIGHTER");
      button(cx, y + 58, "Open the studio (N)", 24, true, () => this.openStudio());
      text(cx, y + 120, bodyText(14, COLOR.muted, 600, { wordWrap: { width: 320 } })).setText("use a phone or this computer's camera");
      button(cx, y + 162, "Import a fighter file", 18, false, importFile);
      text(cx, y + h - 26, bodyText(12, COLOR.faint, 600)).setText(hint);
    } else {
      text(cx, y + 12, displayText(32, COLOR.accent)).setText("ADD A FIGHTER");
      text(cx, y + 64, bodyText(16, COLOR.muted, 500, { wordWrap: { width: 320 } }))
        .setText(`Turn yourself into a fighter in the Character Studio: strike ${CAPTURE_TARGET_COUNT} poses, record your battle cries.`);
      button(cx, y + 150, "Open the studio (N)", 32, true, () => this.openStudio());
      text(cx, y + 226, bodyText(15, COLOR.muted, 600, { wordWrap: { width: 320 } })).setText("use a phone or this computer's camera");
      text(cx, y + 270, bodyText(13, COLOR.faint, 600, { wordWrap: { width: 320 } }))
        .setText("The studio opens on this computer; your photos stay on your devices. Come back here when your fighter is saved.");
      button(cx, y + 350, "Import a fighter file", 20, false, importFile);
      text(cx, y + h - 20, bodyText(12, COLOR.faint, 600)).setText(hint);
    }
    this.introduce(this.addObjects as IntroTarget[], INTRO_ADD_MS, { x: 80 });
    this.noticeText.setPosition(noticeUnder ? ADD_X : GRID_X, noticeUnder ? GRID_Y + h + 16 : 100).setWordWrapWidth(noticeUnder ? ADD_W : 1180);
  }

  /** The studio is its own page; its "Back to the game" comes back to fighter select. */
  private openStudio(): void {
    if (this.seriesRunning) return;
    location.assign(`${import.meta.env.BASE_URL}studio`);
  }

  /** Retake poses, redo sounds, rename: the studio, on this fighter (docs/character-studio.md §6). */
  private openEditor(entry: LibraryEntry): void {
    if (this.seriesRunning || entry.builtIn || this.vs) return;
    location.assign(`${import.meta.env.BASE_URL}studio?edit=${encodeURIComponent(entry.fighter.fighterId)}`);
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
      if (action === "fullscreen") await toggleFullscreen().catch(() => this.setToolbarStatus("Fullscreen isn't available here"));
    };
    const fullscreenButton = document.getElementById("fullscreen-button");
    if (fullscreenButton) fullscreenButton.hidden = !canFullscreen();
    // The game's box changes size; Phaser keeps the old measurement otherwise.
    const unwatchFullscreen = watchFullscreen((on) => {
      if (fullscreenButton) fullscreenButton.textContent = on ? "Exit fullscreen (F)" : "⛶ Fullscreen (F)";
      requestAnimationFrame(() => refitGame(this.game));
    });
    const onFile = async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const fighter = await importFighterFile(file);
        await saveImportedFighter(fighter);
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
      unwatchFullscreen();
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

  /** One .fotofighter file per captured fighter. */
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
    forgetFighterRecord(this.registry, id);
    this.library = this.library.filter((e) => e.fighter.fighterId !== id);
    this.registry.set(REGISTRY.library, this.library);
    this.selected = null;
    this.cpu = null;
    this.updateAddLayout();
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
