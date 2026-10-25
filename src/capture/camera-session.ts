import { createCanvas, context2d, denormalizeRect, type NormalizedRect } from "../shared/canvas";
import { laplacianVariance, sharpnessSampleSize } from "./sharpness";

export type CameraFacing = "environment" | "user";

/** getUserMedia + a video element; grabs full-resolution frames to a canvas. */
type CameraChoice = { facingMode: CameraFacing; exact?: boolean } | { deviceId: string };

export class CameraSession {
  private stream: MediaStream | null = null;
  private streamListeners = new Set<(track: MediaStreamTrack) => void>();
  /** The camera last opened, so a restart after stop() comes back to the same one. */
  private choice: CameraChoice = { facingMode: "environment" };
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

  /** The live video track, while the camera runs. */
  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /**
   * Called with the new track whenever a camera opens (start, restart, switch),
   * e.g. to `replaceTrack` it into a WebRTC sender. Returns an unsubscribe.
   */
  onStreamChange(callback: (track: MediaStreamTrack) => void): () => void {
    this.streamListeners.add(callback);
    return () => { this.streamListeners.delete(callback); };
  }

  /** Prefer the rear camera; fall back to any camera (e.g. a laptop webcam). */
  async start(facingMode: CameraFacing = "environment"): Promise<void> {
    await this.open({ facingMode });
  }

  /** A specific camera, by its enumerateDevices id (falls back to any camera if it's gone). */
  async startDevice(deviceId: string): Promise<void> {
    await this.open({ deviceId });
  }

  /** Reopen the camera that was in use before stop() (the front one, if they switched). */
  async restart(): Promise<void> {
    const deviceId = this.lastDeviceId;
    await this.open(deviceId ? { deviceId } : this.choice);
  }

  private lastDeviceId: string | undefined;
  /** Bumped by every open() and stop(), so an open() that was overtaken drops its stream instead of leaking it. */
  private openGeneration = 0;

  private async open(choice: CameraChoice): Promise<void> {
    this.stop();
    this.choice = choice;
    const generation = ++this.openGeneration;
    // 1080p: stills get more pixels per limb for the matting; live detection downsizes anyway.
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const video: MediaTrackConstraints = "deviceId" in choice
      ? { deviceId: { exact: choice.deviceId }, ...size }
      : { facingMode: choice.exact ? { exact: choice.facingMode } : choice.facingMode, ...size };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      if ((err as DOMException).name === "NotAllowedError" || generation !== this.openGeneration) throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    if (generation !== this.openGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException("A newer camera request replaced this one", "AbortError");
    }
    this.stream = stream;
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => this.video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
    }
    const track = this.track;
    if (track) for (const listener of this.streamListeners) listener(track);
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
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "AbortError") throw err;
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
   * The sharpest of the next `count` video frames, judged in `region` (the
   * person, normalized 0..1 to the frame, so a region found on a smaller live
   * picture works here too). Only the winner is copied at full resolution.
   */
  async grabSharpest(count: number, region: NormalizedRect | null): Promise<{ frame: HTMLCanvasElement | OffscreenCanvas; sharpness: number[] }> {
    const area = region ? denormalizeRect(region, this.width, this.height) : { x: 0, y: 0, width: this.width, height: this.height };
    const sample = sharpnessSampleSize(area);
    const probe = createCanvas(sample.width, sample.height);
    const probeCtx = context2d(probe);
    const scores: number[] = [];
    // One full-resolution canvas, redrawn whenever a sharper frame comes along.
    const best = createCanvas(this.width, this.height);
    const bestCtx = context2d(best);
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      if (i > 0) await this.nextFrame();
      probeCtx.drawImage(this.video, area.x, area.y, area.width, area.height, 0, 0, sample.width, sample.height);
      const score = laplacianVariance(probeCtx.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestCtx.drawImage(this.video, 0, 0, this.width, this.height);
      }
    }
    return { frame: best, sharpness: scores };
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
    // An open() still waiting on getUserMedia drops its stream when it arrives.
    this.openGeneration++;
    this.lastDeviceId = this.deviceId ?? this.lastDeviceId;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
