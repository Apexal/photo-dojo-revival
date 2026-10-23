import { FighterAssembler, type TransferMessage } from "../shared/fighter-codec";
import type { Fighter } from "../shared/fighter-model";
import { saveFighter } from "../shared/fighter-storage";
import type { DataChannelLike } from "./data-channel";

export interface ReceiverCallbacks {
  /** Defaults to IndexedDB. */
  save?: (fighter: Fighter) => Promise<void>;
  onStart?: (name: string) => void;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  onFighter?: (fighter: Fighter) => void;
  onError?: (error: Error) => void;
}

/**
 * Reassembles chunks from a data channel, validates, saves to IndexedDB and
 * acknowledges. Handles several fighters in a row on the same channel.
 * Returns a function that detaches it.
 */
export function receiveFighters(channel: DataChannelLike, callbacks: ReceiverCallbacks = {}): () => void {
  const save = callbacks.save ?? saveFighter;
  let assembler = new FighterAssembler();
  let queue = Promise.resolve();
  // After a failed transfer, drop the rest of it until the next manifest.
  let discarding = false;

  const reply = (msg: TransferMessage) => { if (channel.readyState === "open") channel.send(JSON.stringify(msg)); };
  const fail = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    reply({ type: "error", message: error.message });
    callbacks.onError?.(error);
    assembler = new FighterAssembler();
    discarding = true;
  };

  const handle = async (data: unknown) => {
    const payload = data instanceof Blob ? await data.arrayBuffer() : data;
    if (typeof payload !== "string" && !(payload instanceof ArrayBuffer) && !(payload instanceof Uint8Array)) return;
    if (discarding) {
      if (typeof payload !== "string" || !payload.includes('"manifest"')) return;
      discarding = false;
    }
    const msg = assembler.accept(payload);
    if (msg?.type === "manifest") callbacks.onStart?.(msg.name);
    if (msg === null) callbacks.onProgress?.(assembler.bytesReceived, assembler.totalBytes);
    if (msg?.type === "done") {
      const fighter = assembler.build();
      assembler = new FighterAssembler();
      await save(fighter);
      reply({ type: "ack", fighterId: fighter.fighterId });
      callbacks.onFighter?.(fighter);
    }
  };

  // Messages are processed strictly in order (Blob payloads decode asynchronously).
  const onMessage = (ev: { data: unknown }) => {
    queue = queue.then(() => handle(ev.data)).catch(fail);
  };
  channel.addEventListener("message", onMessage);
  return () => channel.removeEventListener("message", onMessage);
}
