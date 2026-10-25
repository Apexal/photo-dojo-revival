/**
 * Canvas helpers shared by the capture pipeline and the phone camera page, so
 * the phone can grab stills without pulling in matting or sprite code.
 */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A rectangle in pixels. */
export interface Rect { x: number; y: number; width: number; height: number }

/** A rectangle as fractions 0..1 of a frame's width and height (the same region at any resolution). */
export interface NormalizedRect { x: number; y: number; width: number; height: number }

export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export function context2d(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as AnyContext | null;
  if (!ctx) throw new Error("2D canvas not available");
  return ctx;
}

export async function canvasToPng(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"),
  );
}

export function normalizeRect(rect: Rect, frameWidth: number, frameHeight: number): NormalizedRect {
  return { x: rect.x / frameWidth, y: rect.y / frameHeight, width: rect.width / frameWidth, height: rect.height / frameHeight };
}

/** A normalized region in a frame's pixels, clamped to the frame and at least 1×1. */
export function denormalizeRect(region: NormalizedRect, frameWidth: number, frameHeight: number): Rect {
  const x0 = Math.min(frameWidth - 1, Math.max(0, Math.round(region.x * frameWidth)));
  const y0 = Math.min(frameHeight - 1, Math.max(0, Math.round(region.y * frameHeight)));
  const x1 = Math.min(frameWidth, Math.max(x0 + 1, Math.round((region.x + region.width) * frameWidth)));
  const y1 = Math.min(frameHeight, Math.max(y0 + 1, Math.round((region.y + region.height) * frameHeight)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
