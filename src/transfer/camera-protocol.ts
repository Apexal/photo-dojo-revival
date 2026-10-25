import type { NormalizedRect } from "../shared/canvas";

/**
 * The phone camera ↔ studio protocol on the "camera" data channel (ordered,
 * reliable): JSON text frames, plus binary frames carrying still chunks. Pure,
 * so both sides can be tested in Node. docs/character-studio.md §4.3.
 */

/** Bumped on any incompatible change; the studio answers another version with `bye`. */
export const CAMERA_PROTOCOL = 1;
export const CAMERA_CHANNEL_LABEL = "camera";

/** Both sides ping this often; a link with no answer for PING_TIMEOUT_MS is lost. */
export const PING_INTERVAL_MS = 2000;
export const PING_TIMEOUT_MS = 6000;
/** Studio-side wait for a requested still, from the request to its last chunk. */
export const STILL_TIMEOUT_MS = 15_000;

/** Binary still frames: request id (u32) + chunk index (u32), then payload; ≤16 KB in all. */
export const STILL_CHUNK_HEADER_BYTES = 8;
export const STILL_FRAME_BYTES = 16 * 1024;
export const STILL_CHUNK_PAYLOAD_BYTES = STILL_FRAME_BYTES - STILL_CHUNK_HEADER_BYTES;

export type CameraFacingInfo = "user" | "environment" | "unknown";
export type StillMime = "image/png" | "image/jpeg";

export type CameraMessage =
  // phone → studio
  | { type: "hello"; protocol: number; device: string }
  | { type: "camera-info"; facing: CameraFacingInfo; width: number; height: number; canSwitch: boolean }
  | { type: "still"; id: number; mime: StillMime; width: number; height: number; byteLength: number; sharpness: number[] }
  | { type: "still-error"; id: number; message: string }
  // studio → phone
  | { type: "still-request"; id: number; region: NormalizedRect | null; burst: number }
  | { type: "switch-camera" }
  | { type: "status"; text: string }
  // either
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "bye"; reason: string };

export type CameraMessageType = CameraMessage["type"];
export type StillHeader = Extract<CameraMessage, { type: "still" }>;

/** Largest still accepted (a 4K PNG is well under this). */
export const MAX_STILL_BYTES = 64 * 1024 * 1024;
const MAX_STILL_SIDE = 8192;
const MAX_BURST = 30;
const MAX_TEXT = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isUint = (v: unknown, max = 0xffffffff): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
const isSide = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_STILL_SIDE;

function isRegion(v: unknown): v is NormalizedRect {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.width) || !isNum(v.height)) return false;
  return v.width > 0 && v.height > 0 && v.x >= -1 && v.y >= -1 && v.x + v.width <= 2 && v.y + v.height <= 2;
}

/**
 * Validates one message, returning a clean copy (only the known fields), or
 * null for anything unknown or malformed.
 */
export function validateCameraMessage(v: unknown): CameraMessage | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case "hello":
      return isUint(v.protocol) && isText(v.device) ? { type: "hello", protocol: v.protocol, device: v.device } : null;
    case "camera-info":
      return (v.facing === "user" || v.facing === "environment" || v.facing === "unknown") && isSide(v.width) && isSide(v.height) && typeof v.canSwitch === "boolean"
        ? { type: "camera-info", facing: v.facing, width: v.width, height: v.height, canSwitch: v.canSwitch }
        : null;
    case "still":
      return isUint(v.id) && (v.mime === "image/png" || v.mime === "image/jpeg") && isSide(v.width) && isSide(v.height)
        && isUint(v.byteLength, MAX_STILL_BYTES) && v.byteLength > 0
        && Array.isArray(v.sharpness) && v.sharpness.length <= MAX_BURST && v.sharpness.every(isNum)
        ? { type: "still", id: v.id, mime: v.mime, width: v.width, height: v.height, byteLength: v.byteLength, sharpness: [...v.sharpness] }
        : null;
    case "still-error":
      return isUint(v.id) && isText(v.message) ? { type: "still-error", id: v.id, message: v.message } : null;
    case "still-request":
      return isUint(v.id) && (v.region === null || isRegion(v.region)) && isUint(v.burst, MAX_BURST) && v.burst >= 1
        ? { type: "still-request", id: v.id, region: v.region === null ? null : { x: v.region.x, y: v.region.y, width: v.region.width, height: v.region.height }, burst: v.burst }
        : null;
    case "switch-camera":
      return { type: "switch-camera" };
    case "status":
      return isText(v.text) ? { type: "status", text: v.text } : null;
    case "ping":
    case "pong":
      return isNum(v.t) ? { type: v.type, t: v.t } : null;
    case "bye":
      return isText(v.reason) ? { type: "bye", reason: v.reason } : null;
    default:
      return null;
  }
}

/** A text frame → message, or null (logged) if it isn't valid JSON or a known message. */
export function parseCameraMessage(text: string): CameraMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn("[camera] ignoring a frame that isn't JSON");
    return null;
  }
  const msg = validateCameraMessage(raw);
  if (!msg) console.warn("[camera] ignoring an unknown or malformed message", isObj(raw) ? raw.type : raw);
  return msg;
}

export function encodeCameraMessage(msg: CameraMessage): string {
  return JSON.stringify(msg);
}

/** Number of binary frames a still of `byteLength` bytes is sent in. */
export function stillChunkCount(byteLength: number): number {
  return Math.ceil(byteLength / STILL_CHUNK_PAYLOAD_BYTES);
}

/** The binary frames for one still, in order. */
export function* stillChunks(id: number, bytes: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
  const count = stillChunkCount(bytes.byteLength);
  for (let index = 0; index < count; index++) {
    const payload = bytes.subarray(index * STILL_CHUNK_PAYLOAD_BYTES, (index + 1) * STILL_CHUNK_PAYLOAD_BYTES);
    const frame = new Uint8Array(STILL_CHUNK_HEADER_BYTES + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, id);
    view.setUint32(4, index);
    frame.set(payload, STILL_CHUNK_HEADER_BYTES);
    yield frame;
  }
}

export function decodeStillChunk(frame: ArrayBuffer | Uint8Array): { id: number; index: number; payload: Uint8Array } | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < STILL_CHUNK_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { id: view.getUint32(0), index: view.getUint32(4), payload: bytes.subarray(STILL_CHUNK_HEADER_BYTES) };
}

export interface AssembledStill {
  header: StillHeader;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Reassembles the one still the studio is waiting for. `expect(id)` names it
 * (a new request supersedes the last); headers and chunks for any other id are
 * dropped, so late chunks of a cancelled still can't leak into the next one.
 * `acceptChunk` returns the finished still, or null while it's incomplete; a
 * header or chunk that doesn't fit the expected still throws.
 */
export class StillAssembler {
  private expected: number | null = null;
  private header: StillHeader | null = null;
  private buffer: Uint8Array<ArrayBuffer> | null = null;
  private received: Uint8Array | null = null;
  private receivedCount = 0;
  private receivedBytes = 0;

  /** Waits for still `id` from now on, dropping anything partly received. */
  expect(id: number): void {
    this.reset();
    this.expected = id;
  }

  /** Stops waiting (the request was cancelled or failed). */
  cancel(): void {
    this.reset();
    this.expected = null;
  }

  get expectedId(): number | null {
    return this.expected;
  }

  get bytesReceived(): number {
    return this.receivedBytes;
  }

  /** The expected still's size, once its header has arrived (else 0). */
  get totalBytes(): number {
    return this.header?.byteLength ?? 0;
  }

  acceptHeader(header: StillHeader): void {
    if (header.id !== this.expected) return;
    if (this.header) throw new Error(`Still ${header.id} sent twice`);
    this.header = header;
    this.buffer = new Uint8Array(header.byteLength);
    this.received = new Uint8Array(stillChunkCount(header.byteLength));
  }

  acceptChunk(frame: ArrayBuffer | Uint8Array): AssembledStill | null {
    const chunk = decodeStillChunk(frame);
    if (!chunk || chunk.id !== this.expected) return null;
    const { header, buffer, received } = this;
    if (!header || !buffer || !received) throw new Error(`Still ${chunk.id}: a chunk arrived before its header`);
    const count = received.length;
    if (chunk.index >= count) throw new Error(`Still ${chunk.id}: chunk ${chunk.index} is past the end`);
    const want = chunk.index === count - 1 ? header.byteLength - chunk.index * STILL_CHUNK_PAYLOAD_BYTES : STILL_CHUNK_PAYLOAD_BYTES;
    if (chunk.payload.byteLength !== want) throw new Error(`Still ${chunk.id}: chunk ${chunk.index} has ${chunk.payload.byteLength} bytes, expected ${want}`);
    if (received[chunk.index]) return null; // a duplicate; identical by construction on a reliable channel
    buffer.set(chunk.payload, chunk.index * STILL_CHUNK_PAYLOAD_BYTES);
    received[chunk.index] = 1;
    this.receivedCount++;
    this.receivedBytes += chunk.payload.byteLength;
    if (this.receivedCount < count) return null;
    this.cancel();
    return { header, bytes: buffer };
  }

  private reset(): void {
    this.header = null;
    this.buffer = null;
    this.received = null;
    this.receivedCount = 0;
    this.receivedBytes = 0;
  }
}
