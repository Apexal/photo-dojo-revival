import type { Box } from "../shared/frame-data";

export type Facing = 1 | -1;

export interface Placement {
  /** World position of the fighter's feet anchor. */
  position: { x: number; y: number };
  facing: Facing;
  /** The sprite-space point that sits on `position`. */
  anchor: { x: number; y: number };
}

/**
 * Sprite-canvas box → world box. Captures face right; a fighter facing left is
 * mirrored around its anchor, so x offsets flip sign.
 */
export function toWorldBox(spriteBox: Box, placement: Placement): Box {
  const { position, facing, anchor } = placement;
  const left = spriteBox.x - anchor.x;
  const right = spriteBox.x + spriteBox.width - anchor.x;
  const worldLeft = facing === 1 ? left : -right;
  return {
    x: position.x + worldLeft,
    y: position.y + (spriteBox.y - anchor.y),
    width: spriteBox.width,
    height: spriteBox.height,
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Horizontal overlap depth between two boxes that also overlap vertically; 0 if they don't touch. */
export function horizontalOverlap(a: Box, b: Box): number {
  if (!boxesOverlap(a, b)) return 0;
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
}

export function boxCenterX(b: Box): number {
  return b.x + b.width / 2;
}

/** Attacker hitbox vs any of the defender's hurtboxes, all in sprite space, resolved in world space. */
export function hitConnects(hitbox: Box, attacker: Placement, hurtboxes: readonly Box[], defender: Placement): boolean {
  const hit = toWorldBox(hitbox, attacker);
  return hurtboxes.some((h) => boxesOverlap(hit, toWorldBox(h, defender)));
}
