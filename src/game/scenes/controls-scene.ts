import Phaser from "phaser";
import { ATTACKS, GRABS, PARRY_TOTAL_FRAMES, grabTotalFrames, groundAnchorFor, isGrab, type FighterAction, type FighterGeometry } from "../../shared/frame-data";
import { SPRITE_CANVAS_SIZE } from "../../shared/fighter-model";
import { frameOf } from "../../simulation/fight-simulation";
import { GRAVITY, JUMP_IMPULSE, createFighterState, isAttack } from "../../simulation/fighter-state-machine";
import type { InputFrame } from "../../simulation/input-frame";
import { geometryOf } from "../fighter-library";
import { GRAB_TIPS, GUARD_TIPS, controlLabels, deviceName, moveGuide } from "../input/control-labels";
import { createInputSource, describeInput, isPlayerInput, type PlayerInputDescriptor } from "../input/input-descriptor";
import type { InputSource } from "../input/input-source";
import { fighterTextureKeys, preloadFighterTextures, textureKey } from "../render/fighter-sprite-view";
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from "../render/stage";
import { bodyText, COLOR, displayText, drawBackdrop, drawPopBox, HEX, popBox, RADIUS, SHADOW, stamp } from "../render/theme";
import { menuSceneFor, type FightSceneData } from "./fight-scene";
import { stopMenuMusic } from "../menu-music";
import { announce } from "../announcer";

const PREFIXES = ["ctl0", "ctl1"] as const;
export const MIRROR_TINT = 0x9fc4ff;
const PLAYER_CSS = [COLOR.bad, COLOR.p2];
const COLS = 5;
const CARD_W = 116;
const CARD_GAP = 4;
/** Each player's half is a panel; the cards sit inside it with this much room. */
const PANEL_PAD = 12;
const PANEL_W = COLS * CARD_W + (COLS - 1) * CARD_GAP + 2 * PANEL_PAD;
const PANEL_TOP = 74;
const PANEL_BOTTOM = 640;
const CARD_H = 190;
const SPRITE_SCALE = 0.24;
const PAUSE_FRAMES = 30;
/** Previews run in slow motion so the hard cuts are readable (real attack frames last ~0.1 s). */
const PREVIEW_SPEED = 0.5;
/** Cards start their loops at different times so the screen isn't all wind-up poses at once. */
const STAGGER_FRAMES = 11;
const INPUT_DELAY_MS = 500;

/** How long each card's loop runs before a short idle pause. */
function loopFrames(action: FighterAction): number {
  if (isAttack(action)) return ATTACKS[action].startup + ATTACKS[action].active + ATTACKS[action].recovery;
  if (isGrab(action)) return grabTotalFrames(GRABS[action]);
  if (action === "parry") return PARRY_TOTAL_FRAMES;
  if (action === "jump") return Math.round((2 * -JUMP_IMPULSE) / GRAVITY);
  return 40;
}

/** Shrink a label that's wider than its card. */
function fitWidth(text: Phaser.GameObjects.Text, width: number): Phaser.GameObjects.Text {
  return text.width > width ? text.setScale(width / text.width) : text;
}

interface Card {
  sprite: Phaser.GameObjects.Image;
  action: FighterAction;
  player: number;
  baseY: number;
  frames: number;
  offset: number;
}

/**
 * Pre-match screen: each player's controls for their own device and side,
 * with every move previewed using their fighter's frames (hard cuts, real
 * frame data). Both press punch to start; kick goes back to fighter select.
 */
export class ControlsScene extends Phaser.Scene {
  private setup!: FightSceneData;
  private geometry: FighterGeometry[] = [];
  private cards: Card[] = [];
  private sources: InputSource[] = [];
  /** Which player each source is (the CPU has none). */
  private seats: (0 | 1)[] = [];
  private previous: InputFrame[] = [];
  private ready: [boolean, boolean] = [false, false];
  private readyTexts: Phaser.GameObjects.Text[] = [];
  private readyStamps: Phaser.GameObjects.Container[] = [];
  private panels: Phaser.GameObjects.Graphics[] = [];
  private objectUrls: string[] = [];
  private frame = 0;
  private openedAt = 0;

  constructor() {
    super("controls");
  }

  init(data: FightSceneData): void {
    this.setup = data;
    this.cards = [];
    // The CPU is always ready.
    this.ready = [!isPlayerInput(data.inputs[0]), !isPlayerInput(data.inputs[1])];
    this.frame = 0;
  }

  preload(): void {
    this.setup.entries.forEach((e, i) => this.objectUrls.push(...preloadFighterTextures(this, e.fighter, PREFIXES[i])));
  }

  create(): void {
    stopMenuMusic(this);
    this.openedAt = performance.now();
    this.geometry = this.setup.entries.map((e) => geometryOf(e.fighter));
    this.seats = ([0, 1] as const).filter((i) => isPlayerInput(this.setup.inputs[i]));
    this.sources = this.seats.map((i) => createInputSource(this, this.setup.inputs[i] as PlayerInputDescriptor));
    this.previous = this.sources.map((s) => s.read());
    drawBackdrop(this);
    this.add.text(GAME_WIDTH / 2, 14, "HOW TO FIGHT", displayText(44, COLOR.accent)).setOrigin(0.5, 0);
    [0, 1].forEach((p) => this.buildHalf(p));
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 58, `${GUARD_TIPS}  Pause: Esc / Start`, bodyText(16, COLOR.muted, 600)).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 32, `Previews in slow motion.  ${GRAB_TIPS}`, bodyText(16, COLOR.muted, 600)).setOrigin(0.5);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.setup.entries.forEach((e, i) => fighterTextureKeys(e.fighter, PREFIXES[i]).forEach((k) => this.textures.exists(k) && this.textures.remove(k)));
      this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
      this.objectUrls = [];
    });
  }

  private buildHalf(player: number): void {
    const left = player === 0;
    // Two panels, centred on each half of the screen with a gap between them.
    const panelX = left ? GAME_WIDTH / 2 - 8 - PANEL_W : GAME_WIDTH / 2 + 8;
    const x0 = panelX + PANEL_PAD;
    this.panels[player] = this.add.graphics({ x: panelX, y: PANEL_TOP });
    const input = this.setup.inputs[player];
    // The CPU's half shows its moves, without buttons.
    const labels = isPlayerInput(input) ? controlLabels(input, left ? "left" : "right") : null;
    const name = this.setup.entries[player].fighter.name;
    this.add.text(x0, 84, `P${player + 1} · ${name}`, displayText(30, PLAYER_CSS[player]));
    this.add.text(x0, 118, isPlayerInput(input) ? deviceName(input) : describeInput(input), bodyText(16, COLOR.muted, 600));

    moveGuide(this.setup.entries[player].fighter.archetype).forEach((move, i) => {
      const cx = x0 + (i % COLS) * (CARD_W + CARD_GAP);
      const cy = 146 + Math.floor(i / COLS) * (CARD_H + 10);
      popBox(this, cx, cy, CARD_W, CARD_H, { fill: HEX.tile, radius: RADIUS.md, shadow: SHADOW.sm });
      const baseY = cy + CARD_H - 44;
      const sprite = this.add.image(cx + CARD_W / 2, baseY, textureKey(PREFIXES[player], "idle")).setScale(SPRITE_SCALE);
      // Captures face right; the right-hand player fights facing left.
      sprite.setFlipX(!left);
      // Same tint the fight uses to tell a mirror match apart.
      if (!left && this.setup.entries[0].fighter.fighterId === this.setup.entries[1].fighter.fighterId) sprite.setTint(MIRROR_TINT);
      this.cards.push({ sprite, action: move.action, player, baseY, frames: loopFrames(move.action), offset: i * STAGGER_FRAMES });
      fitWidth(this.add.text(cx + 6, cy + 4, move.name, bodyText(15, COLOR.fg, 800)), CARD_W - 12);
      fitWidth(this.add.text(cx + CARD_W / 2, cy + CARD_H - 22, labels ? move.how(labels) : "", displayText(19, COLOR.accent, { outline: false, align: "center" })).setOrigin(0.5), CARD_W - 8);
    });

    const readyX = panelX + PANEL_W / 2;
    this.readyTexts[player] = this.add.text(readyX, GAME_HEIGHT - 100, "", displayText(24, PLAYER_CSS[player])).setOrigin(0.5);
    this.readyStamps[player] = stamp(this, readyX, GAME_HEIGHT - 100, "Ready!", PLAYER_COLORS[player], 26);
    this.updateReadyText(player);
  }

  private updateReadyText(player: number): void {
    const input = this.setup.inputs[player];
    const ready = !isPlayerInput(input) || this.ready[player];
    this.readyTexts[player].setText(isPlayerInput(input) ? `Press ${controlLabels(input, "left").punch} when ready` : "").setVisible(!ready);
    this.readyStamps[player].setVisible(ready);
    // A ready player's panel is framed in their colour.
    drawPopBox(this.panels[player].clear(), 0, 0, PANEL_W, PANEL_BOTTOM - PANEL_TOP, {
      fill: HEX.panel, radius: RADIUS.lg, shadow: SHADOW.lg,
      ...(ready ? { border: PLAYER_COLORS[player], borderWidth: 5 } : {}),
    });
  }

  update(): void {
    this.frame++;
    for (const card of this.cards) this.animate(card);

    const now = this.sources.map((s) => s.read());
    const accepting = performance.now() - this.openedAt > INPUT_DELAY_MS;
    now.forEach((f, s) => {
      if (!accepting) return;
      const i = this.seats[s];
      if (f.punch && !this.previous[s].punch && !this.ready[i]) {
        this.ready[i] = true;
        this.updateReadyText(i);
        announce(this, i === 0 ? "p1-ready" : "p2-ready");
      }
      if (f.kick && !this.previous[s].kick) {
        if (this.ready[i]) {
          this.ready[i] = false;
          this.updateReadyText(i);
        } else {
          this.scene.start(menuSceneFor(this.setup));
        }
      }
    });
    this.previous = now;
    if (this.ready[0] && this.ready[1]) this.scene.start("fight", this.setup);
  }

  /** Show the frame of the card's move for the current loop position, as the fight would (with hard cuts where it tweens). */
  private animate(card: Card): void {
    const t = Math.floor(this.frame * PREVIEW_SPEED + card.offset) % (card.frames + PAUSE_FRAMES);
    const playing = t < card.frames;
    const state = { ...createFighterState(0, card.player === 0 ? 1 : -1, 100), action: playing ? card.action : "idle", actionFrame: playing ? t : 0 } as const;
    const { poseId, variant } = frameOf(state);
    const prefix = PREFIXES[card.player];
    const key = textureKey(prefix, poseId, variant);
    if (card.sprite.texture.key !== key) card.sprite.setTexture(key);
    const anchor = groundAnchorFor(this.geometry[card.player], poseId, variant);
    card.sprite.setOrigin(anchor.x / SPRITE_CANVAS_SIZE, anchor.y / SPRITE_CANVAS_SIZE);
    // Jump: follow the real arc, scaled to the card.
    const height = playing && card.action === "jump" ? -JUMP_IMPULSE * t - (GRAVITY * t * t) / 2 : 0;
    card.sprite.y = card.baseY - Math.max(0, height) * SPRITE_SCALE;
  }
}
