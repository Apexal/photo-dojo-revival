import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalingClient, SignalingMessage } from "../src/transfer/signaling-client";
import { acceptAsHost, connectAsGuest, type PeerLink } from "../src/transfer/peer-connection";

/**
 * Just enough of WebRTC to check the order things happen in. Offers carry the
 * guest's channel labels and track ids as JSON; the host-side fake fires
 * `ontrack` inside setRemoteDescription, as browsers do, and the test opens
 * data channels by hand afterwards.
 */
class FakeDataChannel extends EventTarget {
  binaryType = "blob";
  readyState = "connecting";
  onopen: (() => void) | null = null;
  constructor(readonly label: string) { super(); }
  open(): void {
    this.readyState = "open";
    this.onopen?.();
    this.dispatchEvent(new Event("open"));
  }
  close(): void { this.readyState = "closed"; }
}

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  calls: string[] = [];
  channels: FakeDataChannel[] = [];
  tracks: { track: unknown; stream: unknown }[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  onicecandidate: ((ev: unknown) => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() { FakePeerConnection.all.push(this); }

  addTrack(track: unknown, stream: unknown) {
    this.calls.push("addTrack");
    this.tracks.push({ track, stream });
    return { kind: "fake-sender", track };
  }

  createDataChannel(label: string) {
    this.calls.push(`createDataChannel:${label}`);
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    this.calls.push("createOffer");
    return { type: "offer", sdp: JSON.stringify({ labels: this.channels.map((c) => c.label), tracks: this.tracks.length }) };
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer" };
  }

  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.calls.push(`setRemoteDescription:${desc.type}`);
    if (desc.type !== "offer") return;
    const { tracks } = JSON.parse(desc.sdp) as { tracks: number };
    for (let i = 0; i < tracks; i++) {
      const track = { id: `track-${i}`, kind: "video" };
      this.ontrack?.({ track, streams: [remoteStream] });
    }
  }

  async addIceCandidate() {}
  close() { this.closed = true; }
}

const remoteStream = { id: "remote-stream", getTracks: () => [{ id: "track-0", kind: "video" }] };

function fakeSignaling() {
  const handlers = new Set<(m: SignalingMessage) => void>();
  const sent: SignalingMessage[] = [];
  const client = {
    sent,
    closed: false,
    send: (m: SignalingMessage) => { sent.push(m); },
    onMessage: (h: (m: SignalingMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
    close() { this.closed = true; },
    emit: (m: SignalingMessage) => { for (const h of [...handlers]) h(m); },
  };
  return client;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakePeerConnection.all = [];
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("peer connection: camera link", () => {
  it("the guest adds its video track before offering, on the given channel label, and returns the sender", async () => {
    const signaling = fakeSignaling();
    const track = { id: "cam", kind: "video" };
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const linking = connectAsGuest(signaling as unknown as SignalingClient, true, [], { label: "camera", stream });
    await tick();
    const [pc] = FakePeerConnection.all;
    expect(pc.calls.slice(0, 3)).toEqual(["addTrack", "createDataChannel:camera", "createOffer"]);
    expect(pc.tracks[0]).toEqual({ track, stream });
    expect(signaling.sent[0]).toMatchObject({ type: "offer" });
    signaling.emit({ type: "answer", sdp: "answer" });
    await tick();
    pc.channels[0].open();
    const link = await linking;
    expect(link.sender).toEqual({ kind: "fake-sender", track });
    expect(link.channel.label).toBe("camera");
    expect(signaling.closed).toBe(true);
  });

  it("the guest without a stream opens just the channel: no track, no sender", async () => {
    const signaling = fakeSignaling();
    const linking = connectAsGuest(signaling as unknown as SignalingClient, true, [], { label: "camera" });
    await tick();
    const [pc] = FakePeerConnection.all;
    expect(pc.calls.slice(0, 2)).toEqual(["createDataChannel:camera", "createOffer"]);
    pc.channels[0].open();
    const link = await linking;
    expect(link.sender).toBeUndefined();
  });

  it("the host gets the remote track (fired during setRemoteDescription) with the link, before the channel opens", async () => {
    const signaling = fakeSignaling();
    const links: PeerLink[] = [];
    const listener = acceptAsHost(signaling as unknown as SignalingClient, (l) => links.push(l), [], { label: "camera" });
    signaling.emit({ type: "offer", sdp: JSON.stringify({ labels: ["camera"], tracks: 1 }) });
    await tick();
    const [conn] = FakePeerConnection.all;
    expect(signaling.sent).toContainEqual({ type: "answer", sdp: "answer" });
    // Another label is ignored.
    const other = new FakeDataChannel("other");
    conn.ondatachannel!({ channel: other });
    other.open();
    expect(links).toHaveLength(0);
    const channel = new FakeDataChannel("camera");
    conn.ondatachannel!({ channel });
    expect(links).toHaveLength(0);
    channel.open();
    expect(links).toHaveLength(1);
    expect(links[0].remoteStream).toBe(remoteStream);
    expect(links[0].channel).toBe(channel);
    expect(channel.binaryType).toBe("arraybuffer");
    listener.stopListening();
  });

  it("the host takes only its own label's channel, and no remote stream from a guest without one", async () => {
    const signaling = fakeSignaling();
    const links: PeerLink[] = [];
    acceptAsHost(signaling as unknown as SignalingClient, (l) => links.push(l), [], { label: "camera" });
    signaling.emit({ type: "offer", sdp: JSON.stringify({ labels: ["camera"], tracks: 0 }) });
    await tick();
    const [conn] = FakePeerConnection.all;
    const other = new FakeDataChannel("other");
    conn.ondatachannel!({ channel: other });
    other.open();
    const camera = new FakeDataChannel("camera");
    conn.ondatachannel!({ channel: camera });
    camera.open();
    expect(links).toHaveLength(1);
    expect(links[0].channel).toBe(camera);
    expect(links[0].remoteStream).toBeUndefined();
  });
});
