import { DurableObject } from "cloudflare:workers";

export type Role = "host" | "guest";
export const ROOM_TTL_MS = 10 * 60 * 1000;

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace<SignalingRoom>;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Override the room lifetime (ms), for testing expiry. */
  ROOM_TTL_MS?: string;
}

const otherRole = (role: Role): Role => (role === "host" ? "guest" : "host");

/**
 * One room per code. Holds at most two sockets (one host, one guest), relays
 * every message from one to the other verbatim, and never parses or stores
 * payloads. Self-destructs 10 minutes after creation or when both sides leave.
 */
export class SignalingRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const role = new URL(request.url).searchParams.get("role");
    if (role !== "host" && role !== "guest") return new Response("role must be host or guest", { status: 400 });

    // A reconnecting laptop or phone replaces its stale socket.
    for (const old of this.ctx.getWebSockets(role)) old.close(4000, "Replaced by a new connection");
    const roomWasEmpty = this.ctx.getWebSockets().length === 0;

    // The room's lifetime starts when its first socket arrives.
    let expiresAt = await this.ctx.storage.getAlarm();
    if (roomWasEmpty || expiresAt === null) {
      expiresAt = Date.now() + (Number(this.env.ROOM_TTL_MS) || ROOM_TTL_MS);
      await this.ctx.storage.setAlarm(expiresAt);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    const peers = this.ctx.getWebSockets(otherRole(role));
    // Relative, so the laptop's countdown doesn't depend on its clock matching ours.
    server.send(JSON.stringify({ type: "welcome", role, peerPresent: peers.length > 0, expiresInMs: Math.max(0, expiresAt - Date.now()) }));
    for (const peer of peers) peer.send(JSON.stringify({ type: "peer-joined", role }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag === "host" || tag === "guest" ? tag : null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return;
    for (const peer of this.ctx.getWebSockets(otherRole(role))) peer.send(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    await this.peerLeft(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.peerLeft(ws);
  }

  private async peerLeft(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (role) {
      for (const peer of remaining) {
        if (this.roleOf(peer) !== role && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "peer-left", role }));
      }
    }
    if (remaining.length === 0) await this.destroy();
  }

  async alarm(): Promise<void> {
    console.log("[room] expired, closing", this.ctx.getWebSockets().length, "sockets");
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, "Room expired");
    await this.destroy();
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
