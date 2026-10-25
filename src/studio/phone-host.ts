import { generateRoomCode } from "../shared/room-code";
import { CAMERA_CHANNEL_LABEL } from "../transfer/camera-protocol";
import { acceptAsHost, fetchIceServers, type HostListener, type HostOptions, type PeerLink } from "../transfer/peer-connection";
import { SignalingClient, type RoomMessage } from "../transfer/signaling-client";

/**
 * What PhoneHost needs of signaling and WebRTC, injected so it can be tested
 * with fakes. The real ones are SignalingClient.connect and acceptAsHost.
 */
export interface PhoneHostDeps {
  connect(roomCode: string): Promise<{ client: SignalingLike; welcome: Extract<RoomMessage, { type: "welcome" }> }>;
  accept(client: SignalingLike, onLink: (link: PeerLink) => void, iceServers: RTCIceServer[], options: HostOptions): HostListener;
  iceServers(): Promise<RTCIceServer[]>;
}

/** The bits of SignalingClient PhoneHost itself uses. */
export interface SignalingLike {
  onClose(handler: (ev: { code: number; reason: string }) => void): () => void;
  close(): void;
}

const realDeps: PhoneHostDeps = {
  connect: (roomCode) => SignalingClient.connect(roomCode, "host"),
  accept: (client, onLink, iceServers, options) => acceptAsHost(client as SignalingClient, onLink, iceServers, options),
  iceServers: () => fetchIceServers(),
};

export type PhoneHostStatus =
  /** Opening (or reopening) the room. `reason`: why the last try failed. */
  | { kind: "opening"; roomCode: string; reason?: string }
  /** The room is open: scan the QR. */
  | { kind: "waiting"; roomCode: string }
  /** A phone is connected; nobody else can join until it leaves. */
  | { kind: "connected"; roomCode: string }
  | { kind: "stopped"; roomCode: string };

/** Wait before reopening the room after the n-th failure in a row: 1 s, 2 s, 4 s, … up to 10 s. */
export function reopenDelayMs(failures: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, failures - 1));
}

/**
 * The studio's room and its one phone (docs/character-studio.md §4.1). One
 * room code for the whole studio visit. While waiting it answers phones'
 * offers (the last one wins); once a phone's channel opens it stops
 * listening and closes signaling, so nobody else can join. When that phone
 * goes (`dropPhone`, or its channel closes), or the room expires while
 * waiting, the room is reopened under the same code, so the phone (which
 * keeps retrying that code) comes back without rescanning.
 */
export class PhoneHost {
  readonly roomCode: string;
  private readonly deps: PhoneHostDeps;
  private listeners = new Set<(s: PhoneHostStatus) => void>();
  private phoneListeners = new Set<(link: PeerLink) => void>();
  private client: SignalingLike | null = null;
  private listener: HostListener | null = null;
  private phone: PeerLink | null = null;
  private running = false;
  /** Bumped on every (re)open and stop, so a stale attempt can tell it's been overtaken. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  status: PhoneHostStatus;

  constructor(options: { roomCode?: string; deps?: Partial<PhoneHostDeps> } = {}) {
    this.roomCode = options.roomCode ?? generateRoomCode();
    this.deps = { ...realDeps, ...options.deps };
    this.status = { kind: "stopped", roomCode: this.roomCode };
  }

  /** Called immediately with the current status. */
  onStatus(cb: (s: PhoneHostStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => { this.listeners.delete(cb); };
  }

  /** A phone connected (its link carries the video stream). */
  onPhone(cb: (link: PeerLink) => void): () => void {
    this.phoneListeners.add(cb);
    return () => { this.phoneListeners.delete(cb); };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPhone(): boolean {
    return this.phone !== null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.open();
  }

  /**
   * The phone is gone (the studio noticed: pings, track, connection state):
   * close its link and reopen the room under the same code.
   */
  dropPhone(link: PeerLink | null = this.phone): void {
    if (!link || link !== this.phone) return;
    this.phone = null;
    link.close();
    if (this.running) void this.open();
  }

  /** Closes the room (and the phone's link: say bye on it first). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.closeRoom();
    const phone = this.phone;
    this.phone = null;
    phone?.close();
    this.set({ kind: "stopped", roomCode: this.roomCode });
  }

  private set(status: PhoneHostStatus): void {
    this.status = status;
    for (const l of [...this.listeners]) l(status);
  }

  private closeRoom(): void {
    this.listener?.stopListening();
    this.listener = null;
    const client = this.client;
    this.client = null;
    client?.close();
  }

  private async open(reason?: string): Promise<void> {
    if (!this.running || this.phone) return;
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.closeRoom();
    this.set({ kind: "opening", roomCode: this.roomCode, ...(reason ? { reason } : {}) });
    let client: SignalingLike;
    let iceServers: RTCIceServer[];
    try {
      const [connected, ice] = await Promise.all([this.deps.connect(this.roomCode), this.deps.iceServers()]);
      client = connected.client;
      iceServers = ice;
    } catch (err) {
      if (generation !== this.generation) return;
      this.retry((err as Error).message);
      return;
    }
    if (generation !== this.generation) {
      client.close();
      return;
    }
    this.failures = 0;
    this.client = client;
    // The room expired (10 min) or the socket dropped while waiting: same code again.
    client.onClose((ev) => {
      if (this.client !== client) return;
      this.client = null;
      this.listener?.stopListening();
      this.listener = null;
      if (this.running && !this.phone) this.retry(ev.reason || "The room closed");
    });
    this.listener = this.deps.accept(client, (link) => this.connected(link, generation), iceServers, { label: CAMERA_CHANNEL_LABEL });
    this.set({ kind: "waiting", roomCode: this.roomCode });
  }

  private retry(reason: string): void {
    if (!this.running) return;
    this.failures++;
    this.set({ kind: "opening", roomCode: this.roomCode, reason });
    const generation = this.generation;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (generation === this.generation) void this.open(reason); }, reopenDelayMs(this.failures));
  }

  private connected(link: PeerLink, generation: number): void {
    // A second channel from the same room (shouldn't happen once we stop listening), or one after stop().
    if (!this.running || generation !== this.generation || this.phone) {
      link.close();
      return;
    }
    this.phone = link;
    // Nobody else joins while this phone is here.
    this.closeRoom();
    link.channel.addEventListener("close", () => this.dropPhone(link));
    this.set({ kind: "connected", roomCode: this.roomCode });
    for (const l of [...this.phoneListeners]) l(link);
  }
}
