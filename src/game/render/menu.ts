import Phaser from "phaser";
import type { MenuAction } from "../input/menu-input";
import { COLOR, displayText, drawPopBox, HEX, strokeFor } from "./theme";

export interface MenuItem {
  label: () => string;
  onConfirm?: () => void;
  /** Left / right on a value (volume, on/off). */
  onAdjust?: (direction: -1 | 1) => void;
  disabled?: () => boolean;
}

const TEXT = { normal: COLOR.fg, selected: COLOR.ink, disabled: COLOR.disabled };

interface Row {
  /** The whole label, or the name part of a "name\tvalue" label (left-aligned then). */
  label: Phaser.GameObjects.Text;
  /** The value part of a "name\tvalue" label, right-aligned in the same row. */
  value: Phaser.GameObjects.Text;
  selected: boolean;
}

/**
 * A vertical list of text items: keyboard / pad via `handle`, mouse / touch directly. The selected row
 * is a gold pill with ink text. A label "name\tvalue" lays out as two columns (settings rows).
 */
export class Menu {
  index = 0;
  private readonly rows: Row[];
  private readonly pill: Phaser.GameObjects.Graphics;
  private readonly stroke: number;
  private readonly inset: number;
  private visible = true;

  constructor(scene: Phaser.Scene, x: number, y: number, private readonly items: MenuItem[], options: { width: number; lineHeight?: number; fontSize?: number; depth?: number }) {
    const lineHeight = options.lineHeight ?? 56;
    const fontSize = options.fontSize ?? 30;
    const rowHeight = Math.min(lineHeight - 6, fontSize + 22);
    const depth = options.depth ?? 0;
    this.stroke = strokeFor(fontSize);
    this.inset = Math.round(rowHeight * 0.6);
    const top = (rowHeight - fontSize * 1.25) / 2;
    // One gold pill, moved under whichever row is selected.
    this.pill = drawPopBox(scene.add.graphics(), -options.width / 2, 0, options.width, rowHeight, { fill: HEX.accent, radius: rowHeight / 2 }).setDepth(depth);
    this.rows = items.map((item, i) => {
      const rowY = y + i * lineHeight;
      const label = scene.add.text(x, rowY, "", displayText(fontSize, TEXT.normal, { fixedWidth: options.width, fixedHeight: rowHeight, align: "center", padding: { left: this.inset, right: this.inset, top, bottom: 0 } }))
        .setOrigin(0.5, 0).setDepth(depth).setInteractive({ useHandCursor: true });
      const value = scene.add.text(x + options.width / 2 - this.inset, rowY, "", displayText(fontSize, TEXT.normal, { fixedHeight: rowHeight, padding: { left: 0, right: 0, top, bottom: 0 } }))
        .setOrigin(1, 0).setDepth(depth);
      label.on("pointerover", () => { if (!item.disabled?.()) { this.index = i; this.refresh(); } });
      label.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (item.disabled?.()) return;
        this.index = i;
        // Values: the left third steps down, the rest steps up.
        if (item.onAdjust) item.onAdjust(pointer.x < label.x - options.width / 6 ? -1 : 1);
        else item.onConfirm?.();
        this.refresh();
      });
      return { label, value, selected: false };
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
    this.rows.forEach((row, i) => {
      const item = this.items[i];
      const disabled = item.disabled?.() ?? false;
      const selected = i === this.index && !disabled;
      const [name, value = ""] = item.label().split("\t");
      // Each setter redraws the text and re-uploads its texture, so only change what changed.
      const align = value ? "left" : "center";
      if (row.label.style.align !== align) row.label.setAlign(align);
      if (row.label.text !== name) row.label.setText(name);
      if (row.value.text !== value) row.value.setText(value);
      if (row.selected !== selected) {
        // On the gold pill: plain ink text, no outline or drop.
        for (const t of [row.label, row.value]) {
          t.setStroke(COLOR.ink, selected ? 0 : this.stroke);
          t.setShadow(0, selected ? 0 : 4, COLOR.ink, 0, !selected, !selected);
        }
        row.selected = selected;
      }
      const color = disabled ? TEXT.disabled : selected ? TEXT.selected : TEXT.normal;
      for (const t of [row.label, row.value]) if (t.style.color !== color) t.setColor(color);
    });
    const sel = this.rows.find((r) => r.selected);
    this.pill.setVisible(this.visible && !!sel);
    if (sel) this.pill.setPosition(sel.label.x, sel.label.y);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.pill.setVisible(visible && this.rows.some((r) => r.selected));
    for (const { label, value } of this.rows) {
      label.setVisible(visible);
      value.setVisible(visible);
      if (label.input) label.input.enabled = visible;
    }
  }
}
