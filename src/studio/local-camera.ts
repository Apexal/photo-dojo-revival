import { CameraSession } from "../capture/camera-session";
import type { NormalizedRect } from "../shared/canvas";
import { StatusHub, type CameraSource, type CameraStatus, type CameraStill } from "./camera-source";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/** This computer's cameras (labels only appear once camera permission has been granted). */
export async function listCameras(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** Why a camera didn't open, for people. */
export function cameraErrorText(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === "NotAllowedError") return "Camera access was denied. Allow it in the browser's site settings, then retry.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "That camera isn't available.";
  if (name === "NotReadableError") return "The camera is busy (another app may be using it).";
  return (err as Error)?.message ?? String(err);
}

/**
 * A camera on this computer: built-in or USB webcam, or an iPhone through
 * macOS Continuity Camera (an ordinary webcam to getUserMedia). Stills are
 * the sharpest frame of a burst, straight from the live video.
 */
export class LocalCamera implements CameraSource {
  readonly kind = "local" as const;
  private readonly session = new CameraSession();
  private readonly hub = new StatusHub();
  private watchedTrack: MediaStreamTrack | null = null;
  /** The camera picked in the list, if any (else the default one). */
  private deviceId: string | null;

  constructor(deviceId: string | null = null) {
    this.deviceId = deviceId;
    this.session.onStreamChange((track) => this.watch(track));
  }

  get video(): HTMLVideoElement {
    return this.session.video;
  }

  get width(): number {
    return this.session.width;
  }

  get height(): number {
    return this.session.height;
  }

  get mirrored(): boolean {
    return this.session.isFrontFacing;
  }

  get status(): CameraStatus {
    return this.hub.status;
  }

  /** The device that's running, once one is. */
  get currentDeviceId(): string | null {
    return this.session.track?.getSettings().deviceId ?? this.deviceId;
  }

  /** Opens the picked camera (or the default one). Failures show up as `lost`. */
  async start(): Promise<void> {
    if (this.hub.status.kind === "stopped") return;
    this.hub.set({ kind: "starting" });
    try {
      await (this.deviceId ? this.session.startDevice(this.deviceId) : this.session.start("user"));
      this.hub.set({ kind: "ready" });
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return; // a newer start took over
      console.warn("[camera] couldn't start", err);
      this.hub.set({ kind: "lost", reason: cameraErrorText(err) });
    }
  }

  /** Switches to another camera from the list. */
  async useCamera(deviceId: string): Promise<void> {
    this.deviceId = deviceId;
    await this.start();
  }

  /** Watches the running track: unplugged, or taken by another app, means lost. */
  private watch(track: MediaStreamTrack): void {
    this.watchedTrack = track;
    track.addEventListener("ended", () => {
      if (this.watchedTrack !== track || this.hub.status.kind === "stopped") return;
      this.hub.set({ kind: "lost", reason: "The camera stopped (unplugged, or another app took it)" });
    }, { once: true });
  }

  onFrame(cb: (nowMs: number) => void): () => void {
    return this.session.onFrame(cb);
  }

  async grabStill(region: NormalizedRect | null, burst: number): Promise<CameraStill> {
    if (!this.session.isRunning) throw new Error("The camera isn't running");
    return this.session.grabSharpest(burst, region);
  }

  canSwitch(): Promise<boolean> {
    return this.session.canSwitch();
  }

  async switchCamera(): Promise<void> {
    try {
      await this.session.switchCamera();
    } catch (err) {
      // A switch that failed partway has already closed the old stream: that's a lost camera (Retry).
      if ((err as DOMException).name !== "AbortError" && !this.session.isRunning) {
        this.hub.set({ kind: "lost", reason: cameraErrorText(err) });
      }
      throw err;
    }
    this.deviceId = this.session.track?.getSettings().deviceId ?? this.deviceId;
    this.hub.set({ kind: "ready" });
  }

  onStatus(cb: (s: CameraStatus) => void): () => void {
    return this.hub.on(cb);
  }

  stop(): void {
    this.watchedTrack = null;
    this.session.stop();
    this.hub.set({ kind: "stopped" });
  }
}
