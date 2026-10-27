import { describe, expect, it } from "vitest";
import { SNOW, SnowCover, SnowDrift } from "../src/game/stages/snow";
import { TOP_EDGE_STEP, blendProfiles, topProfile, type TopEdge } from "../src/game/render/top-edge";

/** An edge across `columns`, flat at y = 100 between `from` and `to` (nothing elsewhere). */
function flatEdge(columns: number, from: number, to: number, y = 100): TopEdge {
  return Array.from({ length: columns }, (_, i) => (i >= from && i < to ? { x: i * TOP_EDGE_STEP, y } : null));
}

describe("topProfile", () => {
  it("finds each column's topmost solid pixel, ignoring single stray pixels", () => {
    const width = 8, height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    const fill = (x: number, y: number) => { data[(y * width + x) * 4 + 3] = 255; };
    for (let y = 5; y < height; y++) fill(2, y); // column 0 (samples x = 2): solid from y = 5
    fill(6, 1); // column 1 (samples x = 6): a lone pixel, then nothing
    expect(topProfile({ data, width, height })).toEqual([5, null]);
  });

  it("blends two profiles, keeping the nearer end's column where only one has it", () => {
    expect(blendProfiles([10, null, 4], [20, 8, null], 0.25)).toEqual([12.5, null, 4]);
    expect(blendProfiles([10, null, 4], [20, 8, null], 0.75)).toEqual([17.5, 8, null]);
  });
});

describe("SnowCover", () => {
  it("settles on a flat top while still, up to the maximum depth", () => {
    const cover = new SnowCover(20, () => 0.5);
    const edge = flatEdge(20, 5, 15);
    expect(cover.hasSnow).toBe(false);
    cover.settle(edge, 1);
    const early = cover.runs(edge)[0].map((p) => p.depth);
    expect(Math.min(...early)).toBeGreaterThan(0);
    for (let s = 0; s < 60; s++) cover.settle(edge, 1);
    const full = cover.runs(edge)[0];
    expect(Math.max(...full.map((p) => p.depth))).toBeLessThanOrEqual(SNOW.maxDepth);
    expect(Math.max(...full.map((p) => p.depth))).toBeGreaterThan(Math.max(...early));
  });

  it("doesn't stick to steep slopes or lone columns", () => {
    const cover = new SnowCover(10, () => 0.5);
    const steep: TopEdge = Array.from({ length: 10 }, (_, i) => ({ x: i * TOP_EDGE_STEP, y: 100 + i * TOP_EDGE_STEP * 3 }));
    const lone: TopEdge = Array.from({ length: 10 }, (_, i) => (i === 4 ? { x: 16, y: 50 } : null));
    for (let s = 0; s < 20; s++) cover.settle(steep, 1);
    expect(cover.hasSnow).toBe(false);
    for (let s = 0; s < 20; s++) cover.settle(lone, 1);
    expect(cover.hasSnow).toBe(false);
  });

  it("sheds everything at once as clumps where the snow lay", () => {
    const cover = new SnowCover(20, () => 0.5);
    const edge = flatEdge(20, 5, 15);
    for (let s = 0; s < 10; s++) cover.settle(edge, 1);
    const clumps = cover.shed(edge);
    expect(clumps.length).toBeGreaterThan(0);
    for (const c of clumps) {
      expect(c.x).toBeGreaterThanOrEqual(5 * TOP_EDGE_STEP);
      expect(c.x).toBeLessThan(15 * TOP_EDGE_STEP);
      expect(c.y).toBeLessThan(100);
      expect(c.size).toBeGreaterThan(1);
    }
    expect(cover.hasSnow).toBe(false);
    expect(cover.shed(edge)).toEqual([]);
  });

  it("splits runs where the edge jumps (a gap between head and arm)", () => {
    const cover = new SnowCover(20, () => 0.5);
    const edge: TopEdge = [...flatEdge(10, 2, 8, 100), ...flatEdge(10, 2, 8, 160)].map((p, i) => p && { ...p, x: i * TOP_EDGE_STEP });
    for (let s = 0; s < 10; s++) cover.settle(edge, 1);
    expect(cover.runs(edge)).toHaveLength(2);
  });
});

describe("SnowDrift", () => {
  it("heaps up where clumps land, never past the maximum", () => {
    const drift = new SnowDrift(400);
    drift.add(200, 5);
    const at = (x: number) => drift.heights[Math.round(x / SNOW.driftStep)];
    expect(at(200)).toBeGreaterThan(at(220));
    expect(at(100)).toBe(0);
    for (let k = 0; k < 500; k++) drift.add(200, 6);
    expect(Math.max(...drift.heights)).toBeLessThanOrEqual(SNOW.maxDrift);
  });
});

describe("SnowDrift cover", () => {
  it("covers the floor as snow falls, whether or not anything is knocked off", () => {
    const drift = new SnowDrift(400);
    expect(drift.cover).toBe(0);
    drift.snowfall(SNOW.groundSeconds / 2);
    expect(drift.cover).toBeCloseTo(0.5);
    drift.snowfall(SNOW.groundSeconds);
    expect(drift.cover).toBe(1);
    expect(Math.max(...drift.heights)).toBe(0);
  });
});
