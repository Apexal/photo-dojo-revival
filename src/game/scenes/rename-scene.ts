import Phaser from "phaser";
import { MAX_TYPED_NAME_LENGTH, tidyFighterName } from "../../shared/fighter-model";
import { saveFighter } from "../../shared/fighter-storage";
import type { LibraryEntry } from "../fighter-library";
import { playGameSound } from "../game-sounds";
import { KEY } from "../input/key-bindings";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, RADIUS, SHADOW } from "../render/theme";
import { REGISTRY } from "./boot-scene";

export interface RenameSceneData {
  fighterId: string;
  /** Scene to resume on close (it was paused while this is open), with `RenameResult` as the resume data. */
  returnTo: string;
}

/** Handed to the resumed scene: the new name, or null when nothing changed. */
export interface RenameResult {
  renamed: { from: string; to: string } | null;
}

const BOX_W = 640;

/**
 * Rename a captured fighter: type over their name (keyboard), Enter or Save
 * keeps it, Esc or Cancel doesn't. Saved to IndexedDB and the library in the
 * registry. Opened over fighter select from the selected tile's ✎ button.
 */
export class RenameScene extends Phaser.Scene {
  private setup!: RenameSceneData;
  private entry: LibraryEntry | undefined;
  private name = "";
  private nameText!: Phaser.GameObjects.Text;
  private counter!: Phaser.GameObjects.Text;
  private caret!: Phaser.GameObjects.Rectangle;
  private saving = false;

  constructor() {
    super("rename");
  }

  init(data: RenameSceneData): void {
    this.setup = data;
    this.saving = false;
  }

  create(): void {
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    this.entry = library.find((e) => e.fighter.fighterId === this.setup.fighterId);
    if (!this.entry || this.entry.builtIn) return this.close(null);
    this.name = this.entry.fighter.name.slice(0, MAX_TYPED_NAME_LENGTH);

    const cx = GAME_WIDTH / 2;
    drawBackdrop(this);
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.001).setOrigin(0).setInteractive(); // swallow clicks
    this.add.text(cx, 200, "RENAME FIGHTER", displayText(52, COLOR.accent)).setOrigin(0.5);
    // The name field: a sunken well, outlined in accent while it has the keyboard (always, here).
    drawPopBox(this.add.graphics(), cx - BOX_W / 2, 300 - 36, BOX_W, 72, { fill: HEX.well, border: HEX.accent, radius: RADIUS.md, shadow: 0 });
    this.nameText = this.add.text(cx, 300, "", displayText(36, COLOR.fg, { outline: false })).setOrigin(0.5);
    this.caret = this.add.rectangle(0, 300, 3, 40, HEX.accent);
    this.tweens.add({ targets: this.caret, alpha: 0, duration: 500, yoyo: true, repeat: -1, ease: "Stepped" });
    this.counter = this.add.text(cx + BOX_W / 2, 346, "", bodyText(15, COLOR.faint, 600)).setOrigin(1, 0);
    this.add.text(cx, 400, "Type a new name  ·  Enter: save  ·  Esc: cancel", bodyText(18, COLOR.muted, 600)).setOrigin(0.5);
    this.button(cx - 90, "Save", true, () => void this.save());
    this.button(cx + 90, "Cancel", false, () => this.close(null));
    // The browser's own events: Phaser's replays a frame's earlier keys when several land in one frame (fast typing).
    const onKey = (ev: KeyboardEvent) => this.onKey(ev);
    window.addEventListener("keydown", onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => window.removeEventListener("keydown", onKey));
    this.refresh();
  }

  /** A popped button: the primary one gold, the other a panel that turns gold on hover. */
  private button(x: number, label: string, primary: boolean, onClick: () => void): void {
    const box = this.add.graphics();
    const text = this.add.text(x, 470, label, displayText(24, primary ? COLOR.ink : COLOR.fg, { outline: false, padding: { x: 22, y: 10 } }))
      .setOrigin(0.5).setInteractive({ useHandCursor: true }).on("pointerdown", onClick);
    const draw = (hover: boolean) => {
      const gold = primary || hover;
      text.setColor(gold ? COLOR.ink : COLOR.fg);
      drawPopBox(box.clear(), text.x - text.width / 2, text.y - text.height / 2, text.width, text.height, {
        fill: gold ? HEX.accent : HEX.panel, border: hover ? HEX.fg : HEX.ink, radius: RADIUS.md, shadow: SHADOW.md,
      });
    };
    text.on("pointerover", () => draw(true)).on("pointerout", () => draw(false));
    draw(false);
  }

  private onKey(ev: KeyboardEvent): void {
    if (this.saving) return;
    if (ev.keyCode === KEY.ESC) return this.close(null);
    if (ev.keyCode === KEY.ENTER) return void this.save();
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    ev.preventDefault(); // Tab, Space and the rest stay in the box
    if (ev.key === "Backspace") this.name = this.name.slice(0, -1);
    else if (ev.key.length === 1 && this.name.length < MAX_TYPED_NAME_LENGTH) this.name += ev.key;
    else return;
    this.refresh();
  }

  private refresh(): void {
    this.nameText.setText(this.name);
    this.caret.setX(this.nameText.x + this.nameText.width / 2 + 4);
    this.counter.setText(`${this.name.length} / ${MAX_TYPED_NAME_LENGTH}`);
  }

  private async save(): Promise<void> {
    const entry = this.entry!;
    const name = tidyFighterName(this.name);
    if (!name) return playGameSound(this, "block", 0.4);
    if (name === entry.fighter.name) return this.close(null);
    this.saving = true;
    const fighter = { ...entry.fighter, name };
    try {
      await saveFighter(fighter);
    } catch (err) {
      console.error("[rename] couldn't save", err);
      this.saving = false;
      return void this.counter.setColor(COLOR.bad).setText("Couldn't save: storage unavailable");
    }
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    this.registry.set(REGISTRY.library, library.map((e) => (e.fighter.fighterId === fighter.fighterId ? { ...e, fighter } : e)));
    playGameSound(this, "hit", 0.6);
    this.close({ from: entry.fighter.name, to: name });
  }

  private close(renamed: RenameResult["renamed"]): void {
    this.scene.stop();
    this.scene.resume(this.setup.returnTo, { renamed } satisfies RenameResult);
  }
}
