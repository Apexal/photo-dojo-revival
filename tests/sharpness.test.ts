import { describe, expect, it } from "vitest";
import { laplacianVariance, sharpnessSampleSize } from "../src/capture/sharpness";

/** A checkerboard of `cell`-pixel squares, optionally box-blurred horizontally and vertically. */
function checkerboard(size: number, cell: number, blur = 0): Uint8ClampedArray {
  let gray = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) gray[y * size + x] = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) * 255;
  for (let pass = 0; pass < 2 && blur; pass++) {
    const out = new Float32Array(gray.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = 0, n = 0;
      for (let k = -blur; k <= blur; k++) {
        const xx = pass ? x : Math.min(size - 1, Math.max(0, x + k));
        const yy = pass ? Math.min(size - 1, Math.max(0, y + k)) : y;
        sum += gray[yy * size + xx];
        n++;
      }
      out[y * size + x] = sum / n;
    }
    gray = out;
  }
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < gray.length; i++) rgba.set([gray[i], gray[i], gray[i], 255], i * 4);
  return rgba;
}

describe("sharpness", () => {
  it("ranks a crisp frame above motion-blurred ones", () => {
    const sharp = laplacianVariance(checkerboard(64, 8), 64, 64);
    const soft = laplacianVariance(checkerboard(64, 8, 1), 64, 64);
    const blurry = laplacianVariance(checkerboard(64, 8, 3), 64, 64);
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(blurry);
  });

  it("a flat image has no sharpness", () => {
    expect(laplacianVariance(new Uint8ClampedArray(16 * 16 * 4).fill(128), 16, 16)).toBe(0);
    expect(laplacianVariance(new Uint8ClampedArray(4 * 4), 2, 2)).toBe(0);
  });

  it("samples the person's region at a bounded size, keeping its shape", () => {
    expect(sharpnessSampleSize({ x: 0, y: 0, width: 400, height: 1000 })).toEqual({ width: 128, height: 320 });
    expect(sharpnessSampleSize({ x: 0, y: 0, width: 100, height: 50 })).toEqual({ width: 100, height: 50 });
  });
});
