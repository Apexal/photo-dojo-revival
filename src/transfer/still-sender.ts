import { encodeCameraMessage, stillChunks, type StillHeader } from "./camera-protocol";
import type { DataChannelLike } from "./data-channel";

/** Pause sending above this much queued data; resume at the low threshold. */
export const STILL_MAX_BUFFERED_BYTES = 1024 * 1024;
export const STILL_BUFFERED_LOW_THRESHOLD = 256 * 1024;

export type StillToSend = Omit<StillHeader, "type" | "byteLength"> & { bytes: Uint8Array | Blob };

/** Waits for the channel's queue to drain; false if aborted first. Rejects if the channel closes. */
function waitForDrain(channel: DataChannelLike, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onLow = () => { cleanup(); resolve(true); };
    const onAbort = () => { cleanup(); resolve(false); };
    const onClose = () => { cleanup(); reject(new Error("Connection closed while sending")); };
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Phone side: sends a still as its `still` header and binary chunks, honoring
 * bufferedAmountLowThreshold for backpressure. Aborting `signal` (the studio
 * asked for a newer still) stops mid-way; the studio drops what it already got
 * by request id. Resolves "sent" or "cancelled"; rejects if the channel closes.
 */
export async function sendStill(
  channel: DataChannelLike,
  still: StillToSend,
  options: { signal?: AbortSignal } = {},
): Promise<"sent" | "cancelled"> {
  const { signal } = options;
  const bytes = still.bytes instanceof Blob ? new Uint8Array(await still.bytes.arrayBuffer()) : still.bytes;
  if (signal?.aborted) return "cancelled";
  channel.bufferedAmountLowThreshold = STILL_BUFFERED_LOW_THRESHOLD;
  const ensureOpen = () => { if (channel.readyState !== "open") throw new Error("Connection closed while sending"); };
  ensureOpen();
  const { id, mime, width, height, sharpness } = still;
  channel.send(encodeCameraMessage({ type: "still", id, mime, width, height, byteLength: bytes.byteLength, sharpness }));
  for (const frame of stillChunks(still.id, bytes)) {
    if (channel.bufferedAmount > STILL_MAX_BUFFERED_BYTES && !(await waitForDrain(channel, signal))) return "cancelled";
    if (signal?.aborted) return "cancelled";
    ensureOpen();
    channel.send(frame);
  }
  return "sent";
}
