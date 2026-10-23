import { describe, expect, it } from "vitest";
import { CHUNK_SIZE } from "../src/shared/fighter-codec";
import type { Fighter } from "../src/shared/fighter-model";
import type { DataChannelLike } from "../src/transfer/data-channel";
import { receiveFighters } from "../src/transfer/fighter-receiver";
import { BUFFERED_LOW_THRESHOLD, MAX_BUFFERED_BYTES, sendFighter } from "../src/transfer/fighter-sender";
import { fighterSnapshot, makeFighter } from "./helpers";

type Listener = (ev: any) => void;

/**
 * In-memory data channel pair. Sent messages queue in `bufferedAmount` and are
 * delivered when the test calls `flush` (or automatically, with `autoFlush`).
 */
class FakeChannel implements DataChannelLike {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer!: FakeChannel;
  queue: unknown[] = [];
  maxBufferedSeen = 0;
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly autoFlush: boolean) {}

  static pair(autoFlush = true): [FakeChannel, FakeChannel] {
    const a = new FakeChannel(autoFlush);
    const b = new FakeChannel(autoFlush);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") throw new Error("closed");
    const copy = typeof data === "string" ? data : ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data.slice(0);
    this.queue.push(copy);
    this.bufferedAmount += typeof copy === "string" ? copy.length : (copy as ArrayBuffer).byteLength;
    this.maxBufferedSeen = Math.max(this.maxBufferedSeen, this.bufferedAmount);
    if (this.autoFlush) queueMicrotask(() => this.flush());
  }

  /** Deliver queued messages to the peer. */
  flush(max = Infinity): void {
    let n = 0;
    while (this.queue.length && n++ < max) {
      const data = this.queue.shift();
      const size = typeof data === "string" ? data.length : (data as ArrayBuffer).byteLength;
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      this.peer.emit("message", { data });
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.emit("bufferedamountlow");
    }
  }

  close(): void {
    this.readyState = "closed";
    this.peer.readyState = "closed";
    this.emit("close");
    this.peer.emit("close");
  }

  emit(type: string, ev?: { data: unknown }): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(ev);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
}

describe("fighter transfer over a data channel", () => {
  it("sends, reassembles, saves and acknowledges", async () => {
    const [phone, laptop] = FakeChannel.pair();
    const saved: Fighter[] = [];
    const received: Fighter[] = [];
    receiveFighters(laptop, { save: async (f) => { saved.push(f); }, onFighter: (f) => received.push(f) });
    const fighter = makeFighter({ poseBytes: { idle: 3 * CHUNK_SIZE + 5 } });
    const progress: number[] = [];
    await sendFighter(phone, fighter, { onProgress: (p) => progress.push(p.sentBytes / p.totalBytes) });
    expect(saved).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(await fighterSnapshot(saved[0])).toEqual(await fighterSnapshot(fighter));
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("handles several fighters in a row on one channel", async () => {
    const [phone, laptop] = FakeChannel.pair();
    const names: string[] = [];
    receiveFighters(laptop, { save: async () => {}, onFighter: (f) => names.push(f.name) });
    await sendFighter(phone, makeFighter({ name: "One" }));
    await sendFighter(phone, makeFighter({ name: "Two" }));
    expect(names).toEqual(["One", "Two"]);
  });

  it("honors backpressure: pauses above the buffer cap until bufferedamountlow", async () => {
    const [phone, laptop] = FakeChannel.pair(false);
    receiveFighters(laptop, { save: async () => {} });
    // 3 MB of pose data: well over the 1 MB cap.
    const big = Math.ceil((3 * 1024 * 1024) / 8);
    const fighter = makeFighter({ poseBytes: { idle: big, walk: big, block: big, punch: big, kick: big, jump: big, hurt: big, win: big } });
    let done = false;
    const sending = sendFighter(phone, fighter).then(() => { done = true; });
    // Drain slowly, like a real network.
    for (let i = 0; i < 2000 && !done; i++) {
      await new Promise((r) => setTimeout(r, 0));
      phone.flush(4);
      laptop.flush();
    }
    await sending;
    expect(phone.bufferedAmountLowThreshold).toBe(BUFFERED_LOW_THRESHOLD);
    expect(phone.maxBufferedSeen).toBeLessThanOrEqual(MAX_BUFFERED_BYTES + CHUNK_SIZE + 8);
    expect(phone.maxBufferedSeen).toBeGreaterThan(MAX_BUFFERED_BYTES);
  });

  it("the receiver rejects a corrupt transfer and the sender sees the error", async () => {
    const [phone, laptop] = FakeChannel.pair();
    const errors: Error[] = [];
    const ok: string[] = [];
    receiveFighters(laptop, { save: async () => {}, onError: (e) => errors.push(e), onFighter: (f) => ok.push(f.name) });
    const fighter = makeFighter();
    // Corrupt: drop the first binary chunk on the wire.
    const realSend = phone.send.bind(phone);
    let dropped = false;
    phone.send = (data) => {
      if (!dropped && typeof data !== "string") { dropped = true; return; }
      realSend(data);
    };
    await expect(sendFighter(phone, fighter)).rejects.toThrow(/rejected the fighter: Missing parts: pose:idle/);
    expect(errors).toHaveLength(1);
    // The channel recovers for the next fighter.
    phone.send = realSend;
    await sendFighter(phone, makeFighter({ name: "Retry" }));
    expect(ok).toEqual(["Retry"]);
  });

  it("fails if the channel closes mid-transfer", async () => {
    const [phone, laptop] = FakeChannel.pair(false);
    receiveFighters(laptop, { save: async () => {} });
    const big = 400 * 1024;
    const sending = sendFighter(phone, makeFighter({ poseBytes: { idle: big, walk: big, block: big, punch: big } }));
    await new Promise((r) => setTimeout(r, 0));
    phone.close();
    await expect(sending).rejects.toThrow(/closed/);
  });

  it("accepts Blob payloads (Firefox's default binaryType)", async () => {
    const [phone, laptop] = FakeChannel.pair();
    const realEmit = laptop.emit.bind(laptop);
    laptop.emit = (type, ev) => realEmit(type, ev && ev.data instanceof ArrayBuffer ? { data: new Blob([ev.data]) } : ev);
    const got: string[] = [];
    receiveFighters(laptop, { save: async () => {}, onFighter: (f) => got.push(f.name) });
    await sendFighter(phone, makeFighter({ name: "Blobby" }));
    expect(got).toEqual(["Blobby"]);
  });
});
