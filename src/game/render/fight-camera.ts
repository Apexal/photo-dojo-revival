import { GAME_HEIGHT, GAME_WIDTH } from "./stage";

/*
 * A camera that follows the fight: it frames both fighters, closes in when
 * they're near each other and eases out as they separate, and punches in for
 * a moment on big hits. Rendering only. Pure, so the framing rules are tested
 * in Node; fight-scene.ts applies the result to Phaser's main camera.
 */

export const CAMERA = {
  /** Fully zoomed out shows the whole stage. */
  minZoom: 1,
  maxZoom: 1.22,
  /** Gap between the fighters' feet (px) at which the camera is fully in / fully out. */
  nearGap: 240,
  farGap: 620,
  /** Room kept beside each fighter (px, screen space at zoom 1): their body and reach. */
  sideMargin: 170,
  /** Room kept above each fighter's feet (px): a whole fighter, arms raised (the jump pose) included. */
  fighterHeight: 540,
  /** Fraction of the way to the target covered per 60 Hz frame. */
  follow: 0.1,
  /** Extra zoom on impact... */
  impact: { hit: 0.025, throw: 0.04, ko: 0.08 },
  /** ...keeping this fraction of itself per 60 Hz frame (about 1/10 left after 12 frames). */
  impactDecay: 0.82,
} as const;

export type CameraImpact = keyof typeof CAMERA.impact;

export interface CameraView {
  zoom: number;
  /** World point at the centre of the screen. */
  centerX: number;
  centerY: number;
}

export const FULL_VIEW: CameraView = { zoom: 1, centerX: GAME_WIDTH / 2, centerY: GAME_HEIGHT / 2 };

/** Keeps a view inside the stage: zoom ≥ 1 and the edges never past the stage's. */
export function clampView(v: CameraView): CameraView {
  const zoom = Math.max(1, v.zoom);
  const halfW = GAME_WIDTH / (2 * zoom), halfH = GAME_HEIGHT / (2 * zoom);
  return {
    zoom,
    centerX: Math.min(GAME_WIDTH - halfW, Math.max(halfW, v.centerX)),
    centerY: Math.min(GAME_HEIGHT - halfH, Math.max(halfH, v.centerY)),
  };
}

/**
 * Where the camera wants to be for fighters whose feet are at these screen
 * points: zoom by how close they are, centred between them, the floor kept at
 * the bottom; zoomed out as far as it takes to keep both whole, jumps included.
 */
export function cameraTarget(feet: readonly { x: number; y: number }[]): CameraView {
  const left = Math.min(...feet.map((f) => f.x)), right = Math.max(...feet.map((f) => f.x));
  const gap = right - left;
  const closeness = Math.min(1, Math.max(0, (CAMERA.farGap - gap) / (CAMERA.farGap - CAMERA.nearGap)));
  let zoom = CAMERA.minZoom + (CAMERA.maxZoom - CAMERA.minZoom) * closeness;
  // Both fighters, with room either side...
  zoom = Math.min(zoom, GAME_WIDTH / (gap + 2 * CAMERA.sideMargin));
  // ...and the highest head: the view's bottom stays on the stage's, so its top is at GAME_HEIGHT · (1 − 1/zoom).
  const top = Math.min(...feet.map((f) => f.y)) - CAMERA.fighterHeight;
  if (top < GAME_HEIGHT) zoom = Math.min(zoom, GAME_HEIGHT / (GAME_HEIGHT - Math.max(0, top)));
  return clampView({ zoom, centerX: (left + right) / 2, centerY: GAME_HEIGHT });
}

/** The camera's state between frames: eases toward the target and carries the impact punch-in. */
export class FightCamera {
  view: CameraView = FULL_VIEW;
  private impact = 0;

  /** Punch in a little for a big moment (the strongest one wins if several land together). */
  kick(kind: CameraImpact): void {
    this.impact = Math.max(this.impact, CAMERA.impact[kind]);
  }

  /** Move `frames` (60 Hz frames, may be fractional) toward framing these fighters; returns the view to show. */
  update(feet: readonly { x: number; y: number }[], frames: number): CameraView {
    const target = cameraTarget(feet);
    const k = 1 - Math.pow(1 - CAMERA.follow, frames);
    const eased = {
      zoom: this.view.zoom + (target.zoom - this.view.zoom) * k,
      centerX: this.view.centerX + (target.centerX - this.view.centerX) * k,
      centerY: this.view.centerY + (target.centerY - this.view.centerY) * k,
    };
    this.view = clampView(eased);
    this.impact *= Math.pow(CAMERA.impactDecay, frames);
    return clampView({ ...this.view, zoom: this.view.zoom + this.impact });
  }

  /** Jump straight to framing these fighters (a new round, a replay starting). */
  snap(feet: readonly { x: number; y: number }[]): CameraView {
    this.view = cameraTarget(feet);
    this.impact = 0;
    return this.view;
  }
}
