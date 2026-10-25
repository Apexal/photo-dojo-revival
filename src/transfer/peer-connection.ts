import { signalingHttpBase, type SignalingClient } from "./signaling-client";

export const CHANNEL_OPEN_TIMEOUT_MS = 20_000;

/** Same-Wi-Fi works with STUN alone. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * Short-lived TURN credentials from the Worker, when it is configured for them
 * (phone on cellular). Falls back to STUN only.
 */
export async function fetchIceServers(httpBase = signalingHttpBase(), timeoutMs = 3000): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(`${httpBase}/turn-credentials`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return DEFAULT_ICE_SERVERS;
    const { iceServers } = (await res.json()) as { iceServers: RTCIceServer[] };
    return [...DEFAULT_ICE_SERVERS, ...iceServers];
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

/** Relay local ICE candidates through signaling and apply the peer's. */
function wireIce(pc: RTCPeerConnection, signaling: SignalingClient): () => void {
  pc.onicecandidate = (ev) => signaling.send({ type: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
  return signaling.onMessage((msg) => {
    if (msg.type === "ice" && msg.candidate) {
      pc.addIceCandidate(msg.candidate).catch((err) => console.warn("[webrtc] bad ICE candidate", err));
    }
  });
}

export interface PeerLink {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  /** Guest with a `stream`: the sender of its video track (for `replaceTrack`, `setParameters`). */
  sender?: RTCRtpSender;
  /** Host: the media the guest sent with its offer, if any (e.g. the phone camera's video). */
  remoteStream?: MediaStream;
  close(): void;
}

export interface GuestOptions {
  /** Data channel label; the host only accepts channels with its own label. */
  label: string;
  /** Its video track is sent to the host, added before the offer (so the host needs no transceiver of its own). */
  stream?: MediaStream;
  timeoutMs?: number;
}

/**
 * Phone side: wait for the studio to be in the room, open an ordered, reliable
 * data channel (plus the stream's video track, if given), and offer. Rejects
 * if the channel isn't open within 20 s.
 */
export function connectAsGuest(
  signaling: SignalingClient,
  peerPresent: boolean,
  iceServers: RTCIceServer[],
  options: GuestOptions,
): Promise<PeerLink> {
  const { label, stream, timeoutMs = CHANNEL_OPEN_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers });
    const track = stream?.getVideoTracks()[0];
    const sender = track && stream ? pc.addTrack(track, stream) : undefined;
    const channel = pc.createDataChannel(label, { ordered: true });
    channel.binaryType = "arraybuffer";
    const offIce = wireIce(pc, signaling);
    let offered = false;
    const cleanup = () => { offIce(); offSignal(); clearTimeout(timer); };
    const fail = (reason: string) => { cleanup(); pc.close(); reject(new Error(reason)); };
    const timer = setTimeout(() => fail("No connection to the studio after 20 seconds"), timeoutMs);

    const offer = async () => {
      if (offered) return;
      offered = true;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        signaling.send({ type: "offer", sdp: pc.localDescription!.sdp });
      } catch (err) {
        fail(`Couldn't create an offer: ${(err as Error).message}`);
      }
    };
    const offSignal = signaling.onMessage((msg) => {
      if (msg.type === "peer-joined") void offer();
      if (msg.type === "answer") pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch((err) => fail(`Bad answer: ${err.message}`));
    });
    channel.onopen = () => {
      cleanup();
      // Connected: free the signaling room (the studio keeps this link when we leave it).
      signaling.close();
      resolve({ pc, channel, ...(sender ? { sender } : {}), close: () => { channel.close(); pc.close(); } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") fail("WebRTC connection failed"); };
    if (peerPresent) void offer();
  });
}

export interface HostListener {
  /** Stop answering new phones; already-open links stay up (e.g. once the studio has its phone). */
  stopListening(): void;
}

export interface HostOptions {
  /** Only data channels with this label are accepted. */
  label: string;
}

/**
 * Studio side: answer each offer that arrives through the room and hand the
 * resulting data channel to `onChannel`, with the media the phone sent, if
 * any (its track arrives during setRemoteDescription, before the channel
 * opens). Several phones can stay connected: a new offer only replaces a peer
 * that hasn't opened its channel yet, and a phone leaving the signaling room
 * doesn't close anything (the phone leaves it as soon as its channel opens,
 * which may be before ours does). A peer that never connects is dropped after
 * CHANNEL_OPEN_TIMEOUT_MS.
 */
export function acceptAsHost(
  signaling: SignalingClient,
  onChannel: (link: PeerLink) => void,
  iceServers: RTCIceServer[],
  options: HostOptions,
): HostListener {
  const { label } = options;
  let pending: RTCPeerConnection | null = null;
  let offIce: (() => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const closePending = () => { clearTimeout(pendingTimer); offIce?.(); offIce = null; pending?.close(); pending = null; };

  const offSignal = signaling.onMessage(async (msg) => {
    if (msg.type !== "offer") return;
    closePending();
    const conn = new RTCPeerConnection({ iceServers });
    pending = conn;
    offIce = wireIce(conn, signaling);
    pendingTimer = setTimeout(() => { if (pending === conn) closePending(); }, CHANNEL_OPEN_TIMEOUT_MS);
    // Set before setRemoteDescription: that's when ontrack fires.
    let remoteStream: MediaStream | undefined;
    conn.ontrack = (ev) => {
      if (remoteStream) { if (!remoteStream.getTracks().includes(ev.track)) remoteStream.addTrack(ev.track); return; }
      remoteStream = ev.streams[0] ?? new MediaStream([ev.track]);
    };
    conn.ondatachannel = (ev) => {
      if (ev.channel.label !== label) return;
      ev.channel.binaryType = "arraybuffer";
      const onOpen = () => {
        // Connected: this peer no longer depends on signaling.
        if (pending === conn) { clearTimeout(pendingTimer); offIce?.(); offIce = null; pending = null; }
        ev.channel.addEventListener("close", () => conn.close());
        onChannel({ pc: conn, channel: ev.channel, ...(remoteStream ? { remoteStream } : {}), close: () => { ev.channel.close(); conn.close(); } });
      };
      if (ev.channel.readyState === "open") onOpen();
      else ev.channel.addEventListener("open", onOpen, { once: true });
    };
    try {
      await conn.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      await conn.setLocalDescription(await conn.createAnswer());
      signaling.send({ type: "answer", sdp: conn.localDescription!.sdp });
    } catch (err) {
      console.warn("[webrtc] couldn't answer offer", err);
      if (pending === conn) closePending();
    }
  });
  return { stopListening: () => { offSignal(); closePending(); } };
}
