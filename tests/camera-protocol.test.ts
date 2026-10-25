import { describe, expect, it, vi } from "vitest";
import { denormalizeRect, normalizeRect } from "../src/shared/canvas";
import {
  STILL_CHUNK_HEADER_BYTES,
  STILL_CHUNK_PAYLOAD_BYTES,
  STILL_FRAME_BYTES,
  StillAssembler,
  decodeStillChunk,
  parseCameraMessage,
  stillChunkCount,
  stillChunks,
  validateCameraMessage,
  type StillHeader,
} from "../src/transfer/camera-protocol";
import { bytes } from "./helpers";

const header = (id: number, byteLength: number): StillHeader => ({ type: "still", id, mime: "image/png", width: 1080, height: 1920, byteLength, sharpness: [1, 2, 3, 4] });

describe("camera protocol messages", () => {
  it("accepts every well-formed message and keeps only the known fields", () => {
    const good = [
      { type: "hello", protocol: 1, device: "iPhone" },
      { type: "camera-info", facing: "environment", width: 1920, height: 1080, canSwitch: true },
      { type: "camera-info", facing: "unknown", width: 640, height: 480, canSwitch: false },
      header(3, 1234),
      { type: "still-error", id: 3, message: "Camera not running" },
      { type: "still-request", id: 3, region: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 }, burst: 4 },
      { type: "still-request", id: 4, region: null, burst: 1 },
      { type: "switch-camera" },
      { type: "status", text: "Pose 4/16 — Punch" },
      { type: "ping", t: 123.5 },
      { type: "pong", t: 123.5 },
      { type: "bye", reason: "The studio closed" },
    ];
    for (const msg of good) expect(validateCameraMessage(msg)).toEqual(msg);
    expect(validateCameraMessage({ type: "ping", t: 1, extra: "x" })).toEqual({ type: "ping", t: 1 });
    expect(parseCameraMessage(JSON.stringify(good[0]))).toEqual(good[0]);
  });

  it("rejects unknown and malformed messages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad: unknown[] = [
      null, 3, "hello", [], {},
      { type: "nope" },
      { type: "hello", protocol: "1", device: "x" },
      { type: "hello", protocol: 1 },
      { type: "camera-info", facing: "sideways", width: 10, height: 10, canSwitch: true },
      { type: "camera-info", facing: "user", width: 0, height: 10, canSwitch: true },
      { type: "camera-info", facing: "user", width: 10, height: 10 },
      { ...header(1, 10), mime: "image/gif" },
      { ...header(1, 0) },
      { ...header(-1, 10) },
      { ...header(1.5, 10) },
      { ...header(1, 10), sharpness: ["a"] },
      { ...header(1, 10), width: 1e6 },
      { type: "still-request", id: 1, region: { x: 0, y: 0, width: 0, height: 1 }, burst: 4 },
      { type: "still-request", id: 1, region: { x: 0, y: 0, width: 1 }, burst: 4 },
      { type: "still-request", id: 1, region: null, burst: 0 },
      { type: "still-request", id: 1, burst: 4 },
      { type: "status", text: 5 },
      { type: "ping", t: Number.NaN },
      { type: "bye" },
    ];
    for (const msg of bad) expect(validateCameraMessage(msg), JSON.stringify(msg)).toBeNull();
    expect(parseCameraMessage("{not json")).toBeNull();
    expect(parseCameraMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("still framing", () => {
  it("splits into frames of at most 16 KB, each tagged with request id and chunk index", () => {
    const data = bytes(2 * STILL_CHUNK_PAYLOAD_BYTES + 100, 7);
    const frames = [...stillChunks(0xdeadbeef, data)];
    expect(frames).toHaveLength(3);
    expect(stillChunkCount(data.byteLength)).toBe(3);
    expect(Math.max(...frames.map((f) => f.byteLength))).toBe(STILL_FRAME_BYTES);
    expect(frames[2].byteLength).toBe(STILL_CHUNK_HEADER_BYTES + 100);
    frames.forEach((f, i) => {
      const chunk = decodeStillChunk(f.buffer)!;
      expect(chunk.id).toBe(0xdeadbeef);
      expect(chunk.index).toBe(i);
    });
    expect(decodeStillChunk(new Uint8Array(4))).toBeNull();
  });

  it("reassembles a still", () => {
    const data = bytes(3 * STILL_CHUNK_PAYLOAD_BYTES + 5, 2);
    const asm = new StillAssembler();
    asm.expect(1);
    asm.acceptHeader(header(1, data.byteLength));
    const frames = [...stillChunks(1, data)];
    for (const f of frames.slice(0, -1)) expect(asm.acceptChunk(f)).toBeNull();
    expect(asm.bytesReceived).toBe(3 * STILL_CHUNK_PAYLOAD_BYTES);
    const done = asm.acceptChunk(frames.at(-1)!);
    expect(done?.header.id).toBe(1);
    expect(done?.bytes).toEqual(data);
    expect(asm.expectedId).toBeNull();
  });

  it("drops headers and chunks of other ids, interleaved with the expected one", () => {
    const want = bytes(2 * STILL_CHUNK_PAYLOAD_BYTES + 1, 3);
    const other = bytes(2 * STILL_CHUNK_PAYLOAD_BYTES + 1, 4);
    const asm = new StillAssembler();
    asm.expect(2);
    asm.acceptHeader(header(1, other.byteLength));
    asm.acceptHeader(header(2, want.byteLength));
    const a = [...stillChunks(1, other)];
    const b = [...stillChunks(2, want)];
    let done = null;
    for (let i = 0; i < b.length; i++) {
      expect(asm.acceptChunk(a[i])).toBeNull();
      done = asm.acceptChunk(b[i]);
    }
    expect(done?.bytes).toEqual(want);
  });

  it("a cancelled still's late chunks can't leak into the next request", () => {
    const old = bytes(3 * STILL_CHUNK_PAYLOAD_BYTES, 5);
    const next = bytes(STILL_CHUNK_PAYLOAD_BYTES + 9, 6);
    const asm = new StillAssembler();
    asm.expect(1);
    asm.acceptHeader(header(1, old.byteLength));
    const oldFrames = [...stillChunks(1, old)];
    asm.acceptChunk(oldFrames[0]);
    // A new request supersedes it; the rest of still 1 arrives late, before and after still 2's header.
    asm.expect(2);
    expect(asm.bytesReceived).toBe(0);
    expect(asm.acceptChunk(oldFrames[1])).toBeNull();
    asm.acceptHeader(header(1, old.byteLength));
    asm.acceptHeader(header(2, next.byteLength));
    expect(asm.acceptChunk(oldFrames[2])).toBeNull();
    const nextFrames = [...stillChunks(2, next)];
    expect(asm.acceptChunk(nextFrames[0])).toBeNull();
    expect(asm.acceptChunk(nextFrames[1])?.bytes).toEqual(next);
    // After cancel(), nothing is expected.
    asm.expect(3);
    asm.cancel();
    asm.acceptHeader(header(3, 10));
    expect(asm.acceptChunk([...stillChunks(3, bytes(10))][0])).toBeNull();
  });

  it("throws on chunks that don't fit the expected still", () => {
    const data = bytes(STILL_CHUNK_PAYLOAD_BYTES + 10, 8);
    const frames = [...stillChunks(1, data)];
    const asm = new StillAssembler();
    asm.expect(1);
    expect(() => asm.acceptChunk(frames[0])).toThrow(/before its header/);
    asm.acceptHeader(header(1, data.byteLength));
    expect(() => asm.acceptHeader(header(1, data.byteLength))).toThrow(/twice/);
    expect(() => asm.acceptChunk([...stillChunks(1, bytes(3 * STILL_CHUNK_PAYLOAD_BYTES))][2])).toThrow(/past the end/);
    expect(() => asm.acceptChunk([...stillChunks(1, bytes(STILL_CHUNK_PAYLOAD_BYTES + 11))][1])).toThrow(/expected 10/);
    // Duplicates are ignored; out-of-order chunks still assemble.
    expect(asm.acceptChunk(frames[1])).toBeNull();
    expect(asm.acceptChunk(frames[1])).toBeNull();
    expect(asm.acceptChunk(frames[0])?.bytes).toEqual(data);
  });
});

describe("normalized regions", () => {
  it("round-trips at any resolution and clamps to the frame", () => {
    const n = normalizeRect({ x: 96, y: 54, width: 480, height: 540 }, 960, 540);
    expect(n).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 1 });
    expect(denormalizeRect(n, 1920, 1080)).toEqual({ x: 192, y: 108, width: 960, height: 972 });
    expect(denormalizeRect({ x: -0.2, y: 0.9, width: 1.5, height: 0.5 }, 100, 100)).toEqual({ x: 0, y: 90, width: 100, height: 10 });
    expect(denormalizeRect({ x: 1.2, y: 1.2, width: 0.1, height: 0.1 }, 100, 100)).toEqual({ x: 99, y: 99, width: 1, height: 1 });
  });
});
