// Headless browser smoke test of the game, and the Character Studio with its phone camera (/capture) and fighter editing.
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
  await game.waitForFunction(() => window.fotoFighter?.scene.isActive("title"), null, { timeout: 20000 });
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("title").sim?.current.frame > 30, null, { timeout: 10000 });
  step("title screen is up, demo fight running");
  await game.screenshot({ path: `${OUT}/00-title.png` });
  await game.keyboard.press("Enter"); // not a player key: starts without joining anyone
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("character-select"), null, { timeout: 5000 });
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("character-select").players.every((p) => p === null))), "Enter on the title joins nobody");
  step("character select is up");
  const panel = () => game.evaluate(() => window.fotoFighter.scene.getScene("character-select").addObjects.filter((o) => o.type === "Text").map((o) => o.text));
  check((await panel()).includes("Open the studio (N)"), `the Add a fighter panel offers the studio (${JSON.stringify(await panel())})`);
  await game.waitForTimeout(500);
  await game.screenshot({ path: `${OUT}/01-select.png` });

  // --- a test fighter straight into IndexedDB (as the studio or an import would), then /?to=select boots into fighter select ---
  const sent = await game.evaluate(async () => {
    const { loadPlaceholderFighter } = await import("/src/game/fighter-library.ts");
    const { saveFighter } = await import("/src/shared/fighter-storage.ts");
    const f = await loadPlaceholderFighter("placeholder-blue", "/");
    const fighter = { ...f, fighterId: crypto.randomUUID(), name: "Wire Blue", createdAt: Date.now(),
      sounds: { attack: null, hurt: null, win: null } };
    await saveFighter(fighter);
    return { id: fighter.fighterId };
  });
  await game.goto(BASE + "/?to=select");
  await game.waitForFunction(() => window.fotoFighter?.scene.isActive("character-select"), null, { timeout: 20000 });
  check(!(await game.evaluate(() => window.fotoFighter.scene.isActive("title"))) && (await game.evaluate(() => location.search)) === "", "/?to=select opens fighter select (not the title) and drops the parameter");
  check(await game.evaluate((id) => window.fotoFighter.registry.get("library")[0]?.fighter.fighterId === id, sent.id), "the saved fighter is first in the library after the reload");
  const stored = await game.evaluate(async (id) => {
    const { loadFighter } = await import("/src/shared/fighter-storage.ts");
    const f = await loadFighter(id);
    return f ? { name: f.name, kickBytes: f.poses.kick.imageBlob.size, alternates: Object.values(f.poseVariants ?? {}).flat().length } : null;
  }, sent.id);
  check(stored?.name === "Wire Blue" && stored.kickBytes > 1000 && stored.alternates === 5, `test fighter stored with its pose alternates (${JSON.stringify(stored)})`);
  step(`saved a test fighter; /?to=select booted straight into fighter select with it (${JSON.stringify(stored)})`);
  await game.waitForTimeout(400);
  await game.screenshot({ path: `${OUT}/02-select-with-fighter.png` });

  // --- mouse: select a tile, export from the tile's own button, re-import through the toolbar ---
  // First tile of the grid (character-select-scene.ts: GRID_X 40, GRID_Y 116, TILE 120); its buttons sit along its bottom edge.
  const TILE_X = 40, TILE_Y = 116, TILE = 120;
  await clickGame(game, TILE_X + TILE / 2, TILE_Y + TILE / 2); // first tile
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("character-select").selected)) === 0, "clicking a tile selects it");
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/02b-tile-selected.png` });
  const [download] = await Promise.all([game.waitForEvent("download"), clickGame(game, TILE_X + 30, TILE_Y + TILE - 16)]);
  const exportPath = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(exportPath);
  step(`exported ${download.suggestedFilename()}`);
  await game.setInputFiles("#import-file", exportPath);
  await game.waitForFunction(() => /^(Imported|Updated)/.test(document.getElementById("toolbar-status").textContent), null, { timeout: 5000 });
  step("re-imported the exported file");
  // The same fighter again reloads its images (a new revision): let the grid redraw with them before clicking it.
  await game.waitForFunction(() => !window.fotoFighter.scene.getScene("character-select").load.isLoading(), null, { timeout: 5000 });
  await game.waitForTimeout(100);
  // Delete needs a confirm on the tile; "Keep" backs out.
  await clickGame(game, TILE_X + TILE / 2, TILE_Y + TILE / 2);
  await clickGame(game, TILE_X + 96, TILE_Y + TILE - 16); // 🗑
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/02c-delete.png` });
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("character-select").pendingDelete)) !== null, "delete asks to confirm");
  await clickGame(game, TILE_X + 88, TILE_Y + TILE - 16); // Keep
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("character-select").pendingDelete)) === null, "Keep cancels the delete");
  step("mouse: tile select, export button, delete confirm/cancel");
  // ✎ Rename sits along the selected tile's top edge; typing fast mustn't double letters.
  await game.waitForTimeout(400); // a tile ignores clicks for 300 ms after one of its buttons
  await clickGame(game, TILE_X + TILE / 2, TILE_Y + TILE / 2);
  await game.waitForTimeout(100);
  await clickGame(game, TILE_X + 30, TILE_Y + 16);
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("rename"), null, { timeout: 3000 })
    .catch(async () => { throw new Error(`rename didn't open: ${await game.evaluate(() => { const sc = window.fotoFighter.scene.getScene("character-select"); return JSON.stringify({ selected: sc.selected, buttons: sc.tileButtons.map((b) => [b.text, b.x, b.y]), lib: sc.library.slice(0, 2).map((e) => [e.fighter.name, e.builtIn]) }); })}`); });
  for (let i = 0; i < 12; i++) await game.keyboard.press("Backspace");
  await game.keyboard.type(" Wire   Blue II ");
  await game.keyboard.press("Enter");
  await game.waitForFunction(() => /^Renamed/.test(document.getElementById("toolbar-status").textContent), null, { timeout: 5000 });
  const renamed = await game.evaluate(async (id) => {
    const { loadFighter } = await import("/src/shared/fighter-storage.ts");
    return (await loadFighter(id))?.name;
  }, sent.id);
  check(renamed === "Wire Blue II", `rename saved the tidied name (${renamed})`);
  step("mouse: renamed the fighter from its tile");

  // --- pick fighters: P1 keyboard (J), P2 keyboard (,) ---
  await game.click("canvas");
  await game.keyboard.press("j"); // P1 joins
  await game.keyboard.press("Comma"); // P2 joins
  await game.waitForTimeout(100);
  await game.keyboard.press("j"); // P1 ready on tile 0 (newest = Wire Blue II)
  await game.keyboard.press("ArrowRight");
  await game.keyboard.press("ArrowRight");
  await game.waitForTimeout(100);
  await game.screenshot({ path: `${OUT}/03-picking.png` });
  await game.keyboard.press("Comma"); // P2 ready
  // VS, then the stage select (there's more than one stage): P2 moves to the second stage and picks it.
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("stage-select"), null, { timeout: 10000 });
  await game.waitForTimeout(150);
  await game.keyboard.press("ArrowRight");
  await game.waitForTimeout(100);
  const stagePicked = await game.evaluate(() => { const s = window.fotoFighter.scene.getScene("stage-select"); return s.options[s.index]; });
  await game.screenshot({ path: `${OUT}/03a-stage-select.png` });
  await game.keyboard.press("Comma");
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("controls"), null, { timeout: 10000 });
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("controls").setup.stageId)) === stagePicked, `the picked stage (${stagePicked}) goes into the match`);
  step(`stage select: picked ${stagePicked}`);
  await game.waitForTimeout(1200); // let the move previews animate
  await game.screenshot({ path: `${OUT}/03b-controls.png` });
  const cards = await game.evaluate(() => window.fotoFighter.scene.getScene("controls").cards.length);
  check(cards === 18, `controls screen shows 9 move previews per player, the signature move last (${cards})`);
  step("pre-match controls screen with move previews");
  await game.keyboard.press("j"); // P1 ready
  await game.waitForTimeout(100);
  check(await game.evaluate(() => window.fotoFighter.scene.isActive("controls")), "waits for both players");
  await game.keyboard.press("Comma"); // P2 ready
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("fight"), null, { timeout: 10000 });
  step("fight started");
  const fight = () => game.evaluate(() => {
    const s = window.fotoFighter.scene.getScene("fight").sim.current;
    return { phase: s.round.phase, f: s.fighters.map((f) => ({ x: Math.round(f.position.x), action: f.action, health: f.health })) };
  });
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  const variants = await game.evaluate(() => {
    const scene = window.fotoFighter.scene.getScene("fight");
    return { punch: scene.geometry[1].variants?.punch?.length ?? 0, texture: scene.textures.exists("p1:pose:punch#1") };
  });
  check(variants.punch === 1 && variants.texture, `built-in fighter has a punch alternate loaded (${JSON.stringify(variants)})`);
  step("pose alternates loaded for the built-in fighter");
  const start = await fight();
  // Walk until in punch range (the fighters start most of the stage apart).
  await game.keyboard.down("d");
  await game.waitForFunction(() => {
    const [a, b] = window.fotoFighter.scene.getScene("fight").sim.current.fighters;
    return Math.abs(b.position.x - a.position.x) < 220;
  }, null, { timeout: 8000 }).catch(() => {});
  await game.keyboard.up("d");
  const walked = await fight();
  if (walked.f[0].x <= start.f[0].x + 100) {
    console.log("walk debug", await game.evaluate(() => {
      const sc = window.fotoFighter.scene.getScene("fight");
      const src = sc.sources[0];
      const d = src.keys?.right?.[0];
      return JSON.stringify({ src: src.id, read: src.read(), dKey: d && { isDown: d.isDown, code: d.keyCode }, active: window.fotoFighter.scene.getScenes(true).map((x) => x.sys.settings.key), paused: sc.paused, phase: sc.sim.current.round.phase, inputs: sc.setup.inputs });
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
  check(await game.evaluate(() => window.fotoFighter.scene.getScene("fight").debug.visible), "F1 shows hitboxes");
  await game.keyboard.down("k");
  await game.waitForTimeout(150);
  await game.screenshot({ path: `${OUT}/05-kick-hitboxes.png` });
  await game.keyboard.up("k");
  await game.keyboard.press("Escape");
  await game.waitForTimeout(200);
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("fight").paused)) === true, "Esc pauses");
  check(await game.evaluate(() => window.fotoFighter.scene.isActive("pause")), "Esc opens the pause menu");
  await game.screenshot({ path: `${OUT}/06-paused.png` });
  await game.keyboard.press("Escape");
  await game.waitForTimeout(150);
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("fight").paused)) === false, "Esc again resumes");

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
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").replay !== null, null, { timeout: 8000 });
  await game.waitForTimeout(1500);
  await game.screenshot({ path: `${OUT}/06b-ko-replay.png` });
  const replayFrames = await game.evaluate(() => window.fotoFighter.scene.getScene("fight").replay.states.length);
  check(replayFrames > 60, `KO replay has the lead-up (${replayFrames} frames)`);
  step(`KO replay playing (${replayFrames} frames, slow motion)`);
  await game.keyboard.press("j"); // skip
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("round-result"), null, { timeout: 5000 });
  step("skipped the replay → round result screen");
  await game.screenshot({ path: `${OUT}/07-round-result.png` });
  await game.waitForTimeout(800);
  await game.keyboard.press("j");
  // Well before the screen's own 3.5 s auto-continue: the press has to work.
  await game.waitForFunction(() => {
    const s = window.fotoFighter.scene.getScene("fight").sim.current.round;
    return s.roundNumber === 2 && !window.fotoFighter.scene.isActive("round-result");
  }, null, { timeout: 1500 });
  step("punch on the round result → round 2 started");

  // New moves through the real keyboard: S+J uppercut, J+K throw.
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  const actionOf = () => game.evaluate(() => window.fotoFighter.scene.getScene("fight").sim.current.fighters.map((f) => f.action));
  await game.keyboard.down("s");
  await game.keyboard.press("j");
  await game.waitForTimeout(50);
  const upper = await actionOf();
  await game.keyboard.up("s");
  check(upper[0] === "uppercut", `S+J starts an uppercut (${upper[0]})`);
  await game.waitForTimeout(600);
  // Sides swap every round: in round 2 P1 starts on the right.
  const p1OnRight = await game.evaluate(() => { const [a, b] = window.fotoFighter.scene.getScene("fight").sim.current.fighters; return a.position.x > b.position.x; });
  check(p1OnRight, "players swapped sides for round 2");
  const toward = p1OnRight ? "a" : "d";
  await game.keyboard.down(toward);
  await game.waitForFunction(() => {
    const [a, b] = window.fotoFighter.scene.getScene("fight").sim.current.fighters;
    return Math.abs(b.position.x - a.position.x) < 90;
  }, null, { timeout: 8000 });
  await game.keyboard.up(toward);
  await game.waitForTimeout(100);
  const before = await game.evaluate(() => window.fotoFighter.scene.getScene("fight").sim.current.fighters[1].health);
  await game.keyboard.down("j");
  await game.keyboard.down("k");
  await game.waitForTimeout(40);
  await game.keyboard.up("j");
  await game.keyboard.up("k");
  await game.waitForFunction((hp) => window.fotoFighter.scene.getScene("fight").sim.current.fighters[1].health < hp, before, { timeout: 3000 });
  step("J+K throw lands on the idle opponent");

  // --- finish the match (P2 down to 1 health: the next clean hit is the KO) → stats page → rematch ---
  await game.evaluate(() => {
    const sim = window.fotoFighter.scene.getScene("fight").sim; // poking the private state: only to keep the test short
    sim.state = { ...sim.state, fighters: [sim.state.fighters[0], { ...sim.state.fighters[1], health: 1 }] };
  });
  const phaseNow = () => game.evaluate(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase);
  for (let i = 0; i < 60 && (await phaseNow()) === "fighting"; i++) {
    await game.keyboard.down(toward);
    await game.waitForTimeout(120);
    await game.keyboard.up(toward);
    await game.keyboard.press("j");
    await game.waitForTimeout(200);
  }
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "matchOver", null, { timeout: 15000 });
  await game.waitForTimeout(2500);
  await game.keyboard.press("j"); // skip the KO replay
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("match-result"), null, { timeout: 8000 });
  const matchStats = await game.evaluate(() => window.fotoFighter.scene.getScene("match-result").result.stats);
  check(matchStats.rounds.length === 2 && matchStats.players[0].roundsWon === 2, `stats page: P1 won both rounds (${JSON.stringify(matchStats.rounds)})`);
  check(matchStats.players[0].hits > 0 && matchStats.players[0].throws >= 1 && matchStats.players[0].damageDealt === 200, `stats page counts P1's hits, throw and damage (${JSON.stringify(matchStats.players[0])})`);
  await game.waitForTimeout(1300); // past the page's input delay
  await game.screenshot({ path: `${OUT}/08-match-result.png` });
  await game.keyboard.press("j");
  await game.waitForFunction(() => {
    const r = window.fotoFighter.scene.getScene("fight").sim?.current.round;
    return !window.fotoFighter.scene.isActive("match-result") && r?.roundNumber === 1 && r.wins[0] === 0 && r.wins[1] === 0;
  }, null, { timeout: 3000 });
  step(`match over → stats page (${matchStats.players[0].hits} clean hits, ${matchStats.players[0].throws} throw) → punch: rematch`);
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });

  // --- vs CPU, then practice: quit to select (pause menu: up from Resume wraps to Quit); one player picks, punch opens the CPU's slot ---
  await game.keyboard.press("Escape");
  await game.waitForTimeout(150);
  await game.keyboard.press("w");
  await game.waitForTimeout(80);
  await game.keyboard.press("j");
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("character-select"), null, { timeout: 5000 });
  await game.waitForTimeout(300);
  const selectState = () => game.evaluate(() => {
    const sc = window.fotoFighter.scene.getScene("character-select");
    return JSON.stringify({
      players: sc.players.map((p) => p && { ready: p.ready, cursor: p.cursor, prev: p.previous, input: p.input }),
      active: sc.sys.isActive(), status: sc.sys.settings.status, scenes: window.fotoFighter.scene.getScenes(true).map((x) => x.sys.settings.key),
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
  const cpuSlot = () => game.evaluate(() => window.fotoFighter.scene.getScene("character-select").cpu);
  const press = async (key) => { await game.keyboard.press(key); await game.waitForTimeout(80); };
  await stepTo("join", () => !!window.fotoFighter.scene.getScene("character-select").players[0]);
  await stepTo("pick", () => window.fotoFighter.scene.getScene("character-select").players[0]?.ready === true);
  await stepTo("opponent", () => !!window.fotoFighter.scene.getScene("character-select").cpu);
  const opened = await cpuSlot();
  check(opened.slot === 1 && !opened.picked, `punch opens the CPU's slot (${JSON.stringify(opened)})`);
  await press("d");
  check((await cpuSlot()).cursor === (opened.cursor + 1) % (await game.evaluate(() => window.fotoFighter.scene.getScene("character-select").library.length)), "the player's controller moves the CPU's cursor");
  const opponentId = await game.evaluate(() => { const sc = window.fotoFighter.scene.getScene("character-select"); return sc.library[sc.cpu.cursor].fighter.fighterId; });
  await stepTo("cpu pick", () => window.fotoFighter.scene.getScene("character-select").cpu?.picked === true);
  await press("d"); // level: easy → normal
  await stepTo("cpu match", () => window.fotoFighter.scene.isActive("stage-select"));
  await stepTo("cpu stage", () => window.fotoFighter.scene.isActive("controls"));
  await game.waitForTimeout(600); // the controls screen ignores input at first
  await stepTo("cpu ready", () => window.fotoFighter.scene.isActive("fight"));
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 8000 });
  const vsCpu = await game.evaluate(() => {
    const f = window.fotoFighter.scene.getScene("fight");
    return { input: f.setup.inputs[1], behavior: f.dummy.behavior, practice: f.sim.practice, opponent: f.setup.entries[1].fighter.fighterId, timer: f.timerText.text };
  });
  check(vsCpu.input.kind === "cpu" && vsCpu.input.level === "normal" && vsCpu.behavior === "cpuNormal" && !vsCpu.practice && vsCpu.timer !== "PRACTICE",
    `a real match against the normal CPU (${JSON.stringify(vsCpu)})`);
  check(vsCpu.opponent === opponentId, "against the fighter the player chose");
  // The CPU fights back on its own.
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").stats.result.players[1].attacks > 0, null, { timeout: 10000 });
  step("vs CPU: chose the opponent and level, then a match with a clock against a CPU that attacks");
  await game.keyboard.press("Escape");
  await game.waitForTimeout(150);
  await game.keyboard.press("w");
  await game.waitForTimeout(80);
  await game.keyboard.press("j");
  await game.waitForFunction(() => window.fotoFighter.scene.isActive("character-select"), null, { timeout: 5000 });
  await game.waitForTimeout(300);

  await stepTo("join again", () => !!window.fotoFighter.scene.getScene("character-select").players[0]);
  await stepTo("pick again", () => window.fotoFighter.scene.getScene("character-select").players[0]?.ready === true);
  await stepTo("opponent again", () => !!window.fotoFighter.scene.getScene("character-select").cpu);
  await stepTo("practice opponent", () => window.fotoFighter.scene.getScene("character-select").cpu?.picked === true);
  await press("s"); // Practice
  await stepTo("practice", () => window.fotoFighter.scene.isActive("stage-select"));
  await stepTo("stage", () => window.fotoFighter.scene.isActive("fight"));
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight")?.sim?.practice === true && window.fotoFighter.scene.isActive("fight"), null, { timeout: 8000 });
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("fight").dummy.behavior)) === "cpuEasy", "practice opens against the easy CPU");
  await game.keyboard.press("2"); // dummy: block
  check((await game.evaluate(() => window.fotoFighter.scene.getScene("fight").dummy.behavior)) === "block", "number keys pick the dummy's behavior");
  await game.keyboard.down("d");
  await game.waitForFunction(() => { const [a, b] = window.fotoFighter.scene.getScene("fight").sim.current.fighters; return b.position.x - a.position.x < 140; }, null, { timeout: 8000 });
  await game.keyboard.up("d");
  await game.keyboard.press("j");
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.fighters[1].action === "blockstun", null, { timeout: 2000 });
  await game.screenshot({ path: `${OUT}/07b-practice.png` });
  await game.keyboard.press("1"); // stand still, take hits
  for (let i = 0; i < 5; i++) { await game.keyboard.press("j"); await game.waitForTimeout(300); }
  const hurt = await game.evaluate(() => window.fotoFighter.scene.getScene("fight").sim.current.fighters[1].health);
  await game.waitForFunction(() => window.fotoFighter.scene.getScene("fight").sim.current.fighters[1].health === 100, null, { timeout: 4000 });
  const timer = await game.evaluate(() => window.fotoFighter.scene.getScene("fight").timerText.text);
  check(timer === "PRACTICE" && hurt < 100, `practice: no clock (${timer}), health refills (was ${hurt})`);
  step("practice mode: dummy blocks on command, health refills, no timer");

  // --- phone camera page (/capture): code entry (with a link to the studio on a computer), then the camera starts ---
  const cam = await ctx.newPage();
  watch(cam, "camera");
  await cam.goto(BASE + "/capture");
  await cam.getByText("Enter the code the studio shows").waitFor({ timeout: 15000 });
  check((await cam.getByRole("link", { name: "Open the studio" }).getAttribute("href")) === "/studio", "/capture on a computer links to the studio");
  await cam.fill("#studio-code", "nope");
  await cam.getByRole("button", { name: "Connect" }).click();
  await cam.getByText("That isn't a studio code").waitFor({ timeout: 5000 });
  await cam.screenshot({ path: `${OUT}/11-camera-code-entry.png` });
  step("/capture shows code entry and rejects a bad code");
  await cam.fill("#studio-code", "zz2345");
  await cam.getByRole("button", { name: "Connect" }).click();
  await cam.waitForFunction(() => document.querySelector("video.preview")?.videoWidth > 0, null, { timeout: 15000 });
  const camState = await cam.evaluate(() => ({ url: location.search, headline: document.querySelector(".headline")?.textContent }));
  check(camState.url === "?room=ZZ2345" && camState.headline === "Connecting to the studio…", `camera page live: ${JSON.stringify(camState)}`);
  step(`/capture opened the camera and is waiting for studio ZZ2345`);
  await cam.close();

  // --- Character Studio (/studio, docs/character-studio.md) ---
  // A /capture?room= tab streams to the studio: the video arrives, a still comes back as a PNG at the phone camera's size,
  // and a phone that drops pauses the studio on "Phone disconnected" until it reconnects on the same code by itself.
  const studio = await ctx.newPage();
  watch(studio, "studio");
  await studio.goto(BASE + "/studio");
  // First visit: "How it works" before setup; skipped, it stays skipped (later studio pages share this browser).
  await studio.locator(".intro-canvas").waitFor();
  await studio.click("[data-action=skip-intro]");
  await studio.click("[data-camera=phone]");
  await studio.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.querySelector("[data-room-code]")?.textContent ?? ""), null, { timeout: 10000 });
  const studioCode = await studio.textContent("[data-room-code]");
  await studio.waitForSelector("img.qr", { timeout: 10000 });
  check(await studio.evaluate(() => window.fotoFighterStudio.cameraEnv().phone.url.endsWith("/capture?room=" + window.fotoFighterStudio.phoneHost.roomCode)), "the studio's QR opens /capture?room=CODE");
  await studio.waitForFunction(() => window.fotoFighterStudio.phoneHost.status.kind === "waiting", null, { timeout: 10000 });
  await studio.screenshot({ path: `${OUT}/12-studio-phone-setup.png` });
  step(`studio opened room ${studioCode} for a phone`);
  const phoneCam = await ctx.newPage();
  watch(phoneCam, "phone camera");
  await phoneCam.goto(BASE + "/capture?room=" + studioCode);
  await studio.waitForFunction(() => { const s = window.fotoFighterStudio.source; return s?.kind === "phone" && s.status.kind === "ready" && s.video.videoWidth > 0; }, null, { timeout: 30000 });
  await phoneCam.waitForFunction(() => document.querySelector(".headline")?.textContent === "Streaming to the studio", null, { timeout: 10000 });
  const phoneVideo = await phoneCam.evaluate(() => ({ width: document.querySelector("video.preview").videoWidth, height: document.querySelector("video.preview").videoHeight }));
  const remoteStill = await studio.evaluate(async () => {
    const source = window.fotoFighterStudio.source;
    const raw = await source.link.requestStill({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, 3);
    const magic = Array.from(new Uint8Array(await raw.blob.slice(0, 8).arrayBuffer()));
    const { frame, sharpness } = await source.grabStill(null, 3);
    return { mime: raw.blob.type, width: raw.width, height: raw.height, bytes: raw.blob.size, magic, frame: [frame.width, frame.height], sharpness: sharpness.length, live: [source.width, source.height] };
  });
  check(remoteStill.mime === "image/png" && remoteStill.magic.join() === "137,80,78,71,13,10,26,10", `the phone's still is a PNG (${JSON.stringify(remoteStill)})`);
  check(remoteStill.width === phoneVideo.width && remoteStill.height === phoneVideo.height && remoteStill.frame.join() === `${phoneVideo.width},${phoneVideo.height}` && remoteStill.sharpness === 3,
    `still at the phone camera's size ${JSON.stringify(phoneVideo)}: ${JSON.stringify(remoteStill)}`);
  step(`phone video reached the studio (${remoteStill.live.join("×")}); still request → ${remoteStill.width}×${remoteStill.height} PNG, ${(remoteStill.bytes / 1024).toFixed(0)} KB`);
  await studio.screenshot({ path: `${OUT}/13-studio-phone-ready.png` });
  await studio.click("[data-mode=helped]");
  await studio.click("[data-action=start]");
  await studio.click("[data-archetype=guardian]"); // the style comes first
  await studio.getByText("Let's go").click();
  await studio.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "pose", null, { timeout: 90000 });
  await phoneCam.waitForFunction(() => document.body.innerText.includes("Pose 1/16 — Fighting stance"), null, { timeout: 10000 });
  await studio.waitForTimeout(1000);
  await studio.screenshot({ path: `${OUT}/14-studio-phone-live.png` });
  step("studio live on the phone's video; the phone shows the studio's status line");
  // The phone drops without a bye (as when Wi-Fi blips).
  await phoneCam.evaluate(() => window.fotoFighterCamera.connection.session.lose("e2e: link dropped"));
  await studio.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "cameraLost", null, { timeout: 15000 });
  await studio.screenshot({ path: `${OUT}/15-studio-phone-lost.png` });
  check((await studio.textContent("[data-room-code]")) === studioCode, "the studio shows the same code again");
  await studio.waitForFunction(() => {
    const app = window.fotoFighterStudio;
    return app.flow.screen.name === "pose" && app.flow.screen.poseIndex === 0 && app.source?.status.kind === "ready";
  }, null, { timeout: 30000 });
  check((await studio.evaluate(() => window.fotoFighterStudio.phoneHost.roomCode)) === studioCode, "reconnected on the same room code");
  await phoneCam.waitForFunction(() => document.querySelector(".headline")?.textContent === "Streaming to the studio", null, { timeout: 10000 });
  step("phone dropped → studio on cameraLost → phone reconnected on the same code → back on pose 1");
  // Leaving the studio says bye: the phone stops retrying.
  await studio.goto("about:blank");
  await phoneCam.waitForFunction(() => document.querySelector(".headline")?.textContent === "The studio closed", null, { timeout: 15000 });
  step("left the studio → the phone shows “The studio closed”");
  await phoneCam.close();
  await studio.close();

  // The studio with this computer's camera (Chrome's fake one): live, then injected captures through to a saved fighter.
  const local = await ctx.newPage();
  watch(local, "studio local");
  await local.goto(BASE + "/studio");
  await local.click("[data-camera=local]");
  await local.waitForFunction(() => { const s = window.fotoFighterStudio.source; return s?.kind === "local" && s.status.kind === "ready"; }, null, { timeout: 15000 });
  await local.click("[data-action=start]");
  await local.click("[data-archetype=guardian]");
  await local.getByText("Let's go").click();
  await local.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "pose", null, { timeout: 90000 });
  await local.waitForTimeout(1000);
  const localHud = await local.evaluate(() => ({ label: document.querySelector("[data-hud=label]")?.textContent, videoWidth: document.querySelector(".live video")?.videoWidth }));
  check(localHud.label === "Fighting stance" && localHud.videoWidth > 0, `studio live on the local camera: ${JSON.stringify(localHud)}`);
  await local.screenshot({ path: `${OUT}/16-studio-local-live.png` });
  step(`studio live on this computer's camera: ${JSON.stringify(localHud)}`);
  await local.evaluate(async () => {
    const { loadPlaceholderFighter } = await import("/src/game/fighter-library.ts");
    const { captureTargetsFor } = await import("/src/shared/pose-definitions.ts");
    const f = await loadPlaceholderFighter("placeholder-green", "/");
    const app = window.fotoFighterStudio;
    for (const t of captureTargetsFor(f.archetype)) {
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
    app.stopLive();
    app.flow = { ...app.flow, archetype: f.archetype, screen: { name: "review" } };
    app.render();
  });
  check((await local.locator(".strip img").count()) === 16, "studio review strip shows all 16 poses");
  await local.screenshot({ path: `${OUT}/17-studio-review.png` });
  await local.getByText("Looks good").click();
  await local.getByText("Battle cry").waitFor();
  await local.getByText("Skip all sounds").click();
  await local.getByPlaceholder("Fighter name").fill("Studio Green");
  await local.waitForTimeout(800);
  await local.screenshot({ path: `${OUT}/18-studio-preview.png` });
  await local.getByText("Save fighter").click();
  await local.getByRole("heading", { name: "Saved" }).waitFor({ timeout: 15000 });
  const saved = await local.evaluate(async () => {
    const { listFighters, loadFighterSources, loadDraft } = await import("/src/shared/fighter-storage.ts");
    const f = (await listFighters()).find((x) => x.name === "Studio Green");
    const sources = f && await loadFighterSources(f.fighterId);
    return f ? { id: f.fighterId, sources: sources?.captures.length, draft: (await loadDraft()) ?? null } : null;
  });
  check(saved?.sources === 16 && saved.draft === null, `studio saved the fighter with its 16 sources and dropped the draft (${JSON.stringify(saved)})`);
  await local.screenshot({ path: `${OUT}/19-studio-saved.png` });
  step("studio: review → sounds → preview → Save → saved with its sources");
  // "Back to the game" goes to /?to=select: fighter select, with the new fighter loaded at boot.
  await local.getByRole("link", { name: "Back to the game" }).last().click();
  await local.waitForFunction(() => window.fotoFighter?.scene.isActive("character-select"), null, { timeout: 20000 });
  check(await local.evaluate((id) => window.fotoFighter.registry.get("library").some((e) => e.fighter.fighterId === id && e.fighter.name === "Studio Green"), saved.id), "back in the game, the studio's fighter is in the library");
  step("studio → Back to the game → fighter select with the studio's fighter");
  // The panel is compact now (there are captured fighters): its "Open the studio" sits beside the previews.
  await local.waitForTimeout(800); // past the intro
  const studioButton = await local.evaluate(() => {
    const b = window.fotoFighter.scene.getScene("character-select").addObjects.find((o) => o.text === "Open the studio (N)");
    return b && { x: b.x, y: b.y + b.height / 2 };
  });
  check(studioButton, "fighter select has an Open the studio button");
  await local.screenshot({ path: `${OUT}/20-select-back-from-studio.png` });
  await Promise.all([local.waitForURL(/\/studio$/, { timeout: 10000 }), clickGame(local, studioButton.x, studioButton.y)]);
  await local.waitForSelector("[data-camera=phone]", { timeout: 15000 });
  step("fighter select → Open the studio → /studio");

  // --- editing saved fighters (docs/character-studio.md §6) ---
  await local.goto(BASE + "/studio?edit=not-a-fighter");
  await local.getByText("That fighter isn't on this computer").waitFor({ timeout: 15000 });
  step("/studio?edit= with an unknown id: “That fighter isn't on this computer”");
  // Wire Blue II was saved straight into storage: no sources, so no single retakes.
  await local.goto(BASE + "/studio?edit=" + sent.id);
  await local.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "review", null, { timeout: 15000 });
  const sourceless = await local.evaluate(() => ({
    edit: window.fotoFighterStudio.flow.edit,
    images: document.querySelectorAll(".strip img").length,
    enabled: document.querySelectorAll(".strip button:not(:disabled)").length,
    recapture: !!document.querySelector("[data-action=recapture-all]"),
    heading: document.querySelector("h2")?.textContent,
  }));
  check(sourceless.edit?.hasSources === false && sourceless.images === 16 && sourceless.enabled === 0 && sourceless.recapture && sourceless.heading === "Editing Wire Blue II",
    `a fighter without sources opens for rename / sounds / capture everything again (${JSON.stringify(sourceless)})`);
  await local.screenshot({ path: `${OUT}/21-studio-edit-sourceless.png` });
  step("editing a fighter without sources: its sprites shown, single retakes off, “Capture all poses again”");

  // The studio's fighter, from its tile's Edit: retake one pose (injected), rename, save. Same id, its record kept.
  await local.evaluate(async (id) => {
    const { getSetting, setSetting } = await import("/src/shared/fighter-storage.ts");
    await setSetting("fighterRecords", { ...((await getSetting("fighterRecords")) ?? {}), [id]: { matches: 2, wins: 1, losses: 1 } });
  }, saved.id);
  const beforeEdit = await local.evaluate(async (id) => {
    const { listFighters, loadFighter, loadFighterSources } = await import("/src/shared/fighter-storage.ts");
    const f = await loadFighter(id);
    const sources = await loadFighterSources(id);
    return { count: (await listFighters()).length, createdAt: f.createdAt, kick: Array.from(new Uint8Array(await f.poses.kick.imageBlob.arrayBuffer())).join(), kickAt: sources.captures.find((c) => c.key === "kick").capturedAt };
  }, saved.id);
  await local.goto(BASE + "/?to=select");
  await local.waitForFunction(() => window.fotoFighter?.scene.isActive("character-select"), null, { timeout: 20000 });
  await local.waitForTimeout(800); // past the intro
  const tile = await local.evaluate((id) => {
    const sc = window.fotoFighter.scene.getScene("character-select");
    return sc.tilePosition(sc.library.findIndex((e) => e.fighter.fighterId === id));
  }, saved.id);
  await clickGame(local, tile.x + TILE / 2, tile.y + TILE / 2);
  await local.waitForTimeout(100);
  await local.screenshot({ path: `${OUT}/22-select-edit-button.png` });
  const editButton = await local.evaluate(() => {
    const b = window.fotoFighter.scene.getScene("character-select").tileButtons.find((o) => o.text === "✂ Edit");
    return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  check(editButton, "the selected captured fighter's tile has Edit");
  await Promise.all([local.waitForURL((u) => u.pathname === "/studio" && u.searchParams.get("edit") === saved.id, { timeout: 10000 }), clickGame(local, editButton.x, editButton.y)]);
  await local.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "review", null, { timeout: 15000 });
  check(await local.evaluate(() => window.fotoFighterStudio.flow.edit?.hasSources === true && document.querySelectorAll(".strip button:not(:disabled)").length === 16), "the studio's fighter opens with its sources: every pose can be retaken");
  step("fighter select → ✂ Edit → /studio?edit=<id> on the review");
  await local.click('.strip [data-key="kick"]');
  await local.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "camera", null, { timeout: 5000 });
  await local.click("[data-camera=local]");
  await local.waitForFunction(() => { const s = window.fotoFighterStudio.flow.screen; return s.name === "pose" && s.retake && window.fotoFighterStudio.source?.status.kind === "ready"; }, null, { timeout: 15000 });
  await local.evaluate(async () => {
    const { loadPlaceholderFighter } = await import("/src/game/fighter-library.ts");
    const pose = (await loadPlaceholderFighter("placeholder-red", "/")).poses.kick;
    const app = window.fotoFighterStudio;
    const bmp = await createImageBitmap(pose.imageBlob);
    const image = new OffscreenCanvas(512, 512);
    image.getContext("2d").drawImage(bmp, 0, 0);
    app.stopLive();
    app.captures.set("kick", {
      cut: { image, offsetX: 0, offsetY: 0 },
      geometry: { poseId: "kick", landmarks: pose.landmarks.map((l) => ({ x: l.x / 512, y: l.y / 512, visibility: l.visibility })), frameWidth: 512, frameHeight: 512 },
      capturedAt: Date.now(),
      ...(pose.attackSide ? { attackSide: pose.attackSide } : {}),
    });
    await app.renderSprites();
    app.dispatch({ type: "poseCaptured" });
    app.dispatch({ type: "graceElapsed" });
  });
  await local.waitForFunction(() => window.fotoFighterStudio.flow.screen.name === "review", null, { timeout: 5000 });
  await local.getByText("Next: sounds").click();
  await local.getByText("Skip all sounds").click();
  await local.getByPlaceholder("Fighter name").fill("Studio Green II");
  await local.getByText("Save changes").click();
  await local.getByRole("heading", { name: "Saved" }).waitFor({ timeout: 15000 });
  await local.screenshot({ path: `${OUT}/23-studio-edit-saved.png` });
  const afterEdit = await local.evaluate(async (id) => {
    const { getSetting, listFighters, loadFighter, loadFighterSources, loadDraft } = await import("/src/shared/fighter-storage.ts");
    const f = await loadFighter(id);
    const sources = await loadFighterSources(id);
    return {
      count: (await listFighters()).length, name: f.name, createdAt: f.createdAt,
      kick: Array.from(new Uint8Array(await f.poses.kick.imageBlob.arrayBuffer())).join(),
      sources: sources.captures.length, kickAt: sources.captures.find((c) => c.key === "kick").capturedAt,
      record: (await getSetting("fighterRecords"))?.[id], draft: (await loadDraft()) ?? null,
    };
  }, saved.id);
  check(afterEdit.count === beforeEdit.count && afterEdit.name === "Studio Green II" && afterEdit.createdAt === beforeEdit.createdAt,
    `the edit saved over the same fighter (${afterEdit.count} fighters, was ${beforeEdit.count}; ${afterEdit.name}; createdAt kept: ${afterEdit.createdAt === beforeEdit.createdAt})`);
  check(afterEdit.kick !== beforeEdit.kick && afterEdit.sources === 16 && afterEdit.kickAt > beforeEdit.kickAt, `the retaken kick is in the fighter and its sources (sources ${afterEdit.sources})`);
  check(afterEdit.record?.matches === 2 && afterEdit.draft === null, `its career record is kept, and no draft was written (${JSON.stringify({ record: afterEdit.record, draft: afterEdit.draft })})`);
  step("edited: retook the kick, renamed, saved over the same id with its sources; career record kept");
  await local.getByRole("link", { name: "Back to the game" }).last().click();
  await local.waitForFunction(() => window.fotoFighter?.scene.isActive("character-select"), null, { timeout: 20000 });
  check(await local.evaluate((id) => window.fotoFighter.registry.get("library").filter((e) => e.fighter.fighterId === id).map((e) => e.fighter.name).join() === "Studio Green II", saved.id), "back in the game, the edited fighter is in the library once, renamed");
  step("studio → Back to the game → the edited fighter in the library");
  await local.close();

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
