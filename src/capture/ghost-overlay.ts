import type { NormalizedLandmark } from "../shared/fighter-model";
import { STICK_SEGMENTS } from "../shared/stick-figure";
import { defaultGhostFit, ghostTransform, type GhostFit } from "./framing";

export interface OverlayState {
  ghostPath: string;
  /** Where and how big to draw the ghost (sized to the person); default framing if omitted. */
  ghostFit?: GhostFit;
  landmarks: NormalizedLandmark[] | null;
  holdProgress: number;
  matching: boolean;
  /** Bigger text for solo mode (phone propped up across the room). */
  large: boolean;
  message: string;
}

/**
 * Draws the target silhouette, the live skeleton and the hold progress ring
 * over the camera. The canvas uses the video's pixel size so landmarks map 1:1.
 */
export class GhostOverlay {
  private readonly ctx: CanvasRenderingContext2D;
  private pathCache: { source: string; path: Path2D } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas not available");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private ghost(source: string): Path2D {
    if (this.pathCache?.source !== source) this.pathCache = { source, path: new Path2D(source) };
    return this.pathCache.path;
  }

  draw(state: OverlayState): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    // Ghost: sprite space → frame, standing where the person stands (or centered, feet near the bottom).
    const { scale, translateX, translateY } = ghostTransform(state.ghostFit ?? defaultGhostFit(W, H));
    ctx.save();
    ctx.translate(translateX, translateY);
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = state.matching ? "rgba(90, 230, 140, 0.55)" : "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 26;
    ctx.stroke(this.ghost(state.ghostPath));
    ctx.restore();

    // Live skeleton.
    if (state.landmarks) {
      ctx.strokeStyle = state.matching ? "#5ae68c" : "#f2c14e";
      ctx.lineWidth = Math.max(3, W / 240);
      ctx.lineCap = "round";
      for (const [a, b] of STICK_SEGMENTS) {
        const la = state.landmarks[a];
        const lb = state.landmarks[b];
        if (la.visibility < 0.3 || lb.visibility < 0.3) continue;
        ctx.beginPath();
        ctx.moveTo(la.x * W, la.y * H);
        ctx.lineTo(lb.x * W, lb.y * H);
        ctx.stroke();
      }
    }

    // Progress ring.
    const r = Math.min(W, H) * (state.large ? 0.1 : 0.07);
    const cx = W - r * 1.6;
    const cy = r * 1.6;
    ctx.lineWidth = r * 0.28;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (state.holdProgress > 0) {
      ctx.strokeStyle = "#5ae68c";
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + state.holdProgress * Math.PI * 2);
      ctx.stroke();
    }

    if (state.message) {
      const size = Math.round(H * (state.large ? 0.075 : 0.045));
      ctx.font = `700 ${size}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.lineWidth = size / 6;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.fillStyle = "#fff";
      ctx.strokeText(state.message, W / 2, H - size * 0.8);
      ctx.fillText(state.message, W / 2, H - size * 0.8);
    }
  }
}
