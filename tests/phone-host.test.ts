import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneHost, reopenDelayMs, type PhoneHostDeps, type PhoneHostStatus, type SignalingLike } from "../src/studio/phone-host";
import type { HostOptions, PeerLink } from "../src/transfer/peer-connection";
import { FakeChannel } from "./helpers";

/** One signaling socket to the room: closes like a WebSocket (room expiry is a close from the other end). */
class FakeSignaling implements SignalingLike {
  open = true;
  private handlers = new Set<(ev: { code: number; reason: string }) => void>();
  onClose(handler: (ev: { code: number; reason: string }) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  close(): void {
    this.serverClose(1000, "done");
  }
  serverClose(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const h of [...this.handlers]) h({ code, reason });
  }
}

/** A fake "Worker + phones": records every room opened and lets the test connect phones to the open one. */
function fakeNetwork() {
  const rooms: { code: string; client: FakeSignaling; listening: boolean; onLink: (link: PeerLink) => void; options: HostOptions | null }[] = [];
  let failNext = 0;
  const deps: PhoneHostDeps = {
    async connect(roomCode) {
      if (failNext > 0) {
        failNext--;
        throw new Error("Couldn't reach the signaling server");
      }
      const client = new FakeSignaling();
      rooms.push({ code: roomCode, client, listening: false, onLink: () => {}, options: null });
      return { client, welcome: { type: "welcome", role: "host", peerPresent: false, expiresInMs: 600_000 } };
    },
    accept(client, onLink, _ice, options) {
      const room = rooms.find((r) => r.client === client)!;
      Object.assign(room, { listening: true, onLink, options });
      return { stopListening: () => { room.listening = false; } };
    },
    async iceServers() {
      return [];
    },
  };
  /** A phone whose channel opens in the room that's listening now. */
  const phone = () => {
    const room = rooms.at(-1)!;
    if (!room.listening || !room.client.open) throw new Error("no room listening");
    const [studioEnd, phoneEnd] = FakeChannel.pair();
    let closed = 0;
    const link = { pc: {} as RTCPeerConnection, channel: studioEnd as unknown as RTCDataChannel, close: () => { closed++; if (studioEnd.readyState === "open") studioEnd.close(); } } satisfies PeerLink;
    room.onLink(link);
    return { link, phoneEnd, closed: () => closed };
  };
  return { deps, rooms, phone, failConnects: (n: number) => { failNext = n; } };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("PhoneHost", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens one room code, takes one phone, and then closes signaling so nobody else joins", async () => {
    const net = fakeNetwork();
    const host = new PhoneHost({ roomCode: "ABC234", deps: net.deps });
    const statuses: PhoneHostStatus["kind"][] = [];
    host.onStatus((s) => statuses.push(s.kind));
    const phones: PeerLink[] = [];
    host.onPhone((link) => phones.push(link));
    host.start();
    await flush();
    expect(net.rooms).toHaveLength(1);
    expect(net.rooms[0]).toMatchObject({ code: "ABC234", listening: true, options: { label: "camera" } });
    expect(host.status).toEqual({ kind: "waiting", roomCode: "ABC234" });

    const first = net.phone();
    expect(phones).toEqual([first.link]);
    expect(host.status.kind).toBe("connected");
    expect(host.hasPhone).toBe(true);
    // Signaling is closed and not listening: a second phone can't get in.
    expect(net.rooms[0].listening).toBe(false);
    expect(net.rooms[0].client.open).toBe(false);
    expect(() => net.phone()).toThrow(/no room/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.rooms).toHaveLength(1); // no reopening while the phone is here
    expect(statuses).toEqual(["stopped", "opening", "waiting", "connected"]);
  });

  it("reopens the same code when the phone goes, and takes it (or another) again", async () => {
    const net = fakeNetwork();
    const host = new PhoneHost({ roomCode: "ABC234", deps: net.deps });
    host.start();
    await flush();
    const first = net.phone();
    // The studio noticed the phone stopped answering.
    host.dropPhone(first.link);
    expect(first.closed()).toBe(1);
    await flush();
    expect(net.rooms).toHaveLength(2);
    expect(net.rooms[1]).toMatchObject({ code: "ABC234", listening: true });
    expect(host.status).toEqual({ kind: "waiting", roomCode: "ABC234" });
    // The same phone, retrying the same code, comes back.
    const again = net.phone();
    expect(host.status.kind).toBe("connected");
    // Its channel closing (the phone's page went) reopens too.
    again.phoneEnd.close();
    await flush();
    expect(net.rooms).toHaveLength(3);
    expect(net.rooms.map((r) => r.code)).toEqual(["ABC234", "ABC234", "ABC234"]);
    // Dropping a stale link does nothing.
    host.dropPhone(first.link);
    await flush();
    expect(net.rooms).toHaveLength(3);
  });

  it("reopens a room that expires (or drops) while waiting, under the same code", async () => {
    const net = fakeNetwork();
    const host = new PhoneHost({ roomCode: "XYZ789", deps: net.deps });
    host.start();
    await flush();
    net.rooms[0].client.serverClose(4001, "Room expired");
    expect(host.status).toEqual({ kind: "opening", roomCode: "XYZ789", reason: "Room expired" });
    expect(net.rooms[0].listening).toBe(false);
    await vi.advanceTimersByTimeAsync(reopenDelayMs(1));
    expect(net.rooms).toHaveLength(2);
    expect(net.rooms[1]).toMatchObject({ code: "XYZ789", listening: true });
    expect(host.status.kind).toBe("waiting");
  });

  it("keeps retrying while signaling is unreachable, backing off", async () => {
    const net = fakeNetwork();
    const host = new PhoneHost({ roomCode: "XYZ789", deps: net.deps });
    net.failConnects(3);
    host.start();
    await flush();
    expect(host.status).toMatchObject({ kind: "opening", reason: "Couldn't reach the signaling server" });
    await vi.advanceTimersByTimeAsync(reopenDelayMs(1)); // 2nd try fails
    await vi.advanceTimersByTimeAsync(reopenDelayMs(2)); // 3rd try fails
    expect(net.rooms).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(reopenDelayMs(3) - 1);
    expect(net.rooms).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.rooms).toHaveLength(1);
    expect(host.status.kind).toBe("waiting");
    expect([1, 2, 3, 4, 5, 9].map(reopenDelayMs)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("stop closes the room and the phone, and doesn't reopen", async () => {
    const net = fakeNetwork();
    const host = new PhoneHost({ roomCode: "ABC234", deps: net.deps });
    host.start();
    await flush();
    const p = net.phone();
    host.stop();
    expect(p.closed()).toBe(1);
    expect(host.status).toEqual({ kind: "stopped", roomCode: "ABC234" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.rooms).toHaveLength(1);
    // Started again (the studio's "Use a phone" once more): same code.
    host.start();
    await flush();
    expect(net.rooms.map((r) => r.code)).toEqual(["ABC234", "ABC234"]);
  });

  it("a stop while the room is still opening closes the late socket", async () => {
    const net = fakeNetwork();
    let release!: () => void;
    const slow: PhoneHostDeps = { ...net.deps, connect: async (code) => { await new Promise<void>((r) => { release = r; }); return net.deps.connect(code); } };
    const host = new PhoneHost({ roomCode: "ABC234", deps: slow });
    host.start();
    await flush();
    host.stop();
    release();
    await flush();
    expect(net.rooms).toHaveLength(1);
    expect(net.rooms[0].client.open).toBe(false);
    expect(net.rooms[0].listening).toBe(false);
  });
});
