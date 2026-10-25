import type { Rect } from "../shared/canvas";

/**
 * Picking the sharpest frame of a short burst: motion blur at the moment of
 * capture (a kick still settling, a shaky hand) costs both landmark accuracy
 * and clean cut-out edges. Pure, on RGBA bytes.
 */

/** Variance of the 4-neighbour Laplacian of luminance: high for crisp edges, low for blur. */
export function laplacianVariance(rgba: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Where to measure sharpness, at a size that's cheap to scan: the person's
 * region (or the whole frame), scaled so its longer side is at most `maxSide`.
 */
export function sharpnessSampleSize(region: Rect, maxSide = 320): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(region.width, region.height));
  return { width: Math.max(3, Math.round(region.width * k)), height: Math.max(3, Math.round(region.height * k)) };
}

/** Number of consecutive video frames to consider per capture (~130 ms at 30 fps). */
export const BURST_FRAMES = 4;
