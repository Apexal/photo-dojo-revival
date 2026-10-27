/** Width (sprite px) of each column of a top edge. */
export const TOP_EDGE_STEP = 4;

/** A point on screen, or null where a column has nothing in it. Index = sprite column (TOP_EDGE_STEP wide). */
export type TopEdge = ({ x: number; y: number } | null)[];

/**
 * For each TOP_EDGE_STEP-wide column of a sprite's alpha mask, the y of its
 * topmost solid pixel (sampled down the column's middle, needing two solid
 * pixels in a row so a stray wisp of hair doesn't count), or null for an empty
 * column. What weather settles on (FighterSpriteView.topEdge).
 */
export function topProfile(mask: { data: ArrayLike<number>; width: number; height: number }, step = TOP_EDGE_STEP, threshold = 128): (number | null)[] {
  const { data, width, height } = mask;
  const solid = (x: number, y: number) => data[(y * width + x) * 4 + 3] >= threshold;
  const columns: (number | null)[] = [];
  for (let left = 0; left < width; left += step) {
    const x = Math.min(width - 1, left + (step >> 1));
    let top: number | null = null;
    for (let y = 0; y < height - 1; y++) {
      if (solid(x, y) && solid(x, y + 1)) {
        top = y;
        break;
      }
    }
    columns.push(top);
  }
  return columns;
}

/** Two profiles blended `t` of the way from `a` to `b`; where only one has the column, the nearer end's (or nothing). */
export function blendProfiles(a: (number | null)[], b: (number | null)[], t: number): (number | null)[] {
  return a.map((ya, i) => {
    const yb = b[i] ?? null;
    if (ya !== null && yb !== null) return ya + (yb - ya) * t;
    return t < 0.5 ? ya : yb;
  });
}
