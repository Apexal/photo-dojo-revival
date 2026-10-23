import { isValidRoomCode } from "../../src/shared/room-code";
import { SignalingRoom, type Env } from "./signaling-room";

export { SignalingRoom };

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const TURN_TTL_SECONDS = 3600;

function json(body: unknown, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, "Access-Control-Allow-Origin": origin, Vary: "Origin" } });
}

/**
 * TURN relays traffic on the account's bill, so with ALLOWED_ORIGINS set only
 * the game's own pages get credentials (a browser can't fake its Origin).
 */
function allowedOrigin(request: Request, env: Env): string | null {
  if (!env.ALLOWED_ORIGINS) return "*";
  const origin = request.headers.get("Origin");
  return origin && env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).includes(origin) ? origin : null;
}

/** Mint short-lived Cloudflare TURN credentials, if a TURN key is configured. */
async function turnCredentials(request: Request, env: Env): Promise<Response> {
  const origin = allowedOrigin(request, env);
  if (!origin) return json({ error: "Origin not allowed" }, 403, "null");
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: "TURN not configured" }, 404, origin);
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!res.ok) return json({ error: `TURN credential request failed (${res.status})` }, 502, origin);
  // Always a list: Cloudflare has answered with a single object or an array.
  const { iceServers } = (await res.json()) as { iceServers?: unknown };
  return json({ iceServers: Array.isArray(iceServers) ? iceServers : iceServers ? [iceServers] : [] }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const room = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (room) {
      const code = room[1].toUpperCase(); // codes are plain letters and digits: nothing to decode
      if (!isValidRoomCode(code)) return new Response("Invalid room code", { status: 400 });
      const stub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname === "/turn-credentials") return turnCredentials(request, env);
    if (url.pathname === "/") return new Response("photo-dojo signaling\n", { headers: CORS });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
