import Phaser from "phaser";
import { MOVE_GUIDE, controlLabels, deviceName } from "../input/control-labels";
import { isPlayerInput } from "../input/input-descriptor";
import { MenuInput } from "../input/menu-input";
import { getOptions } from "../options";
import { Menu } from "../render/menu";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import type { FightScene } from "./fight-scene";

const PLAYER_CSS = ["#e8483b", "#3f86f0"];

/**
 * Pause menu over the frozen fight: Resume / Controls / Settings / Restart
 * round / Quit. Any controller can drive it. While a player's controller is
 * disconnected it says so and Resume waits for them to reconnect.
 */
export class PauseScene extends Phaser.Scene {
  private menuInput!: MenuInput;
  private menu!: Menu;
  private menuObjects: Phaser.GameObjects.GameObject[] = [];
  private controls: Phaser.GameObjects.GameObject[] = [];
  private disconnectText!: Phaser.GameObjects.Text;
  private shownDisconnect: number | null = null;
  private hint!: Phaser.GameObjects.Text;

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
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x121018, 0.78).setOrigin(0);
    this.disconnectText = this.add.text(GAME_WIDTH / 2, 120, "", {
      fontSize: "26px", fontStyle: "bold", color: "#f3efe6", backgroundColor: "#8c2a22", padding: { x: 20, y: 12 }, align: "center",
    }).setOrigin(0.5).setVisible(false);
    const title = this.add.text(GAME_WIDTH / 2, 190, "PAUSED", { fontSize: "64px", fontStyle: "bold", color: "#f2c14e" }).setOrigin(0.5);
    this.menu = new Menu(this, GAME_WIDTH / 2, 250, [
      { label: () => "Resume", onConfirm: () => this.fight.resumeFromPause(), disabled: () => this.fight.disconnectedPlayer !== null },
      { label: () => "Controls", onConfirm: () => this.showControls(true) },
      { label: () => "Settings", onConfirm: () => this.openSettings() },
      { label: () => (practice ? "Reset positions" : "Restart round"), onConfirm: () => this.fight.restartRound(), disabled: () => this.fight.disconnectedPlayer !== null },
      { label: () => (this.fight.isTournament ? "Quit to the bracket" : "Quit to fighter select"), onConfirm: () => this.fight.quitToSelect() },
    ], { width: 420 });
    this.hint = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 60, "", { fontSize: "17px", color: "#a8a196" }).setOrigin(0.5);
    const hint = this.hint;
    this.menuObjects = [title, hint];
    const onResume = () => this.menuInput.reset();
    this.events.on(Phaser.Scenes.Events.RESUME, onResume);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.events.off(Phaser.Scenes.Events.RESUME, onResume));
    this.updateDisconnect();
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
    const { inputs, names } = this.fight.playerInfo;
    inputs.forEach((input, p) => {
      if (!isPlayerInput(input)) return;
      const x = p === 0 ? 120 : GAME_WIDTH / 2 + 60;
      const labels = controlLabels(input, p === 0 ? "left" : "right");
      const lines = MOVE_GUIDE.map((m) => `${m.name.padEnd(10)} ${m.how(labels)}`).join("\n");
      this.controls.push(
        this.add.text(x, 110, `P${p + 1} · ${names[p]}`, { fontSize: "28px", fontStyle: "bold", color: PLAYER_CSS[p] }),
        this.add.text(x, 148, deviceName(input), { fontSize: "17px", color: "#c9c3b8" }),
        this.add.text(x, 190, lines, { fontSize: "22px", color: "#f3efe6", fontFamily: "monospace", lineSpacing: 10 }),
      );
    });
    this.controls.push(
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 110, "Hold down to crouch: punches whiff over you.  Jump kick: block it standing.  Low kick: block it crouching.\nGrabbed? Press punch + kick to break free.  Punch + kick from far away = taunt.", {
        fontSize: "17px", color: "#c9c3b8", align: "center",
      }).setOrigin(0.5),
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 50, "Any button: back", { fontSize: "18px", color: "#a8a196" }).setOrigin(0.5),
    );
  }

  private updateDisconnect(): void {
    const player = this.fight.disconnectedPlayer;
    if (player === this.shownDisconnect) return;
    this.shownDisconnect = player;
    this.disconnectText
      .setText(player === null ? "" : `P${player + 1}'s controller disconnected — press any button to reconnect`)
      .setVisible(player !== null);
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
