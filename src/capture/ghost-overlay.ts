import type { NormalizedLandmark } from "../shared/fighter-model";
import type { JointError } from "../shared/pose-geometry";
import { STICK_SEGMENTS } from "../shared/stick-figure";
import { defaultGhostFit, ghostTransform, type GhostFit } from "./framing";
import { segmentBands, type CorrectionArrow, type JointBand } from "./pose-coaching";

const MATCH_COLOUR = "#5ae68c";
const ARROW_COLOUR = "#ffffff";
/** Live skeleton bones: by how their joint is doing; bones the pose doesn't check stay neutral. */
const BAND_COLOURS: Record<JointBand | "unchecked", string> = {
  good: MATCH_COLOUR,
  close: "#f2c14e",
  off: "#ff5a5a",
  unchecked: "rgba(255, 255, 255, 0.7)",
};

export interface OverlayState {
  ghostPath: string;
  /** Where and how big to draw the ghost (sized to the person); default framing if omitted. */
  ghostFit?: GhostFit;
  landmarks: NormalizedLandmark[] | null;
  /** The matcher's per-joint errors, to colour each bone (all green while matching). */
  joints: readonly JointError[];
  /** Which way to move the limb being corrected (frame pixels). */
  arrows: readonly CorrectionArrow[];
  holdProgress: number;
  matching: boolean;
  /** A bigger ring for solo mode (phone propped up across the room). */
  large: boolean;
}

const sameState = (a: OverlayState, b: OverlayState) =>
  a.ghostPath === b.ghostPath && a.landmarks === b.landmarks && a.joints === b.joints && a.arrows === b.arrows && a.holdProgress === b.holdProgress && a.matching === b.matching && a.large === b.large
  && a.ghostFit?.scale === b.ghostFit?.scale && a.ghostFit?.groundX === b.ghostFit?.groundX && a.ghostFit?.groundY === b.ghostFit?.groundY;

/**
 * Draws the target silhouette, the live skeleton and the hold progress ring
 * over the camera. The canvas uses the video's pixel size so landmarks map 1:1.
 */
export class GhostOverlay {
  private readonly ctx: CanvasRenderingContext2D;
  private pathCache: { source: string; path: Path2D } | null = null;
  /** What's on the canvas now: drawing is skipped while nothing changes (detection runs slower than video). */
  private drawn: OverlayState | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas not available");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.drawn = null; // resizing clears the canvas
  }

  private ghost(source: string): Path2D {
    if (this.pathCache?.source !== source) this.pathCache = { source, path: new Path2D(source) };
    return this.pathCache.path;
  }

  draw(state: OverlayState): void {
    if (this.drawn && sameState(this.drawn, state)) return;
    this.drawn = state;
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

    // Live skeleton, each bone coloured by the joint it's measured on.
    if (state.landmarks) {
      const bands = segmentBands(state.joints);
      // Thick enough to read from across the room.
      const width = Math.max(5, W / 140);
      ctx.lineCap = "round";
      for (const [i, [a, b]] of STICK_SEGMENTS.entries()) {
        const la = state.landmarks[a];
        const lb = state.landmarks[b];
        if (la.visibility < 0.3 || lb.visibility < 0.3) continue;
        const band = bands[i];
        ctx.strokeStyle = state.matching ? MATCH_COLOUR : BAND_COLOURS[band ?? "unchecked"];
        // Checked bones are thicker, the ones to fix thickest: the shape says it too, not only the colour.
        ctx.lineWidth = band === null ? width : band === "off" && !state.matching ? width * 1.8 : width * 1.4;
        ctx.beginPath();
        ctx.moveTo(la.x * W, la.y * H);
        ctx.lineTo(lb.x * W, lb.y * H);
        ctx.stroke();
      }
    }

    if (!state.matching) for (const arrow of state.arrows) drawArrow(ctx, arrow, Math.max(8, W / 90));

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
      ctx.strokeStyle = MATCH_COLOUR;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + state.holdProgress * Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** A fat arrow with a dark outline, so it shows on any background. */
function drawArrow(ctx: CanvasRenderingContext2D, { from, to }: CorrectionArrow, width: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = width * 2.2;
  // Stop the shaft short of the point so the head's tip stays sharp.
  const shaftEnd = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 };
  const headPath = () => {
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - 0.5) * head * 1.3, to.y - Math.sin(angle - 0.5) * head * 1.3);
    ctx.lineTo(to.x - Math.cos(angle + 0.5) * head * 1.3, to.y - Math.sin(angle + 0.5) * head * 1.3);
    ctx.closePath();
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [colour, extra] of [["rgba(0, 0, 0, 0.6)", width * 0.6], [ARROW_COLOUR, 0]] as const) {
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = width + extra;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    headPath();
    if (extra) ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}
