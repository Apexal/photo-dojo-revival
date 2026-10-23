import type { Fighter } from "../shared/fighter-model";
import { generateRoomCode } from "../shared/room-code";
import { acceptAsHost, fetchIceServers, type HostListener } from "../transfer/peer-connection";
import { receiveFighters } from "../transfer/fighter-receiver";
import { SignalingClient } from "../transfer/signaling-client";

export type HostStatus = (
  | { kind: "connecting"; roomCode: string }
  | { kind: "waiting"; roomCode: string }
  | { kind: "receiving"; roomCode: string; name: string; progress: number }
  | { kind: "received"; roomCode: string; name: string }
  | { kind: "error"; roomCode: string | null; message: string }
) & {
  /** Phones with an open link right now. */
  phones?: number;
  /** When the current room code stops working (local clock, ms), while a room is open. */
  expiresAt?: number;
};

/** The Worker's room lifetime, for Workers that don't say. */
const DEFAULT_ROOM_TTL_MS = 10 * 60 * 1000;

type StatusListener = (status: HostStatus) => void;
type FighterListener = (fighter: Fighter) => void;

/**
 * The laptop side of "Add a fighter": holds a signaling room open for the
 * whole session (so phones can send fighters mid-match), answers phones,
 * receives fighters into IndexedDB. When the room expires (10 min) or the
 * socket drops, it reopens with a fresh code.
 */
export class HostSession {
  private statusListeners = new Set<StatusListener>();
  private fighterListeners = new Set<FighterListener>();
  private lastStatus: HostStatus | null = null;
  private client: SignalingClient | null = null;
  private listener: HostListener | null = null;
  /** Open links survive room refreshes; each has its own receiver. */
  private phones = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  private expiresAt: number | undefined;

  private onStatus(status: HostStatus): void {
    status = { ...status, phones: this.phones, expiresAt: this.client ? this.expiresAt : undefined };
    this.lastStatus = status;
    for (const l of this.statusListeners) l(status);
  }

  private onFighter(fighter: Fighter): void {
    for (const l of this.fighterListeners) l(fighter);
  }

  get status(): HostStatus | null {
    return this.lastStatus;
  }

  /** Listen for status changes (called immediately with the current one) and received fighters. */
  subscribe(onStatus: StatusListener, onFighter?: FighterListener): () => void {
    this.statusListeners.add(onStatus);
    if (onFighter) this.fighterListeners.add(onFighter);
    if (this.lastStatus) onStatus(this.lastStatus);
    return () => {
      this.statusListeners.delete(onStatus);
      if (onFighter) this.fighterListeners.delete(onFighter);
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    const roomCode = generateRoomCode();
    this.onStatus({ kind: "connecting", roomCode });
    try {
      const connectedAt = Date.now();
      const [{ client, welcome }, iceServers] = await Promise.all([SignalingClient.connect(roomCode, "host"), fetchIceServers()]);
      if (this.stopped) return client.close();
      this.expiresAt = connectedAt + (welcome.expiresInMs ?? DEFAULT_ROOM_TTL_MS);
      this.client = client;
      this.failures = 0;
      this.onStatus({ kind: "waiting", roomCode });
      client.onClose(() => this.scheduleRestart());
      this.listener = acceptAsHost(client, (link) => {
        let name = "fighter";
        this.phones++;
        link.channel.addEventListener("close", () => {
          this.phones = Math.max(0, this.phones - 1);
          if (this.lastStatus) this.onStatus(this.lastStatus);
        });
        if (this.lastStatus) this.onStatus(this.lastStatus);
        receiveFighters(link.channel, {
          onStart: (n) => { name = n; this.onStatus({ kind: "receiving", roomCode, name, progress: 0 }); },
          onProgress: (got, total) => this.onStatus({ kind: "receiving", roomCode, name, progress: total ? got / total : 0 }),
          onFighter: (fighter) => {
            this.onStatus({ kind: "received", roomCode, name: fighter.name });
            this.onFighter(fighter);
          },
          onError: (err) => this.onStatus({ kind: "error", roomCode, message: `Transfer failed: ${err.message}` }),
        });
      }, iceServers);
    } catch (err) {
      this.onStatus({ kind: "error", roomCode: null, message: `Phone transfer unavailable: ${(err as Error).message}. Use Import file instead.` });
      this.failures++;
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.teardown();
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  /** Stop using this room; phones that are already connected stay connected. */
  private teardown(): void {
    this.listener?.stopListening();
    this.listener = null;
    this.client?.close();
    this.client = null;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.listener?.closeAll();
    this.teardown();
  }
}
