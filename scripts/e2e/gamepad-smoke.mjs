// Headless check of gamepad input and rumble with a virtual standard-mapping pad.
//   node scripts/e2e/gamepad-smoke.mjs [http://localhost:5173]
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://localhost:5173";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const step = (msg) => console.log("•", msg);
const check = (cond, msg) => { if (!cond) throw new Error("CHECK FAILED: " + msg); };
const errors = [];

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const rumbleLog = [];
  page.on("console", (m) => { if (m.text().startsWith("[rumble]")) rumbleLog.push(m.text()); });
  // A fake Xbox-style pad at index 1 (nothing at 0, like a lone controller the browser numbers 2),
  // with a vibration actuator that records every effect.
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    window.__rumbles = [];
    window.__staleRumbles = 0;
    let timestamp = performance.now();
    let generation = 0;
    // Like Chrome: every getGamepads() call returns a fresh snapshot, and only the newest
    // snapshot's vibration actuator works (older ones reject).
    const snapshot = () => {
      const mine = ++generation;
      return {
        id: "Virtual Pad (STANDARD GAMEPAD)", index: 1, connected: true, mapping: "standard", timestamp,
        buttons: buttons.map((b) => ({ ...b })), axes: [0, 0, 0, 0],
        vibrationActuator: {
          type: "dual-rumble",
          playEffect: (type, params) => {
            if (mine !== generation) { window.__staleRumbles++; return Promise.reject(new DOMException("stale gamepad", "InvalidStateError")); }
            window.__rumbles.push({ type, ...params });
            return Promise.resolve("complete");
          },
        },
      };
    };
    window.__pad = snapshot();
    window.__press = (i, down) => { buttons[i].pressed = down; buttons[i].value = down ? 1 : 0; timestamp = performance.now(); };
    // window.__unplugged simulates pulling the cable: the browser stops listing the pad.
    navigator.getGamepads = () => (window.__unplugged ? [null, null, null, null] : [null, (window.__pad = snapshot()), null, null]);
  });
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.photoDojo?.scene.isActive("title"), null, { timeout: 20000 });
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event("gamepadconnected"), { gamepad: window.__pad })));
  const tap = async (button) => {
    await page.evaluate((b) => window.__press(b, true), button);
    await page.waitForTimeout(80);
    await page.evaluate((b) => window.__press(b, false), button);
    await page.waitForTimeout(120);
  };
  const sel = () => page.evaluate(() => window.photoDojo.scene.getScene("character-select").players[0]);

  await tap(0); // A on the title: straight to fighter select, joined as P1
  await page.waitForFunction(() => window.photoDojo.scene.isActive("character-select") && window.photoDojo.scene.getScene("character-select").players[0]?.input.kind === "pad", null, { timeout: 3000 });
  check(!(await page.evaluate(() => window.photoDojo.scene.getScene("character-select").players[0].ready)), "the start press doesn't also pick");
  check((await page.evaluate(() => window.__rumbles.length)) >= 1, "joining buzzes the pad");
  step(`pad joined as P1 (${JSON.stringify((await sel()).input)}), with a confirmation rumble`);

  await tap(15); // d-pad right: move the cursor
  check((await sel()).cursor === 1, "d-pad moves the cursor");
  await tap(0); // A: pick
  check((await sel()).ready, "A picks");
  await tap(0); // A again: practice
  await page.waitForFunction(() => window.photoDojo.scene.getScene("fight")?.sim?.practice === true, null, { timeout: 5000 });
  await page.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.round.phase === "fighting", null, { timeout: 5000 });
  step("A ×2 started practice (the scene change survives a pad at index 1)");

  // Dummy punches; walk the pad's fighter into it and get hit.
  await page.keyboard.press("6"); // dummy: punch
  await page.evaluate(() => window.__rumbles.splice(0));
  await page.evaluate(() => window.__press(15, true)); // hold right
  await page.waitForFunction(() => window.photoDojo.scene.getScene("fight").sim.current.fighters[0].action === "hurt", null, { timeout: 8000 });
  await page.evaluate(() => window.__press(15, false));
  await page.waitForTimeout(200);
  // Keep taking hits: every one should rumble, not just the first.
  await page.evaluate(() => window.__press(15, true));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__press(15, false));
  const { rumbles, stale } = await page.evaluate(() => ({ rumbles: window.__rumbles, stale: window.__staleRumbles }));
  check(rumbles.length >= 3, `rumble keeps working hit after hit (${rumbles.length} rumbles)`);
  check(stale === 0, `no rumble went to a stale gamepad snapshot (${stale})`);
  step(`getting hit rumbled ${rumbles.length} times in a row, none lost (first: ${JSON.stringify(rumbles[0])})`);
  check(rumbleLog.some((l) => l.endsWith("complete")), `the console reports each effect's result (${rumbleLog.slice(-2).join(" | ")})`);
  step(`console diagnostics: ${rumbleLog.at(-1)}`);

  // Pause with Start, turn rumble off with R, unpause: no more rumble.
  await tap(9);
  check(await page.evaluate(() => window.photoDojo.scene.getScene("fight").paused), "Start pauses");
  await page.keyboard.press("r");
  await tap(9);
  await page.evaluate(() => window.__rumbles.splice(0));
  await page.evaluate(() => window.__press(15, true));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__press(15, false));
  check((await page.evaluate(() => window.__rumbles.length)) === 0, "rumble off means no rumble");
  check((await page.evaluate(async () => (await import("/src/shared/fighter-storage.ts")).getSetting("rumble"))) === false, "the setting is saved");
  step("Start pauses; R turns rumble off (and it's remembered)");

  // Unplug mid-fight: the game pauses and says so; any button on the pad brings it back.
  const fightState = () => page.evaluate(() => {
    const f = window.photoDojo.scene.getScene("fight");
    return { paused: f.paused, disconnected: f.disconnectedPlayer, menu: window.photoDojo.scene.isActive("pause") };
  });
  check(!(await fightState()).paused, "back in the fight before unplugging");
  await page.evaluate(() => { window.__unplugged = true; });
  await page.waitForTimeout(200);
  check(JSON.stringify(await fightState()) === JSON.stringify({ paused: true, disconnected: 0, menu: true }), `unplugging pauses with P1 disconnected (${JSON.stringify(await fightState())})`);
  await tap(9); // Start does nothing while unplugged
  check((await fightState()).paused, "can't resume while the controller is missing");
  await page.evaluate(() => { window.__unplugged = false; });
  await tap(0);
  check((await fightState()).disconnected === null, "pressing a button on the pad reconnects it");
  check((await fightState()).paused, "still paused after reconnecting, so the player can get ready");
  await tap(9);
  check(!(await fightState()).paused, "Start resumes");
  step("unplugging pauses with a reconnect prompt; a button press reconnects; Start resumes");

  if (errors.length) { console.log("Page errors:\n" + errors.join("\n")); process.exitCode = 1; }
  else console.log("OK: no page errors");
} catch (err) {
  console.error(err);
  if (errors.length) console.log("Page errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
