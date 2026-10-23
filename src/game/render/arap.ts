/*
 * As-rigid-as-possible shape manipulation (Igarashi, Moscovich & Hughes 2005):
 * a triangle mesh over a sprite's opaque pixels, pulled by handle points, bends
 * where it has to and stays locally rigid elsewhere. Pure math, no Phaser, so it
 * runs in Node tests.
 *
 * Both solver steps are linear least squares whose matrices depend only on the
 * rest mesh and where the handles sit in it, so they're factored once; each
 * deform() is two triangular back-substitutions per step. Vertices are numbered
 * row by row over a grid, which keeps the matrices banded.
 */

export interface Point { x: number; y: number }

/** RGBA pixels, as in ImageData. */
export interface AlphaMask { width: number; height: number; data: Uint8ClampedArray }

export interface TriangleMesh {
  /** Rest positions, x/y interleaved, in the mask's pixel space. */
  positions: Float64Array;
  /** Three vertex indices per triangle. */
  triangles: Uint32Array;
  /** Which piece of the body each triangle belongs to (0 when absent); handles only bind within their own piece. */
  groups?: Uint8Array;
}

/** Grid cell size (px) for triangulateMask. Smaller bends more smoothly; 12 keeps a fighter to a few hundred vertices. */
export const MESH_CELL_PX = 12;
/** Alpha above this counts as part of the sprite. */
export const MESH_ALPHA_THRESHOLD = 8;

/**
 * Two triangles per grid cell that holds any opaque pixel. Partly transparent
 * triangles are fine: the texture's own alpha draws the outline, so the mesh
 * only has to cover it. Cells are not dilated: legs a few pixels apart stay
 * separate pieces instead of being stitched together and bending as one.
 */
export function triangulateMask(mask: AlphaMask, cell = MESH_CELL_PX, threshold = MESH_ALPHA_THRESHOLD): TriangleMesh {
  const cols = Math.ceil(mask.width / cell);
  const rows = Math.ceil(mask.height / cell);
  const filled = new Uint8Array(cols * rows);
  for (let y = 0; y < mask.height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[(y * mask.width + x) * 4 + 3] > threshold) filled[row + Math.floor(x / cell)] = 1;
    }
  }
  // Number the used grid corners row by row (banded matrices).
  const corner = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
  const used = (cx: number, cy: number) =>
    (cy < rows && cx < cols && filled[cy * cols + cx]) || (cy < rows && cx > 0 && filled[cy * cols + cx - 1]) ||
    (cy > 0 && cx < cols && filled[(cy - 1) * cols + cx]) || (cy > 0 && cx > 0 && filled[(cy - 1) * cols + cx - 1]);
  const positions: number[] = [];
  for (let cy = 0; cy <= rows; cy++) {
    for (let cx = 0; cx <= cols; cx++) {
      if (!used(cx, cy)) continue;
      corner[cy * (cols + 1) + cx] = positions.length / 2;
      positions.push(Math.min(cx * cell, mask.width), Math.min(cy * cell, mask.height));
    }
  }
  const triangles: number[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!filled[cy * cols + cx]) continue;
      const tl = corner[cy * (cols + 1) + cx], tr = corner[cy * (cols + 1) + cx + 1];
      const bl = corner[(cy + 1) * (cols + 1) + cx], br = corner[(cy + 1) * (cols + 1) + cx + 1];
      triangles.push(tl, tr, bl, tr, br, bl);
    }
  }
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles) };
}

/** Symmetric positive-definite band matrix, factored in place as L·Lᵀ. Only the lower band is stored. */
class BandedCholesky {
  private readonly band: Float64Array;
  private readonly stride: number;

  constructor(readonly size: number, readonly bandwidth: number) {
    this.stride = bandwidth + 1;
    this.band = new Float64Array(size * this.stride);
  }

  /** Adds to entry (i, j); entries above the diagonal are dropped, so add both halves of a symmetric sum. */
  add(i: number, j: number, value: number): void {
    if (j > i) return;
    if (i - j > this.bandwidth) throw new Error("ARAP: entry outside the band");
    this.band[i * this.stride + j - i + this.bandwidth] += value;
  }

  private at(i: number, j: number): number {
    return this.band[i * this.stride + j - i + this.bandwidth];
  }

  factor(): void {
    const { size, bandwidth, stride, band } = this;
    for (let i = 0; i < size; i++) {
      const first = Math.max(0, i - bandwidth);
      for (let j = first; j <= i; j++) {
        let sum = this.at(i, j);
        for (let k = first; k < j; k++) sum -= this.at(i, k) * this.at(j, k);
        const index = i * stride + j - i + bandwidth;
        if (i === j) {
          if (!(sum > 0)) throw new Error("ARAP: matrix is not positive definite");
          band[index] = Math.sqrt(sum);
        } else {
          band[index] = sum / this.at(j, j);
        }
      }
    }
  }

  solve(rhs: Float64Array): Float64Array {
    const { size, bandwidth } = this;
    const x = Float64Array.from(rhs);
    for (let i = 0; i < size; i++) {
      for (let k = Math.max(0, i - bandwidth); k < i; k++) x[i] -= this.at(i, k) * x[k];
      x[i] /= this.at(i, i);
    }
    for (let i = size - 1; i >= 0; i--) {
      for (let k = i + 1; k <= Math.min(size - 1, i + bandwidth); k++) x[i] -= this.at(k, i) * x[k];
      x[i] /= this.at(i, i);
    }
    return x;
  }
}

/**
 * A handle tied to the mesh: a weighted sum of vertices (barycentric in its
 * triangle), or one nearby vertex that keeps its rest offset from the handle.
 */
interface Binding { vertices: number[]; weights: number[]; offset: Point }

export interface ArapOptions {
  /** How hard handles pull compared with the rigidity of one triangle. High: the mesh lands on its handles. */
  handleWeight?: number;
  /** Handles farther than this (px) from every mesh vertex are ignored. */
  maxBindDistance?: number;
}

/** Ties every vertex weakly to a fallback position, so pieces with too few handles can't drift. */
const REGULARIZATION = 1e-4;

export class ArapDeformer {
  /** Which handles found a place in the mesh; targets for the others are ignored. */
  readonly bound: boolean[];
  /** Triangles of the mesh pieces that hold at least one handle; pieces without one can't be placed. */
  readonly triangles: Uint32Array;
  /** The mesh group of each of `triangles`. */
  readonly groups: Uint8Array;
  private readonly bindings: (Binding | null)[];
  private readonly step1: BandedCholesky;
  private readonly step2: BandedCholesky;
  private readonly weight: number;
  /** Per triangle and corner, the rest position minus the triangle's centroid (for the rotation fit). */
  private readonly restLocal: Float64Array;

  /** `handleGroups[i]`: the mesh group handle i may bind to (default 0). */
  constructor(readonly mesh: TriangleMesh, handles: readonly Point[], options: ArapOptions = {}, handleGroups?: readonly number[]) {
    this.weight = options.handleWeight ?? 100;
    const { positions, triangles } = mesh;
    const n = positions.length / 2;
    this.bindings = handles.map((h, i) => bindPoint(mesh, h, options.maxBindDistance ?? 3 * MESH_CELL_PX, handleGroups?.[i] ?? 0));
    this.bound = this.bindings.map(Boolean);
    ({ triangles: this.triangles, groups: this.groups } = anchoredTriangles(mesh, this.bindings));

    let bandwidth = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
      bandwidth = Math.max(bandwidth, Math.abs(a - b), Math.abs(b - c), Math.abs(a - c));
    }

    // Step 1, similarity-invariant: each corner should sit where the opposite edge's rest
    // frame puts it. Unknowns interleave x and y; blocks are s·I + r·R, R = [[0, 1], [-1, 0]].
    this.step1 = new BandedCholesky(2 * n, 2 * bandwidth + 1);
    const addBlock = (p: number, q: number, s: number, r: number) => {
      this.step1.add(2 * p, 2 * q, s);
      this.step1.add(2 * p, 2 * q + 1, r);
      this.step1.add(2 * p + 1, 2 * q, -r);
      this.step1.add(2 * p + 1, 2 * q + 1, s);
    };
    for (let t = 0; t < triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = triangles[t + k], b = triangles[t + (k + 1) % 3], c = triangles[t + (k + 2) % 3];
        const dx = positions[2 * b] - positions[2 * a], dy = positions[2 * b + 1] - positions[2 * a + 1];
        const ex = positions[2 * c] - positions[2 * a], ey = positions[2 * c + 1] - positions[2 * a + 1];
        const len2 = dx * dx + dy * dy;
        const u = (ex * dx + ey * dy) / len2;
        const v = (ex * dy - ey * dx) / len2; // e · R(d), R(d) = (d.y, -d.x)
        // residual = v_c + ((u - 1)·I + v·R)·v_a + (-u·I - v·R)·v_b
        const terms: [number, number, number][] = [[c, 1, 0], [a, u - 1, v], [b, -u, -v]];
        for (const [p, sp, rp] of terms) {
          for (const [q, sq, rq] of terms) addBlock(p, q, sp * sq + rp * rq, sp * rq - rp * sq);
        }
      }
    }

    // Step 2, rigid: edges should match each triangle's rotation-only fit to step 1. Same matrix for x and y.
    this.step2 = new BandedCholesky(n, bandwidth);
    for (let t = 0; t < triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = triangles[t + k], j = triangles[t + (k + 1) % 3];
        this.step2.add(i, i, 1); this.step2.add(j, j, 1);
        this.step2.add(i, j, -1); this.step2.add(j, i, -1);
      }
    }

    for (const binding of this.bindings) {
      if (!binding) continue;
      binding.vertices.forEach((p, a) => binding.vertices.forEach((q, b) => {
        const w = this.weight * binding.weights[a] * binding.weights[b];
        addBlock(p, q, w, 0);
        this.step2.add(p, q, w);
      }));
    }
    for (let i = 0; i < n; i++) {
      addBlock(i, i, REGULARIZATION, 0);
      this.step2.add(i, i, REGULARIZATION);
    }
    this.step1.factor();
    this.step2.factor();

    this.restLocal = new Float64Array(triangles.length * 2);
    for (let t = 0; t < triangles.length; t += 3) {
      const cx = (positions[2 * triangles[t]] + positions[2 * triangles[t + 1]] + positions[2 * triangles[t + 2]]) / 3;
      const cy = (positions[2 * triangles[t] + 1] + positions[2 * triangles[t + 1] + 1] + positions[2 * triangles[t + 2] + 1]) / 3;
      for (let k = 0; k < 3; k++) {
        this.restLocal[2 * (t + k)] = positions[2 * triangles[t + k]] - cx;
        this.restLocal[2 * (t + k) + 1] = positions[2 * triangles[t + k] + 1] - cy;
      }
    }
  }

  /** Vertex positions (x/y interleaved) with each bound handle pulled toward its target. */
  deform(targets: readonly Point[]): Float64Array {
    const { positions, triangles } = this.mesh;
    const n = positions.length / 2;

    const rhs1 = new Float64Array(2 * n);
    for (let i = 0; i < 2 * n; i++) rhs1[i] = REGULARIZATION * positions[i];
    this.bindings.forEach((binding, h) => {
      if (!binding) return;
      binding.vertices.forEach((p, a) => {
        rhs1[2 * p] += this.weight * binding.weights[a] * (targets[h].x + binding.offset.x);
        rhs1[2 * p + 1] += this.weight * binding.weights[a] * (targets[h].y + binding.offset.y);
      });
    });
    const similar = this.step1.solve(rhs1);

    const rhsX = new Float64Array(n), rhsY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      rhsX[i] = REGULARIZATION * similar[2 * i];
      rhsY[i] = REGULARIZATION * similar[2 * i + 1];
    }
    const fit = new Float64Array(6);
    for (let t = 0; t < triangles.length; t += 3) {
      // Best rotation of the rest triangle onto step 1's (2D Procrustes), placed at its centroid.
      let cx = 0, cy = 0;
      for (let k = 0; k < 3; k++) { cx += similar[2 * triangles[t + k]] / 3; cy += similar[2 * triangles[t + k] + 1] / 3; }
      let dot = 0, cross = 0;
      for (let k = 0; k < 3; k++) {
        const qx = this.restLocal[2 * (t + k)], qy = this.restLocal[2 * (t + k) + 1];
        const px = similar[2 * triangles[t + k]] - cx, py = similar[2 * triangles[t + k] + 1] - cy;
        dot += qx * px + qy * py;
        cross += qx * py - qy * px;
      }
      const norm = Math.hypot(dot, cross);
      const cos = norm ? dot / norm : 1, sin = norm ? cross / norm : 0;
      for (let k = 0; k < 3; k++) {
        const qx = this.restLocal[2 * (t + k)], qy = this.restLocal[2 * (t + k) + 1];
        fit[2 * k] = cx + cos * qx - sin * qy;
        fit[2 * k + 1] = cy + sin * qx + cos * qy;
      }
      for (let k = 0; k < 3; k++) {
        const i = triangles[t + k], j = triangles[t + (k + 1) % 3];
        const ex = fit[2 * k] - fit[2 * ((k + 1) % 3)], ey = fit[2 * k + 1] - fit[2 * ((k + 1) % 3) + 1];
        rhsX[i] += ex; rhsX[j] -= ex;
        rhsY[i] += ey; rhsY[j] -= ey;
      }
    }
    this.bindings.forEach((binding, h) => {
      if (!binding) return;
      binding.vertices.forEach((p, a) => {
        rhsX[p] += this.weight * binding.weights[a] * (targets[h].x + binding.offset.x);
        rhsY[p] += this.weight * binding.weights[a] * (targets[h].y + binding.offset.y);
      });
    });
    const xs = this.step2.solve(rhsX), ys = this.step2.solve(rhsY);
    const out = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) { out[2 * i] = xs[i]; out[2 * i + 1] = ys[i]; }
    return out;
  }
}

/** Barycentric weights in the group's triangle holding the point, else the group's nearest vertex within reach. */
function bindPoint(mesh: TriangleMesh, p: Point, maxDistance: number, group: number): Binding | null {
  const { positions, triangles } = mesh;
  const inGroup = (t: number) => (mesh.groups?.[t / 3] ?? 0) === group;
  const EPS = 1e-9;
  for (let t = 0; t < triangles.length; t += 3) {
    if (!inGroup(t)) continue;
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    const ax = positions[2 * a], ay = positions[2 * a + 1];
    const v0x = positions[2 * b] - ax, v0y = positions[2 * b + 1] - ay;
    const v1x = positions[2 * c] - ax, v1y = positions[2 * c + 1] - ay;
    const det = v0x * v1y - v1x * v0y;
    if (Math.abs(det) < EPS) continue;
    const wx = p.x - ax, wy = p.y - ay;
    const wb = (wx * v1y - v1x * wy) / det;
    const wc = (v0x * wy - wx * v0y) / det;
    const wa = 1 - wb - wc;
    if (wa >= -EPS && wb >= -EPS && wc >= -EPS) return { vertices: [a, b, c], weights: [wa, wb, wc], offset: { x: 0, y: 0 } };
  }
  let best = -1, bestDistance = maxDistance;
  for (let t = 0; t < triangles.length; t++) {
    if (!inGroup(t - (t % 3))) continue;
    const i = triangles[t];
    const d = Math.hypot(positions[2 * i] - p.x, positions[2 * i + 1] - p.y);
    if (d <= bestDistance) { best = i; bestDistance = d; }
  }
  return best < 0 ? null : { vertices: [best], weights: [1], offset: { x: positions[2 * best] - p.x, y: positions[2 * best + 1] - p.y } };
}

/** Triangles of the connected pieces (sharing a vertex counts) that some handle is bound to. */
function anchoredTriangles(mesh: TriangleMesh, bindings: readonly (Binding | null)[]): { triangles: Uint32Array; groups: Uint8Array } {
  const parent = Int32Array.from({ length: mesh.positions.length / 2 }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    parent[find(triangles[t + 1])] = find(triangles[t]);
    parent[find(triangles[t + 2])] = find(triangles[t]);
  }
  const anchored = new Set<number>();
  for (const b of bindings) b?.vertices.forEach((v) => anchored.add(find(v)));
  const kept: number[] = [], groups: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    if (!anchored.has(find(triangles[t]))) continue;
    kept.push(triangles[t], triangles[t + 1], triangles[t + 2]);
    groups.push(mesh.groups?.[t / 3] ?? 0);
  }
  return { triangles: Uint32Array.from(kept), groups: Uint8Array.from(groups) };
}
