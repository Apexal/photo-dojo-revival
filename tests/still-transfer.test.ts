import { afterEach, describe, expect, it, vi } from "vitest";
import { STILL_CHUNK_PAYLOAD_BYTES, encodeCameraMessage, parseCameraMessage, type CameraMessage } from "../src/transfer/camera-protocol";
import { StillReceiver, StillRequestError } from "../src/transfer/still-receiver";
import { STILL_BUFFERED_LOW_THRESHOLD, STILL_MAX_BUFFERED_BYTES, sendStill } from "../src/transfer/still-sender";
import { FakeChannel, blobBytes, bytes } from "./helpers";

type Request = Extract<CameraMessage, { type: "still-request" }>;

/** The phone side, answering each still request with `respond` (default: a still of `size` bytes). */
function phoneAnswering(phone: FakeChannel, respond?: (req: Request) => void, size = 3 * STILL_CHUNK_PAYLOAD_BYTES + 17): Request[] {
  const requests: Request[] = [];
  phone.addEventListener("message", (ev: { data: unknown }) => {
    if (typeof ev.data !== "string") return;
    const msg = parseCameraMessage(ev.data);
    if (msg?.type !== "still-request") return;
    requests.push(msg);
    if (respond) respond(msg);
    else void sendStill(phone, { id: msg.id, mime: "image/png", width: 1080, height: 1920, sharpness: [3, 9, 4, 1], bytes: bytes(size, msg.id) });
  });
  return requests;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.useRealTimers(); });

describe("stills over the camera channel", () => {
  it("requests a still and gets the PNG at the phone's size", async () => {
    const [phone, studio] = FakeChannel.pair();
    const size = 3 * STILL_CHUNK_PAYLOAD_BYTES + 17;
    const requests = phoneAnswering(phone, undefined, size);
    const progress: number[] = [];
    const receiver = new StillReceiver(studio, { onProgress: (got, total) => progress.push(got / total) });
    const region = { x: 0.25, y: 0.1, width: 0.5, height: 0.85 };
    const still = await receiver.request(region, 4);
    expect(requests).toEqual([{ type: "still-request", id: 1, region, burst: 4 }]);
    expect(still).toMatchObject({ id: 1, mime: "image/png", width: 1080, height: 1920, sharpness: [3, 9, 4, 1] });
    expect(still.blob.type).toBe("image/png");
    expect(await blobBytes(still.blob)).toEqual(bytes(size, 1));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(new Set(progress).size).toBe(progress.length);
    expect(progress.at(-1)).toBe(1);
    // Several in a row on one channel.
    expect((await receiver.request(null, 1)).id).toBe(2);
  });

  it("a new request supersedes the pending one; its late chunks are dropped", async () => {
    const [phone, studio] = FakeChannel.pair(false);
    const controllers = new Map<number, AbortController>();
    const sends: Promise<string>[] = [];
    phoneAnswering(phone, (req) => {
      // Like the phone: a new request cancels the still being sent.
      for (const c of controllers.values()) c.abort();
      const c = new AbortController();
      controllers.set(req.id, c);
      sends.push(sendStill(phone, { id: req.id, mime: "image/png", width: 720, height: 1280, sharpness: [1], bytes: bytes(80 * STILL_CHUNK_PAYLOAD_BYTES, req.id) }, { signal: c.signal }));
    });
    const receiver = new StillReceiver(studio);
    const first = receiver.request(null, 4);
    const firstResult = first.catch((e) => e);
    studio.flush();
    await tick();
    // Part of still 1 is on the wire (more than the buffer cap is queued, so the sender waits) when still 2 is asked for.
    phone.flush(10);
    const second = receiver.request(null, 4);
    expect(await firstResult).toBeInstanceOf(StillRequestError);
    expect((await firstResult).reason).toBe("superseded");
    let done = false;
    void second.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 500 && !done; i++) {
      studio.flush();
      phone.flush(8);
      await tick();
    }
    const still = await second;
    expect(still.id).toBe(2);
    // Buffer.equals: toEqual walks a megabyte element by element, which took seconds on CI.
    expect(Buffer.from(await blobBytes(still.blob)).equals(Buffer.from(bytes(80 * STILL_CHUNK_PAYLOAD_BYTES, 2)))).toBe(true);
    expect(await Promise.all(sends)).toEqual(["cancelled", "sent"]);
  });

  it("honors backpressure while sending a big still", async () => {
    const [phone, studio] = FakeChannel.pair(false);
    const size = 3 * 1024 * 1024;
    phoneAnswering(phone, undefined, size);
    const receiver = new StillReceiver(studio);
    let done = false;
    const got = receiver.request(null, 4).then((s) => { done = true; return s; });
    for (let i = 0; i < 5000 && !done; i++) {
      await tick();
      studio.flush();
      phone.flush(4);
    }
    expect((await got).blob.size).toBe(size);
    expect(phone.bufferedAmountLowThreshold).toBe(STILL_BUFFERED_LOW_THRESHOLD);
    expect(phone.maxBufferedSeen).toBeGreaterThan(STILL_MAX_BUFFERED_BYTES);
    expect(phone.maxBufferedSeen).toBeLessThanOrEqual(STILL_MAX_BUFFERED_BYTES + 16 * 1024 + 1024);
  });

  it("fails with the phone's still-error", async () => {
    const [phone, studio] = FakeChannel.pair();
    phoneAnswering(phone, (req) => phone.send(encodeCameraMessage({ type: "still-error", id: req.id, message: "Camera not running" })));
    const receiver = new StillReceiver(studio);
    await expect(receiver.request(null, 4)).rejects.toMatchObject({ reason: "phone", message: "Camera not running" });
  });

  it("times out when the phone doesn't answer", async () => {
    vi.useFakeTimers();
    const [phone, studio] = FakeChannel.pair();
    phoneAnswering(phone, () => {});
    const receiver = new StillReceiver(studio, { timeoutMs: 15_000 });
    const result = receiver.request(null, 4).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await result).reason).toBe("timeout");
  });

  it("fails when the channel closes mid-still, and on the sender's side too", async () => {
    const [phone, studio] = FakeChannel.pair(false);
    let sending: Promise<string> | undefined;
    phoneAnswering(phone, (req) => {
      sending = sendStill(phone, { id: req.id, mime: "image/png", width: 720, height: 1280, sharpness: [1], bytes: bytes(2 * 1024 * 1024) });
    });
    const receiver = new StillReceiver(studio);
    const result = receiver.request(null, 4).catch((e) => e);
    studio.flush();
    await tick();
    phone.flush(5);
    phone.close();
    expect((await result).reason).toBe("closed");
    await expect(sending).rejects.toThrow(/closed/);
    await expect(receiver.request(null, 4)).rejects.toMatchObject({ reason: "closed" });
  });

  it("fails a corrupt still (chunk before header) instead of hanging", async () => {
    const [phone, studio] = FakeChannel.pair();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realSend = phone.send.bind(phone);
    phone.send = (data) => { if (typeof data === "string" && data.includes('"type":"still"')) return; realSend(data); };
    phoneAnswering(phone);
    const receiver = new StillReceiver(studio);
    await expect(receiver.request(null, 4)).rejects.toMatchObject({ reason: "invalid" });
    warn.mockRestore();
  });

  it("accepts Blob payloads (Firefox's default binaryType)", async () => {
    const [phone, studio] = FakeChannel.pair();
    const realEmit = studio.emit.bind(studio);
    studio.emit = (type, ev) => realEmit(type, ev && ev.data instanceof ArrayBuffer ? { data: new Blob([ev.data]) } : ev);
    phoneAnswering(phone, undefined, 2 * STILL_CHUNK_PAYLOAD_BYTES + 3);
    const still = await new StillReceiver(studio).request(null, 4);
    expect(await blobBytes(still.blob)).toEqual(bytes(2 * STILL_CHUNK_PAYLOAD_BYTES + 3, 1));
  });

  it("fails as closed, at once, when the request can't be sent", async () => {
    vi.useFakeTimers();
    const [phone, studio] = FakeChannel.pair();
    const requests = phoneAnswering(phone);
    studio.send = () => { throw new Error("send queue is full"); };
    const receiver = new StillReceiver(studio);
    await expect(receiver.request(null, 4)).rejects.toMatchObject({ reason: "closed", message: expect.stringContaining("send queue is full") });
    expect(vi.getTimerCount()).toBe(0);
    expect(requests).toEqual([]);
  });

  it("a receiver rebuilt on the same channel doesn't reuse request ids", async () => {
    const [phone, studio] = FakeChannel.pair();
    const requests = phoneAnswering(phone, () => {});
    const first = new StillReceiver(studio);
    const old = first.request(null, 4).catch((e) => e);
    first.dispose();
    expect((await old).reason).toBe("disposed");
    const second = new StillReceiver(studio);
    const got = second.request(null, 4);
    await tick();
    expect(requests.map((r) => r.id)).toEqual([1, 2]);
    // The old request's late still isn't taken for the new one.
    const still = { mime: "image/png" as const, width: 720, height: 1280, sharpness: [1] };
    await sendStill(phone, { ...still, id: 1, bytes: bytes(STILL_CHUNK_PAYLOAD_BYTES + 5, 1) });
    await sendStill(phone, { ...still, id: 2, bytes: bytes(STILL_CHUNK_PAYLOAD_BYTES + 9, 2) });
    const result = await got;
    expect(result.id).toBe(2);
    expect(await blobBytes(result.blob)).toEqual(bytes(STILL_CHUNK_PAYLOAD_BYTES + 9, 2));
  });

  it("sends a Blob still", async () => {
    const [phone, studio] = FakeChannel.pair();
    const size = 2 * STILL_CHUNK_PAYLOAD_BYTES + 11;
    phoneAnswering(phone, (req) => void sendStill(phone, { id: req.id, mime: "image/png", width: 1080, height: 1920, sharpness: [2], bytes: new Blob([bytes(size, req.id)]) }));
    const still = await new StillReceiver(studio).request(null, 4);
    expect(await blobBytes(still.blob)).toEqual(bytes(size, 1));
  });

  it("an already aborted send sends nothing, not even the header", async () => {
    const [phone] = FakeChannel.pair(false);
    const controller = new AbortController();
    controller.abort();
    const still = { id: 1, mime: "image/png" as const, width: 720, height: 1280, sharpness: [1] };
    expect(await sendStill(phone, { ...still, bytes: bytes(1000) }, { signal: controller.signal })).toBe("cancelled");
    expect(await sendStill(phone, { ...still, bytes: new Blob([bytes(1000)]) }, { signal: controller.signal })).toBe("cancelled");
    expect(phone.queue).toEqual([]);
  });

  it("dispose rejects a pending request and detaches", async () => {
    const [phone, studio] = FakeChannel.pair();
    phoneAnswering(phone, () => {});
    const receiver = new StillReceiver(studio);
    const result = receiver.request(null, 4).catch((e) => e);
    receiver.dispose();
    expect((await result).reason).toBe("disposed");
    await expect(receiver.request(null, 4)).rejects.toMatchObject({ reason: "disposed" });
  });
});
