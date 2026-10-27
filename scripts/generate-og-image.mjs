// Link-preview image (public/og-image.png, 1200×628): the title screen mid-fight.
// Needs `npm run dev` running. Usage: node scripts/generate-og-image.mjs [baseUrl]
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "http://localhost:5173";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../public/og-image.png", import.meta.url).pathname;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
try {
  // 1280×670 of the 1280×720 game is the 1.91:1 preview shape; scaled to 1200 wide.
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1200 / 1280 })).newPage();
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.fotoFighter?.scene.isActive("title"), null, { timeout: 20000 });
  // Past the reveal, then wait for a blow to land.
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => {
    const scene = window.fotoFighter.scene.getScene("title");
    return scene.sim.current.events.some((e) => e.type === "hit" && !e.blocked);
  }, null, { timeout: 60000, polling: "raf" });
  await page.evaluate(() => {
    // Hold the moment: no more steps; no prompt or footer links (nothing to press in a preview).
    const scene = window.fotoFighter.scene.getScene("title");
    scene.started = true;
    for (const child of scene.children.list) {
      if (child.type !== "Text") continue;
      scene.tweens.killTweensOf(child);
      if (/Press any button|About|Unofficial| vs /.test(child.text)) child.setVisible(false);
    }
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: OUT, clip: { x: 0, y: 25, width: 1280, height: 670 } });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
}
