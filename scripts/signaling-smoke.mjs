// End-to-end check of the signaling Worker: node scripts/signaling-smoke.mjs [ws://localhost:8787]
const base = process.argv[2] ?? "ws://localhost:8787";
const code = "SMK" + Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01OI]/g, "A");
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

function open(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/room/${code}?role=${role}`);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const w = waiters.findIndex((x) => x.type === msg.type);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    };
    ws.onerror = () => reject(new Error(`${role} socket error`));
    ws.onopen = () => resolve({
      ws,
      next(type, timeout = 3000) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          waiters.push({ type, resolve: res });
          setTimeout(() => rej(new Error(`${role}: timed out waiting for ${type}`)), timeout);
        });
      },
      closed: new Promise((res) => { ws.onclose = (ev) => res(ev); }),
    });
  });
}

const http = base.replace(/^ws/, "http");
const health = await fetch(http + "/");
if (!health.ok) fail("health check");
const badOpened = await new Promise((resolve) => {
  const ws = new WebSocket(`${base}/room/BAD0?role=host`);
  ws.onopen = () => resolve(true);
  ws.onerror = () => resolve(false);
});
if (badOpened) fail("invalid room code should be rejected");
const noUpgrade = await fetch(`${http}/room/${code}?role=host`);
if (noUpgrade.status !== 426) fail(`non-upgrade should be 426, got ${noUpgrade.status}`);

const host = await open("host");
const hw = await host.next("welcome");
if (hw.peerPresent !== false) fail("host should be alone");
if (!(hw.expiresInMs > 0 && hw.expiresInMs <= 10 * 60 * 1000)) fail(`welcome should say when the room expires, got ${hw.expiresInMs}`);
const guest = await open("guest");
const gw = await guest.next("welcome");
if (gw.peerPresent !== true) fail("guest should see host");
if (!(gw.expiresInMs <= hw.expiresInMs)) fail("a guest joining later doesn't extend the room");
await host.next("peer-joined");

// Verbatim relay both ways, including content the room doesn't understand.
guest.ws.send(JSON.stringify({ type: "offer", sdp: "v=0 fake" }));
const offer = await host.next("offer");
if (offer.sdp !== "v=0 fake") fail("offer relay");
host.ws.send(JSON.stringify({ type: "answer", sdp: "answer!" }));
if ((await guest.next("answer")).sdp !== "answer!") fail("answer relay");
host.ws.send(JSON.stringify({ type: "custom", nested: { a: [1, 2] } }));
if ((await guest.next("custom")).nested.a[1] !== 2) fail("verbatim relay");

// A second guest replaces the first.
const guest2 = await open("guest");
await guest2.next("welcome");
const replaced = await guest.closed;
if (replaced.code !== 4000) fail(`replaced guest should close with 4000, got ${replaced.code}`);

guest2.ws.close();
await host.next("peer-left");
host.ws.close();
await host.closed;

// With the Worker started with --var ROOM_TTL_MS:2000, rooms expire quickly (local alarms fire up to ~10 s late).
if (process.argv.includes("--expiry")) {
  const lonely = await open("host");
  await lonely.next("welcome");
  const ev = await Promise.race([lonely.closed, new Promise((r) => setTimeout(() => r(null), 20000))]);
  if (!ev || ev.code !== 4001) fail(`room should expire with 4001, got ${ev?.code}`);
  console.log("room expiry: ok");
}

const turn = await fetch(http + "/turn-credentials");
console.log("turn-credentials:", turn.status);
console.log("OK: signaling relay works for room", code);
process.exit(0);
