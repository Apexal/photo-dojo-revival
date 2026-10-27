import Phaser from "phaser";
import type { Fighter } from "../../shared/fighter-model";
import { CAPTURE_TARGET_COUNT } from "../../shared/pose-definitions";
import { FightSimulation, type FightState } from "../../simulation/fight-simulation";
import type { InputFrame } from "../../simulation/input-frame";
import type { PlayerIndex } from "../../simulation/round-rules";
import { geometryOf, type LibraryEntry } from "../fighter-library";
import { DummyInputSource, type DummyBehavior } from "../input/dummy-input-source";
import type { PlayerInputDescriptor } from "../input/input-descriptor";
import { KeyboardInputSource } from "../input/keyboard-input-source";
import { getOptions } from "../options";
import { FighterSpriteView, fallbackSoundKey, fighterTextureKeys, loadFighterSounds, preloadFighterTextures } from "../render/fighter-sprite-view";
import { HitMarkers } from "../render/hit-markers";
import { GAME_HEIGHT, GAME_WIDTH } from "../render/stage";
import { randomStage, type StageDefinition } from "../stages/stages";
import { preloadStage } from "../stages/stage-music";
import { pickTake } from "../sound-choice";
import { REGISTRY } from "./boot-scene";
import type { CharacterSelectData } from "./character-select-scene";
import { MIRROR_TINT } from "./controls-scene";
import { playMenuMusic } from "../menu-music";
import { bodyText, COLOR, displayText, HEX, popBox, SHADOW } from "../render/theme";

export interface TitleSceneData {
  /** A later bout of the demo: the logo is already up, no flash. */
  revealed?: boolean;
}

const PREFIXES = ["demo0", "demo1"] as const;
const STEP_MS = 1000 / 60;
const MAX_FRAME_MS = 100;
const CPU_LEVELS: readonly DummyBehavior[] = ["cpuNormal", "cpuHard"];
/** A demo bout ends at the KO, or after this long, whichever is first. */
const BOUT_MAX_FRAMES = 40 * 60;
/** Pause on the result before the next pair walks on. */
const BOUT_GAP_MS = 1500;
const FADE_MS = 400;
const FLASH_MS = 600;
/** The logo "develops" from a dark print to full colour, like a photo. */
const DEVELOP_MS = 1400;
const UNDEVELOPED = 0x3a2a20;
const OVERLAY_DEPTH = 50;

/**
 * Title screen, shown once per page load. Behind the logo two fighters from
 * the library fight each other (CPU vs CPU, the real simulation), so the game
 * explains itself; with no captured fighters yet, a three-step strip says how
 * to get in. Any button goes to fighter select: a controller's press joins it
 * as P1, and plays a random fighter's victory line as the announcer (browsers
 * only allow sound after that first press).
 */
export class TitleScene extends Phaser.Scene {
  private setup: TitleSceneData = {};
  private pair!: [LibraryEntry, LibraryEntry];
  private stage!: StageDefinition;
  private sim!: FightSimulation;
  private sources: DummyInputSource[] = [];
  private views: FighterSpriteView[] = [];
  private markers!: HitMarkers;
  private accumulator = 0;
  private boutOverAt: number | null = null;
  private objectUrls: string[] = [];
  /** Fading out to the next bout. */
  private leaving = false;
  private started = false;
  /** Kept across bouts (the scene restarts for each pair): decoded once per page. */
  private announcerTakes: string[] | null = null;
  private announcerLoading = false;
  private lastPair: string[] = [];

  constructor() {
    super("title");
  }

  init(data: TitleSceneData): void {
    this.setup = data ?? {};
    this.accumulator = 0;
    this.boutOverAt = null;
    this.leaving = false;
    this.started = false;
    this.views = [];
    this.sources = [];
    this.pair = this.pickPair();
    this.stage = randomStage();
  }

  preload(): void {
    this.pair.forEach((e, i) => this.objectUrls.push(...preloadFighterTextures(this, e.fighter, PREFIXES[i])));
    preloadStage(this, this.stage); // its music too, so fighter select → fight doesn't load it again
  }

  create(): void {
    playMenuMusic(this);
    this.stage.build(this, this.add.container(0, 0).setDepth(0));
    const geometry = this.pair.map((e) => geometryOf(e.fighter)) as [ReturnType<typeof geometryOf>, ReturnType<typeof geometryOf>];
    this.sim = new FightSimulation(geometry, { seed: (Math.random() * 2 ** 32) >>> 0 });
    this.sources = [0, 1].map((i) => {
      const cpu = new DummyInputSource(this.sim, i as PlayerIndex);
      cpu.setBehavior(CPU_LEVELS[Math.floor(Math.random() * CPU_LEVELS.length)]);
      return cpu;
    });
    const mirrorMatch = this.pair[0].fighter.fighterId === this.pair[1].fighter.fighterId;
    this.views = [0, 1].map((i) => new FighterSpriteView(this, PREFIXES[i], geometry[i], i === 1 && mirrorMatch ? MIRROR_TINT : undefined, this.sim.grips[i]));
    this.views.forEach((v, i) => v.setDepth(10 + i));
    this.markers = new HitMarkers(this.add.graphics().setDepth(25));
    this.buildOverlay();
    this.loadAnnouncer();

    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      if (ev.key === "Tab") ev.preventDefault();
      const layout = KeyboardInputSource.layoutForKey(ev.keyCode);
      this.start(layout ? { kind: "keyboard", layout } : null);
    });
    this.input.gamepad?.on("down", (pad: Phaser.Input.Gamepad.Gamepad) => this.start({ kind: "pad", index: pad.index }));
    this.input.on("pointerdown", () => this.start(null));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.removeAllListeners("keydown");
      this.input.gamepad?.removeAllListeners("down");
      this.input.removeAllListeners("pointerdown");
      this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
      this.objectUrls = [];
      this.pair.forEach((e, i) => fighterTextureKeys(e.fighter, PREFIXES[i]).forEach((k) => this.textures.exists(k) && this.textures.remove(k)));
    });
    if (this.setup.revealed) this.cameras.main.fadeIn(FADE_MS);
  }

  /** Two fighters for the next bout: captured ones when there are any, not the same pair twice running. */
  private pickPair(): [LibraryEntry, LibraryEntry] {
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    const captured = library.filter((e) => !e.builtIn);
    const pool = captured.length >= 2 ? captured : library;
    const pick = (from: LibraryEntry[]) => from[Math.floor(Math.random() * from.length)];
    for (let attempt = 0; ; attempt++) {
      const a = pick(pool);
      const others = pool.filter((e) => e !== a);
      const b = others.length ? pick(others) : captured.length ? pick(library.filter((e) => e !== a)) ?? a : a;
      const ids = [a.fighter.fighterId, b.fighter.fighterId].sort();
      if (attempt < 5 && pool.length > 2 && ids.join() === this.lastPair.join()) continue;
      this.lastPair = ids;
      return [a, b];
    }
  }

  // --- overlay -----------------------------------------------------------------

  private buildOverlay(): void {
    const cx = GAME_WIDTH / 2;
    // A darker sky behind the words, fading out above the fighters' heads.
    this.add.graphics().setDepth(OVERLAY_DEPTH - 1)
      .fillGradientStyle(HEX.ink, HEX.ink, HEX.ink, HEX.ink, 0.75, 0.75, 0, 0).fillRect(0, 0, GAME_WIDTH, 350);
    const logo = this.add.text(cx, 86, "FOTO FIGHTER", displayText(112, COLOR.accent)).setOrigin(0.5).setDepth(OVERLAY_DEPTH);
    const tagline = this.add.text(cx, 204, "Snap yourself. Fight your friends, side by side.", bodyText(24, COLOR.fg, 800, { stroke: COLOR.ink, strokeThickness: 5 }))
      .setOrigin(0.5).setDepth(OVERLAY_DEPTH);
    const late: Phaser.GameObjects.GameObject[] = [tagline, ...this.buildFooter()];
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    if (!library.some((e) => !e.builtIn)) late.push(...this.buildHowTo(cx, 256));
    const prompt = this.add.text(cx, library.some((e) => !e.builtIn) ? 256 : 318, "Press any button", displayText(34, COLOR.fg)).setOrigin(0.5).setDepth(OVERLAY_DEPTH);
    // Starts pulsing once the logo has developed.
    this.tweens.add({ targets: prompt, alpha: { from: 1, to: 0.35 }, delay: this.setup.revealed ? 0 : DEVELOP_MS, duration: 800, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    if (!this.setup.revealed) prompt.setAlpha(0);
    const [a, b] = this.pair.map((e) => e.fighter.name);
    late.push(this.add.text(16, GAME_HEIGHT - 12, `${a}  vs  ${b}`, displayText(18, COLOR.fg))
      .setOrigin(0, 1).setDepth(OVERLAY_DEPTH));
    if (!this.setup.revealed) this.reveal(logo, late);
  }

  /** Bottom right: the About page and feedback (new tabs, so the room stays open), and the fan-project disclaimer. */
  private buildFooter(): Phaser.GameObjects.GameObject[] {
    const x = GAME_WIDTH - 16;
    const style = bodyText(15, COLOR.fg, 800, { stroke: COLOR.ink, strokeThickness: 4 });
    const link = (right: number, label: string, path: string) => {
      const text = this.add.text(right, GAME_HEIGHT - 34, label, style).setOrigin(1, 1).setDepth(OVERLAY_DEPTH)
        .setInteractive({ useHandCursor: true });
      text.on("pointerover", () => text.setColor(COLOR.accent));
      text.on("pointerout", () => text.setColor(COLOR.fg));
      text.on("pointerdown", (_p: unknown, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation(); // not a "press any button"
        window.open(`${import.meta.env.BASE_URL}${path}`, "_blank", "noopener");
      });
      return text;
    };
    const feedback = link(x, "Bugs & ideas ↗", "about#feedback");
    const about = link(x - feedback.width - 24, "About · FAQ · Credits ↗", "about");
    const disclaimer = this.add.text(x, GAME_HEIGHT - 12, "Unofficial fan project · not affiliated with Nintendo", { ...style, fontSize: "13px", fontStyle: "600", color: COLOR.muted })
      .setOrigin(1, 1).setDepth(OVERLAY_DEPTH);
    return [about, feedback, disclaimer];
  }

  /** First visit (nothing captured yet): how to get yourself in the game. */
  private buildHowTo(cx: number, y: number): Phaser.GameObjects.GameObject[] {
    const steps = ["📷 Open the studio", `🥋 Strike ${CAPTURE_TARGET_COUNT} poses`, "🥊 Fight as yourself"];
    const gap = 330;
    const bandW = gap * steps.length + 40;
    const band = popBox(this, cx - bandW / 2, y - 26, bandW, 52, { fill: HEX.panel, fillAlpha: 0.92, radius: 26, shadow: SHADOW.sm }).setDepth(OVERLAY_DEPTH);
    const items: Phaser.GameObjects.GameObject[] = [band];
    steps.forEach((step, i) => {
      const x = cx + (i - 1) * gap;
      items.push(this.add.text(x, y, step, displayText(22, COLOR.fg, { outline: false })).setOrigin(0.5).setDepth(OVERLAY_DEPTH));
      if (i > 0) items.push(this.add.text(x - gap / 2, y, "→", displayText(24, COLOR.accent, { outline: false })).setOrigin(0.5).setDepth(OVERLAY_DEPTH));
    });
    return items;
  }

  /** Camera flash, then the logo develops like a print; the rest fades in after it. */
  private reveal(logo: Phaser.GameObjects.Text, late: Phaser.GameObjects.GameObject[]): void {
    const flash = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0xffffff).setOrigin(0).setDepth(OVERLAY_DEPTH + 10);
    this.tweens.add({ targets: flash, alpha: 0, duration: FLASH_MS, ease: "Cubic.easeOut", onComplete: () => flash.destroy() });
    logo.setTint(UNDEVELOPED).setAlpha(0.6);
    const from = Phaser.Display.Color.ValueToColor(UNDEVELOPED), to = Phaser.Display.Color.ValueToColor(0xffffff);
    this.tweens.addCounter({
      from: 0, to: 100, duration: DEVELOP_MS, ease: "Sine.easeOut",
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(from, to, 100, t);
        logo.setTint(Phaser.Display.Color.GetColor(c.r, c.g, c.b)).setAlpha(0.6 + 0.004 * t);
      },
    });
    for (const o of late) (o as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0);
    this.tweens.add({ targets: late, alpha: 1, delay: DEVELOP_MS * 0.6, duration: 500 });
  }

  // --- demo bout ---------------------------------------------------------------

  update(time: number, delta: number): void {
    if (this.leaving || this.started) return;
    let state = this.sim.current;
    if (!this.boutOver(state)) {
      this.accumulator += Math.min(delta, MAX_FRAME_MS);
      while (this.accumulator >= STEP_MS && !this.boutOver(state)) {
        state = this.sim.step(this.sources.map((s) => s.read()) as [InputFrame, InputFrame]);
        this.handleEvents(state);
        this.accumulator -= STEP_MS;
      }
    }
    const tweening = getOptions(this.registry).poseTweening;
    state.fighters.forEach((f, i) => this.views[i]?.render(f, state.frame, tweening, state.fighters[1 - i]));
    this.markers.render(state.frame);
    if (this.boutOver(state) && this.boutOverAt === null) this.boutOverAt = time;
    if (this.boutOverAt !== null && time - this.boutOverAt > BOUT_GAP_MS) this.nextBout();
  }

  private boutOver(state: FightState): boolean {
    return state.round.phase === "roundOver" || state.round.phase === "matchOver" || state.frame > BOUT_MAX_FRAMES;
  }

  private nextBout(): void {
    this.leaving = true;
    this.cameras.main.fadeOut(FADE_MS);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (!this.started) this.scene.restart({ revealed: true } satisfies TitleSceneData);
    });
  }

  /** Sparks and dust, as in a fight; no sounds (the page can't play any yet). */
  private handleEvents(state: FightState): void {
    for (const ev of state.events) this.markers.addFor(ev, state);
  }

  // --- leaving -----------------------------------------------------------------

  /** A random fighter's victory line, shouted as the title when the player presses start. */
  private loadAnnouncer(): void {
    if (this.announcerTakes || this.announcerLoading) return;
    const library: LibraryEntry[] = this.registry.get(REGISTRY.library) ?? [];
    const voiced = library.filter((e) => !e.builtIn && e.fighter.sounds.win);
    if (!voiced.length) return;
    const fighter: Fighter = voiced[Math.floor(Math.random() * voiced.length)].fighter;
    this.announcerLoading = true;
    void loadFighterSounds(this, fighter, "announcer").then((keys) => { this.announcerTakes = keys.win; });
  }

  private start(join: PlayerInputDescriptor | null): void {
    if (this.started) return;
    this.started = true;
    const key = pickTake(this.announcerTakes ?? [fallbackSoundKey("win")], undefined);
    const volume = getOptions(this.registry).voiceVolume;
    if (volume > 0 && this.cache.audio.exists(key)) this.sound.play(key, { volume });
    this.scene.start("character-select", { join: join ?? undefined } satisfies CharacterSelectData);
  }
}
