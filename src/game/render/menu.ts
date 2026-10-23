import Phaser from "phaser";
import type { MenuAction } from "../input/menu-input";

export interface MenuItem {
  label: () => string;
  onConfirm?: () => void;
  /** Left / right on a value (volume, on/off). */
  onAdjust?: (direction: -1 | 1) => void;
  disabled?: () => boolean;
}

const COLOR = { normal: "#f3efe6", selected: "#121018", disabled: "#6b6574" };

/** A vertical list of text items: keyboard / pad via `handle`, mouse / touch directly. */
export class Menu {
  index = 0;
  private readonly texts: Phaser.GameObjects.Text[];

  constructor(scene: Phaser.Scene, x: number, y: number, private readonly items: MenuItem[], options: { width: number; lineHeight?: number; fontSize?: number; depth?: number }) {
    const lineHeight = options.lineHeight ?? 52;
    this.texts = items.map((item, i) => {
      const t = scene.add.text(x, y + i * lineHeight, "", {
        fontSize: `${options.fontSize ?? 28}px`, fontStyle: "bold", fixedWidth: options.width, align: "center", padding: { x: 0, y: 8 },
      }).setOrigin(0.5, 0).setDepth(options.depth ?? 0).setInteractive({ useHandCursor: true });
      t.on("pointerover", () => { if (!item.disabled?.()) { this.index = i; this.refresh(); } });
      t.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (item.disabled?.()) return;
        this.index = i;
        // Values: the left third steps down, the rest steps up.
        if (item.onAdjust) item.onAdjust(pointer.x < t.x - options.width / 6 ? -1 : 1);
        else item.onConfirm?.();
        this.refresh();
      });
      return t;
    });
    this.index = Math.max(0, items.findIndex((item) => !item.disabled?.()));
    this.refresh();
  }

  handle(actions: Set<MenuAction>): void {
    if (actions.has("up")) this.move(-1);
    if (actions.has("down")) this.move(1);
    const item = this.items[this.index];
    if (item && !item.disabled?.()) {
      if (item.onAdjust && actions.has("left")) item.onAdjust(-1);
      if (item.onAdjust && actions.has("right")) item.onAdjust(1);
      if (actions.has("confirm")) (item.onConfirm ?? (() => item.onAdjust?.(1)))();
    }
    this.refresh();
  }

  private move(step: number): void {
    const n = this.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.index + step * k + n * k) % n;
      if (!this.items[i].disabled?.()) {
        this.index = i;
        return;
      }
    }
  }

  /** Re-read labels and disabled states (call after anything they depend on changes). */
  refresh(): void {
    if (this.items[this.index]?.disabled?.()) this.move(1);
    this.texts.forEach((t, i) => {
      const item = this.items[i];
      const disabled = item.disabled?.() ?? false;
      const selected = i === this.index && !disabled;
      t.setText(item.label());
      // Each style setter redraws the text and re-uploads its texture, even when nothing changed.
      const color = disabled ? COLOR.disabled : selected ? COLOR.selected : COLOR.normal;
      const background = selected ? "#f2c14e" : "#00000000";
      if (t.style.color !== color) t.setColor(color);
      if (t.style.backgroundColor !== background) t.setBackgroundColor(background);
    });
  }

  setVisible(visible: boolean): void {
    this.texts.forEach((t) => {
      t.setVisible(visible);
      if (t.input) t.input.enabled = visible;
    });
  }
}
