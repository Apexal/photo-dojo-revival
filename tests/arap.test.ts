import { describe, expect, it } from "vitest";
import { ArapDeformer, triangulateMask, type AlphaMask, type Point } from "../src/game/render/arap";

/** An opaque-where-`inside` RGBA mask. */
function mask(width: number, height: number, inside: (x: number, y: number) => boolean): AlphaMask {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x + 0.5, y + 0.5)) data[(y * width + x) * 4 + 3] = 255;
  return { width, height, data };
}

const vertex = (v: Float64Array, i: number): Point => ({ x: v[2 * i], y: v[2 * i + 1] });
const edgeLengths = (v: Float64Array, tris: Uint32Array) => {
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = vertex(v, tris[t + k]), b = vertex(v, tris[t + (k + 1) % 3]);
      out.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return out;
};

describe("mask triangulation", () => {
  it("covers every opaque pixel with two triangles per cell and nothing else", () => {
    const m = triangulateMask(mask(48, 48, (x, y) => x > 12 && x < 36 && y < 24), 12);
    expect(m.triangles.length / 3).toBe(2 * 2 * 2); // cells (1..2, 0..1)
    for (let i = 0; i < m.positions.length / 2; i++) {
      expect(m.positions[2 * i]).toBeGreaterThanOrEqual(12);
      expect(m.positions[2 * i]).toBeLessThanOrEqual(36);
      expect(m.positions[2 * i + 1]).toBeLessThanOrEqual(24);
    }
  });

  it("is empty for a transparent mask", () => {
    expect(triangulateMask(mask(40, 40, () => false)).triangles.length).toBe(0);
  });
});

describe("ARAP deformer", () => {
  // A 24×144 bar standing upright, handles along its axis.
  const bar = triangulateMask(mask(48, 168, (x, y) => x > 12 && x < 36 && y > 12 && y < 156), 12);
  const handles: Point[] = [0, 1, 2, 3, 4].map((i) => ({ x: 24, y: 18 + i * 33 }));

  it("leaves the mesh in place when the handles don't move", () => {
    const out = new ArapDeformer(bar, handles).deform(handles);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(bar.positions[i], 3);
  });

  it("reproduces a rigid motion of all handles exactly", () => {
    const angle = 0.7, c = Math.cos(angle), s = Math.sin(angle);
    const move = (p: Point) => ({ x: 100 + c * p.x - s * p.y, y: -40 + s * p.x + c * p.y });
    const out = new ArapDeformer(bar, handles).deform(handles.map(move));
    for (let i = 0; i < bar.positions.length / 2; i++) {
      const expected = move(vertex(bar.positions, i));
      expect(out[2 * i]).toBeCloseTo(expected.x, 1);
      expect(out[2 * i + 1]).toBeCloseTo(expected.y, 1);
    }
  });

  it("bends a bar at the middle while keeping both halves close to rigid", () => {
    // Top half stays; the bottom half swings 90° about the middle handle.
    const pivot = handles[2];
    const targets = handles.map((h, i) => (i <= 2 ? h : { x: pivot.x + (h.y - pivot.y), y: pivot.y }));
    const deformer = new ArapDeformer(bar, handles);
    const out = deformer.deform(targets);
    const rest = edgeLengths(bar.positions, bar.triangles), bent = edgeLengths(out, bar.triangles);
    // Most edges keep their length; only the joint stretches/squashes.
    const kept = rest.filter((l, i) => Math.abs(bent[i] - l) < 0.15 * l).length;
    expect(kept / rest.length).toBeGreaterThan(0.75);
    // The tip lands near its handle.
    const tipTarget = targets[4];
    let nearest = Infinity;
    for (let i = 0; i < out.length / 2; i++) nearest = Math.min(nearest, Math.hypot(out[2 * i] - tipTarget.x, out[2 * i + 1] - tipTarget.y));
    expect(nearest).toBeLessThan(12);
  });

  it("ignores handles far from the mesh and drops pieces no handle reaches", () => {
    const twoPieces = triangulateMask(mask(120, 48, (x, y) => y < 24 && (x < 24 || x > 96)), 12);
    const deformer = new ArapDeformer(twoPieces, [{ x: 12, y: 12 }, { x: 60, y: 200 }]);
    expect(deformer.bound).toEqual([true, false]);
    expect(deformer.triangles.length).toBe(twoPieces.triangles.length / 2);
    const out = deformer.deform([{ x: 22, y: 12 }, { x: 0, y: 0 }]);
    expect(out[0]).toBeCloseTo(twoPieces.positions[0] + 10, 1);
  });
});
