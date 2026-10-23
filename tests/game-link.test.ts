import { describe, expect, it } from "vitest";
import { GameLink, type LinkStatus } from "../src/capture/game-link";
import type { PeerLink } from "../src/transfer/peer-connection";

class FakeChannel {
  readyState = "open";
  private closeListeners: (() => void)[] = [];
  addEventListener(_type: "close", l: () => void) { this.closeListeners.push(l); }
  drop() { this.readyState = "closed"; this.closeListeners.forEach((l) => l()); }
}

function connector(results: ("ok" | Error)[]) {
  const calls: string[] = [];
  const channels: FakeChannel[] = [];
  const fn = async (room: string): Promise<PeerLink> => {
    calls.push(room);
    const r = results.shift() ?? "ok";
    if (r instanceof Error) throw r;
    const channel = new FakeChannel();
    channels.push(channel);
    return { channel: channel as unknown as RTCDataChannel, pc: {} as RTCPeerConnection, close: () => channel.drop() };
  };
  return { fn, calls, channels };
}

describe("GameLink (phone → laptop)", () => {
  it("connects once and reuses the open link", async () => {
    const c = connector(["ok"]);
    const link = new GameLink("ABC234", c.fn);
    const statuses: string[] = [];
    link.onStatus((s) => statuses.push(s.kind));
    const [a, b] = await Promise.all([link.ensure(), link.ensure()]);
    expect(a).toBe(b);
    expect(await link.ensure()).toBe(a);
    expect(c.calls).toEqual(["ABC234"]);
    expect(statuses).toEqual(["idle", "connecting", "connected"]);
  });

  it("reports failures, and retries on the next ensure", async () => {
    const c = connector([new Error("No connection to the game after 20 seconds"), "ok"]);
    const link = new GameLink("ABC234", c.fn);
    let last: LinkStatus = link.status;
    link.onStatus((s) => (last = s));
    await expect(link.ensure()).rejects.toThrow(/20 seconds/);
    expect(last).toEqual({ kind: "failed", reason: "No connection to the game after 20 seconds" });
    await link.ensure();
    expect(last.kind).toBe("connected");
  });

  it("notices a dropped channel and reconnects when needed", async () => {
    const c = connector(["ok", "ok"]);
    const link = new GameLink("ABC234", c.fn);
    await link.ensure();
    c.channels[0].drop();
    expect(link.status.kind).toBe("closed");
    expect(link.isOpen).toBe(false);
    await link.ensure();
    expect(c.calls).toHaveLength(2);
    expect(link.isOpen).toBe(true);
  });

  it("switching rooms drops the old link and connects to the new code", async () => {
    const c = connector(["ok", "ok"]);
    const link = new GameLink("OLD234", c.fn);
    await link.ensure();
    link.setRoom("NEW234");
    expect(c.channels[0].readyState).toBe("closed");
    await link.ensure();
    expect(c.calls).toEqual(["OLD234", "NEW234"]);
  });

  it("without a code it doesn't try", async () => {
    const c = connector([]);
    const link = new GameLink(null, c.fn);
    link.warmUp();
    await expect(link.ensure()).rejects.toThrow(/No game code/);
    expect(c.calls).toEqual([]);
  });
});
