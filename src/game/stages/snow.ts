import { TOP_EDGE_STEP, type TopEdge } from "../render/top-edge";

/** How snow behaves on the Winter Dojo (winter-dojo.ts). Lengths in screen px. */
export const SNOW = {
  /** The deepest snow gets on a flat top (a head, level shoulders). */
  maxDepth: 14,
  /** Standing still this long (s) buries a flat top as deep as it goes. */
  fillSeconds: 2.5,
  /** Slope (rise over run) at which nothing sticks; it thins out towards it. */
  steepest: 1.4,
  /** A jump bigger than this between neighbouring columns is a break: an arm over a gap, the edge of the head. */
  breakAt: 10,
  /** The snowfall covers the whole floor in this long (s); patches first, then a blanket. */
  groundSeconds: 40,
  /** Tallest a drift on the floor gets. */
  maxDrift: 18,
  /** Columns of the floor's drift (each DRIFT_STEP px wide). */
  driftStep: 4,
} as const;

/** A lump of snow knocked off a fighter: where it was and how big (radius, px). */
export interface Clump { x: number; y: number; size: number }

/** A run of covered columns to draw: the top edge it lies on and its depth there. */
export type SnowRun = { x: number; y: number; depth: number }[];

/**
 * The snow on one fighter: a depth per column of their top edge (sprite
 * columns, so it moves and turns with them). It settles while they stand still
 * and all comes off at once when they move. Pure; winter-dojo.ts draws it.
 */
export class SnowCover {
  private readonly depth: number[];
  /** Fixed per column: snow settles a little unevenly. */
  private readonly grain: number[];

  constructor(columns: number, random: () => number = Math.random) {
    this.depth = new Array<number>(columns).fill(0);
    this.grain = Array.from({ length: columns }, () => random());
  }

  get hasSnow(): boolean {
    return this.depth.some((d) => d > 0);
  }

  /** `seconds` of snowfall on a fighter standing still with this top edge. */
  settle(edge: TopEdge, seconds: number): void {
    for (let i = 0; i < this.depth.length; i++) {
      const at = edge[i];
      if (!at) {
        this.depth[i] = 0;
        continue;
      }
      const most = SNOW.maxDepth * hold(edge, i) * (0.7 + 0.3 * this.grain[i]);
      const grown = this.depth[i] + (SNOW.maxDepth / SNOW.fillSeconds) * seconds * (0.6 + 0.8 * this.grain[i]);
      this.depth[i] = Math.min(grown, most);
    }
  }

  /** Everything comes off: a clump for every couple of covered columns, from where it lay. */
  shed(edge: TopEdge): Clump[] {
    const clumps: Clump[] = [];
    for (let i = 0; i < this.depth.length; i += 2) {
      const d = Math.max(this.depth[i], this.depth[i + 1] ?? 0);
      const at = edge[i] ?? edge[i + 1];
      if (at && d > 1) clumps.push({ x: at.x, y: at.y - d / 2, size: 1 + d * 0.45 });
    }
    this.depth.fill(0);
    return clumps;
  }

  /** The covered stretches of `edge`, depths softened a little across each, for drawing. */
  runs(edge: TopEdge): SnowRun[] {
    const runs: SnowRun[] = [];
    let run: SnowRun = [];
    const end = () => {
      if (run.length > 1) runs.push(run);
      run = [];
    };
    for (let i = 0; i < this.depth.length; i++) {
      const at = edge[i];
      if (!at || this.depth[i] <= 0.3) {
        end();
        continue;
      }
      const last = run[run.length - 1];
      if (last && Math.abs(at.y - last.y) > SNOW.breakAt) end();
      const near = [i - 1, i, i + 1].filter((j) => edge[j] && Math.abs(edge[j]!.y - at.y) <= SNOW.breakAt);
      const depth = near.reduce((sum, j) => sum + this.depth[j], 0) / near.length;
      run.push({ x: at.x, y: at.y, depth });
    }
    end();
    return runs;
  }
}

/** How much of the full depth column `i` holds: none on a steep slope, all of it on a flat top. */
function hold(edge: TopEdge, i: number): number {
  const here = edge[i]!;
  const near = [edge[i - 1], edge[i + 1]].filter((p): p is { x: number; y: number } => !!p && Math.abs(p.y - here.y) <= SNOW.breakAt);
  if (!near.length) return 0; // a lone column: a wisp, a fingertip
  const slope = Math.max(...near.map((p) => Math.abs(p.y - here.y) / Math.max(1, Math.abs(p.x - here.x) || TOP_EDGE_STEP)));
  // The ends of a run (the side of the head, the end of a shoulder) hold less.
  const edgeFactor = near.length === 2 ? 1 : 0.5;
  return Math.max(0, 1 - slope / SNOW.steepest) * edgeFactor;
}

/**
 * The snow on the floor: `cover`, how far the snowfall has got to covering it
 * (0 bare, 1 under a blanket), and the drifts of snow knocked off the
 * fighters, as a height per DRIFT_STEP-wide column across the stage.
 */
export class SnowDrift {
  readonly heights: number[];
  cover = 0;

  /** `seconds` of snow falling on the floor. */
  snowfall(seconds: number): void {
    this.cover = Math.min(1, this.cover + seconds / SNOW.groundSeconds);
  }

  constructor(width: number) {
    this.heights = new Array<number>(Math.ceil(width / SNOW.driftStep) + 1).fill(0);
  }

  /** A clump of radius `size` lands at x: it heaps up there and spreads to the sides. */
  add(x: number, size: number): void {
    const centre = Math.round(x / SNOW.driftStep);
    const spread = 1 + size / SNOW.driftStep;
    const reach = Math.ceil(spread * 2);
    for (let k = -reach; k <= reach; k++) {
      const i = centre + k;
      if (i < 0 || i >= this.heights.length) continue;
      const add = size * 0.35 * Math.exp(-(k * k) / (2 * spread * spread));
      this.heights[i] = Math.min(SNOW.maxDrift, this.heights[i] + add * (1 - this.heights[i] / SNOW.maxDrift));
    }
  }
}
