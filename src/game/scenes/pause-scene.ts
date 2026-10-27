import Phaser from "phaser";
import { GRAB_TIPS, GUARD_TIPS, controlLabels, deviceName, moveGuide } from "../input/control-labels";
import { feedbackUrl } from "../../shared/feedback";
import { isPlayerInput } from "../input/input-descriptor";
import { MenuInput } from "../input/menu-input";
import { getOptions } from "../options";
import { Menu } from "../render/menu";
import { SERIES_INFO } from "../series";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawPopBox, HEX, popBox, RADIUS, SHADOW } from "../render/theme";
import type { FightScene } from "./fight-scene";

const PLAYER_CSS = [COLOR.bad, COLOR.p2];
const PANEL_W = 520;
const DISCONNECT_Y = 76;

/**
 * Pause menu over the frozen fight: Resume / Controls / Settings / Restart
 * round / Report a problem / Quit. Any controller can drive it. While a player's controller is
 * disconnected it says so and Resume waits for them to reconnect.
 */
export class PauseScene extends Phaser.Scene {
  private menuInput!: MenuInput;
  private menu!: Menu;
  private menuObjects: Phaser.GameObjects.GameObject[] = [];
  private controls: Phaser.GameObjects.GameObject[] = [];
  private disconnectText!: Phaser.GameObjects.Text;
  private disconnectBox!: Phaser.GameObjects.Graphics;
  private shownDisconnect: number | null = null;
  private hint!: Phaser.GameObjects.Text;
  private note!: Phaser.GameObjects.Text;

  constructor() {
    super("pause");
  }

  private get fight(): FightScene {
    return this.scene.get("fight") as FightScene;
  }

  create(): void {
    this.menuInput = new MenuInput(this);
    this.controls = [];
    this.shownDisconnect = null;
    const practice = this.fight.isPractice;
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, HEX.ink, 0.75).setOrigin(0);
    const panel = popBox(this, (GAME_WIDTH - PANEL_W) / 2, 128, PANEL_W, 480, { fill: HEX.panel, radius: RADIUS.lg, shadow: SHADOW.lg });
    this.disconnectBox = this.add.graphics().setVisible(false);
    this.disconnectText = this.add.text(GAME_WIDTH / 2, DISCONNECT_Y, "", displayText(26, COLOR.ink, { outline: false, align: "center", padding: { x: 20, y: 12 } }))
      .setOrigin(0.5).setVisible(false);
    const title = this.add.text(GAME_WIDTH / 2, 190, "PAUSED", displayText(64, COLOR.accent)).setOrigin(0.5);
    this.menu = new Menu(this, GAME_WIDTH / 2, 250, [
      { label: () => "Resume", onConfirm: () => this.fight.resumeFromPause(), disabled: () => this.fight.disconnectedPlayer !== null },
      { label: () => "Controls", onConfirm: () => this.showControls(true) },
      { label: () => "Settings", onConfirm: () => this.openSettings() },
      { label: () => (practice ? "Reset positions" : "Restart round"), onConfirm: () => this.fight.restartRound(), disabled: () => this.fight.disconnectedPlayer !== null },
      { label: () => "Report a problem ↗", onConfirm: () => this.reportProblem() },
      { label: () => (this.fight.series ? `Quit to ${SERIES_INFO[this.fight.series].home}` : "Quit to fighter select"), onConfirm: () => this.fight.quitToSelect() },
    ], { width: 420 });
    this.hint = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 60, "", bodyText(17, COLOR.muted, 600)).setOrigin(0.5);
    const hint = this.hint;
    this.note = this.add.text(GAME_WIDTH / 2, 628, "", bodyText(17, COLOR.fg, 800, { align: "center" })).setOrigin(0.5);
    this.menuObjects = [panel, title, hint, this.note];
    const onResume = () => this.menuInput.reset();
    this.events.on(Phaser.Scenes.Events.RESUME, onResume);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.events.off(Phaser.Scenes.Events.RESUME, onResume));
    this.updateDisconnect();
  }

  /** GitHub's bug form in a new tab, with the browser's details filled in. */
  private reportProblem(): void {
    // Not "noopener": with it, window.open returns null even when the tab opened.
    const tab = window.open(feedbackUrl("bug", `Paused in ${this.fight.isPractice ? "practice" : "a fight"}`), "_blank");
    if (tab) tab.opener = null;
    this.note.setText(tab
      ? "Opened in a new tab: tell us what happened there."
      : "The browser blocked the new tab. Click Report a problem with the mouse, or see About → Bugs & ideas.");
  }

  private openSettings(): void {
    this.scene.pause();
    this.scene.launch("settings", { returnTo: "pause" });
  }

  /** Each player's moves for their own device and side. */
  private showControls(show: boolean): void {
    this.menu.setVisible(!show);
    this.menuObjects.forEach((o) => (o as Phaser.GameObjects.Text).setVisible(!show));
    this.controls.forEach((o) => o.destroy());
    this.controls = [];
    if (!show) return;
    const { inputs, fighters } = this.fight.playerInfo;
    inputs.forEach((input, p) => {
      if (!isPlayerInput(input)) return;
      const x = p === 0 ? 120 : GAME_WIDTH / 2 + 60;
      const labels = controlLabels(input, p === 0 ? "left" : "right");
      this.controls.push(popBox(this, x - 30, 92, 520, 412, { fill: HEX.panel, radius: RADIUS.lg, shadow: SHADOW.lg }));
      const lines = moveGuide(fighters[p].archetype).map((m) => `${m.name.padEnd(16)} ${m.how(labels)}`).join("\n");
      this.controls.push(
        this.add.text(x, 110, `P${p + 1} · ${fighters[p].name}`, displayText(30, PLAYER_CSS[p])),
        this.add.text(x, 148, deviceName(input), bodyText(17, COLOR.muted, 600)),
        // Monospace so the move names and their buttons line up in columns.
        this.add.text(x, 186, lines, bodyText(21, COLOR.fg, 500, { fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineSpacing: 8 })),
      );
    });
    this.controls.push(
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 110, `${GUARD_TIPS}\n${GRAB_TIPS}`, bodyText(17, COLOR.muted, 600, { align: "center" })).setOrigin(0.5),
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 50, "Any button: back", bodyText(18, COLOR.muted, 600)).setOrigin(0.5),
    );
  }

  private updateDisconnect(): void {
    const player = this.fight.disconnectedPlayer;
    if (player === this.shownDisconnect) return;
    this.shownDisconnect = player;
    this.disconnectText
      .setText(player === null ? "" : `P${player + 1}'s controller disconnected — press any button to reconnect`)
      .setVisible(player !== null);
    const t = this.disconnectText;
    this.disconnectBox.clear().setVisible(player !== null);
    if (player !== null) drawPopBox(this.disconnectBox, t.x - t.width / 2, t.y - t.height / 2, t.width, t.height, { fill: HEX.bad, radius: RADIUS.md, shadow: SHADOW.md });
    this.menu.refresh();
  }

  update(): void {
    const wasDisconnected = this.shownDisconnect !== null;
    this.fight.pollReconnect();
    this.updateDisconnect();
    if (wasDisconnected && this.shownDisconnect === null) {
      // The press that reconnected a controller isn't also a menu choice.
      this.menuInput.reset();
      return;
    }
    const hint = `▲ ▼ choose  ·  punch / Enter: select  ·  kick, Esc or Start: resume  ·  R: rumble ${getOptions(this.registry).rumble ? "ON" : "OFF"}`;
    if (this.hint.text !== hint) this.hint.setText(hint);
    const actions = this.menuInput.poll();
    if (this.controls.length) {
      if (actions.size) this.showControls(false);
      return;
    }
    if (actions.has("pause") || actions.has("back")) {
      if (this.fight.disconnectedPlayer === null) this.fight.resumeFromPause();
      return;
    }
    this.menu.handle(actions);
  }
}
