import Phaser from "phaser";
import { keyboardKeys } from "../input/input-descriptor";
import { KEY, RemapSession, actionName, isDefaultBindings, keyBindings, type KeyboardLayout } from "../input/key-bindings";
import { MenuInput } from "../input/menu-input";
import { fallbackSoundKey } from "../render/fighter-sprite-view";
import { Menu } from "../render/menu";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop } from "../render/theme";
import { gameSoundKey } from "../game-sounds";
import { announcerKey } from "../announcer";
import { getOptions, resetKeyBindings, saveKeyBindings, setOption } from "../options";
import { updateMenuMusicVolume } from "../menu-music";

export interface SettingsSceneData {
  /** Scene to resume on close (it was paused while settings are open). */
  returnTo: string;
}

const VOLUME_STEP = 0.1;

/**
 * Volumes, screen shake, camera, rumble, smooth motion, and keyboard remapping. Opened over fighter
 * select or the pause menu; every change is saved right away.
 */
export class SettingsScene extends Phaser.Scene {
  private returnTo = "character-select";
  private menuInput!: MenuInput;
  private menu!: Menu;
  private remap: RemapSession | null = null;
  private promptText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;

  constructor() {
    super("settings");
  }

  init(data: SettingsSceneData): void {
    this.returnTo = data.returnTo;
    this.remap = null;
  }

  create(): void {
    this.menuInput = new MenuInput(this);
    // A menu screen of its own, over fighter select or the paused fight (whose pause panel would show through a dim).
    drawBackdrop(this);
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.001).setOrigin(0).setInteractive(); // swallow clicks
    this.add.text(GAME_WIDTH / 2, 34, "SETTINGS", displayText(56, COLOR.accent)).setOrigin(0.5, 0);

    const options = () => getOptions(this.registry);
    const onOff = (v: boolean) => (v ? "On" : "Off");
    const percent = (v: number) => `${Math.round(v * 100)}%`;
    const volume = (key: "gameVolume" | "voiceVolume" | "announcerVolume" | "musicVolume", preview: string | null) => (direction: -1 | 1) => {
      const value = Math.round(Math.min(1, Math.max(0, options()[key] + direction * VOLUME_STEP)) * 10) / 10;
      setOption(this.registry, key, value);
      if (preview && value > 0 && this.cache.audio.exists(preview)) this.sound.play(preview, { volume: value });
      if (key === "musicVolume") updateMenuMusicVolume(this); // the menu music, if it's on, is the preview
    };
    const toggle = (key: "screenShake" | "dynamicCamera" | "rumble" | "poseTweening") => () => setOption(this.registry, key, !options()[key]);
    const row = (name: string, value: string) => `${name}\t${value}`;

    this.menu = new Menu(this, GAME_WIDTH / 2, 120, [
      { label: () => row("Game volume", `◀ ${percent(options().gameVolume)} ▶`), onAdjust: volume("gameVolume", gameSoundKey("hit")) },
      { label: () => row("Voice volume", `◀ ${percent(options().voiceVolume)} ▶`), onAdjust: volume("voiceVolume", fallbackSoundKey("hurt")) },
      { label: () => row("Announcer volume", `◀ ${percent(options().announcerVolume)} ▶`), onAdjust: volume("announcerVolume", announcerKey("fight")) },
      // Previewed by the menu music when it's playing; a fight's soundtrack picks the new level up when it resumes.
      { label: () => row("Music volume", `◀ ${percent(options().musicVolume)} ▶`), onAdjust: volume("musicVolume", null) },
      { label: () => row("Screen shake", onOff(options().screenShake)), onAdjust: toggle("screenShake") },
      { label: () => row("Dynamic camera", onOff(options().dynamicCamera)), onAdjust: toggle("dynamicCamera") },
      { label: () => row("Controller rumble", onOff(options().rumble)), onAdjust: toggle("rumble") },
      { label: () => row("Smooth motion", onOff(options().poseTweening)), onAdjust: toggle("poseTweening") },
      { label: () => row("P1 keys", keyboardKeys("p1")), onConfirm: () => this.startRemap("p1") },
      { label: () => row("P2 keys", keyboardKeys("p2")), onConfirm: () => this.startRemap("p2") },
      { label: () => "Reset keys to default", onConfirm: () => resetKeyBindings(), disabled: () => isDefaultBindings(keyBindings()) },
      { label: () => "Back", onConfirm: () => this.close() },
    ], { width: 720, lineHeight: 36, fontSize: 24 });

    this.promptText = this.add.text(GAME_WIDTH / 2, 552, "", displayText(26, COLOR.accent, { align: "center" })).setOrigin(0.5, 0);
    this.messageText = this.add.text(GAME_WIDTH / 2, 592, "", bodyText(19, COLOR.bad, 600)).setOrigin(0.5, 0);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 70,
      "Throws need punch + kick pressed together. Some keyboards can't register that while a direction is held;\nif throws don't come out, remap to keys that are further apart.", bodyText(16, COLOR.muted, 600, { align: "center" })).setOrigin(0.5, 0);
    this.add.text(GAME_WIDTH / 2, 552, "▲ ▼ choose  ·  ◀ ▶ change  ·  punch / Enter: select  ·  kick / Esc: back", bodyText(17, COLOR.muted, 600))
      .setOrigin(0.5, 0).setName("hint");

    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => this.onRemapKey(ev));
  }

  private startRemap(layout: KeyboardLayout): void {
    this.remap = new RemapSession(layout);
    this.messageText.setText("");
    this.showPrompt();
  }

  private showPrompt(): void {
    const hint = this.children.getByName("hint") as Phaser.GameObjects.Text;
    hint.setVisible(!this.remap);
    if (!this.remap?.action) return void this.promptText.setText("");
    this.promptText.setText(`${this.remap.layout.toUpperCase()}: press the key for ${actionName(this.remap.action).toUpperCase()}   (Esc: cancel)`);
  }

  private onRemapKey(ev: KeyboardEvent): void {
    if (!this.remap || ev.repeat) return;
    ev.preventDefault();
    if (ev.keyCode === KEY.ESC) return this.endRemap("Cancelled — keys unchanged", false);
    const refused = this.remap.press(ev.keyCode);
    if (refused) return void this.messageText.setColor(COLOR.bad).setText(refused);
    this.messageText.setText("");
    if (!this.remap.done) return this.showPrompt();
    const layout = this.remap.layout;
    saveKeyBindings(this.remap.result());
    this.endRemap(`Saved ${layout.toUpperCase()} keys: ${keyboardKeys(layout)}`, true);
  }

  private endRemap(message: string, saved: boolean): void {
    this.remap = null;
    this.messageText.setColor(saved ? COLOR.ok : COLOR.muted).setText(message);
    this.showPrompt();
    this.menu.refresh();
    // The keys just pressed shouldn't also move the menu.
    this.menuInput.reset();
  }

  private close(): void {
    this.scene.stop();
    this.scene.resume(this.returnTo);
  }

  update(): void {
    if (this.remap) return;
    const actions = this.menuInput.poll();
    if (actions.has("back") || actions.has("pause")) return this.close();
    this.menu.handle(actions);
  }
}
