import { signalingHttpBase, type SignalingClient } from "./signaling-client";

export const DATA_CHANNEL_LABEL = "fighter";
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
    const body = (await res.json()) as { iceServers?: RTCIceServer[] | RTCIceServer };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    return servers.length ? [...DEFAULT_ICE_SERVERS, ...servers] : DEFAULT_ICE_SERVERS;
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
  close(): void;
}

/**
 * Phone side: wait for the laptop to be in the room, open an ordered, reliable
 * data channel, and offer. Rejects if the channel isn't open within 20 s.
 */
export function connectAsGuest(
  signaling: SignalingClient,
  peerPresent: boolean,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS,
  timeoutMs = CHANNEL_OPEN_TIMEOUT_MS,
): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers });
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    channel.binaryType = "arraybuffer";
    const offIce = wireIce(pc, signaling);
    let offered = false;
    const cleanup = () => { offIce(); offSignal(); clearTimeout(timer); };
    const fail = (reason: string) => { cleanup(); pc.close(); reject(new Error(reason)); };
    const timer = setTimeout(() => fail("No connection to the game after 20 seconds"), timeoutMs);

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
      // Connected: free the signaling room (the laptop keeps this link when we leave it).
      signaling.close();
      resolve({ pc, channel, close: () => { channel.close(); pc.close(); } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") fail("WebRTC connection failed"); };
    if (peerPresent) void offer();
  });
}

export interface HostListener {
  /** Stop answering new phones; already-open links stay up (e.g. when the room code refreshes). */
  stopListening(): void;
  /** Also close every open link. */
  closeAll(): void;
}

/**
 * Laptop side: answer each offer that arrives through the room and hand the
 * resulting data channel to `onChannel`. Several phones can stay connected:
 * a new offer only replaces a peer that hasn't opened its channel yet, and a
 * phone leaving the signaling room doesn't close an open link.
 */
export function acceptAsHost(
  signaling: SignalingClient,
  onChannel: (link: PeerLink) => void,
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS,
): HostListener {
  let pending: RTCPeerConnection | null = null;
  let offIce: (() => void) | null = null;
  const open = new Set<RTCPeerConnection>();
  const closePending = () => { offIce?.(); offIce = null; pending?.close(); pending = null; };

  const offSignal = signaling.onMessage(async (msg) => {
    if (msg.type === "peer-left") return closePending();
    if (msg.type !== "offer") return;
    closePending();
    const conn = new RTCPeerConnection({ iceServers });
    pending = conn;
    offIce = wireIce(conn, signaling);
    conn.ondatachannel = (ev) => {
      if (ev.channel.label !== DATA_CHANNEL_LABEL) return;
      ev.channel.binaryType = "arraybuffer";
      const onOpen = () => {
        // Connected: this peer no longer depends on signaling.
        if (pending === conn) { offIce?.(); offIce = null; pending = null; }
        open.add(conn);
        ev.channel.addEventListener("close", () => { open.delete(conn); conn.close(); });
        onChannel({ pc: conn, channel: ev.channel, close: () => { ev.channel.close(); conn.close(); } });
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
  return {
    stopListening: () => { offSignal(); closePending(); },
    closeAll: () => { offSignal(); closePending(); for (const c of open) c.close(); open.clear(); },
  };
}
