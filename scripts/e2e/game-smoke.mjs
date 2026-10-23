// Headless browser smoke test of the game + phone→laptop transfer.
// Needs `npm run dev` (Vite) and `npm run worker:dev` running.
//   node scripts/e2e/game-smoke.mjs [http://localhost:5173] [out-dir]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = process.argv[3] ?? "e2e-out";
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const watch = (page, name) => {
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`[${name}] console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/turn-credentials")) errors.push(`[${name}] HTTP ${r.status()} ${r.url()}`); });
};
const step = (msg) => console.log("•", msg);
/** Click a point given in game coordinates (1280×720), through the scaled canvas. */
async function clickGame(page, x, y) {
  const r = await page.evaluate(() => { const b = document.querySelector("#game canvas").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.click(r.x + (x / 1280) * r.w, r.y + (y / 720) * r.h);
}
const check = (cond, msg) => { if (!cond) throw new Error("CHECK FAILED: " + msg); };

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const game = await ctx.newPage();
  watch(game, "game");
  await game.goto(BASE + "/");
  await game.waitForFunction(() => window.photoDojo?.scene.isActive("title"), null, { timeout: 20000 });
  await game.waitForFunction(() => window.photoDojo.scene.getScene("title").sim?.current.frame > 30, null, { timeout: 10000 });
  step("title screen is up, demo fight running");
  await game.screenshot({ path: `${OUT}/00-title.png` });
  await game.keyboard.press("Enter"); // not a player key: starts without joining anyone
  await game.waitForFunction(() => window.photoDojo.scene.isActive("character-select"), null, { timeout: 5000 });
  check((await game.evaluate(() => window.photoDojo.scene.getScene("character-select").players.every((p) => p === null))), "Enter on the title joins nobody");
  step("character select is up");
  await game.waitForFunction(() => /^[A-Z2-9]{6}$/.test(window.photoDojo.scene.getScene("character-select").codeText.text), null, { timeout: 10000 });
  await game.waitForFunction(() => window.photoDojo.scene.getScene("character-select").hostText.text.startsWith("Or open"), null, { timeout: 10000 });
  const roomCode = await game.evaluate(() => window.photoDojo.scene.getScene("character-select").codeText.text);
  step(`hosting room ${roomCode}`);
  await game.waitForTimeout(500);
  await game.screenshot({ path: `${OUT}/01-select.png` });

  // --- phone → laptop transfer over real WebRTC, using the app's own modules ---
  const phone = await ctx.newPage();
  watch(phone, "phone");
  await phone.goto(BASE + "/capture.html?room=" + roomCode);
  const sent = await phone.evaluate(async (code) => {
    const { loadPlaceholderFighter } = await import("/src/game/fighter-library.ts");
    const { SignalingClient } = await import("/src/transfer/signaling-client.ts");
    const { connectAsGuest } = await import("/src/transfer/peer-connection.ts");
    const { sendFighter } = await import("/src/transfer/fighter-sender.ts");
    const f = await loadPlaceholderFighter("placeholder-blue", "/");
    const fighter = { ...f, fighterId: crypto.randomUUID(), name: "Wire Blue", createdAt: Date.now(),
      sounds: { attack: null, hurt: null, win: null } };
    const { client, welcome } = await SignalingClient.connect(code, "guest");
    const link = await connectAsGuest(client, welcome.peerPresent);
    let last = 0;
    await sendFighter(link.channel, fighter, { onProgress: (p) => { last = p.sentBytes / p.totalBytes; } });
    link.close();
    client.close();
    return { id: fighter.fighterId, progress: last };
  }, roomCode);
  check(sent.progress === 1, "sender reported full progress");
  step("phone sent a fighter over WebRTC and got an ack");
  await game.waitForFunction((id) => window.photoDojo.registry.get("library").some((e) => e.fighter.fighterId === id), sent.id, { timeout: 10000 });
  const stored = await game.evaluate(async (id) => {
    const { loadFighter } = await import("/src/shared/fighter-storage.ts");
    const f = await loadFighter(id);
    return f ? { name: f.name, kickBytes: f.poses.kick.imageBlob.size, alternates: Object.values(f.poseVariants ?? {}).flat().length } : null;
  }, sent.id);
  check(stored?.name === "Wire Blue" && stored.kickBytes > 1000, "received fighter is in IndexedDB");
  check(stored.alternates === 5, `pose alternates (second stance included) survived the transfer (${stored.alternates})`);
  step(`laptop saved it to IndexedDB and the grid updated (${JSON.stringify(stored)})`);
  await game.waitForTimeout(400);
  await game.screenshot({ path: `${OUT}/02-select-after-transfer.png` });
  await phone.close();

  // --- mouse: select a tile, export from the tile's own button, re-import through the toolbar ---
  // First tile of the grid (character-select-scene.ts: GRID_X 40, GRID_Y 116, TILE 120); its buttons sit along its bottom edge.
  const TILE_X = 40, TILE_Y = 116, TILE = 120;
  await clickGame(game, TILE_X + TILE / 2, TILE_Y + TILE / 2); // first tile
  check((await game.evaluate(() => window.photoDojo.scene.getScene("character-select").selected)) === 0, "clicking a tile selects it");
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/02b-tile-selected.png` });
  const [download] = await Promise.all([game.waitForEvent("download"), clickGame(game, TILE_X + 30, TILE_Y + TILE - 16)]);
  const exportPath = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(exportPath);
  step(`exported ${download.suggestedFilename()}`);
  await game.setInputFiles("#import-file", exportPath);
  await game.waitForFunction(() => /^(Imported|Updated)/.test(document.getElementById("toolbar-status").textContent), null, { timeout: 5000 });
  step("re-imported the exported file");
  // Delete needs a confirm on the tile; "Keep" backs out.
  await clickGame(game, TILE_X + TILE / 2, TILE_Y + TILE / 2);
  await clickGame(game, TILE_X + 96, TILE_Y + TILE - 16); // 🗑
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/02c-delete.png` });
  check((await game.evaluate(() => window.photoDojo.scene.getScene("character-select").pendingDelete)) !== null, "delete asks to confirm");
  await clickGame(game, TILE_X + 88, TILE_Y + TILE - 16); // Keep
  check((await game.evaluate(() => window.photoDojo.scene.getScene("character-select").pendingDelete)) === null, "Keep cancels the delete");
  step("mouse: tile select, export button, delete confirm/cancel");

  // --- pick fighters: P1 keyboard (J), P2 keyboard (,) ---
  await game.click("canvas");
  await game.keyboard.press("j"); // P1 joins
  await game.keyboard.press("Comma"); // P2 joins
  await game.waitForTimeout(100);
  await game.keyboard.press("j"); // P1 ready on tile 0 (newest = Wire Blue)
  await game.keyboard.press("ArrowRight");
  await game.keyboard.press("ArrowRight");
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/03-picking.png` });
  await game.keyboard.press("Comma"); // P2 ready
  // VS, then the stage select (there's more than one stage): P2 moves to the second stage and picks it.
  await game.waitForFunction(() => window.photoDojo.scene.isActive("stage-select"), null, { timeout: 10000 });
  await game.waitForTimeout(150);
  await game.keyboard.press("ArrowRight");
  await game.waitForTimeout(100);
  const stagePicked = await game.evaluate(() => { const s = window.photoDojo.scene.getScene("stage-select"); return s.options[s.index]; });
  await game.screenshot({ path: `${OUT}/03a-stage-select.png` });
  await game.keyboard.press("Comma");
  await game.waitForFunction(() => window.photoDojo.scene.isActive("controls"), null, { timeout: 10000 });
  check((await game.evaluate(() => window.photoDojo.scene.getScene("controls").setup.stageId)) === stagePicked, `the picked stage (${stagePicked}) goes into the match`);
  step(`stage select: picked ${stagePicked}`);
  await game.waitForTimeout(1200); // let the move previews animate
  await game.screenshot({ path: `${OUT}/03b-controls.png` });
  const cards = await game.evaluate(() => window.photoDojo.scene.getScene("controls").cards.length);
  check(cards === 16, `controls screen shows 8 move previews per player (${cards})`);
  step("pre-match controls screen with move previews");
  await game.keyboard.press("j"); // P1 ready
  await game.waitForTimeout(100);
  check(await game.evaluate(() => window.photoDojo.scene.isActive("controls")), "waits for both players");
  await game.keyboard.press("Comma"); // P2 ready
  await game.waitForFunction(() => window.photoDojo.scene.isActive("fight"), null, { timeout: 10000 });
  step("fight started");
  const fight = () => game.evaluate(() => {
    const s = window.photoDojo.scene.getScene("fight").sim.current;
    return { phase: s.round.phase, f: s.fighters.map((f) => ({ x: Math.round(f.position.x), action: f.action, health: f.health })) };
  });
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  const variants = await game.evaluate(() => {
    const scene = window.photoDojo.scene.getScene("fight");
    return { punch: scene.geometry[1].variants?.punch?.length ?? 0, texture: scene.textures.exists("p1:pose:punch#1") };
  });
  check(variants.punch === 1 && variants.texture, `built-in fighter has a punch alternate loaded (${JSON.stringify(variants)})`);
  step("pose alternates loaded for the built-in fighter");
  const start = await fight();
  await game.keyboard.down("d");
  await game.waitForTimeout(1200);
  await game.keyboard.up("d");
  const walked = await fight();
  if (walked.f[0].x <= start.f[0].x + 100) {
    console.log("walk debug", await game.evaluate(() => {
      const sc = window.photoDojo.scene.getScene("fight");
      const src = sc.sources[0];
      const d = src.keys?.right?.[0];
      return JSON.stringify({ src: src.id, read: src.read(), dKey: d && { isDown: d.isDown, code: d.keyCode }, active: window.photoDojo.scene.getScenes(true).map((x) => x.sys.settings.key), paused: sc.paused, phase: sc.sim.current.round.phase, inputs: sc.setup.inputs });
    }));
  }
  check(walked.f[0].x > start.f[0].x + 100, `P1 walked right (${start.f[0].x} → ${walked.f[0].x})`);
  step(`P1 walked ${start.f[0].x} → ${walked.f[0].x}`);
  for (let i = 0; i < 6; i++) {
    await game.keyboard.press("j");
    await game.waitForTimeout(80);
    if (i === 1) await game.screenshot({ path: `${OUT}/04-punch.png` });
    await game.waitForTimeout(250);
  }
  const hit = await fight();
  check(hit.f[1].health < 100, `P2 took damage (health ${hit.f[1].health})`);
  step(`punches landed: P2 health ${hit.f[1].health}`);
  await game.keyboard.press("F1");
  await game.waitForTimeout(100);
  check(await game.evaluate(() => window.photoDojo.scene.getScene("fight").debug.visible), "F1 shows hitboxes");
  await game.keyboard.down("k");
  await game.waitForTimeout(150);
  await game.screenshot({ path: `${OUT}/05-kick-hitboxes.png` });
  await game.keyboard.up("k");
  await game.keyboard.press("Escape");
  await game.waitForTimeout(200);
  check((await game.evaluate(() => window.photoDojo.scene.getScene("fight").paused)) === true, "Esc pauses");
  check(await game.evaluate(() => window.photoDojo.scene.isActive("pause")), "Esc opens the pause menu");
  await game.screenshot({ path: `${OUT}/06-paused.png` });
  await game.keyboard.press("Escape");
  await game.waitForTimeout(150);
  check((await game.evaluate(() => window.photoDojo.scene.getScene("fight").paused)) === false, "Esc again resumes");

  // Run out the clock quickly: jump the sim to a KO by beating P2.
  for (let i = 0; i < 40; i++) {
    const s = await fight();
    if (s.phase !== "fighting") break;
    await game.keyboard.down("d");
    await game.waitForTimeout(150);
    await game.keyboard.up("d");
    await game.keyboard.press("k");
    await game.waitForTimeout(450);
  }
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").replay !== null, null, { timeout: 8000 });
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${OUT}/06b-ko-replay.png` });
  const replayFrames = await game.evaluate(() => window.photoDojo.scene.getScene("fight").replay.states.length);
  check(replayFrames > 60, `KO replay has the lead-up (${replayFrames} frames)`);
  step(`KO replay playing (${replayFrames} frames, slow motion)`);
  await game.keyboard.press("j"); // skip
  await game.waitForFunction(() => window.photoDojo.scene.isActive("round-result"), null, { timeout: 5000 });
  step("skipped the replay → round result screen");
  await game.screenshot({ path: `${OUT}/07-round-result.png` });
  await game.waitForTimeout(800);
  await game.keyboard.press("j");
  // Well before the screen's own 3.5 s auto-continue: the press has to work.
  await game.waitForFunction(() => {
    const s = window.photoDojo.scene.getScene("fight").sim.current.round;
    return s.roundNumber === 2 && !window.photoDojo.scene.isActive("round-result");
  }, null, { timeout: 1500 });
  step("punch on the round result → round 2 started");

  // New moves through the real keyboard: S+J uppercut, J+K throw.
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  const actionOf = () => game.evaluate(() => window.photoDojo.scene.getScene("fight").sim.current.fighters.map((f) => f.action));
  await game.keyboard.down("s");
  await game.keyboard.press("j");
  await game.waitForTimeout(50);
  const upper = await actionOf();
  await game.keyboard.up("s");
  check(upper[0] === "uppercut", `S+J starts an uppercut (${upper[0]})`);
  await game.waitForTimeout(600);
  // Sides swap every round: in round 2 P1 starts on the right.
  const p1OnRight = await game.evaluate(() => { const [a, b] = window.photoDojo.scene.getScene("fight").sim.current.fighters; return a.position.x > b.position.x; });
  check(p1OnRight, "players swapped sides for round 2");
  const toward = p1OnRight ? "a" : "d";
  await game.keyboard.down(toward);
  await game.waitForFunction(() => {
    const [a, b] = window.photoDojo.scene.getScene("fight").sim.current.fighters;
    return Math.abs(b.position.x - a.position.x) < 90;
  }, null, { timeout: 8000 });
  await game.keyboard.up(toward);
  await game.waitForTimeout(100);
  const before = await game.evaluate(() => window.photoDojo.scene.getScene("fight").sim.current.fighters[1].health);
  await game.keyboard.down("j");
  await game.keyboard.down("k");
  await game.waitForTimeout(40);
  await game.keyboard.up("j");
  await game.keyboard.up("k");
  await game.waitForFunction((hp) => window.photoDojo.scene.getScene("fight").sim.current.fighters[1].health < hp, before, { timeout: 3000 });
  step("J+K throw lands on the idle opponent");

  // --- finish the match (P2 down to 1 health: the next clean hit is the KO) → stats page → rematch ---
  await game.evaluate(() => {
    const sim = window.photoDojo.scene.getScene("fight").sim; // poking the private state: only to keep the test short
    sim.state = { ...sim.state, fighters: [sim.state.fighters[0], { ...sim.state.fighters[1], health: 1 }] };
  });
  const phaseNow = () => game.evaluate(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase);
  for (let i = 0; i < 60 && (await phaseNow()) === "fighting"; i++) {
    await game.keyboard.down(toward);
    await game.waitForTimeout(120);
    await game.keyboard.up(toward);
    await game.keyboard.press("j");
    await game.waitForTimeout(200);
  }
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "matchOver", null, { timeout: 15000 });
  await game.waitForTimeout(2500);
  await game.keyboard.press("j"); // skip the KO replay
  await game.waitForFunction(() => window.photoDojo.scene.isActive("match-result"), null, { timeout: 8000 });
  const matchStats = await game.evaluate(() => window.photoDojo.scene.getScene("match-result").result.stats);
  check(matchStats.rounds.length === 2 && matchStats.players[0].roundsWon === 2, `stats page: P1 won both rounds (${JSON.stringify(matchStats.rounds)})`);
  check(matchStats.players[0].hits > 0 && matchStats.players[0].throws >= 1 && matchStats.players[0].damageDealt === 200, `stats page counts P1's hits, throw and damage (${JSON.stringify(matchStats.players[0])})`);
  await game.waitForTimeout(1300); // past the page's input delay
  await game.screenshot({ path: `${OUT}/08-match-result.png` });
  await game.keyboard.press("j");
  await game.waitForFunction(() => {
    const r = window.photoDojo.scene.getScene("fight").sim?.current.round;
    return !window.photoDojo.scene.isActive("match-result") && r?.roundNumber === 1 && r.wins[0] === 0 && r.wins[1] === 0;
  }, null, { timeout: 3000 });
  step(`match over → stats page (${matchStats.players[0].hits} clean hits, ${matchStats.players[0].throws} throw) → punch: rematch`);
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });

  // --- practice mode: quit to select (pause menu: up from Resume wraps to Quit), one player readies and presses punch again ---
  await game.keyboard.press("Escape");
  await game.waitForTimeout(150);
  await game.keyboard.press("w");
  await game.waitForTimeout(80);
  await game.keyboard.press("j");
  await game.waitForFunction(() => window.photoDojo.scene.isActive("character-select"), null, { timeout: 5000 });
  await game.waitForTimeout(300);
  const selectState = () => game.evaluate(() => {
    const sc = window.photoDojo.scene.getScene("character-select");
    return JSON.stringify({
      players: sc.players.map((p) => p && { ready: p.ready, cursor: p.cursor, prev: p.previous, input: p.input }),
      active: sc.sys.isActive(), status: sc.sys.settings.status, scenes: window.photoDojo.scene.getScenes(true).map((x) => x.sys.settings.key),
      lib: sc.library.length,
      jKey: (() => { const k = sc.players[0]?.source?.keys?.punch?.[0]; return k ? { isDown: k.isDown, listeners: k.listenerCount("down") } : null; })(),
      kbEnabled: sc.input.keyboard.enabled, managerEnabled: sc.input.keyboard.manager.enabled,
      domKeys: window.__keys, prevTime: sc.input.keyboard.prevTime, prevType: sc.input.keyboard.prevType, prevCode: sc.input.keyboard.prevCode,
      active: document.activeElement?.tagName + "#" + document.activeElement?.id,
    });
  });
  const stepTo = async (label, until) => {
    await game.keyboard.press("j");
    await game.waitForFunction(until, null, { timeout: 3000 }).catch(async () => { throw new Error(`practice entry stuck at "${label}": players ${await selectState()}`); });
    // A player's first frame ignores input (Phaser replays the joining key press), so leave a few frames between presses.
    await game.waitForTimeout(80);
  };
  await game.evaluate(() => {
    window.__keys = [];
    for (const t of ["keydown", "keyup"]) window.addEventListener(t, (e) => window.__keys.push(`${t}:${e.key}@${e.timeStamp.toFixed(1)}`), true);
  });
  await stepTo("join", () => !!window.photoDojo.scene.getScene("character-select").players[0]);
  await stepTo("pick", () => window.photoDojo.scene.getScene("character-select").players[0]?.ready === true);
  await stepTo("practice", () => window.photoDojo.scene.isActive("stage-select"));
  await stepTo("stage", () => window.photoDojo.scene.isActive("fight"));
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight")?.sim?.practice === true && window.photoDojo.scene.isActive("fight"), null, { timeout: 8000 });
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  check((await game.evaluate(() => window.photoDojo.scene.getScene("fight").dummy.behavior)) === "cpuEasy", "practice opens against the easy CPU");
  await game.keyboard.press("2"); // dummy: block
  check((await game.evaluate(() => window.photoDojo.scene.getScene("fight").dummy.behavior)) === "block", "number keys pick the dummy's behavior");
  await game.keyboard.down("d");
  await game.waitForFunction(() => { const [a, b] = window.photoDojo.scene.getScene("fight").sim.current.fighters; return b.position.x - a.position.x < 140; }, null, { timeout: 8000 });
  await game.keyboard.up("d");
  await game.keyboard.press("j");
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.fighters[1].action === "blockstun", null, { timeout: 2000 });
  await game.screenshot({ path: `${OUT}/07b-practice.png` });
  await game.keyboard.press("1"); // stand still, take hits
  for (let i = 0; i < 5; i++) { await game.keyboard.press("j"); await game.waitForTimeout(300); }
  const hurt = await game.evaluate(() => window.photoDojo.scene.getScene("fight").sim.current.fighters[1].health);
  await game.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.fighters[1].health === 100, null, { timeout: 4000 });
  const timer = await game.evaluate(() => window.photoDojo.scene.getScene("fight").timerText.text);
  check(timer === "PRACTICE" && hurt < 100, `practice: no clock (${timer}), health refills (was ${hurt})`);
  step("practice mode: dummy blocks on command, health refills, no timer");

  // --- capture page renders and reaches the live camera screen with the fake camera ---
  const cap = await ctx.newPage();
  watch(cap, "capture");
  await cap.goto(BASE + "/capture?room=" + roomCode);
  await cap.getByText("Friend holds the phone").click();
  await cap.getByText("Start camera").click();
  // The phone connects to the laptop as soon as the camera starts, not after the poses.
  await cap.waitForSelector(".link-chip[data-state=connected]", { timeout: 30000 });
  await cap.waitForSelector(".capture video", { timeout: 60000 });
  await cap.waitForTimeout(1500);
  const hud = await cap.evaluate(() => ({
    label: document.querySelector("[data-hud=label]")?.textContent,
    hint: document.querySelector("[data-hud=hint]")?.textContent,
    videoWidth: document.querySelector("video")?.videoWidth,
  }));
  check(hud.label === "Fighting stance" && hud.videoWidth > 0, `capture HUD live: ${JSON.stringify(hud)}`);
  step(`capture page live: ${JSON.stringify(hud)}`);
  await cap.screenshot({ path: `${OUT}/08-capture-live.png` });

  // No person in the fake camera: after 10 s the manual fallback appears; capturing fails cleanly and retries the pose.
  await cap.waitForSelector("[data-hud=manual]:not([hidden])", { timeout: 15000 });
  await cap.click("[data-hud=manual]");
  await cap.waitForSelector(".toast", { timeout: 5000 });
  await cap.waitForFunction(() => window.photoDojoCapture.flow.screen.name === "pose", null, { timeout: 8000 });
  step("manual capture with nobody in frame fails gracefully and retries the pose");

  step(`phone pre-connected: ${await cap.textContent(".link-chip")}`);

  // Capture draft: five poses in, reload the page, resume at pose 6.
  const inject = (keys) => cap.evaluate(async (keys) => {
    const { loadPlaceholderFighter } = await import("/src/game/fighter-library.ts");
    const { CAPTURE_TARGETS } = await import("/src/shared/pose-definitions.ts");
    const f = await loadPlaceholderFighter("placeholder-red", "/");
    const app = window.photoDojoCapture;
    for (const t of CAPTURE_TARGETS.filter((t) => keys.includes(t.key))) {
      const pose = t.variant ? f.poseVariants[t.poseId][t.variant - 1] : f.poses[t.poseId];
      const bmp = await createImageBitmap(pose.imageBlob);
      const image = new OffscreenCanvas(512, 512);
      image.getContext("2d").drawImage(bmp, 0, 0);
      app.captures.set(t.key, {
        cut: { image, offsetX: 0, offsetY: 0 },
        geometry: { poseId: t.poseId, landmarks: pose.landmarks.map((l) => ({ x: l.x / 512, y: l.y / 512, visibility: l.visibility })), frameWidth: 512, frameHeight: 512 },
        capturedAt: Date.now(),
        ...(pose.attackSide ? { attackSide: pose.attackSide } : {}),
      });
    }
    await app.renderSprites();
    await app.saveDraftNow();
  }, keys);
  await inject(["idle", "idle-2", "walk", "block", "crouch"]);
  await cap.reload();
  await cap.getByText("Pick up where you left off?").waitFor({ timeout: 10000 });
  check((await cap.textContent(".resume")).includes("5 of 15"), "resume card shows progress");
  await cap.getByText("Resume", { exact: true }).click();
  await cap.getByText("Start camera").click();
  await cap.waitForFunction(() => document.querySelector("[data-hud=step]")?.textContent?.startsWith("6 / 15"), null, { timeout: 60000 });
  step("draft survived a reload: resumed at pose 6 / 15");

  // Fill in the rest and drive the remaining capture UI.
  await inject(["punch", "punch-2", "kick", "kick-2", "jump", "hurt", "hurt-2", "win", "win-2", "handshake"]);
  await cap.evaluate(() => {
    const app = window.photoDojoCapture;
    app.stopLive();
    app.flow = { ...app.flow, screen: { name: "review" } };
    app.render();
  });
  check((await cap.locator(".strip img").count()) === 15, "review strip shows all 15 poses");
  await cap.getByText("Looks good").click();
  await cap.getByText("Battle cry").waitFor();
  await cap.getByText("Skip this one").click();
  await cap.getByText("Skip all sounds").click();
  await cap.getByPlaceholder("Fighter name").fill("Phone Red");
  await cap.waitForTimeout(1200);
  await cap.screenshot({ path: `${OUT}/09-capture-preview.png` });
  await cap.getByText("Send to game").click();
  await cap.getByText("Sent!").waitFor({ timeout: 30000 }).catch(async (e) => {
    await cap.screenshot({ path: `${OUT}/10-send-failed.png` });
    console.log("capture screen:", await cap.evaluate(() => JSON.stringify(window.photoDojoCapture.flow.screen)));
    throw e;
  });
  step("capture UI: review → sounds → preview → Send to game → Sent!");
  await game.waitForFunction(() => window.photoDojo.registry.get("library").some((e) => e.fighter.name === "Phone Red"), null, { timeout: 10000 });
  step("laptop received the fighter sent from the capture page");
  const phoneCopy = await cap.evaluate(async () => {
    const { listFighters } = await import("/src/shared/fighter-storage.ts");
    return (await listFighters()).some((f) => f.name === "Phone Red");
  });
  check(phoneCopy, "phone saved its own copy first");

  const realErrors = errors.filter((e) => !/favicon/.test(e));
  if (realErrors.length) {
    console.log("Page errors:\n" + realErrors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("OK: no page errors");
  }
} catch (err) {
  console.error(err);
  if (errors.length) console.log("Page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
