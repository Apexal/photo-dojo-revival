import type { NormalizedRect } from "../shared/canvas";
import { STILL_TIMEOUT_MS, StillAssembler, encodeCameraMessage, parseCameraMessage, type StillMime } from "./camera-protocol";
import type { DataChannelLike } from "./data-channel";

export interface ReceivedStill {
  id: number;
  mime: StillMime;
  /** As the phone reports it; the studio checks it against the decoded image and the live video. */
  width: number;
  height: number;
  sharpness: number[];
  blob: Blob;
}

/** Why a still request ended without a still: a newer request, a timeout, the phone, or the link. */
export class StillRequestError extends Error {
  constructor(message: string, readonly reason: "superseded" | "timeout" | "phone" | "closed" | "invalid" | "disposed") {
    super(message);
    this.name = "StillRequestError";
  }
}

/**
 * The last request id used on each channel. Ids are per channel, not per
 * receiver, so a receiver rebuilt on the same channel can't take a late chunk
 * of its predecessor's still for its own.
 */
const lastIds = new WeakMap<DataChannelLike, number>();

/** The next request id on `channel` (1, 2, …; u32, as the chunk header holds it). */
function nextRequestId(channel: DataChannelLike): number {
  const id = ((lastIds.get(channel) ?? 0) % 0xffffffff) + 1;
  lastIds.set(channel, id);
  return id;
}

interface Pending {
  id: number;
  resolve: (still: ReceivedStill) => void;
  reject: (err: StillRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Studio side: asks the phone for stills and reassembles them. One request at
 * a time: a new one rejects the last ("superseded") and the phone cancels it.
 * Other camera messages are left to whoever else listens on the channel.
 */
export class StillReceiver {
  private readonly assembler = new StillAssembler();
  private pending: Pending | null = null;
  private queue = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly channel: DataChannelLike,
    private readonly options: { timeoutMs?: number; onProgress?: (receivedBytes: number, totalBytes: number) => void } = {},
  ) {
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("close", this.onClose);
  }

  /**
   * The sharpest of `burst` frames at the phone camera's full resolution,
   * judged in `region` (the person, normalized to the live frame).
   */
  request(region: NormalizedRect | null, burst: number): Promise<ReceivedStill> {
    if (this.disposed) return Promise.reject(new StillRequestError("Still receiver disposed", "disposed"));
    if (this.channel.readyState !== "open") return Promise.reject(new StillRequestError("The phone isn't connected", "closed"));
    this.finish(new StillRequestError("A newer still was requested", "superseded"));
    const id = nextRequestId(this.channel);
    this.assembler.expect(id);
    return new Promise<ReceivedStill>((resolve, reject) => {
      const timer = setTimeout(
        () => this.finish(new StillRequestError("The phone didn't send the picture in time", "timeout")),
        this.options.timeoutMs ?? STILL_TIMEOUT_MS,
      );
      this.pending = { id, resolve, reject, timer };
      try {
        this.channel.send(encodeCameraMessage({ type: "still-request", id, region, burst }));
      } catch (err) {
        // e.g. the channel is closing, or its send queue is full.
        this.finish(new StillRequestError(`Couldn't ask the phone for a picture: ${(err as Error).message}`, "closed"));
      }
    });
  }

  /** Detaches from the channel, rejecting a pending request. */
  dispose(): void {
    if (this.disposed) return;
    this.finish(new StillRequestError("Still receiver disposed", "disposed"));
    this.disposed = true;
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
  }

  /** Ends the pending request with a still or an error. */
  private finish(result: ReceivedStill | StillRequestError): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    this.assembler.cancel();
    if (result instanceof StillRequestError) p.reject(result);
    else p.resolve(result);
  }

  private readonly onClose = () => this.finish(new StillRequestError("The phone disconnected", "closed"));

  // Messages are processed strictly in order (Blob payloads decode asynchronously).
  private readonly onMessage = (ev: { data: unknown }) => {
    this.queue = this.queue.then(() => this.handle(ev.data)).catch((err) => {
      console.warn("[camera] bad still data", err);
      this.finish(new StillRequestError(`The picture didn't arrive intact: ${(err as Error).message}`, "invalid"));
    });
  };

  private async handle(data: unknown): Promise<void> {
    if (this.disposed) return;
    if (typeof data === "string") {
      // Cheap filter: most text frames (pings, camera info) aren't ours.
      if (!data.includes('"still')) return;
      const msg = parseCameraMessage(data);
      if (msg?.type === "still-error" && msg.id === this.pending?.id) {
        this.finish(new StillRequestError(msg.message, "phone"));
      } else if (msg?.type === "still") {
        this.assembler.acceptHeader(msg);
      }
      return;
    }
    const payload = data instanceof Blob ? await data.arrayBuffer() : data;
    if (!(payload instanceof ArrayBuffer) && !(payload instanceof Uint8Array)) return;
    const before = this.assembler.bytesReceived;
    const done = this.assembler.acceptChunk(payload);
    const p = this.pending;
    if (!done) {
      // Progress only when a chunk of the still we're waiting for was taken.
      if (p && this.assembler.expectedId === p.id && this.assembler.bytesReceived > before) {
        this.options.onProgress?.(this.assembler.bytesReceived, this.assembler.totalBytes);
      }
      return;
    }
    if (!p || done.header.id !== p.id) return;
    const { id, mime, width, height, sharpness } = done.header;
    this.options.onProgress?.(done.header.byteLength, done.header.byteLength);
    this.finish({ id, mime, width, height, sharpness, blob: new Blob([done.bytes], { type: mime }) });
  }
}
