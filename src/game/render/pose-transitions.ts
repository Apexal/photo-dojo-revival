import { softCut } from "../../shared/frame-data";
import type { FrameTween } from "../../simulation/fight-simulation";
import type { FrameRef } from "./pose-tweener";

/** Below this, the idle sway is drawn as the plain sprite. */
const SWAY_EPSILON = 0.01;

/**
 * Turns the hard cuts between actions into short morphs (SOFT_CUTS in
 * frame-data.ts) and lets a standing fighter sway. The simulation only knows
 * the pose it shows now, so this remembers what was on screen. Rendering only:
 * it never feeds back into the fight. One per fighter view.
 */
export class PoseTransitions {
  private shown: FrameRef | null = null;
  private active: { from: FrameRef; to: FrameRef; start: number; frames: number } | null = null;
  private lastFrame = -Infinity;

  /**
   * The tween to draw on simulation frame `frame`, given the capture the
   * simulation shows (`held`), the move's own tween if it has one, and the idle
   * sway if the fighter is standing still. A move's tween wins, then a soft
   * cut, then the sway. Rendering the same frame twice gives the same answer.
   */
  update(frame: number, held: FrameRef, sequenceTween: FrameTween | null, sway: FrameTween | null = null): FrameTween | null {
    if (frame < this.lastFrame) this.reset(); // a replay rewound time
    this.lastFrame = frame;
    if (sequenceTween) {
      // The move morphs on its own; afterwards, what's on screen is where it was heading.
      this.active = null;
      this.shown = sequenceTween.to;
      return sequenceTween;
    }
    // Only a change of pose is a cut: swaying between two versions of idle isn't.
    if (this.shown && this.shown.poseId !== held.poseId) {
      const cut = softCut(this.shown.poseId, held.poseId);
      this.active = cut ? { from: this.shown, to: held, start: frame, frames: cut.frames } : null;
    }
    const active = this.active;
    if (active && frame - active.start < active.frames) {
      this.shown = held;
      const x = (frame - active.start + 1) / (active.frames + 1);
      return { from: active.from, to: active.to, t: 1 - (1 - x) * (1 - x) };
    }
    this.active = null;
    if (sway && sway.t >= SWAY_EPSILON) {
      // Whichever stance it's nearer is where a cut out of it starts.
      this.shown = sway.t < 0.5 ? sway.from : sway.to;
      return sway;
    }
    this.shown = held;
    return null;
  }

  reset(): void {
    this.shown = null;
    this.active = null;
    this.lastFrame = -Infinity;
  }
}
