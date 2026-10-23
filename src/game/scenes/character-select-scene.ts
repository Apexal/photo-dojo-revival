import Phaser from "phaser";
import QRCode from "qrcode";
import { exportFighterFile, fighterFileName, importFighterFile } from "../../shared/fighter-codec";
import { formatCountdown } from "../../shared/room-code";
import type { Fighter } from "../../shared/fighter-model";
import { deleteFighter, getSetting, isStoragePersisted, saveFighter, setSetting } from "../../shared/fighter-storage";
import type { InputFrame } from "../../simulation/input-frame";
import type { LibraryEntry } from "../fighter-library";
import { HostSession, type HostStatus } from "../host-session";
import { PAD_BUTTON } from "../input/gamepad-input-source";
import { createInputSource, describeInput, sameInput, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { KeyboardInputSource } from "../input/keyboard-input-source";
import { KEY, actionKeyLabel } from "../input/key-bindings";
import { JOIN_RUMBLE } from "../input/rumble";
import { getOptions } from "../options";
import { REGISTRY } from "./boot-scene";
import type { FightSceneData } from "./fight-scene";

const COLS = 5;
const TILE = 150;
const GAP = 14;
const GRID_X = 40;
const GRID_Y = 120;
const PLAYER_COLORS = [0xe8483b, 0x3f86f0];
const PLAYER_CSS = ["#e8483b", "#3f86f0"];

interface PlayerSlot {
  input: PlayerInputDescriptor;
  source: InputSource;
  cursor: number;
  ready: boolean;
  previous: InputFrame;
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
  private slotTexts: Phaser.GameObjects.Text[] = [];
  private hostText!: Phaser.GameObjects.Text;
  private codeText!: Phaser.GameObjects.Text;
  private expiryText!: Phaser.GameObjects.Text;
  private expiresAt: number | undefined;
  private qrImage: Phaser.GameObjects.Image | null = null;
  private noticeText!: Phaser.GameObjects.Text;
  private unsubscribeHost: (() => void) | null = null;
  private thumbUrls: string[] = [];
  private pendingDelete: { fighterId: string; until: number } | null = null;
  /** Tile chosen with the mouse / touch (shows its export / delete buttons). */
  private selected: number | null = null;
  private buttonPressedAt = 0;
  private tileButtons: Phaser.GameObjects.Text[] = [];
  private toolbarCleanup: (() => void) | null = null;
  /** False after shutdown, for async work that finishes late. */
  private alive = false;

  constructor() {
    super("character-select");
  }

  create(): void {
    this.library = this.registry.get(REGISTRY.library) ?? [];
    this.players = [null, null];
    this.selected = null;
    this.pendingDelete = null;
    this.tileButtons = [];
    this.alive = true;
    this.add.text(GRID_X, 36, "PHOTO DOJO", { fontSize: "52px", fontStyle: "bold", color: "#f2c14e" });
    this.add.text(GRID_X + 360, 60, "Pick your fighters", { fontSize: "22px", color: "#c9c3b8" });
    this.tiles = this.add.container(0, 0);
    this.cursors = this.add.graphics().setDepth(10);
    this.slotTexts = [0, 1].map((i) =>
      this.add.text(GRID_X + i * 420, 610, "", { fontSize: "22px", color: PLAYER_CSS[i], wordWrap: { width: 400 } }),
    );
    this.noticeText = this.add.text(GRID_X, 686, "", { fontSize: "15px", color: "#a8a196" });
    this.buildHostPanel();
    this.refreshGrid();
    this.updateSlotTexts();

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
    this.events.on(Phaser.Scenes.Events.RESUME, this.onResume, this);
    this.setupToolbar();
    void this.showStorageNotices();

    const host: HostSession | undefined = this.registry.get(REGISTRY.host);
    this.unsubscribeHost = host?.subscribe((s) => this.showHostStatus(s), (f) => this.onFighterReceived(f)) ?? null;

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
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

  private tilePosition(index: number) {
    return { x: GRID_X + (index % COLS) * (TILE + GAP), y: GRID_Y + Math.floor(index / COLS) * (TILE + 34) };
  }

  private drawGrid(): void {
    this.tiles.removeAll(true);
    this.tileButtons.forEach((b) => b.destroy());
    this.tileButtons = [];
    this.library.forEach((entry, i) => {
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
      if (this.textures.exists(key)) items.push(this.add.image(x + TILE / 2, y + TILE / 2, key).setDisplaySize(TILE - 10, TILE - 10));
      items.push(this.add.text(x + TILE / 2, y + TILE + 4, entry.fighter.name, { fontSize: "16px", color: "#f3efe6" }).setOrigin(0.5, 0));
      if (entry.builtIn) items.push(this.add.text(x + 6, y + 4, "built-in", { fontSize: "11px", color: "#8a8478" }));
      // Buttons live outside the container: Phaser's hit-testing doesn't reliably put container siblings above the tile.
      if (selected) this.tileButtons = this.tileActions(entry, x, y).map((b) => b.setDepth(20));
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
        button(x + 80, "Keep", "#f3efe6", () => { this.pendingDelete = null; this.drawGrid(); }),
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
    const chooser = this.players.find((p) => p && !p.ready);
    if (chooser) {
      if (chooser.cursor === index && this.selected === index) chooser.ready = true;
      chooser.cursor = index;
      this.updateSlotTexts();
    }
    this.selected = index;
    this.pendingDelete = null;
    this.drawGrid();
  }

  private drawCursors(): void {
    this.cursors.clear();
    this.players.forEach((p, i) => {
      if (!p || !this.library.length) return;
      const { x, y } = this.tilePosition(Math.min(p.cursor, this.library.length - 1));
      const inset = i * 6;
      this.cursors.lineStyle(p.ready ? 7 : 4, PLAYER_COLORS[i], 1).strokeRect(x - 4 + inset, y - 4 + inset, TILE + 8 - 2 * inset, TILE + 8 - 2 * inset);
    });
  }

  /** The boot scene already added it to the registry library. */
  private onFighterReceived(fighter: Fighter): void {
    this.library = this.registry.get(REGISTRY.library) ?? this.library;
    this.afterLibraryGrew(fighter);
  }

  private addFighter(fighter: Fighter): void {
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
    this.players[slot] = { input, source, cursor: Math.min(slot, Math.max(0, this.library.length - 1)), ready: false, previous: source.read() };
    // "That's you": a pad buzzes when it joins.
    if (getOptions(this.registry).rumble) source.rumble?.(JOIN_RUMBLE);
    this.updateSlotTexts();
    this.drawCursors();
  }

  private updateSlotTexts(): void {
    this.slotTexts.forEach((t, i) => {
      const p = this.players[i];
      if (!p) return t.setText(`P${i + 1}: press any button\n(gamepad, ${actionKeyLabel("p1", "punch")}, or ${actionKeyLabel("p2", "punch")})`);
      const name = this.library[p.cursor]?.fighter.name ?? "—";
      const alone = this.players.filter(Boolean).length === 1;
      const ready = alone ? `READY: ${name}  (punch again: PRACTICE)` : `READY: ${name}  (kick to change)`;
      t.setText(`P${i + 1} · ${describeInput(p.input)}\n${p.ready ? ready : name + "  (punch to pick)"}`);
    });
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
    this.updateSlotTexts();
  }

  update(): void {
    this.updateExpiry();
    let changed = false;
    this.players.forEach((p, i) => {
      if (!p) return;
      if (!p.source.connected && p.input.kind === "pad") {
        this.players[i] = null;
        changed = true;
        return;
      }
      const now = p.source.read();
      const pressed = (k: keyof InputFrame) => now[k] && !p.previous[k];
      const n = this.library.length;
      if (!p.ready && n) {
        let c = p.cursor;
        if (pressed("left")) c = (c - 1 + n) % n;
        if (pressed("right")) c = (c + 1) % n;
        if (pressed("up") && c - COLS >= 0) c -= COLS;
        if (pressed("down") && c + COLS < n) c += COLS;
        if (c !== p.cursor) { p.cursor = c; changed = true; }
        if (pressed("punch")) { p.ready = true; changed = true; }
      } else if (pressed("kick")) {
        p.ready = false;
        changed = true;
      } else if (pressed("punch") && this.players.filter(Boolean).length === 1) {
        p.previous = now;
        return this.startPractice(p);
      }
      if (!p.ready && pressed("kick") && !changed) {
        this.players[i] = null; // leave the slot
        changed = true;
      }
      p.previous = now;
    });
    if (changed) {
      this.updateSlotTexts();
      this.drawCursors();
    }
    if (this.pendingDelete && performance.now() > this.pendingDelete.until) {
      this.pendingDelete = null;
      this.drawGrid();
    }
    const [a, b] = this.players;
    if (a?.ready && b?.ready && this.library.length) this.startFight(a, b);
  }

  private startFight(a: PlayerSlot, b: PlayerSlot): void {
    const data: FightSceneData = {
      entries: [this.library[a.cursor], this.library[b.cursor]],
      inputs: [a.input, b.input],
    };
    void setSetting("controllerMapping", { p1: a.input, p2: b.input }).catch(() => {});
    this.scene.start("controls", data);
  }

  /** One player against a scripted dummy: another fighter from the roster (or the same one). */
  startPractice(p: PlayerSlot): void {
    const mine = this.library[p.cursor];
    const dummy = this.library.find((e) => e.fighter.fighterId !== mine.fighter.fighterId) ?? mine;
    const data: FightSceneData = { entries: [mine, dummy], inputs: [p.input, { kind: "dummy" }], practice: true };
    this.scene.start("fight", data);
  }

  // --- add a fighter (QR + room code) ----------------------------------------

  private buildHostPanel(): void {
    const x = 880;
    this.add.rectangle(x, GRID_Y, 360, 460, 0x1c1824).setOrigin(0).setStrokeStyle(2, 0xf2c14e);
    this.add.text(x + 180, GRID_Y + 14, "ADD A FIGHTER", { fontSize: "26px", fontStyle: "bold", color: "#f2c14e" }).setOrigin(0.5, 0);
    this.add.text(x + 180, GRID_Y + 48, "Scan with a phone to capture yourself", { fontSize: "15px", color: "#c9c3b8" }).setOrigin(0.5, 0);
    this.codeText = this.add.text(x + 180, GRID_Y + 316, "", { fontSize: "40px", fontStyle: "bold", color: "#f3efe6", fontFamily: "monospace" }).setOrigin(0.5, 0);
    this.expiryText = this.add.text(x + 180, GRID_Y + 360, "", { fontSize: "14px", color: "#8a8478" }).setOrigin(0.5, 0);
    this.hostText = this.add.text(x + 180, GRID_Y + 382, "", { fontSize: "15px", color: "#c9c3b8", align: "center", wordWrap: { width: 330 } }).setOrigin(0.5, 0);
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
    this.qrImage?.destroy();
    this.qrImage = this.add.image(880 + 180, GRID_Y + 200, key).setDisplaySize(240, 240);
  }

  /** "code refreshes in 3:12" under the room code; urgent in the last 30 s. */
  private updateExpiry(): void {
    const left = this.expiresAt === undefined ? null : this.expiresAt - Date.now();
    const text = left === null ? "" : left > 0 ? `code refreshes in ${formatCountdown(left)}` : "getting a new code…";
    if (this.expiryText.text !== text) this.expiryText.setText(text).setColor(left !== null && left < 30_000 ? "#f2c14e" : "#8a8478");
  }

  private showHostStatus(s: HostStatus): void {
    if (!this.alive) return;
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
      : s.kind === "waiting" ? (s.phones ? `📱 ${s.phones} phone${s.phones > 1 ? "s" : ""} connected — capture away!` : `Or open ${location.host}/capture and enter the code.${local}`)
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
    // Showing the toolbar moves the canvas; Phaser caches its position for pointer input.
    requestAnimationFrame(() => this.scale.refresh());
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
      requestAnimationFrame(() => this.game.scale.refresh());
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
    for (const p of this.players) if (p) { p.cursor = Math.min(p.cursor, Math.max(0, this.library.length - 1)); p.ready = false; }
    this.drawGrid();
    this.updateSlotTexts();
    this.setToolbarStatus(`Deleted ${entry.fighter.name}`);
  }

}
