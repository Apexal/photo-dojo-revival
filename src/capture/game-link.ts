import type { PeerLink } from "../transfer/peer-connection";

export type LinkStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "failed"; reason: string }
  | { kind: "closed" };

/** Opens a data channel to the laptop for a room code (signaling + WebRTC). */
export type Connector = (roomCode: string) => Promise<PeerLink>;

/**
 * The phone's connection to the game, opened as soon as the camera starts so a
 * dead room or unreachable laptop shows up before the user strikes eight poses.
 * The same link is reused for sending (and for capturing another fighter).
 */
export class GameLink {
  private link: PeerLink | null = null;
  private pending: Promise<PeerLink> | null = null;
  private listeners = new Set<(s: LinkStatus) => void>();
  status: LinkStatus = { kind: "idle" };

  constructor(public roomCode: string | null, private readonly connector: Connector) {}

  onStatus(listener: (s: LinkStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private set(status: LinkStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  get isOpen(): boolean {
    return this.link?.channel.readyState === "open";
  }

  /** Use a different room (e.g. the laptop restarted and shows a new code). Drops the current link. */
  setRoom(roomCode: string | null): void {
    if (roomCode === this.roomCode) return;
    this.close();
    this.roomCode = roomCode;
  }

  /** The open link, connecting first if needed. Concurrent callers share one attempt. */
  ensure(): Promise<PeerLink> {
    if (this.link && this.isOpen) return Promise.resolve(this.link);
    if (this.pending) return this.pending;
    const room = this.roomCode;
    if (!room) return Promise.reject(new Error("No game code"));
    this.set({ kind: "connecting" });
    this.pending = this.connector(room).then(
      (link) => {
        this.pending = null;
        if (room !== this.roomCode) {
          link.close();
          return this.ensure();
        }
        this.link = link;
        link.channel.addEventListener("close", () => {
          if (this.link !== link) return;
          this.link = null;
          this.set({ kind: "closed" });
        });
        this.set({ kind: "connected" });
        return link;
      },
      (err: Error) => {
        this.pending = null;
        this.set({ kind: "failed", reason: err.message });
        throw err;
      },
    );
    return this.pending;
  }

  /** Fire-and-forget connect (status shows the result). */
  warmUp(): void {
    if (this.roomCode) this.ensure().catch(() => {});
  }

  close(): void {
    const link = this.link;
    this.link = null;
    link?.close();
    if (this.status.kind !== "idle") this.set({ kind: "idle" });
  }
}
