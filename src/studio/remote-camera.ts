import { context2d, createCanvas, type NormalizedRect } from "../shared/canvas";
import {
  CAMERA_PROTOCOL,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  encodeCameraMessage,
  parseCameraMessage,
  type CameraMessage,
} from "../transfer/camera-protocol";
import type { DataChannelLike } from "../transfer/data-channel";
import type { PeerLink } from "../transfer/peer-connection";
import { StillReceiver, type ReceivedStill } from "../transfer/still-receiver";
import { StatusHub, onVideoFrame, sameOrientation, type CameraSource, type CameraStatus, type CameraStill } from "./camera-source";

export type PhoneCameraInfo = Omit<Extract<CameraMessage, { type: "camera-info" }>, "type">;

/** A remote track muted for this long (screen locked, camera taken away) counts as a lost phone. */
export const TRACK_MUTE_LOST_MS = 3000;

/**
 * The studio's side of the "camera" channel, without the browser: hello and
 * protocol check, camera-info, pings both ways, status lines, camera
 * switches and still requests. Node-tested against the phone's PhoneSession.
 * docs/character-studio.md §4.
 */
export class StudioLink {
  /** Resolves once, with why the link ended. */
  readonly ended: Promise<string>;
  private resolveEnded!: (reason: string) => void;
  private done = false;
  private lastHeard = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly stills: StillReceiver;
  private helloSeen = false;
  info: PhoneCameraInfo | null = null;
  device = "";

  constructor(
    private readonly channel: DataChannelLike,
    private readonly options: {
      /** The phone said hello and described its camera (again after each switch or resume). */
      onInfo?: (info: PhoneCameraInfo) => void;
      onStillProgress?: (receivedBytes: number, totalBytes: number) => void;
      stillTimeoutMs?: number;
    } = {},
  ) {
    this.ended = new Promise((resolve) => { this.resolveEnded = resolve; });
    this.stills = new StillReceiver(channel, {
      ...(options.stillTimeoutMs ? { timeoutMs: options.stillTimeoutMs } : {}),
      ...(options.onStillProgress ? { onProgress: options.onStillProgress } : {}),
    });
  }

  get isOpen(): boolean {
    return !this.done;
  }

  /** Hello seen and the camera described: stills can be asked for. */
  get isReady(): boolean {
    return !this.done && this.helloSeen && this.info !== null;
  }

  start(): void {
    if (this.done) return;
    this.channel.addEventListener("message", this.onMessage);
    this.channel.addEventListener("close", this.onClose);
    if (this.channel.readyState !== "open") return this.end("The phone's link closed");
    this.lastHeard = Date.now();
    this.pingTimer = setInterval(() => {
      // Anything counts (still chunks included), not just pongs.
      if (Date.now() - this.lastHeard > PING_TIMEOUT_MS) return this.end("The phone stopped answering");
      this.send({ type: "ping", t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  /** The sharpest of `burst` frames at the phone camera's resolution; a new request supersedes the last. */
  requestStill(region: NormalizedRect | null, burst: number): Promise<ReceivedStill> {
    return this.stills.request(region, burst);
  }

  /** The line the phone shows under its preview ("Pose 4/16 — Punch"). */
  sendStatus(text: string): void {
    this.send({ type: "status", text: text.slice(0, 200) });
  }

  switchCamera(): void {
    this.send({ type: "switch-camera" });
  }

  /** Something outside the channel says the phone is gone (connection failed, track ended). */
  lose(reason: string): void {
    this.end(reason);
  }

  /** Clean close from the studio: the phone stops retrying. */
  close(reason: string): void {
    if (this.done) return;
    this.send({ type: "bye", reason });
    this.end(reason);
  }

  private send(msg: CameraMessage): void {
    if (this.done) return;
    try {
      this.channel.send(encodeCameraMessage(msg));
    } catch (err) {
      this.end(`The phone's link closed (${(err as Error).message})`);
    }
  }

  private end(reason: string): void {
    if (this.done) return;
    this.done = true;
    clearInterval(this.pingTimer);
    this.stills.dispose();
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
    this.resolveEnded(reason);
  }

  private readonly onClose = () => this.end("The phone's link closed");

  private readonly onMessage = (ev: { data: unknown }) => {
    if (this.done) return;
    this.lastHeard = Date.now();
    if (typeof ev.data !== "string") return; // still chunks: the StillReceiver's
    const msg = parseCameraMessage(ev.data);
    if (!msg) return;
    switch (msg.type) {
      case "hello":
        if (msg.protocol !== CAMERA_PROTOCOL) {
          console.warn(`[studio] phone speaks camera protocol ${msg.protocol}, not ${CAMERA_PROTOCOL}`);
          return this.close("This camera page is out of date: reload it");
        }
        this.helloSeen = true;
        this.device = msg.device;
        if (this.info) this.options.onInfo?.(this.info);
        break;
      case "camera-info": {
        const { type: _type, ...info } = msg;
        this.info = info;
        if (this.helloSeen) this.options.onInfo?.(info);
        break;
      }
      case "ping":
        this.send({ type: "pong", t: msg.t });
        break;
      case "bye":
        this.end(msg.reason || "The phone closed the camera page");
        break;
      default:
        // pong (lastHeard is enough); still / still-error go to the StillReceiver.
        break;
    }
  };
}

/**
 * A phone streaming its camera to the studio: the received track plays in
 * our own <video> (live tracking runs on it); stills come over the data
 * channel at the phone camera's full resolution, never through the video codec.
 */
export class RemoteCamera implements CameraSource {
  readonly kind = "phone" as const;
  readonly video: HTMLVideoElement;
  private readonly hub = new StatusHub();
  readonly link: StudioLink;
  private muteTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly peer: PeerLink, options: { onStillProgress?: (receivedBytes: number, totalBytes: number) => void } = {}) {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.link = new StudioLink(peer.channel, {
      onInfo: () => this.checkReady(),
      ...(options.onStillProgress ? { onStillProgress: options.onStillProgress } : {}),
    });
    void this.link.ended.then((reason) => this.lost(reason));
    const stream = peer.remoteStream;
    const track = stream?.getVideoTracks()[0];
    if (!stream || !track) {
      this.lost("The phone sent no video");
      return;
    }
    this.video.srcObject = stream;
    const onMeta = () => this.checkReady();
    this.video.addEventListener("loadedmetadata", onMeta);
    this.video.addEventListener("resize", onMeta);
    this.cleanups.push(() => { this.video.removeEventListener("loadedmetadata", onMeta); this.video.removeEventListener("resize", onMeta); });
    void this.video.play().catch(() => {});
    this.watchTrack(track);
    const onState = () => {
      const state = peer.pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") this.link.lose(`Connection ${state}`);
    };
    peer.pc.addEventListener("connectionstatechange", onState);
    this.cleanups.push(() => peer.pc.removeEventListener("connectionstatechange", onState));
    this.link.start();
  }

  /** Ended, or muted for more than TRACK_MUTE_LOST_MS, means the phone is gone. */
  private watchTrack(track: MediaStreamTrack): void {
    const onEnded = () => this.link.lose("The phone's video ended");
    const onMute = () => {
      clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => this.link.lose("The phone's video stopped"), TRACK_MUTE_LOST_MS);
    };
    const onUnmute = () => clearTimeout(this.muteTimer);
    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    if (track.muted) onMute();
    this.cleanups.push(() => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      clearTimeout(this.muteTimer);
    });
  }

  private checkReady(): void {
    if (this.link.isReady && this.video.videoWidth > 0) this.hub.set({ kind: "ready" });
  }

  private lost(reason: string): void {
    // Lost is final for this link too (a reconnect is a new RemoteCamera); link.lose below comes back here once.
    if (this.hub.status.kind === "stopped" || this.hub.status.kind === "lost") return;
    for (const c of this.cleanups.splice(0)) c();
    // Ends the link too (idempotent): closing the peer doesn't fire the channel's close event.
    this.link.lose(reason);
    this.peer.close();
    this.video.srcObject = null;
    this.hub.set({ kind: "lost", reason });
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  get mirrored(): boolean {
    return this.link.info?.facing === "user";
  }

  get status(): CameraStatus {
    return this.hub.status;
  }

  /** The phone's camera as it last described it. */
  get info(): PhoneCameraInfo | null {
    return this.link.info;
  }

  onFrame(cb: (nowMs: number) => void): () => void {
    return onVideoFrame(this.video, cb);
  }

  async grabStill(region: NormalizedRect | null, burst: number): Promise<CameraStill> {
    const still = await this.link.requestStill(region, burst);
    const bitmap = await createImageBitmap(still.blob);
    try {
      const { width, height } = bitmap;
      console.info(`[studio] phone still ${width}×${height} (${(still.blob.size / 1e6).toFixed(1)} MB), live video ${this.width}×${this.height}`);
      if (width !== still.width || height !== still.height) throw new Error(`The phone's picture is ${width}×${height}, not the ${still.width}×${still.height} it said`);
      if (!sameOrientation(bitmap, this)) throw new Error("The phone's picture is turned sideways compared to its video");
      const frame = createCanvas(width, height);
      context2d(frame).drawImage(bitmap, 0, 0);
      return { frame, sharpness: still.sharpness };
    } finally {
      bitmap.close();
    }
  }

  async canSwitch(): Promise<boolean> {
    return this.link.info?.canSwitch ?? false;
  }

  /** Asks the phone; the result shows up in its next camera-info. */
  async switchCamera(): Promise<void> {
    this.link.switchCamera();
  }

  sendStatus(text: string): void {
    this.link.sendStatus(text);
  }

  onStatus(cb: (s: CameraStatus) => void): () => void {
    return this.hub.on(cb);
  }

  /** Leaving (or picking another camera): bye, so the phone stops retrying. */
  stop(reason = "The studio closed"): void {
    if (this.hub.status.kind === "stopped") return;
    this.link.close(reason);
    for (const c of this.cleanups.splice(0)) c();
    this.peer.close();
    this.video.srcObject = null;
    this.hub.set({ kind: "stopped" });
  }
}
