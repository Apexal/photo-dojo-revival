import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneSession, type CameraInfo, type EncodedStill, type PhoneCamera } from "../src/phone/phone-session";
import type { NormalizedRect } from "../src/shared/canvas";
import { CAMERA_PROTOCOL, PING_INTERVAL_MS, PING_TIMEOUT_MS, encodeCameraMessage, parseCameraMessage, type CameraMessage } from "../src/transfer/camera-protocol";
import { StudioLink } from "../src/studio/remote-camera";
import { sameOrientation } from "../src/studio/camera-source";
import { FakeChannel, blobBytes, bytes } from "./helpers";

/** A portrait 1080×1920 phone camera; stills are deterministic bytes. */
class FakeCamera implements PhoneCamera {
  isRunning = true;
  facing: CameraInfo["facing"] = "environment";
  grabs: { region: NormalizedRect | null; burst: number }[] = [];
  async info(): Promise<CameraInfo> {
    return { facing: this.facing, width: 1080, height: 1920, canSwitch: true };
  }
  async grabStill(region: NormalizedRect | null, burst: number): Promise<EncodedStill> {
    const n = this.grabs.push({ region, burst });
    return { mime: "image/png", width: 1080, height: 1920, sharpness: Array.from({ length: burst }, (_, i) => i), bytes: bytes(40_000, n) };
  }
  async switchCamera(): Promise<void> {
    this.facing = this.facing === "user" ? "environment" : "user";
  }
}

function received(channel: FakeChannel): CameraMessage[] {
  const out: CameraMessage[] = [];
  channel.addEventListener("message", (ev: { data: unknown }) => {
    const msg = typeof ev.data === "string" ? parseCameraMessage(ev.data) : null;
    if (msg) out.push(msg);
  });
  return out;
}

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The studio's link and a real PhoneSession on the other end of a fake channel. */
function connect() {
  const [studioEnd, phoneEnd] = FakeChannel.pair();
  const infos: CameraInfo[] = [];
  const link = new StudioLink(studioEnd, { onInfo: (info) => infos.push(info) });
  const camera = new FakeCamera();
  const statusLines: string[] = [];
  const session = new PhoneSession(phoneEnd, camera, { device: "Test Phone", onStudioStatus: (t) => statusLines.push(t) });
  const toPhone = received(phoneEnd);
  link.start();
  session.start();
  return { studioEnd, phoneEnd, link, session, camera, infos, statusLines, toPhone };
}

describe("studio ↔ phone camera link", () => {
  it("is ready after hello + camera-info, and relays the status line", async () => {
    const { link, infos, statusLines } = connect();
    expect(link.isReady).toBe(false);
    await settle();
    expect(link.isReady).toBe(true);
    expect(link.device).toBe("Test Phone");
    expect(infos).toEqual([{ facing: "environment", width: 1080, height: 1920, canSwitch: true }]);
    link.sendStatus("Pose 4/16 — Punch");
    await settle();
    expect(statusLines).toEqual(["Pose 4/16 — Punch"]);
  });

  it("asks for a still and gets the phone camera's full-size PNG", async () => {
    vi.useRealTimers();
    const { link, camera } = connect();
    await settle();
    const region = { x: 0.25, y: 0.1, width: 0.5, height: 0.85 };
    const still = await link.requestStill(region, 5);
    expect(camera.grabs).toEqual([{ region, burst: 5 }]);
    expect(still).toMatchObject({ mime: "image/png", width: 1080, height: 1920, sharpness: [0, 1, 2, 3, 4] });
    expect(await blobBytes(still.blob)).toEqual(bytes(40_000, 1));
  });

  it("switches the phone's camera; the new camera-info follows", async () => {
    const { link, infos } = connect();
    await settle();
    link.switchCamera();
    await settle(20);
    expect(infos.at(-1)).toMatchObject({ facing: "user" });
    expect(link.info?.facing).toBe("user");
  });

  it("pings both ways while idle and stays up", async () => {
    const { link, session } = connect();
    await settle();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await settle();
    }
    expect(link.isOpen).toBe(true);
    expect(session.isOpen).toBe(true);
  });

  it("a phone that stops answering is lost after the ping timeout", async () => {
    const [studioEnd] = FakeChannel.pair();
    const link = new StudioLink(studioEnd);
    link.start();
    let reason: string | null = null;
    void link.ended.then((r) => { reason = r; });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS + PING_INTERVAL_MS);
    expect(reason).toBe("The phone stopped answering");
  });

  it("a phone on another protocol version gets bye ('reload') and the link ends", async () => {
    const [studioEnd, phoneEnd] = FakeChannel.pair();
    const toPhone = received(phoneEnd);
    const link = new StudioLink(studioEnd);
    link.start();
    phoneEnd.send(encodeCameraMessage({ type: "hello", protocol: CAMERA_PROTOCOL + 1, device: "Future Phone" }));
    await settle();
    expect(toPhone.at(-1)).toMatchObject({ type: "bye", reason: expect.stringMatching(/reload/) });
    expect(link.isOpen).toBe(false);
  });

  it("the phone's bye, or the channel closing, ends the link; the studio's bye stops the phone for good", async () => {
    const a = connect();
    await settle();
    a.session.close("The camera page closed");
    expect(await a.link.ended).toBe("The camera page closed");

    const b = connect();
    await settle();
    b.studioEnd.close();
    expect(await b.link.ended).toBe("The phone's link closed");

    const c = connect();
    await settle();
    c.link.close("The studio closed");
    await settle();
    expect(await c.session.ended).toEqual({ kind: "bye", reason: "The studio closed" });
  });

  it("stills must be the same way up as the video", () => {
    expect(sameOrientation({ width: 1080, height: 1920 }, { width: 720, height: 1280 })).toBe(true);
    expect(sameOrientation({ width: 1920, height: 1080 }, { width: 720, height: 1280 })).toBe(false);
  });
});
