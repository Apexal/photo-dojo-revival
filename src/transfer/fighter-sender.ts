import { chunkParts, encodeFighter, type TransferMessage } from "../shared/fighter-codec";
import type { Fighter } from "../shared/fighter-model";
import type { DataChannelLike } from "./data-channel";

/** Pause sending above this much queued data; resume at the low threshold. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const BUFFERED_LOW_THRESHOLD = 256 * 1024;
export const ACK_TIMEOUT_MS = 20_000;

export interface SendProgress { sentBytes: number; totalBytes: number }

function waitForDrain(channel: DataChannelLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("Connection closed while sending")); };
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
  });
}

function waitForAck(channel: DataChannelLike, fighterId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (ev: { data: unknown }) => {
      if (typeof ev.data !== "string") return;
      let msg: TransferMessage;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "ack" && msg.fighterId === fighterId) { cleanup(); resolve(); }
      if (msg.type === "error") { cleanup(); reject(new Error(`The game rejected the fighter: ${msg.message}`)); }
    };
    const onClose = () => { cleanup(); reject(new Error("Connection closed before the game confirmed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("The game didn't confirm the fighter")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("message", onMessage);
    channel.addEventListener("close", onClose);
  });
}

/**
 * Streams a fighter: JSON manifest, 16 KB binary chunks (honoring
 * bufferedAmountLowThreshold for backpressure), then {type:"done"}.
 * Resolves when the receiver acknowledges it saved the fighter.
 */
export async function sendFighter(
  channel: DataChannelLike,
  fighter: Fighter,
  options: { onProgress?: (p: SendProgress) => void; ackTimeoutMs?: number } = {},
): Promise<void> {
  const { manifest, parts } = await encodeFighter(fighter);
  const totalBytes = parts.reduce((s, p) => s + p.byteLength, 0);
  let sentBytes = 0;
  channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
  const ack = waitForAck(channel, fighter.fighterId, options.ackTimeoutMs ?? ACK_TIMEOUT_MS);
  ack.catch(() => {}); // observed below; avoid an unhandled rejection while still sending

  const ensureOpen = () => { if (channel.readyState !== "open") throw new Error("Connection closed while sending"); };
  ensureOpen();
  channel.send(JSON.stringify(manifest));
  for (const chunk of chunkParts(parts, manifest.chunkSize)) {
    if (channel.bufferedAmount > MAX_BUFFERED_BYTES) await waitForDrain(channel);
    ensureOpen();
    channel.send(chunk as Uint8Array<ArrayBuffer>);
    sentBytes += chunk.byteLength - 8;
    options.onProgress?.({ sentBytes, totalBytes });
  }
  channel.send(JSON.stringify({ type: "done" } satisfies TransferMessage));
  await ack;
}
