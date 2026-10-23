import type { Rect } from "./matting";
import { laplacianVariance, sharpnessSampleSize } from "./sharpness";
import { createCanvas, context2d } from "./sprite-normalizer";

export type CameraFacing = "environment" | "user";

/** getUserMedia + a video element; grabs full-resolution frames to a canvas. */
export class CameraSession {
  private stream: MediaStream | null = null;
  readonly video: HTMLVideoElement;

  constructor(video?: HTMLVideoElement) {
    this.video = video ?? document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  get isRunning(): boolean {
    return this.stream !== null;
  }

  /** Prefer the rear camera; fall back to any camera (e.g. a laptop webcam). */
  async start(facingMode: CameraFacing = "environment"): Promise<void> {
    await this.open({ facingMode });
  }

  private async open(choice: { facingMode: CameraFacing; exact?: boolean } | { deviceId: string }): Promise<void> {
    this.stop();
    // 1080p: stills get more pixels per limb for the matting; live detection downsizes anyway.
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const video: MediaTrackConstraints = "deviceId" in choice
      ? { deviceId: { exact: choice.deviceId }, ...size }
      : { facingMode: choice.exact ? { exact: choice.facingMode } : choice.facingMode, ...size };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      if ((err as DOMException).name === "NotAllowedError") throw err;
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => this.video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
    }
  }

  /** Whether there's another camera to switch to (labels/ids are only listed after permission is granted). */
  async canSwitch(): Promise<boolean> {
    const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
    return devices.filter((d) => d.kind === "videoinput").length > 1;
  }

  /**
   * Front ↔ rear. Phones honor facingMode; laptops with two webcams usually
   * don't report it, so fall back to the next camera in the device list.
   */
  async switchCamera(): Promise<void> {
    const before = this.deviceId;
    const want: CameraFacing = this.isFrontFacing ? "environment" : "user";
    try {
      await this.open({ facingMode: want, exact: true });
    } catch (err) {
      if ((err as DOMException).name === "NotAllowedError") throw err;
    }
    if (this.isRunning && this.deviceId !== before) return;
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const next = cameras[(cameras.findIndex((d) => d.deviceId === before) + 1) % cameras.length];
    await this.open(next ? { deviceId: next.deviceId } : { facingMode: want });
  }

  private get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  /**
   * The front camera is shown mirrored, like a mirror; captures are never mirrored.
   * Laptop webcams usually don't report facingMode, so they count as front-facing unless named "back"/"rear".
   */
  get isFrontFacing(): boolean {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const facing = track.getSettings().facingMode;
    if (facing) return facing === "user";
    return !/back|rear|environment/i.test(track.label);
  }

  grabFrame(): HTMLCanvasElement | OffscreenCanvas {
    const canvas = createCanvas(this.width, this.height);
    context2d(canvas).drawImage(this.video, 0, 0, this.width, this.height);
    return canvas;
  }

  /**
   * The sharpest of the next `count` video frames, judged in `region` (frame
   * pixels; the person). Only the winner is copied at full resolution.
   */
  async grabSharpest(count: number, region: Rect | null): Promise<{ frame: HTMLCanvasElement | OffscreenCanvas; sharpness: number[] }> {
    const area = region ?? { x: 0, y: 0, width: this.width, height: this.height };
    const sample = sharpnessSampleSize(area);
    const probe = createCanvas(sample.width, sample.height);
    const probeCtx = context2d(probe);
    const scores: number[] = [];
    let best: HTMLCanvasElement | OffscreenCanvas | null = null;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      if (i > 0) await this.nextFrame();
      probeCtx.drawImage(this.video, area.x, area.y, area.width, area.height, 0, 0, sample.width, sample.height);
      const score = laplacianVariance(probeCtx.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        best = this.grabFrame();
      }
    }
    return { frame: best ?? this.grabFrame(), sharpness: scores };
  }

  /** Resolves on the next presented video frame, or after ~one frame's time if none comes (paused video, no rVFC). */
  private nextFrame(): Promise<void> {
    const video = this.video;
    return new Promise((resolve) => {
      const hasRvfc = "requestVideoFrameCallback" in video;
      if (hasRvfc) video.requestVideoFrameCallback(() => resolve());
      setTimeout(resolve, hasRvfc ? 100 : 34);
    });
  }

  /** Calls back on each presented video frame (requestVideoFrameCallback, or rAF fallback). */
  onFrame(callback: (nowMs: number) => void): () => void {
    let active = true;
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    };
    const loop = (now: number) => {
      if (!active) return;
      callback(now);
      schedule();
    };
    const schedule = () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    schedule();
    return () => { active = false; };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
