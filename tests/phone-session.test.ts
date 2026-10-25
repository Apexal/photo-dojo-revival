import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PhoneConnection,
  PhoneSession,
  RECONNECT_AFTER_DROP_MS,
  reconnectDelayMs,
  type CameraInfo,
  type EncodedStill,
  type PhoneCamera,
  type PhoneLinkStatus,
  type PhoneTransport,
} from "../src/phone/phone-session";
import type { NormalizedRect } from "../src/shared/canvas";
import { CAMERA_PROTOCOL, PING_INTERVAL_MS, STILL_CHUNK_PAYLOAD_BYTES, decodeStillChunk, encodeCameraMessage, parseCameraMessage, stillChunkCount, type CameraMessage } from "../src/transfer/camera-protocol";
import { StillReceiver, StillRequestError } from "../src/transfer/still-receiver";
import { FakeChannel, blobBytes, bytes } from "./helpers";

/** A phone camera with a portrait 1080×1920 sensor; stills are deterministic bytes. */
class FakeCamera implements PhoneCamera {
  isRunning = true;
  facing: CameraInfo["facing"] = "environment";
  grabs: { region: NormalizedRect | null; burst: number }[] = [];
  switches = 0;
  /** Switches running right now, and the most at once. */
  switching = 0;
  maxSwitching = 0;
  /** When set, switches wait for the test to resolve them. */
  holdSwitches = false;
  heldSwitches: (() => void)[] = [];
  /** When set, grabs wait for the test to resolve them (in order). */
  holdGrabs = false;
  held: (() => void)[] = [];
  failWith: Error | null = null;
  stillBytes = 3 * STILL_CHUNK_PAYLOAD_BYTES + 5;

  async info(): Promise<CameraInfo> {
    return { facing: this.facing, width: 1080, height: 1920, canSwitch: true };
  }

  async grabStill(region: NormalizedRect | null, burst: number): Promise<EncodedStill> {
    const n = this.grabs.push({ region, burst });
    if (this.holdGrabs) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.failWith) throw this.failWith;
    return { mime: "image/png", width: 1080, height: 1920, sharpness: Array.from({ length: burst }, (_, i) => i + 1), bytes: bytes(this.stillBytes, n) };
  }

  async switchCamera(): Promise<void> {
    this.switches++;
    this.maxSwitching = Math.max(this.maxSwitching, ++this.switching);
    if (this.holdSwitches) await new Promise<void>((resolve) => this.heldSwitches.push(resolve));
    this.facing = this.facing === "user" ? "environment" : "user";
    this.switching--;
  }
}

/** Text messages that reached `channel`, parsed. */
function received(channel: FakeChannel): CameraMessage[] {
  const out: CameraMessage[] = [];
  channel.addEventListener("message", (ev: { data: unknown }) => {
    if (typeof ev.data !== "string") return;
    const msg = parseCameraMessage(ev.data);
    if (msg) out.push(msg);
  });
  return out;
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

beforeEach(() => {
  // Microtasks stay real: the fake channel delivers in one.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function open(options: { onStudioStatus?: (text: string) => void } = {}) {
  const [phone, studio] = FakeChannel.pair();
  const camera = new FakeCamera();
  const fromPhone = received(studio);
  const session = new PhoneSession(phone, camera, { device: "Test Phone", ...options });
  session.start();
  return { phone, studio, camera, fromPhone, session };
}

describe("phone session", () => {
  it("says hello, then describes the camera", async () => {
    const { fromPhone } = open();
    await settle();
    expect(fromPhone).toEqual([
      { type: "hello", protocol: CAMERA_PROTOCOL, device: "Test Phone" },
      { type: "camera-info", facing: "environment", width: 1080, height: 1920, canSwitch: true },
    ]);
  });

  it("answers the studio's still requests with the PNG at the camera's size", async () => {
    vi.useRealTimers();
    const { studio, camera } = open();
    const receiver = new StillReceiver(studio);
    const region = { x: 0.3, y: 0.05, width: 0.4, height: 0.9 };
    const still = await receiver.request(region, 4);
    expect(camera.grabs).toEqual([{ region, burst: 4 }]);
    expect(still).toMatchObject({ id: 1, mime: "image/png", width: 1080, height: 1920, sharpness: [1, 2, 3, 4] });
    expect(await blobBytes(still.blob)).toEqual(bytes(camera.stillBytes, 1));
    const next = await receiver.request(null, 1);
    expect(next.id).toBe(2);
    expect(await blobBytes(next.blob)).toEqual(bytes(camera.stillBytes, 2));
  });

  it("a new request cancels the one still being grabbed: only the newest still is sent", async () => {
    vi.useRealTimers();
    const { studio, camera } = open();
    camera.holdGrabs = true;
    const receiver = new StillReceiver(studio);
    const first = receiver.request(null, 4).catch((e: StillRequestError) => e);
    await settle(10);
    const second = receiver.request(null, 4);
    await settle(10);
    expect(camera.grabs).toHaveLength(2);
    camera.held.forEach((release) => release());
    const still = await second;
    expect(still.id).toBe(2);
    expect(await blobBytes(still.blob)).toEqual(bytes(camera.stillBytes, 2));
    expect(((await first) as StillRequestError).reason).toBe("superseded");
  });

  it("a new request stops a still mid-send", async () => {
    vi.useRealTimers();
    const [phone, studio] = FakeChannel.pair(false);
    const camera = new FakeCamera();
    camera.stillBytes = 120 * STILL_CHUNK_PAYLOAD_BYTES; // over the send buffer cap, so the sender waits
    const session = new PhoneSession(phone, camera, { device: "Test Phone" });
    session.start();
    const chunksOf = new Map<number, number>();
    studio.addEventListener("message", (ev: { data: unknown }) => {
      const chunk = typeof ev.data === "string" ? null : decodeStillChunk(ev.data as ArrayBuffer);
      if (chunk) chunksOf.set(chunk.id, (chunksOf.get(chunk.id) ?? 0) + 1);
    });
    const receiver = new StillReceiver(studio);
    const first = receiver.request(null, 2).catch((e: StillRequestError) => e);
    studio.flush();
    await settle(20);
    phone.flush(10);
    const second = receiver.request(null, 2);
    for (let i = 0; i < 400; i++) {
      studio.flush();
      phone.flush(16);
      await settle(3);
    }
    const still = await second;
    expect(still.id).toBe(2);
    expect(((await first) as StillRequestError).reason).toBe("superseded");
    // Still 1 was cut off part-way; still 2 arrived whole.
    expect(chunksOf.get(1)).toBeLessThan(stillChunkCount(camera.stillBytes));
    expect(chunksOf.get(2)).toBe(stillChunkCount(camera.stillBytes));
  });

  it("reports a camera that isn't running or fails as still-error", async () => {
    vi.useRealTimers();
    const { studio, camera } = open();
    const receiver = new StillReceiver(studio);
    camera.isRunning = false;
    const err = await receiver.request(null, 4).catch((e: StillRequestError) => e);
    expect(err).toBeInstanceOf(StillRequestError);
    expect((err as StillRequestError).reason).toBe("phone");
    expect(camera.grabs).toHaveLength(0);
    camera.isRunning = true;
    camera.failWith = new Error("grab broke");
    const err2 = (await receiver.request(null, 4).catch((e: StillRequestError) => e)) as StillRequestError;
    expect([err2.reason, err2.message]).toEqual(["phone", "grab broke"]);
  });

  it("switches cameras on request and describes the new one", async () => {
    const { studio, camera, fromPhone } = open();
    await settle();
    studio.send(encodeCameraMessage({ type: "switch-camera" }));
    await settle(10);
    expect(camera.switches).toBe(1);
    expect(fromPhone.at(-1)).toEqual({ type: "camera-info", facing: "user", width: 1080, height: 1920, canSwitch: true });
  });

  it("runs one camera switch at a time: a switch-camera during one is dropped", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { studio, camera, fromPhone } = open();
    camera.holdSwitches = true;
    await settle();
    studio.send(encodeCameraMessage({ type: "switch-camera" }));
    studio.send(encodeCameraMessage({ type: "switch-camera" }));
    await settle(10);
    expect([camera.switches, camera.switching]).toEqual([1, 1]);
    camera.heldSwitches.forEach((release) => release());
    await settle(10);
    expect([camera.switches, camera.maxSwitching]).toEqual([1, 1]);
    expect(fromPhone.at(-1)).toMatchObject({ type: "camera-info", facing: "user" });
    // Once it's done, the next one goes through.
    camera.holdSwitches = false;
    studio.send(encodeCameraMessage({ type: "switch-camera" }));
    await settle(10);
    expect([camera.switches, camera.maxSwitching]).toEqual([2, 1]);
    expect(fromPhone.at(-1)).toMatchObject({ type: "camera-info", facing: "environment" });
  });

  it("shows the studio's status line and ignores junk", async () => {
    const texts: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { studio, session } = open({ onStudioStatus: (t) => texts.push(t) });
    studio.send("not json");
    studio.send(JSON.stringify({ type: "launch-missiles" }));
    studio.send(JSON.stringify({ type: "status", text: 42 }));
    studio.send(encodeCameraMessage({ type: "status", text: "Pose 4/16 — Punch" }));
    await settle();
    expect(texts).toEqual(["Pose 4/16 — Punch"]);
    expect(session.isOpen).toBe(true);
  });

  it("answers pings, pings every 2 s, and is lost when the studio goes quiet for 6 s", async () => {
    const { studio, session, fromPhone } = open();
    studio.send(encodeCameraMessage({ type: "ping", t: 1234 }));
    await settle();
    expect(fromPhone).toContainEqual({ type: "pong", t: 1234 });
    // The studio keeps talking: still up after a long while.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      studio.send(encodeCameraMessage({ type: "pong", t: Date.now() }));
      await settle();
    }
    expect(fromPhone.filter((m) => m.type === "ping")).toHaveLength(5);
    expect(session.isOpen).toBe(true);
    // Then silence.
    vi.advanceTimersByTime(4 * PING_INTERVAL_MS);
    expect(await session.ended).toEqual({ kind: "lost", reason: "The studio stopped answering" });
  });

  it("ends on the studio's bye, and stops pinging", async () => {
    const { studio, session, fromPhone } = open();
    studio.send(encodeCameraMessage({ type: "bye", reason: "The studio closed" }));
    expect(await session.ended).toEqual({ kind: "bye", reason: "The studio closed" });
    const before = fromPhone.length;
    vi.advanceTimersByTime(10 * PING_INTERVAL_MS);
    await settle();
    expect(fromPhone.length).toBe(before);
  });

  it("is lost when the channel closes; close() says bye", async () => {
    const a = open();
    a.phone.close();
    expect((await a.session.ended).kind).toBe("lost");
    const b = open();
    b.session.close("The camera page closed");
    await settle();
    expect(b.fromPhone.at(-1)).toEqual({ type: "bye", reason: "The camera page closed" });
    expect(await b.session.ended).toEqual({ kind: "stopped" });
  });
});

/** A studio that the connector can reach once `present`; each connect gets a fresh channel pair. */
function fakeStudio() {
  const studio = {
    present: false,
    codes: [] as string[],
    channels: [] as FakeChannel[],
    downs: [] as ((reason: string) => void)[],
    connect: async (code: string): Promise<PhoneTransport> => {
      studio.codes.push(code);
      if (!studio.present) throw new Error("No connection to the studio after 20 seconds");
      const [phone, side] = FakeChannel.pair();
      studio.channels.push(side);
      return { channel: phone, close: () => { if (phone.readyState === "open") phone.close(); }, onDown: (cb) => { studio.downs.push(cb); } };
    },
  };
  return studio;
}

describe("phone connection: retries on the same code", () => {
  it("backs off 1, 2, 4 s, then every 5 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("waits for the studio, streams, and reconnects after a drop without a new code", async () => {
    const studio = fakeStudio();
    const statuses: PhoneLinkStatus[] = [];
    const conn = new PhoneConnection("ABC234", new FakeCamera(), studio.connect, { device: "Test Phone" });
    conn.onStatus((s) => statuses.push(s));
    conn.start();
    await settle();
    expect(studio.codes).toEqual(["ABC234"]);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(studio.codes).toHaveLength(3);
    expect(conn.status).toMatchObject({ kind: "connecting", reason: "No connection to the studio after 20 seconds" });
    studio.present = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(conn.status).toEqual({ kind: "streaming" });
    expect(studio.channels).toHaveLength(1);

    // The link drops (e.g. Wi-Fi blip): reconnecting, then streaming again on the same code.
    studio.downs[0]("Connection failed");
    await settle();
    expect(conn.status).toEqual({ kind: "reconnecting", reason: "Connection failed" });
    await vi.advanceTimersByTimeAsync(RECONNECT_AFTER_DROP_MS);
    expect(conn.status).toEqual({ kind: "streaming" });
    expect(studio.channels).toHaveLength(2);
    expect(new Set(studio.codes)).toEqual(new Set(["ABC234"]));
    expect(statuses.map((s) => s.kind)).toContain("reconnecting");
    conn.stop();
  });

  it("a link that closes before it gets going is a failed attempt: backoff, no reconnecting", async () => {
    const studio = fakeStudio();
    studio.present = true;
    const connect = async (code: string): Promise<PhoneTransport> => {
      const transport = await studio.connect(code);
      transport.close(); // the channel closes before the session starts
      return transport;
    };
    const statuses: PhoneLinkStatus[] = [];
    const conn = new PhoneConnection("ABC234", new FakeCamera(), connect, { device: "Test Phone" });
    conn.onStatus((s) => statuses.push(s));
    conn.start();
    await settle(10);
    expect(studio.codes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(studio.codes).toHaveLength(4);
    expect(statuses.map((s) => s.kind)).not.toContain("reconnecting");
    expect(statuses.map((s) => s.kind)).not.toContain("streaming");
    expect(conn.status).toMatchObject({ kind: "connecting", reason: "The link to the studio closed" });
    conn.stop();
  });

  it("stops for good on the studio's bye", async () => {
    const studio = fakeStudio();
    studio.present = true;
    const conn = new PhoneConnection("ABC234", new FakeCamera(), studio.connect, { device: "Test Phone" });
    conn.start();
    await settle(10);
    expect(conn.status.kind).toBe("streaming");
    studio.channels[0].send(encodeCameraMessage({ type: "bye", reason: "Reload the camera page" }));
    await settle(10);
    expect(conn.status).toEqual({ kind: "closed", reason: "Reload the camera page" });
    expect(conn.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(studio.codes).toHaveLength(1);
  });

  it("stop() says bye to the studio and stops retrying", async () => {
    const studio = fakeStudio();
    studio.present = true;
    const conn = new PhoneConnection("ABC234", new FakeCamera(), studio.connect, { device: "Test Phone" });
    conn.start();
    await settle(10);
    const fromPhone = received(studio.channels[0]);
    conn.stop("The camera page closed");
    await settle();
    expect(fromPhone).toContainEqual({ type: "bye", reason: "The camera page closed" });
    expect(conn.status).toEqual({ kind: "stopped" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(studio.codes).toHaveLength(1);
  });
});
