import type { NormalizedRect } from "../shared/canvas";

/**
 * The studio's camera: a camera this computer has (LocalCamera: webcam, USB,
 * Continuity Camera) or a phone streaming over WebRTC (RemoteCamera).
 * docs/character-studio.md §3.2.
 */

export type CameraStatus = { kind: "starting" } | { kind: "ready" } | { kind: "lost"; reason: string } | { kind: "stopped" };

export interface CameraStill {
  frame: HTMLCanvasElement | OffscreenCanvas;
  /** Sharpness of each burst frame (the sharpest was used). */
  sharpness: number[];
}

export interface CameraSource {
  readonly kind: "local" | "phone";
  /** The live picture, playing (local: getUserMedia; phone: the received track). */
  readonly video: HTMLVideoElement;
  /** Live video size. */
  readonly width: number;
  readonly height: number;
  /** Shown mirrored (front cameras); captures are never mirrored. */
  readonly mirrored: boolean;
  readonly status: CameraStatus;
  /** Calls back on each presented video frame. Returns an unsubscribe. */
  onFrame(cb: (nowMs: number) => void): () => void;
  /**
   * The sharpest of `burst` frames at the camera's full resolution. `region` is
   * the person, normalized 0..1 to the live frame (the still may be larger).
   */
  grabStill(region: NormalizedRect | null, burst: number): Promise<CameraStill>;
  /**
   * Hold the exposure and white balance as they are now, for the rest of the
   * fighter (what got locked; empty where the camera can't). Undone by `unlockExposure`.
   */
  lockExposure(): Promise<string[]>;
  unlockExposure(): Promise<void>;
  canSwitch(): Promise<boolean>;
  switchCamera(): Promise<void>;
  /** Called immediately with the current status. Returns an unsubscribe. */
  onStatus(cb: (s: CameraStatus) => void): () => void;
  stop(): void;
}

/** Status bookkeeping shared by both sources. */
export class StatusHub {
  private listeners = new Set<(s: CameraStatus) => void>();
  status: CameraStatus = { kind: "starting" };

  set(status: CameraStatus): void {
    // "stopped" is final.
    if (this.status.kind === "stopped") return;
    if (status.kind === this.status.kind && status.kind !== "lost") return;
    this.status = status;
    for (const l of [...this.listeners]) l(status);
  }

  on(cb: (s: CameraStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => { this.listeners.delete(cb); };
  }
}

/** Calls back on each presented video frame (requestVideoFrameCallback, or rAF). */
export function onVideoFrame(video: HTMLVideoElement, callback: (nowMs: number) => void): () => void {
  let active = true;
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number) => void) => number };
  const loop = (now: number) => {
    if (!active) return;
    callback(now);
    schedule();
  };
  const schedule = () => {
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };
  schedule();
  return () => { active = false; };
}

/**
 * The still must be the same way up as the live video (both portrait or both
 * landscape), or the person's landmarks wouldn't line up with it.
 */
export function sameOrientation(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  const landscape = (s: { width: number; height: number }) => s.width >= s.height;
  return landscape(a) === landscape(b);
}
