import type { NormalizedRect } from "../shared/canvas";
import {
  CAMERA_PROTOCOL,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  encodeCameraMessage,
  parseCameraMessage,
  type CameraMessage,
  type StillMime,
} from "../transfer/camera-protocol";
import type { DataChannelLike } from "../transfer/data-channel";
import { sendStill } from "../transfer/still-sender";

/**
 * The phone camera's side of the "camera" channel, without the browser: the
 * camera and the transport are injected, so this runs (and is tested against
 * the studio's StillReceiver) in Node. docs/character-studio.md §4.
 */

export type CameraInfo = Omit<Extract<CameraMessage, { type: "camera-info" }>, "type">;

/** A still as the phone sends it: encoded at the camera's full resolution. */
export interface EncodedStill {
  mime: StillMime;
  width: number;
  height: number;
  sharpness: number[];
  bytes: Blob | Uint8Array;
}

/** What the session needs of the phone's camera (main.ts wraps CameraSession). */
export interface PhoneCamera {
  readonly isRunning: boolean;
  /** The camera as `camera-info` describes it. */
  info(): Promise<CameraInfo>;
  /** The sharpest of `burst` frames, judged in `region` (normalized to the frame). */
  grabStill(region: NormalizedRect | null, burst: number): Promise<EncodedStill>;
  /** Front ↔ rear; the new track reaches the WebRTC sender outside the session (`replaceTrack`). */
  switchCamera(): Promise<void>;
}

export type PhoneSessionEnd =
  /** The studio closed the link on purpose (left, or another protocol version): don't retry. */
  | { kind: "bye"; reason: string }
  /** The link dropped or stopped answering: retry. */
  | { kind: "lost"; reason: string }
  /** This side closed it (`close`). */
  | { kind: "stopped" };

/**
 * One open link to the studio: says hello, describes the camera, answers
 * still requests (a new one cancels the one in progress), switches cameras,
 * relays the studio's status line and keeps the link alive with pings.
 */
export class PhoneSession {
  /** Resolves once, when the link is over. */
  readonly ended: Promise<PhoneSessionEnd>;
  private resolveEnded!: (end: PhoneSessionEnd) => void;
  private done = false;
  private lastHeard = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** The still being grabbed or sent, cancelled by the next request. */
  private stillAbort: AbortController | null = null;
  /** The camera switch in progress: another `switch-camera` meanwhile is dropped. */
  private switching: Promise<void> | null = null;

  constructor(
    private readonly channel: DataChannelLike,
    private readonly camera: PhoneCamera,
    private readonly options: { device: string; onStudioStatus?: (text: string) => void },
  ) {
    this.ended = new Promise((resolve) => { this.resolveEnded = resolve; });
  }

  get isOpen(): boolean {
    return !this.done;
  }

  /** Sends `hello` and `camera-info`, then pings every PING_INTERVAL_MS. */
  start(): void {
    if (this.done) return;
    this.channel.addEventListener("message", this.onMessage);
    this.channel.addEventListener("close", this.onClose);
    if (this.channel.readyState !== "open") return this.end({ kind: "lost", reason: "The link to the studio closed" });
    this.lastHeard = Date.now();
    this.send({ type: "hello", protocol: CAMERA_PROTOCOL, device: this.options.device });
    this.sendCameraInfo();
    this.pingTimer = setInterval(() => {
      // Anything from the studio counts, not just pongs: our ping can sit behind a still in our own send queue.
      if (Date.now() - this.lastHeard > PING_TIMEOUT_MS) return this.end({ kind: "lost", reason: "The studio stopped answering" });
      this.send({ type: "ping", t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  /** Tells the studio about the camera (after start, a switch, a resume). */
  sendCameraInfo(): void {
    if (this.done) return;
    this.camera.info().then(
      (info) => this.send({ type: "camera-info", ...info }),
      (err) => console.warn("[phone] couldn't describe the camera", err),
    );
  }

  /** The transport noticed the link is gone (connection failed, track ended). */
  lose(reason: string): void {
    this.end({ kind: "lost", reason });
  }

  /** Clean close from this side: `bye`, then done. */
  close(reason: string): void {
    if (this.done) return;
    this.send({ type: "bye", reason });
    this.end({ kind: "stopped" });
  }

  private send(msg: CameraMessage): void {
    if (this.done) return;
    try {
      this.channel.send(encodeCameraMessage(msg));
    } catch (err) {
      this.end({ kind: "lost", reason: `The link to the studio closed (${(err as Error).message})` });
    }
  }

  private end(end: PhoneSessionEnd): void {
    if (this.done) return;
    this.done = true;
    clearInterval(this.pingTimer);
    this.stillAbort?.abort();
    this.stillAbort = null;
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
    this.resolveEnded(end);
  }

  private readonly onClose = () => this.end({ kind: "lost", reason: "The link to the studio closed" });

  private readonly onMessage = (ev: { data: unknown }) => {
    if (this.done) return;
    this.lastHeard = Date.now();
    if (typeof ev.data !== "string") return; // the studio sends no binary frames
    const msg = parseCameraMessage(ev.data);
    if (!msg) return;
    switch (msg.type) {
      case "ping":
        this.send({ type: "pong", t: msg.t });
        break;
      case "still-request":
        void this.answerStill(msg);
        break;
      case "switch-camera":
        // One switch at a time: the camera can't open two streams at once, and the studio hears the result in camera-info.
        if (this.switching) console.info("[phone] already switching cameras");
        else this.switching = this.switchCamera().finally(() => { this.switching = null; });
        break;
      case "status":
        this.options.onStudioStatus?.(msg.text);
        break;
      case "bye":
        this.end({ kind: "bye", reason: msg.reason });
        break;
      default:
        // pong (lastHeard is enough), or a phone → studio message echoed back: nothing to do.
        break;
    }
  };

  private async answerStill(req: Extract<CameraMessage, { type: "still-request" }>): Promise<void> {
    this.stillAbort?.abort();
    const abort = new AbortController();
    this.stillAbort = abort;
    try {
      if (!this.camera.isRunning) throw new Error("The phone's camera isn't running");
      const still = await this.camera.grabStill(req.region, req.burst);
      if (abort.signal.aborted) return;
      await sendStill(this.channel, { id: req.id, ...still }, { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted || this.done) return;
      // A closed channel ends the session through its close event; anything else, the studio hears about.
      if (this.channel.readyState === "open") this.send({ type: "still-error", id: req.id, message: (err as Error).message.slice(0, 200) });
    } finally {
      if (this.stillAbort === abort) this.stillAbort = null;
    }
  }

  private async switchCamera(): Promise<void> {
    try {
      await this.camera.switchCamera();
    } catch (err) {
      console.warn("[phone] couldn't switch cameras", err);
    }
    // Whatever camera is running now (the old one, reopened, if the switch failed).
    this.sendCameraInfo();
  }
}

/** An open link to the studio, as the connector hands it over. */
export interface PhoneTransport {
  channel: DataChannelLike;
  close(): void;
  /** Calls back if the transport sees the link die before the channel does (e.g. connectionState "failed"). */
  onDown?(callback: (reason: string) => void): void;
}

/** Signaling + WebRTC for one attempt; rejects if the studio doesn't connect (connectAsGuest's 20 s wait). */
export type PhoneConnector = (roomCode: string) => Promise<PhoneTransport>;

export type PhoneLinkStatus =
  /** Trying to reach the studio for the first time; `reason` says why the last attempt failed. */
  | { kind: "connecting"; reason?: string }
  | { kind: "streaming" }
  /** Was streaming, the link dropped: trying again on the same code. */
  | { kind: "reconnecting"; reason: string }
  /** The studio said bye. */
  | { kind: "closed"; reason: string }
  /** This page stopped (`stop`). */
  | { kind: "stopped" };

/** Wait before attempt n+1 after n failed ones: 1 s, 2 s, 4 s, then every 5 s. */
export function reconnectDelayMs(failedAttempts: number): number {
  return Math.min(5000, 1000 * 2 ** Math.max(0, failedAttempts - 1));
}

/** Pause after a link that was up drops, before reconnecting. */
export const RECONNECT_AFTER_DROP_MS = 1000;

/**
 * The phone's link to one studio code: connects, runs a PhoneSession, and on
 * any drop keeps retrying the same code (so a dropped phone comes back without
 * rescanning, and a second phone waits until the first one leaves). Stops for
 * good on the studio's `bye` or `stop()`.
 */
export class PhoneConnection {
  private session: PhoneSession | null = null;
  private running = false;
  private wake: (() => void) | null = null;
  private listeners = new Set<(s: PhoneLinkStatus) => void>();
  status: PhoneLinkStatus = { kind: "connecting" };

  constructor(
    readonly roomCode: string,
    private readonly camera: PhoneCamera,
    private readonly connect: PhoneConnector,
    private readonly options: { device: string; onStudioStatus?: (text: string) => void },
  ) {}

  /** Called immediately with the current status. */
  onStatus(listener: (s: PhoneLinkStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  /** Says bye to the studio (if connected) and stops retrying. */
  stop(reason = "The camera page closed"): void {
    if (!this.running) return;
    this.running = false;
    this.session?.close(reason);
    this.wake?.();
    this.set({ kind: "stopped" });
  }

  /** The camera changed (switched, restarted after a resume): tell the studio. */
  sendCameraInfo(): void {
    this.session?.sendCameraInfo();
  }

  private set(status: PhoneLinkStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  /** setTimeout that stop() cuts short. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private async run(): Promise<void> {
    let failed = 0;
    let wasStreaming = false;
    let reason: string | undefined;
    while (this.running) {
      this.set(wasStreaming ? { kind: "reconnecting", reason: reason ?? "" } : { kind: "connecting", ...(reason ? { reason } : {}) });
      let transport: PhoneTransport;
      try {
        transport = await this.connect(this.roomCode);
      } catch (err) {
        reason = (err as Error).message;
        failed++;
        await this.sleep(reconnectDelayMs(failed));
        continue;
      }
      if (!this.running) { transport.close(); return; }
      const session = new PhoneSession(transport.channel, this.camera, this.options);
      this.session = session;
      transport.onDown?.((why) => session.lose(why));
      session.start();
      // A link that closed before it got going counts as a failed attempt (backoff, no "reconnecting").
      const streamed = session.isOpen;
      if (streamed) {
        failed = 0;
        wasStreaming = true;
        this.set({ kind: "streaming" });
      }
      const end = await session.ended;
      this.session = null;
      transport.close();
      if (end.kind === "stopped") return;
      if (end.kind === "bye") {
        this.running = false;
        this.set({ kind: "closed", reason: end.reason });
        return;
      }
      reason = end.reason;
      if (!streamed) {
        failed++;
        await this.sleep(reconnectDelayMs(failed));
        continue;
      }
      this.options.onStudioStatus?.("");
      if (this.running) this.set({ kind: "reconnecting", reason });
      await this.sleep(RECONNECT_AFTER_DROP_MS);
    }
  }
}
