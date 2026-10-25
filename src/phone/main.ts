import { CameraSession } from "../capture/camera-session";
import { isPhone } from "../game/device-gate";
import { canvasToPng, type NormalizedRect } from "../shared/canvas";
import { normalizeRoomCode } from "../shared/room-code";
import { CAMERA_CHANNEL_LABEL } from "../transfer/camera-protocol";
import { connectAsGuest, fetchIceServers } from "../transfer/peer-connection";
import { SignalingClient } from "../transfer/signaling-client";
import { PhoneConnection, type CameraInfo, type EncodedStill, type PhoneCamera, type PhoneTransport } from "./phone-session";
import { PhoneView } from "./ui";

/**
 * The phone camera page (/capture): streams the camera to the Character
 * Studio on a computer and answers its still requests. No models, no fighter
 * data. docs/character-studio.md §4.
 */

/** Video bitrate cap: plenty for 1080p detail on Wi-Fi. */
const MAX_VIDEO_BITRATE = 6_000_000;

/**
 * CameraSession as the session's PhoneCamera: stills are the sharpest frame of
 * a burst, as PNG. Every camera change (start, switch, revive) goes through
 * `run`, one at a time: CameraSession can't open two streams at once.
 */
class LocalPhoneCamera implements PhoneCamera {
  private ops: Promise<unknown> = Promise.resolve();

  /** `onFailed`: a switch failed and the old camera couldn't be reopened either. */
  constructor(readonly session: CameraSession, private readonly onFailed: (err: unknown) => void) {}

  /** Runs `op` after the camera changes queued before it (never nest: it would wait on itself). */
  run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.ops.then(op);
    this.ops = result.catch(() => {});
    return result;
  }

  get isRunning(): boolean {
    return this.session.track?.readyState === "live";
  }

  async info(): Promise<CameraInfo> {
    const facing = this.session.track?.getSettings().facingMode;
    return {
      facing: facing === "user" || facing === "environment" ? facing : "unknown",
      width: this.session.width,
      height: this.session.height,
      canSwitch: await this.session.canSwitch(),
    };
  }

  async grabStill(region: NormalizedRect | null, burst: number): Promise<EncodedStill> {
    const { frame, sharpness } = await this.session.grabSharpest(burst, region);
    const bytes = await canvasToPng(frame);
    console.info(`[phone] still ${frame.width}×${frame.height}, ${(bytes.size / 1e6).toFixed(1)} MB`);
    return { mime: "image/png", width: frame.width, height: frame.height, sharpness, bytes };
  }

  switchCamera(): Promise<void> {
    return this.run(async () => {
      try {
        await this.session.switchCamera();
      } catch (err) {
        // switchCamera stopped the old camera before trying the new one: bring the old one back.
        console.warn("[phone] couldn't switch cameras", err);
        try {
          await this.session.restart();
        } catch (restartErr) {
          this.onFailed(restartErr);
          throw restartErr;
        }
      }
    });
  }
}

/**
 * Allow a high bitrate and keep detail over frame rate. Browsers may reject or
 * ignore either, so each is set on its own: one refused field doesn't undo the other.
 */
async function tuneSender(sender: RTCRtpSender): Promise<void> {
  try {
    const params = sender.getParameters();
    for (const encoding of params.encodings ?? []) encoding.maxBitrate = MAX_VIDEO_BITRATE;
    await sender.setParameters(params);
  } catch (err) {
    console.info("[phone] video bitrate not applied", err);
  }
  try {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    params.degradationPreference = "maintain-resolution";
    await sender.setParameters(params);
  } catch (err) {
    console.info("[phone] degradation preference not applied", err);
  }
}

class PhoneApp {
  private readonly view: PhoneView;
  private readonly cameraSession = new CameraSession();
  private readonly camera = new LocalPhoneCamera(this.cameraSession, (err) => this.view.cameraError(cameraErrorText(err), () => void this.reviveCamera()));
  private connection: PhoneConnection | null = null;
  /** The current link's video sender, for replaceTrack when the camera changes. */
  private sender: RTCRtpSender | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private reviving: Promise<void> | null = null;

  constructor(root: HTMLElement) {
    this.view = new PhoneView(root, isPhone() ? null : `${import.meta.env.BASE_URL}studio`);
    this.cameraSession.onStreamChange((track) => {
      track.contentHint = "detail";
      track.addEventListener("ended", () => { if (document.visibilityState === "visible") void this.reviveCamera(); });
      this.sender?.replaceTrack(track).catch((err) => console.warn("[phone] replaceTrack failed", err));
      this.view.setMirrored(this.cameraSession.isFrontFacing);
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void this.onResume(); });
    addEventListener("pagehide", () => this.connection?.stop());
    // Back from the back/forward cache with the link stopped: the URL has ?room=, so a reload reconnects to the same studio.
    addEventListener("pageshow", (ev) => { if (ev.persisted && this.connection) location.reload(); });
    const code = normalizeRoomCode(new URLSearchParams(location.search).get("room"));
    if (code) void this.begin(code);
    else this.view.codeEntry((input) => this.enterCode(input));
  }

  get roomCode(): string | null {
    return this.connection?.roomCode ?? null;
  }

  private enterCode(input: string): void {
    const code = normalizeRoomCode(input);
    if (!code) return this.view.codeEntry((again) => this.enterCode(again), "That isn't a studio code: 6 letters and digits, as the studio shows it.");
    // So a reload reconnects to the same studio.
    history.replaceState(null, "", `${location.pathname}?room=${code}`);
    void this.begin(code);
  }

  /** Opens the camera, then connects (the video track goes in the first offer). */
  private async begin(code: string): Promise<void> {
    this.view.starting();
    try {
      await this.camera.run(() => this.cameraSession.start("environment"));
    } catch (err) {
      return this.view.cameraError(cameraErrorText(err), () => void this.begin(code));
    }
    void this.holdWakeLock();
    this.view.live(this.cameraSession.video);
    this.view.setMirrored(this.cameraSession.isFrontFacing);
    const connection = new PhoneConnection(code, this.camera, (room) => this.connectToStudio(room), {
      device: navigator.userAgent.slice(0, 200),
      onStudioStatus: (text) => this.view.setStudioStatus(text),
    });
    this.connection = connection;
    connection.onStatus((status) => {
      this.view.setLink(status, code);
      if (status.kind === "closed") this.finish(status.reason);
    });
    connection.start();
  }

  /** Signaling + WebRTC for one attempt, with the camera's current track. */
  private async connectToStudio(code: string): Promise<PhoneTransport> {
    const track = this.cameraSession.track;
    if (!track || track.readyState !== "live") throw new Error("The camera isn't running");
    const [{ client, welcome }, iceServers] = await Promise.all([SignalingClient.connect(code, "guest"), fetchIceServers()]);
    let link;
    try {
      link = await connectAsGuest(client, welcome.peerPresent, iceServers, { label: CAMERA_CHANNEL_LABEL, stream: new MediaStream([track]) });
    } catch (err) {
      client.close();
      throw err;
    }
    const { pc, channel, sender } = link;
    this.sender = sender ?? null;
    if (sender) {
      // The camera may have changed while we were connecting.
      const current = this.cameraSession.track;
      if (current && current !== sender.track) await sender.replaceTrack(current).catch(() => {});
      void tuneSender(sender);
    }
    return {
      channel,
      close: () => {
        if (this.sender === sender) this.sender = null;
        link.close();
      },
      onDown: (callback) => {
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected") callback(`Connection ${pc.connectionState}`);
        });
      },
    };
  }

  /** Back from a locked screen or another app: the camera may have been stopped meanwhile. */
  private async onResume(): Promise<void> {
    if (!this.connection?.isRunning) return;
    void this.holdWakeLock();
    await this.reviveCamera();
  }

  /** Restarts the camera if its track ended (replaceTrack happens in onStreamChange), then tells the studio. */
  private reviveCamera(): Promise<void> {
    this.reviving ??= (async () => {
      try {
        // Checked inside the queue: a switch in progress has the camera down for a moment, and brings its own up.
        await this.camera.run(async () => { if (!this.camera.isRunning) await this.cameraSession.restart(); });
        // restart() reuses the same <video>; put the live screen back if an error screen replaced it.
        if (!this.cameraSession.video.isConnected && this.roomCode) this.showLive();
        this.connection?.sendCameraInfo();
      } catch (err) {
        this.view.cameraError(cameraErrorText(err), () => void this.reviveCamera());
      } finally {
        this.reviving = null;
      }
    })();
    return this.reviving;
  }

  private showLive(): void {
    const connection = this.connection;
    if (!connection) return;
    this.view.live(this.cameraSession.video);
    this.view.setMirrored(this.cameraSession.isFrontFacing);
    this.view.setLink(connection.status, connection.roomCode);
  }

  private async holdWakeLock(): Promise<void> {
    if (this.wakeLock && !this.wakeLock.released) return;
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      // Released by the browser when the page is hidden; re-requested on resume.
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      console.info("[phone] no wake lock", err);
    }
  }

  /** The studio said bye: no more retrying. */
  private finish(reason: string): void {
    this.cameraSession.stop();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.view.closed(reason, () => location.reload());
  }
}

function cameraErrorText(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === "NotAllowedError") return "Camera access was denied.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "This device has no camera we can use.";
  if (name === "NotReadableError") return "The camera is busy (another app may be using it).";
  return (err as Error)?.message ?? String(err);
}

const root = document.getElementById("app");
// Exposed for debugging from the console (and the e2e smoke test).
if (root) (window as unknown as { photoDojoCamera: PhoneApp }).photoDojoCamera = new PhoneApp(root);
