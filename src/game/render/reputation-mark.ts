import type { NormalizedLandmark } from "../../shared/fighter-model";
import { headOf, type Head } from "./battle-damage";

type Point = { x: number; y: number };

/*
 * The halo or horns a fighter at either end of the reputation scale wears in
 * the versus intro (reputation.ts `adornmentOf`), placed on the top of the
 * head from the face landmarks (battle damage's head frame), so they follow
 * every pose. Pure: outlines in the landmarks' space; the scene maps them
 * onto the screen.
 */

/** A ring floating over the crown, seen nearly edge-on; `bob` (0–1) lifts it a little. */
export function haloOutline(l: readonly NormalizedLandmark[], bob = 0, segments = 24): Point[] | null {
  const head = headOf(l);
  if (!head) return null;
  const c = along(crownOf(head), head.up, head.size * (0.55 + 0.12 * bob));
  const [rx, ry] = [head.size * 1.05, head.size * 0.28];
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * 2 * Math.PI;
    return along(along(c, head.forward, Math.cos(a) * rx), head.up, Math.sin(a) * ry);
  });
}

/** Two horns, each a triangle (base, base, tip), from either side of the crown, curling outward. */
export function hornTriangles(l: readonly NormalizedLandmark[]): [Point, Point, Point][] | null {
  const head = headOf(l);
  if (!head) return null;
  const crown = crownOf(head);
  return ([-1, 1] as const).map((side) => {
    const base = along(crown, head.forward, side * head.size * 0.55);
    const tip = along(along(base, head.up, head.size * 0.85), head.forward, side * head.size * 0.3);
    return [along(base, head.forward, -head.size * 0.22), along(base, head.forward, head.size * 0.22), tip];
  });
}

/** The top of the head: up from between the eye and the ear, a head's size and a bit. */
function crownOf(head: Head): Point {
  const centre = { x: (head.eye.x + head.ear.x) / 2, y: (head.eye.y + head.ear.y) / 2 };
  return along(centre, head.up, head.size * 1.05);
}

const along = (p: Point, dir: Point, d: number): Point => ({ x: p.x + dir.x * d, y: p.y + dir.y * d });
